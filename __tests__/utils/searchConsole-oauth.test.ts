/**
 * Tests for the OAuth-vs-service-account auth selection in utils/searchConsole.ts, and for the
 * signed-state helpers in utils/searchConsoleOAuth.ts.
 *
 * Auth selection (the back-compat guarantee): fetchSearchConsoleData must authenticate via an
 * OAuth2Client (the click-to-authorize refresh token) when one is present, and via the
 * service-account GoogleAuth JWT otherwise. We assert which constructor was used per case, so the
 * new OAuth path is proven AND the existing service-account path is proven unchanged.
 *
 * State helpers: signGSCState/verifyGSCState round-trip, reject tampering, and reject expiry. The
 * signing uses the app SECRET, so a forged state cannot be accepted.
 */

const mockQuery = jest.fn();
const mockSearchconsoleCtor = jest.fn();
jest.mock('@googleapis/searchconsole', () => ({
   __esModule: true,
   auth: { GoogleAuth: jest.fn().mockImplementation((opts: unknown) => ({ __kind: 'service-account', opts })) },
   searchconsole_v1: {
      Searchconsole: jest.fn().mockImplementation((cfg: { auth: unknown }) => {
         mockSearchconsoleCtor(cfg);
         return { searchanalytics: { query: mockQuery } };
      }),
   },
}));

const mockSetCredentials = jest.fn();
jest.mock('google-auth-library', () => ({
   __esModule: true,
   OAuth2Client: jest.fn().mockImplementation(() => ({ __kind: 'oauth', setCredentials: mockSetCredentials })),
}));

// Avoid pulling the real Domain model (sequelize ESM) into this suite. searchConsole.ts imports it
// for the store/clear helpers, which this suite does not call.
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: {} }));
// searchConsole.ts now reads the app-settings SC credential fallback from the DB-backed settings
// store; mock it so this suite does not pull sequelize (the store imports database/database).
jest.mock('../../utils/settingsStore', () => ({ __esModule: true, getStoredSettings: jest.fn(async () => ({})) }));

// eslint-disable-next-line import/first
import fetchSearchConsoleData from '../../utils/searchConsole';
// eslint-disable-next-line import/first
import { auth as gauth } from '@googleapis/searchconsole';
// eslint-disable-next-line import/first
import { OAuth2Client } from 'google-auth-library';
// eslint-disable-next-line import/first
import { signGSCState, verifyGSCState } from '../../utils/searchConsoleOAuth';

const mockGoogleAuth = gauth.GoogleAuth as unknown as jest.Mock;
const mockOAuth2Client = OAuth2Client as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const domain = { domain: 'getmasset.com', search_console: '' } as unknown as DomainType;

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = 'test-secret-for-state-signing-0123456789';
   process.env.GSC_OAUTH_CLIENT_ID = 'cid';
   process.env.GSC_OAUTH_CLIENT_SECRET = 'csecret';
   mockQuery.mockResolvedValue({ data: { rows: [] } });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('fetchSearchConsoleData auth selection', () => {
   it('uses the OAuth2Client (refresh token) when an oauth refresh token is present', async () => {
      await fetchSearchConsoleData(domain, 3, undefined, { client_email: '', private_key: '', refresh_token: 'rt-abc' });

      expect(mockOAuth2Client).toHaveBeenCalledTimes(1);
      expect(mockSetCredentials).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: 'rt-abc' }));
      // The service-account JWT path must NOT be used when OAuth is available.
      expect(mockGoogleAuth).not.toHaveBeenCalled();
      // The searchconsole client is built with the OAuth client as its auth.
      expect(mockSearchconsoleCtor).toHaveBeenCalledWith({ auth: expect.objectContaining({ __kind: 'oauth' }) });
   });

   it('falls back to the service-account JWT when no oauth token is present', async () => {
      await fetchSearchConsoleData(domain, 3, undefined, { client_email: 'svc@x.iam', private_key: 'BEGIN PRIVATE KEY...' });

      expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
      expect(mockOAuth2Client).not.toHaveBeenCalled();
      expect(mockSearchconsoleCtor).toHaveBeenCalledWith({ auth: expect.objectContaining({ __kind: 'service-account' }) });
   });

   it('errors out (no client built) when neither credential is provided', async () => {
      const result = await fetchSearchConsoleData(domain, 3, undefined, { client_email: '', private_key: '' });
      expect(result).toEqual(expect.objectContaining({ error: true }));
      expect(mockOAuth2Client).not.toHaveBeenCalled();
      expect(mockGoogleAuth).not.toHaveBeenCalled();
   });
});

describe('signGSCState / verifyGSCState', () => {
   it('round-trips a signed state back to its domain + owner', () => {
      const state = signGSCState({ domain: 'getmasset.com', ownerId: 7 });
      expect(verifyGSCState(state)).toEqual({ domain: 'getmasset.com', ownerId: 7 });
   });

   it('round-trips a null owner (admin / single-tenant) as null', () => {
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      expect(verifyGSCState(state)).toEqual({ domain: 'getmasset.com', ownerId: null });
   });

   it('rejects a tampered signature', () => {
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      expect(verifyGSCState(`${state}x`)).toBe(false);
   });

   it('rejects a state signed with a different SECRET (forgery)', () => {
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      process.env.SECRET = 'a-totally-different-secret-value-99';
      expect(verifyGSCState(state)).toBe(false);
   });

   it('rejects an expired state', () => {
      const realNow = Date.now;
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      // Advance the clock past the 15-minute TTL.
      Date.now = () => realNow() + (16 * 60 * 1000);
      try {
         expect(verifyGSCState(state)).toBe(false);
      } finally {
         Date.now = realNow;
      }
   });

   it('rejects empty / malformed input', () => {
      expect(verifyGSCState('')).toBe(false);
      expect(verifyGSCState(undefined)).toBe(false);
      expect(verifyGSCState('no-dot-here')).toBe(false);
   });
});
