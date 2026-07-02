/**
 * The first-run installer surface: GET /setup (getServerSideProps gate) + POST /api/setup.
 *
 * The contract under test (the headless-direction brief):
 *   - the page and the POST are TOKEN-AUTHED PUBLIC routes: wrong/missing token = hintless 404;
 *   - an ALREADY-COMPLETED instance (including every existing install via the backfill rule)
 *     404s on both, forever;
 *   - the Serper key is OPTIONAL: skipping still completes setup;
 *   - the POST is write-only (no stored secret in any response) and CSRF-hardened (token in the
 *     body/header, restricted Content-Type, no cookie read);
 *   - a provided key is stored exactly the way pages/api/settings.ts stores it (cryptr-encrypted
 *     scaping_api + scraper_type serper).
 *
 * setupState is mocked (its own unit suite covers token/backfill mechanics); this suite pins the
 * ROUTE behavior around it, per the repo convention of mocking the seam a route composes.
 */
jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../utils/setupState', () => ({
   __esModule: true,
   isSetupCompleted: jest.fn(async () => false),
   verifySetupToken: jest.fn(() => false),
   markSetupCompleted: jest.fn(async () => undefined),
   publicBaseUrlHeaderFree: jest.fn(() => 'http://localhost:3000'),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import Cryptr from 'cryptr';
// eslint-disable-next-line import/first
import handler from '../../pages/api/setup';
// eslint-disable-next-line import/first
import { getServerSideProps } from '../../pages/setup';
// eslint-disable-next-line import/first
import { isSetupCompleted, verifySetupToken, markSetupCompleted } from '../../utils/setupState';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockCompleted = isSetupCompleted as unknown as jest.Mock;
const mockVerify = verifySetupToken as unknown as jest.Mock;
const mockMark = markSetupCompleted as unknown as jest.Mock;

const savedSecret = process.env.SECRET;
beforeAll(() => { process.env.SECRET = 'test-secret-for-setup-route'; });
afterAll(() => {
   if (savedSecret === undefined) { delete process.env.SECRET; } else { process.env.SECRET = savedSecret; }
});

const makeReq = (over: Partial<NextApiRequest> = {}): NextApiRequest => ({
   method: 'POST',
   query: {},
   body: {},
   headers: { 'content-type': 'application/json' },
   socket: { remoteAddress: '203.0.113.9' },
   ...over,
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.headers = {} as Record<string, string>;
   res.setHeader = jest.fn((k: string, v: string) => { (res.headers as Record<string, string>)[k] = v; });
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   mockCompleted.mockResolvedValue(false);
   mockVerify.mockReturnValue(false);
});

