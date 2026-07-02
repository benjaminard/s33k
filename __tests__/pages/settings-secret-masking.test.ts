/**
 * Secret masking on the settings HTTP surface (the headless fast-follow).
 *
 * With the web UI deleted, auth is Bearer-only and nothing legitimate needs to read a credential
 * VALUE back over HTTP: you only ever need to know whether one is set. The rule under test:
 * no settings response (GET or the PUT echo) ever carries a secret in plaintext, whether the
 * secret lives in the DB row or arrives via the env fallback (SERPER_API_KEY). The PUT side must
 * also honor the SECRET_MASK sentinel by PRESERVING the stored encrypted value, so a GET, modify,
 * PUT round-trip can never clobber a real key with the mask. getAppSettings() itself stays fully
 * decrypted for internal callers (scrapes, notifications); only the HTTP shape changes.
 */

jest.mock('next/config', () => ({ __esModule: true, default: () => ({ publicRuntimeConfig: { version: 'test' } }) }));
jest.mock('../../utils/verifyUser', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../scrapers/index', () => ({ __esModule: true, default: [] }));
jest.mock('../../utils/settingsStore', () => ({
   __esModule: true,
   getStoredSettings: jest.fn(async () => ({})),
   writeStoredSettings: jest.fn(async () => undefined),
}));
jest.mock('../../utils/scraper', () => ({
   __esModule: true,
   getFailedRetryKeywordIds: jest.fn(async () => []),
   failedRetryWhere: jest.fn(() => ({})),
}));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn() }, ensureSynced: jest.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import Cryptr from 'cryptr';
// eslint-disable-next-line import/first
import verifyUserFn from '../../utils/verifyUser';
// eslint-disable-next-line import/first
import { getStoredSettings, writeStoredSettings } from '../../utils/settingsStore';
// eslint-disable-next-line import/first
import settingsHandler, { SECRET_MASK } from '../../pages/api/settings';

const mockVerifyUser = verifyUserFn as unknown as jest.Mock;
const mockGetStored = getStoredSettings as unknown as jest.Mock;
const mockWriteStored = writeStoredSettings as unknown as jest.Mock;

const TEST_SECRET = 'masking-test-secret-1234567890';
const PLAINTEXT_KEY = 'sk-super-secret-serper-key-123';

const makeReq = (opts: { method?: string, body?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body ?? {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: { settings?: Record<string, any> } };
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = TEST_SECRET;
   delete process.env.SERPER_API_KEY;
   delete process.env.SCAPING_API;
   mockVerifyUser.mockReturnValue('authorized');
   mockGetStored.mockResolvedValue({});
   mockWriteStored.mockResolvedValue(undefined);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/settings masks every stored secret', () => {
   it('returns the mask, never the plaintext or the encrypted blob, for a DB-stored key', async () => {
      const cryptr = new Cryptr(TEST_SECRET);
      const encrypted = cryptr.encrypt(PLAINTEXT_KEY);
      mockGetStored.mockResolvedValue({ scaping_api: encrypted, scraper_type: 'serper' });

      const res = makeRes();
      await settingsHandler(makeReq(), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.settings?.scaping_api).toBe(SECRET_MASK);
      const raw = JSON.stringify(res.payload);
      expect(raw).not.toContain(PLAINTEXT_KEY);
      expect(raw).not.toContain(encrypted);
   });

   it('masks the env-fallback key too (an env-configured instance must not leak via GET)', async () => {
      process.env.SERPER_API_KEY = PLAINTEXT_KEY;

      const res = makeRes();
      await settingsHandler(makeReq(), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.settings?.scaping_api).toBe(SECRET_MASK);
      expect(JSON.stringify(res.payload)).not.toContain(PLAINTEXT_KEY);
   });

   it('leaves an unset secret as empty string, so set and unset stay distinguishable', async () => {
      const res = makeRes();
      await settingsHandler(makeReq(), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.settings?.scaping_api).toBe('');
      expect(res.payload.settings?.smtp_password).toBe('');
   });
});

describe('PUT /api/settings honors the mask sentinel and never echoes plaintext', () => {
   it('preserves the STORED encrypted value when the incoming value is the mask (round-trip safe)', async () => {
      const cryptr = new Cryptr(TEST_SECRET);
      const storedEncrypted = cryptr.encrypt(PLAINTEXT_KEY);
      mockGetStored.mockResolvedValue({ scaping_api: storedEncrypted });

      const res = makeRes();
      const body = { settings: { scaping_api: SECRET_MASK, scraper_type: 'serper' } };
      await settingsHandler(makeReq({ method: 'PUT', body }), res);

      expect(res.statusCode).toBe(200);
      const written = mockWriteStored.mock.calls[0][0];
      // The exact stored ciphertext survives: the mask was NOT encrypted and saved.
      expect(written.scaping_api).toBe(storedEncrypted);
   });

   it('encrypts a fresh value and masks it in the response echo', async () => {
      const res = makeRes();
      const body = { settings: { scaping_api: PLAINTEXT_KEY, scraper_type: 'serper' } };
      await settingsHandler(makeReq({ method: 'PUT', body }), res);

      expect(res.statusCode).toBe(200);
      const written = mockWriteStored.mock.calls[0][0];
      expect(written.scaping_api).not.toBe(PLAINTEXT_KEY);
      const cryptr = new Cryptr(TEST_SECRET);
      expect(cryptr.decrypt(written.scaping_api)).toBe(PLAINTEXT_KEY);
      // The response never carries the caller's plaintext back.
      expect(res.payload.settings?.scaping_api).toBe(SECRET_MASK);
      expect(JSON.stringify(res.payload)).not.toContain(PLAINTEXT_KEY);
   });

   it('an empty string still explicitly clears a secret (pre-mask behavior unchanged)', async () => {
      const cryptr = new Cryptr(TEST_SECRET);
      mockGetStored.mockResolvedValue({ scaping_api: cryptr.encrypt(PLAINTEXT_KEY) });

      const res = makeRes();
      const body = { settings: { scaping_api: '', scraper_type: 'none' } };
      await settingsHandler(makeReq({ method: 'PUT', body }), res);

      expect(res.statusCode).toBe(200);
      expect(mockWriteStored.mock.calls[0][0].scaping_api).toBe('');
   });
});
