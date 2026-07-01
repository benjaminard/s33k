/**
 * Tests for the click-to-authorize Google Search Console OAuth routes:
 *   - pages/api/searchconsole/connect.ts  (GET, owner-gated, returns a consent URL or a friendly
 *     "not configured" message)
 *   - pages/api/searchconsole/callback.ts (public Google redirect; verifies the SIGNED state, then
 *     stores the refresh token bound to the verified owned domain)
 *
 * The security spine under test:
 *   1. connect requires WRITE access to the domain (403 when not owned).
 *   2. connect returns an authUrl when GSC OAuth is configured, and a clear message (no crash) when
 *      GSC_OAUTH_CLIENT_ID is unset.
 *   3. callback rejects a tampered/expired state and stores NO token.
 *   4. callback with a VALID state stores the token bound to the right { domain, owner_id }, and a
 *      state whose domain the owner does not own resolves to no row and stores nothing.
 *
 * google-auth-library's OAuth2Client is mocked (no network, no real Google). The DB layer is mocked.
 * The real state signing/verifying (utils/searchConsoleOAuth) is used end to end, so the signature
 * path is exercised for real, not stubbed.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/domain-access', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/searchConsole', () => ({ __esModule: true, storeSearchConsoleOAuthToken: jest.fn() }));

// next/config supplies the appURL used to build the redirect URI. Provide it so the redirect is
// deterministic and the routes do not fall back to header sniffing.
jest.mock('next/config', () => ({ __esModule: true, default: () => ({ serverRuntimeConfig: { appURL: 'https://s33k.example' } }) }));

// Mock google-auth-library's OAuth2Client: generateAuthUrl echoes back the state so the connect
// test can assert it; getToken returns a fixed refresh token (or none, per a per-test override).
const mockGetToken = jest.fn();
jest.mock('google-auth-library', () => ({
   __esModule: true,
   OAuth2Client: jest.fn().mockImplementation(() => ({
      generateAuthUrl: (opts: { state?: string }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`,
      getToken: mockGetToken,
   })),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import connectHandler from '../../pages/api/searchconsole/connect';
// eslint-disable-next-line import/first
import callbackHandler from '../../pages/api/searchconsole/callback';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import resolveDomainAccessFn from '../../utils/domain-access';
// eslint-disable-next-line import/first
import { storeSearchConsoleOAuthToken } from '../../utils/searchConsole';
// eslint-disable-next-line import/first
import { signGSCState } from '../../utils/searchConsoleOAuth';

const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockResolveDomainAccess = resolveDomainAccessFn as unknown as jest.Mock;
const mockStoreToken = storeSearchConsoleOAuthToken as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (opts: { method?: string, query?: Record<string, unknown> } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   query: opts.query || {},
   headers: {},
   body: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.send = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.setHeader = jest.fn();
   return res as unknown as NextApiResponse & { statusCode: number, payload: unknown };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = 'test-secret-for-state-signing-0123456789';
   process.env.GSC_OAUTH_CLIENT_ID = 'cid.apps.googleusercontent.com';
   process.env.GSC_OAUTH_CLIENT_SECRET = 'csecret';
   mockGetToken.mockResolvedValue({ tokens: { refresh_token: 'rt-google-123' } });
   mockStoreToken.mockResolvedValue(true);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/searchconsole/connect ownership gate', () => {
   it('403s when the caller does not own the domain', async () => {
      asCaller({ ID: 2 });
      mockResolveDomainAccess.mockResolvedValue(null);
      const res = makeRes();
      await connectHandler(makeReq({ query: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(403);
      // It must check the WRITE gate, not the read gate.
      expect(mockResolveDomainAccess).toHaveBeenCalledWith({ ID: 2 }, 'getmasset.com', { write: true });
   });

   it('401s an unauthorized caller', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'nope' });
      const res = makeRes();
      await connectHandler(makeReq({ query: { domain: 'getmasset.com' } }), res);
      expect(res.statusCode).toBe(401);
   });
});

describe('GET /api/searchconsole/connect configuration', () => {
   it('returns an authUrl with a signed state when configured and owned', async () => {
      asCaller({ ID: 1 });
      mockResolveDomainAccess.mockResolvedValue({ domain: 'getmasset.com', get: () => ({ domain: 'getmasset.com' }) });
      const res = makeRes();
      await connectHandler(makeReq({ query: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { authUrl?: string, instructions?: string };
      expect(payload.authUrl).toContain('https://accounts.google.com/');
      expect(payload.authUrl).toContain('state=');
      expect(payload.instructions).toContain('getmasset.com');
   });

   it('returns a clear "not configured" message (no crash) when GSC_OAUTH_CLIENT_ID is unset', async () => {
      delete process.env.GSC_OAUTH_CLIENT_ID;
      asCaller({ ID: 1 });
      mockResolveDomainAccess.mockResolvedValue({ domain: 'getmasset.com', get: () => ({ domain: 'getmasset.com' }) });
      const res = makeRes();
      await connectHandler(makeReq({ query: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { authUrl?: string, error?: string };
      expect(payload.authUrl).toBeUndefined();
      expect(payload.error).toContain('not configured');
   });
});

describe('GET /api/searchconsole/callback state verification', () => {
   it('rejects a tampered state and stores NO token', async () => {
      const goodState = signGSCState({ domain: 'getmasset.com', ownerId: null });
      const tampered = `${goodState}x`; // corrupt the signature
      const res = makeRes();
      await callbackHandler(makeReq({ query: { code: 'auth-code', state: tampered } }), res);

      expect(res.statusCode).toBe(400);
      expect(mockStoreToken).not.toHaveBeenCalled();
   });

   it('rejects a missing state and stores NO token', async () => {
      const res = makeRes();
      await callbackHandler(makeReq({ query: { code: 'auth-code' } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockStoreToken).not.toHaveBeenCalled();
   });

   it('rejects a missing code and stores NO token', async () => {
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      const res = makeRes();
      await callbackHandler(makeReq({ query: { state } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockStoreToken).not.toHaveBeenCalled();
   });
});

describe('GET /api/searchconsole/callback token storage', () => {
   it('stores the refresh token bound to the verified domain (admin / null owner: no owner_id in where)', async () => {
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      const res = makeRes();
      await callbackHandler(makeReq({ query: { code: 'auth-code', state } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockStoreToken).toHaveBeenCalledWith({ domain: 'getmasset.com' }, 'rt-google-123');
   });

   it('binds the store to BOTH domain and owner for a real tenant, so a foreign domain cannot be attached', async () => {
      // A tenant (owner 7) signs a state for THEIR domain. The store must be scoped to owner_id 7,
      // so even a state naming a domain owned by someone else resolves to no row and attaches nothing.
      const state = signGSCState({ domain: 'tenant-domain.com', ownerId: 7 });
      const res = makeRes();
      await callbackHandler(makeReq({ query: { code: 'auth-code', state } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockStoreToken).toHaveBeenCalledWith({ domain: 'tenant-domain.com', owner_id: 7 }, 'rt-google-123');
   });

   it('400s and stores nothing when Google returns no refresh token', async () => {
      mockGetToken.mockResolvedValue({ tokens: { access_token: 'only-access' } });
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      const res = makeRes();
      await callbackHandler(makeReq({ query: { code: 'auth-code', state } }), res);

      expect(res.statusCode).toBe(400);
      expect(mockStoreToken).not.toHaveBeenCalled();
   });

   it('400s when the verified domain matches no owned row (store returns false)', async () => {
      mockStoreToken.mockResolvedValue(false);
      const state = signGSCState({ domain: 'getmasset.com', ownerId: null });
      const res = makeRes();
      await callbackHandler(makeReq({ query: { code: 'auth-code', state } }), res);

      expect(res.statusCode).toBe(400);
      expect(mockStoreToken).toHaveBeenCalled();
   });
});
