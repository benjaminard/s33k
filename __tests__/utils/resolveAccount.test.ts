import type { NextApiRequest, NextApiResponse } from 'next';

// Mock the sequelize-typescript model module so importing the resolver does NOT pull in
// the real sequelize ESM chain (which jest cannot transform here) and never opens a DB
// connection. The Bearer-key branches under test never call these model methods; the stub
// exists only to keep this a pure, network-free, DB-free unit test. findOne throws so that
// if the code ever fell through to a DB path in these tests, the test would fail loudly
// instead of silently hitting a real model.
jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { findOne: jest.fn(async () => { throw new Error('DB should not be hit in pure resolver tests'); }) },
}));

// eslint-disable-next-line import/first
import resolveAccount from '../../utils/resolveAccount';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

/**
 * Pure unit tests for the single-user accounts resolver (utils/resolveAccount.ts).
 *
 * The resolver turns the APIKEY Bearer key into the single admin account. Single-user AND
 * headless: there is exactly one account (the admin sentinel, ID = ADMIN_ACCOUNT_ID) and exactly
 * one credential. The invariants:
 *   1. The global process.env.APIKEY resolves to the admin account.
 *   2. Anything else (wrong key, no key) is unauthorized.
 *   3. A session cookie no longer authorizes anything: the cookie/JWT branch was deleted with the
 *      web UI in the headless phase, and this suite locks that in.
 *
 * No network, no DB. The resolver returns an in-memory admin sentinel and never calls a model
 * method, so these paths are fully pure.
 */

const ORIGINAL_ENV = { ...process.env };

const LEGACY_KEY = 's33k_legacy_admin_key_fixture';

// Minimal NextApiRequest stand-in carrying just an Authorization header and cookie jar.
const makeReq = (opts: { bearer?: string, cookie?: string } = {}): NextApiRequest => {
   const headers: Record<string, string> = {};
   if (opts.bearer !== undefined) { headers.authorization = `Bearer ${opts.bearer}`; }
   if (opts.cookie !== undefined) { headers.cookie = `token=${opts.cookie}`; }
   return { headers } as unknown as NextApiRequest;
};

// A no-op res with the surface older middleware expected is enough.
const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

describe('resolveAccount', () => {
   beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      process.env.APIKEY = LEGACY_KEY;
      process.env.SECRET = 'unit-test-secret';
   });

   afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
   });

   describe('the global APIKEY resolves to the admin account', () => {
      it('resolves the API key to the admin account, via bearer', async () => {
         const result = await resolveAccount(makeReq({ bearer: LEGACY_KEY }), makeRes());
         expect(result.authorized).toBe(true);
         expect(result.account).not.toBeNull();
         expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
         expect(result.via).toBe('bearer');
         expect(result.error).toBeUndefined();
      });

      it('resolves the admin account without any DB lookup (in-memory sentinel)', async () => {
         // The admin sentinel is a bare { ID } object: it has no sequelize instance
         // methods like save/reload. Asserting that proves the path never touched a table.
         const result = await resolveAccount(makeReq({ bearer: LEGACY_KEY }), makeRes());
         expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
         expect((result.account as unknown as { save?: unknown }).save).toBeUndefined();
      });
   });

   describe('cookies no longer authorize (the web UI and its session are deleted)', () => {
      it('ignores a session cookie entirely: no bearer means Not authorized', async () => {
         const result = await resolveAccount(makeReq({ cookie: 'any-old-jwt-shaped-value' }), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
         expect(result.error).toBe('Not authorized');
      });

      it('a cookie does not rescue a wrong Bearer key', async () => {
         const result = await resolveAccount(makeReq({ bearer: 'wrong-key', cookie: 'whatever' }), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.error).toBe('Invalid API Key Provided.');
      });
   });

   describe('unauthorized paths', () => {
      it('rejects a wrong Bearer key with the invalid-key error', async () => {
         const result = await resolveAccount(makeReq({ bearer: 'totally-wrong-key' }), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
         expect(result.error).toBe('Invalid API Key Provided.');
      });

      it('rejects a request with no key and no cookie', async () => {
         const result = await resolveAccount(makeReq(), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
         expect(result.error).toBe('Not authorized');
      });
   });
});
