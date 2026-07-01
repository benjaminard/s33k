/**
 * Tests for the production demo-credential safety check in pages/api/login.ts.
 *
 * The deploy reality this guards: the repo ships SerpBear's PUBLIC demo APIKEY,
 * SECRET, and PASSWORD as defaults. If a public instance boots with them, anyone
 * can log in and call the API. entrypoint.sh refuses to boot on demo creds, but
 * someone can still run `node server.js` directly and bypass it, so the login
 * route enforces the same guard at request time. The contract under test:
 *
 *   1. In production, login is BLOCKED with 403 when SECRET, APIKEY, or PASSWORD
 *      is a known demo value or a REGENERATE_ME placeholder, even with correct
 *      username/password.
 *   2. In production with STRONG (non-demo) creds, the guard does not fire and a
 *      correct login still succeeds (200).
 *   3. Outside production (NODE_ENV !== 'production'), the guard never fires;
 *      the demo defaults are intentional for local dev, so login still works.
 *
 * jsonwebtoken and cookies are mocked so the happy path issues a token without
 * real crypto or cookie I/O. No network, no DB.
 */

jest.mock('jsonwebtoken', () => ({ __esModule: true, default: { sign: jest.fn(() => 'signed.jwt.token') } }));
jest.mock('cookies', () => {
   return jest.fn().mockImplementation(() => ({ set: jest.fn() }));
});

// eslint-disable-next-line import/first
import handler from '../../pages/api/login';

const DEMO_APIKEY = '5saedXklbslhnapihe2pihp3pih4fdnakhjwq5';
const DEMO_SECRET = '4715aed3216f7b0a38e6b534a958362654e96d10fbc04700770d572af3dce43625dd';
const DEMO_PASSWORD = '0123456789';

const STRONG_APIKEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334';
const STRONG_SECRET = 'deadbeefcafef00dabad1deac0ffee1234567890aabbccddeeff00112233445566';
const STRONG_PASSWORD = 'correct-horse-battery-staple';

const ORIGINAL_ENV = { ...process.env };

/** A minimal Next-style POST req/res pair capturing status + json. */
const makeReqRes = (body: Record<string, string>) => {
   const req = { method: 'POST', body, headers: {} } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/** Set a full, internally-consistent credential env. */
const setCreds = (opts: { nodeEnv: string, apikey: string, secret: string, password: string, user?: string }) => {
   (process.env as any).NODE_ENV = opts.nodeEnv;
   process.env.APIKEY = opts.apikey;
   process.env.SECRET = opts.secret;
   process.env.PASSWORD = opts.password;
   process.env.USER_NAME = opts.user || 'admin';
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
   process.env = { ...ORIGINAL_ENV };
});

describe('login production demo-credential safety check', () => {
   it('blocks login with 403 in production when the SECRET is the demo value', async () => {
      setCreds({ nodeEnv: 'production', apikey: STRONG_APIKEY, secret: DEMO_SECRET, password: STRONG_PASSWORD });
      const { req, res, captured } = makeReqRes({ username: 'admin', password: STRONG_PASSWORD });

      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(captured.body.error).toMatch(/demo credentials/i);
   });

   it('blocks login with 403 in production when the APIKEY is the demo value', async () => {
      setCreds({ nodeEnv: 'production', apikey: DEMO_APIKEY, secret: STRONG_SECRET, password: STRONG_PASSWORD });
      const { req, res, captured } = makeReqRes({ username: 'admin', password: STRONG_PASSWORD });

      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(captured.body.error).toMatch(/demo credentials/i);
   });

   it('blocks login with 403 in production when the PASSWORD is the demo value', async () => {
      setCreds({ nodeEnv: 'production', apikey: STRONG_APIKEY, secret: STRONG_SECRET, password: DEMO_PASSWORD });
      const { req, res, captured } = makeReqRes({ username: 'admin', password: DEMO_PASSWORD });

      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(captured.body.error).toMatch(/demo credentials/i);
   });

   it('blocks login with 403 in production when a credential is a REGENERATE_ME placeholder', async () => {
      setCreds({
         nodeEnv: 'production',
         apikey: 'REGENERATE_ME_run_openssl_rand_hex_24',
         secret: STRONG_SECRET,
         password: STRONG_PASSWORD,
      });
      const { req, res, captured } = makeReqRes({ username: 'admin', password: STRONG_PASSWORD });

      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(captured.body.error).toMatch(/demo credentials/i);
   });

   it('allows a correct login in production when all credentials are strong (guard does not fire)', async () => {
      setCreds({ nodeEnv: 'production', apikey: STRONG_APIKEY, secret: STRONG_SECRET, password: STRONG_PASSWORD });
      const { req, res, captured } = makeReqRes({ username: 'admin', password: STRONG_PASSWORD });

      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.success).toBe(true);
   });

   it('does NOT fire the guard outside production: demo creds still log in for local dev', async () => {
      setCreds({ nodeEnv: 'development', apikey: DEMO_APIKEY, secret: DEMO_SECRET, password: DEMO_PASSWORD });
      const { req, res, captured } = makeReqRes({ username: 'admin', password: DEMO_PASSWORD });

      await handler(req, res);

      // The 403 demo-cred guard is skipped; the normal auth path runs and succeeds.
      expect(captured.status).toBe(200);
      expect(captured.body.success).toBe(true);
   });
});