describe('POST /api/setup', () => {
   it('404s on a missing token with no hints', async () => {
      const res = makeRes();
      await handler(makeReq({ body: {} }), res);
      expect(res.statusCode).toBe(404);
      expect(res.payload).toEqual({ error: 'Not Found' });
      expect(mockMark).not.toHaveBeenCalled();
   });

   it('404s on a wrong token with the same hintless body', async () => {
      mockVerify.mockImplementation((t: string) => t === 'the-right-token');
      const res = makeRes();
      await handler(makeReq({ body: { token: 'guessed-wrong' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.payload).toEqual({ error: 'Not Found' });
   });

   it('404s forever once setup completed, even with the previously-valid token (reuse)', async () => {
      mockCompleted.mockResolvedValue(true);
      mockVerify.mockReturnValue(true);
      const res = makeRes();
      await handler(makeReq({ body: { token: 'previously-valid' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockMark).not.toHaveBeenCalled();
   });

   it('completes WITHOUT a key (Serper is optional; SEO stays an off module)', async () => {
      mockVerify.mockReturnValue(true);
      const res = makeRes();
      await handler(makeReq({ body: { token: 'ok' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ completed: true, seoConfigured: false });
      expect(mockMark).toHaveBeenCalledWith({});
   });

   it('stores a provided key encrypted, settings.ts-style, and never echoes it', async () => {
      mockVerify.mockReturnValue(true);
      const res = makeRes();
      await handler(makeReq({ body: { token: 'ok', serper_key: '  my-serper-key  ' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ completed: true, seoConfigured: true });
      const extra = mockMark.mock.calls[0][0];
      expect(extra.scraper_type).toBe('serper');
      expect(extra.scaping_api).not.toContain('my-serper-key');
      expect(new Cryptr(process.env.SECRET as string).decrypt(extra.scaping_api)).toBe('my-serper-key');
      // Write-only: no stored secret in any response field.
      expect(JSON.stringify(res.payload)).not.toContain('my-serper-key');
   });

   it('rejects a non-JSON/form Content-Type before looking at the body', async () => {
      mockVerify.mockReturnValue(true);
      const res = makeRes();
      await handler(makeReq({ headers: { 'content-type': 'text/plain' }, body: { token: 'ok' } }), res);
      expect(res.statusCode).toBe(415);
      expect(mockMark).not.toHaveBeenCalled();
   });

   it('a completed instance answers 404 to EVERY shape of request, even a bad Content-Type', async () => {
      mockCompleted.mockResolvedValue(true);
      const res = makeRes();
      await handler(makeReq({ headers: { 'content-type': 'text/plain' }, body: {} }), res);
      expect(res.statusCode).toBe(404);
      expect(res.payload).toEqual({ error: 'Not Found' });
   });

   it('accepts the token via the x-setup-token header (no cookies anywhere)', async () => {
      mockVerify.mockImplementation((t: string) => t === 'header-token');
      const res = makeRes();
      await handler(makeReq({ headers: { 'content-type': 'application/json', 'x-setup-token': 'header-token' }, body: {} }), res);
      expect(res.statusCode).toBe(200);
   });

   it('404s on non-POST methods', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'GET' }), res);
      expect(res.statusCode).toBe(404);
   });

   it('rate-limits repeated attempts from one IP (429 + Retry-After)', async () => {
      const last = makeRes();
      for (let i = 0; i < 10; i += 1) {
         // eslint-disable-next-line no-await-in-loop
         await handler(makeReq({ body: { token: 'x' } }), makeRes());
      }
      await handler(makeReq({ body: { token: 'x' } }), last);
      expect(last.statusCode).toBe(429);
      expect(last.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
   });

   it('rejects an oversized key', async () => {
      mockVerify.mockReturnValue(true);
      const res = makeRes();
      await handler(makeReq({ body: { token: 'ok', serper_key: 'x'.repeat(600) } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockMark).not.toHaveBeenCalled();
   });
});

describe('GET /setup (getServerSideProps gate)', () => {
   // gSSP sets Cache-Control (no-store: the page embeds the APIKEY), so the context needs a res.
   const ctx = (token?: string) => ({
      query: token === undefined ? {} : { token },
      res: { setHeader: jest.fn() },
   } as any);

   it('404s with no token', async () => {
      await expect(getServerSideProps(ctx())).resolves.toEqual({ notFound: true });
   });

   it('404s with a wrong token', async () => {
      mockVerify.mockImplementation((t: string) => t === 'right');
      await expect(getServerSideProps(ctx('wrong'))).resolves.toEqual({ notFound: true });
   });

   it('404s on an already-completed instance even with a valid-looking token (backfill rule)', async () => {
      mockCompleted.mockResolvedValue(true);
      mockVerify.mockReturnValue(true);
      await expect(getServerSideProps(ctx('right'))).resolves.toEqual({ notFound: true });
   });

   it('serves the installer props (APIKEY + base URL + beacon snippet) behind a valid token', async () => {
      mockVerify.mockImplementation((t: string) => t === 'right');
      const savedKey = process.env.APIKEY;
      process.env.APIKEY = 'the-instance-apikey';
      const result = await getServerSideProps(ctx('right')) as { props: Record<string, string> };
      if (savedKey === undefined) { delete process.env.APIKEY; } else { process.env.APIKEY = savedKey; }
      expect(result.props.token).toBe('right');
      expect(result.props.apiKey).toBe('the-instance-apikey');
      expect(result.props.baseUrl).toBe('http://localhost:3000');
      expect(result.props.beaconSnippet).toContain('s33k.js');
      expect(result.props.beaconSnippet).toContain('data-domain');
   });
});
