import type { NextApiRequest, NextApiResponse } from 'next';
import verifyUser from '../../utils/verifyUser';
import authorize from '../../utils/authorize';
import { allowedApiRoutes } from '../../utils/allowedApiRoutes';

/**
 * Bearer-only auth invariants for the headless build.
 *
 * The web UI and its cookie/JWT session were deleted, so the single APIKEY Bearer key is the
 * instance's only credential. Two seams enforce it:
 *
 *   - verifyUser (the legacy admin surfaces: settings, clearfailed, ideas, dbmigrate, adwords).
 *     These were cookie-only before the headless phase; they now authenticate with the Bearer key
 *     directly, with NO route-whitelist restriction, because the key is the full-admin credential.
 *   - authorize (the data routes). Bearer callers still must hit a whitelisted route, exactly as
 *     before the headless change.
 *
 * This suite locks in both, plus the negative: a session cookie authorizes nothing anywhere.
 */

const ORIGINAL_ENV = { ...process.env };
const KEY = 's33k_bearer_only_fixture_key';

const makeReq = (opts: { bearer?: string, cookie?: string, url?: string, method?: string } = {}): NextApiRequest => {
   const headers: Record<string, string> = {};
   if (opts.bearer !== undefined) { headers.authorization = `Bearer ${opts.bearer}`; }
   if (opts.cookie !== undefined) { headers.cookie = `token=${opts.cookie}`; }
   return { headers, url: opts.url || '/api/settings', method: opts.method || 'GET' } as unknown as NextApiRequest;
};

const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

// The admin-maintenance surfaces that authenticate through verifyUser. Kept in sync with the
// routes that import utils/verifyUser (logout/login were deleted with the UI).
const LEGACY_ADMIN_ROUTES = [
   '/api/settings',
   '/api/clearfailed',
   '/api/ideas',
   '/api/dbmigrate',
   '/api/adwords',
];

describe('verifyUser: Bearer-only', () => {
   beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      process.env.APIKEY = KEY;
   });
   afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

   it.each(LEGACY_ADMIN_ROUTES)('%s authenticates with the Bearer APIKEY', (route) => {
      const result = verifyUser(makeReq({ bearer: KEY, url: route }), makeRes());
      expect(result).toBe('authorized');
   });

   it('rejects a wrong Bearer key', () => {
      expect(verifyUser(makeReq({ bearer: 'wrong' }), makeRes())).toBe('Invalid API Key Provided.');
   });

   it('rejects a request with no credentials', () => {
      expect(verifyUser(makeReq(), makeRes())).toBe('Not authorized');
   });

   it('a session cookie authorizes nothing (the cookie branch is gone)', () => {
      expect(verifyUser(makeReq({ cookie: 'a-jwt-shaped-cookie' }), makeRes())).toBe('Not authorized');
   });

   it('rejects everything when APIKEY is unset (never authorizes an empty compare)', () => {
      delete process.env.APIKEY;
      expect(verifyUser(makeReq({ bearer: '' }), makeRes())).not.toBe('authorized');
      expect(verifyUser(makeReq(), makeRes())).toBe('Not authorized');
   });
});

describe('authorize: Bearer callers keep the pre-headless route-whitelist behavior', () => {
   beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      process.env.APIKEY = KEY;
   });
   afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

   it('authorizes the Bearer key on a whitelisted route', async () => {
      const [method, path] = allowedApiRoutes[0].split(':');
      const result = await authorize(makeReq({ bearer: KEY, url: path, method }), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.via).toBe('bearer');
   });

   it('rejects the Bearer key on a non-whitelisted route', async () => {
      const result = await authorize(makeReq({ bearer: KEY, url: '/api/definitely-not-whitelisted' }), makeRes());
      expect(result.authorized).toBe(false);
      expect(result.error).toBe('This Route cannot be accessed with API.');
   });

   it('a session cookie authorizes nothing', async () => {
      const [method, path] = allowedApiRoutes[0].split(':');
      const result = await authorize(makeReq({ cookie: 'a-jwt-shaped-cookie', url: path, method }), makeRes());
      expect(result.authorized).toBe(false);
      expect(result.error).toBe('Not authorized');
   });
});
