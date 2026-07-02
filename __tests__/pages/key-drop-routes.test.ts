/**
 * The key-drop flow: POST /api/key-drop (authed mint) + POST /api/key-drop/[nonce] (public consume).
 *
 * The contract under test (the headless-direction brief): a secret can be enabled from an LLM
 * conversation WITHOUT ever passing through the chat. So the mint half must be key-authed and
 * leak nothing, and the consume half must enforce signature + TTL + single-use, cap the body,
 * save the key encrypted, and NEVER echo it.
 *
 * The token layer (utils/keyDrop) is REAL here: the routes are exercised with genuinely signed,
 * tampered, expired, and replayed tokens, because the token checks ARE the route's security.
 * Only the IO seams (DB, settings row, authorize) are mocked, per the repo route-test convention.
 */
jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/settingsStore', () => ({
   __esModule: true,
   getStoredSettings: jest.fn(async () => ({})),
   writeStoredSettings: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import { Readable } from 'stream';
// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import Cryptr from 'cryptr';
// eslint-disable-next-line import/first
import mintHandler from '../../pages/api/key-drop/index';
// eslint-disable-next-line import/first
import consumeHandler from '../../pages/api/key-drop/[nonce]';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { getStoredSettings, writeStoredSettings } from '../../utils/settingsStore';
// eslint-disable-next-line import/first
import { signKeyDropToken, verifyKeyDropToken, KEY_DROP_TTL_MS, KEY_DROP_CONSUMED_FIELD } from '../../utils/keyDrop';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockRead = getStoredSettings as unknown as jest.Mock;
const mockWrite = writeStoredSettings as unknown as jest.Mock;

const ENV_KEYS = ['SECRET', 'NEXT_PUBLIC_APP_URL'];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
   ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
   process.env.SECRET = 'test-secret-for-key-drop-routes';
   process.env.NEXT_PUBLIC_APP_URL = 'https://s33k.example.com';
});
afterAll(() => {
   ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) { delete process.env[k]; } else { process.env[k] = savedEnv[k]; }
   });
});

// A distinct source IP per test keeps the per-IP limiter out of the way except where asserted.
let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `198.51.100.${ipCounter}`; };

const makeMintReq = (body: Record<string, unknown> = {}): NextApiRequest => ({
   method: 'POST', query: {}, body, headers: {}, socket: { remoteAddress: nextIp() },
} as unknown as NextApiRequest);

// The consume route reads its body as a RAW stream (body parser off), so the mock request is a
// real Readable with the request-ish fields bolted on.
const makeConsumeReq = (nonceParam: string, bodyChunks: (string | Buffer)[], ip?: string): NextApiRequest => (
   Object.assign(Readable.from(bodyChunks), {
      method: 'POST',
      query: { nonce: nonceParam },
      headers: {},
      socket: { remoteAddress: ip || nextIp() },
   }) as unknown as NextApiRequest
);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.setHeader = jest.fn();
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   res.send = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   mockRead.mockResolvedValue({});
});

describe('POST /api/key-drop (mint)', () => {
   it('requires auth (401 for an unauthorized caller)', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Not authorized' });
      const res = makeRes();
      await mintHandler(makeMintReq(), res);
      expect(res.statusCode).toBe(401);
   });

   it('mints a verifiable serper token + the exact curl one-liner on the configured base URL', async () => {
      const res = makeRes();
      await mintHandler(makeMintReq({ secret: 'serper' }), res);
      expect(res.statusCode).toBe(200);
      const verified = verifyKeyDropToken(res.payload.token);
      expect(verified).not.toBe(false);
      expect((verified as { secret: string }).secret).toBe('serper');
      expect(res.payload.command).toBe(
         `curl -sS -X POST https://s33k.example.com/api/key-drop/${res.payload.token} --data-binary @-`,
      );
      expect(res.payload.expiresInMinutes).toBe(15);
      expect(res.payload.instructions).toContain('Ctrl-D');
   });

   it('defaults the secret to serper when the body omits it', async () => {
      const res = makeRes();
      await mintHandler(makeMintReq({}), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.secret).toBe('serper');
   });

   it('rejects an unknown secret', async () => {
      const res = makeRes();
      await mintHandler(makeMintReq({ secret: 'stripe' }), res);
      expect(res.statusCode).toBe(400);
   });
});

describe('POST /api/key-drop/[nonce] (consume)', () => {
   it('saves the key encrypted, burns the nonce durably, and never echoes the key', async () => {
      mockRead.mockResolvedValue({ some_field: 'kept' });
      const token = signKeyDropToken('serper');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['my-secret-serper-key\n']), res);
      expect(res.statusCode).toBe(200);
      expect(String(res.payload)).not.toContain('my-secret-serper-key');
      const written = mockWrite.mock.calls[0][0];
      expect(written.some_field).toBe('kept');
      expect(written.scraper_type).toBe('serper');
      expect(written.scaping_api).not.toContain('my-secret-serper-key');
      expect(new Cryptr(process.env.SECRET as string).decrypt(written.scaping_api)).toBe('my-secret-serper-key');
      const nonce = (verifyKeyDropToken(token) as { nonce: string }).nonce;
      expect(written[KEY_DROP_CONSUMED_FIELD][nonce]).toEqual(expect.any(Number));
   });

   it('404s a tampered signature without touching the settings row', async () => {
      const token = signKeyDropToken('serper');
      const flipped = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(flipped, ['key']), res);
      expect(res.statusCode).toBe(404);
      expect(mockWrite).not.toHaveBeenCalled();
   });

   it('404s an expired token', async () => {
      const token = signKeyDropToken('serper', Date.now() - KEY_DROP_TTL_MS - 60 * 1000);
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['key']), res);
      expect(res.statusCode).toBe(404);
      expect(mockWrite).not.toHaveBeenCalled();
   });

   it('404s a REUSED token: within-process replay after a successful drop', async () => {
      const token = signKeyDropToken('serper');
      const first = makeRes();
      await consumeHandler(makeConsumeReq(token, ['key-one']), first);
      expect(first.statusCode).toBe(200);
      const replay = makeRes();
      await consumeHandler(makeConsumeReq(token, ['key-two']), replay);
      expect(replay.statusCode).toBe(404);
      expect(mockWrite).toHaveBeenCalledTimes(1);
   });

   it('404s a token whose nonce the DURABLE consumed map already holds (restart survival)', async () => {
      const token = signKeyDropToken('serper');
      const nonce = (verifyKeyDropToken(token) as { nonce: string }).nonce;
      mockRead.mockResolvedValue({ [KEY_DROP_CONSUMED_FIELD]: { [nonce]: Date.now() } });
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['key']), res);
      expect(res.statusCode).toBe(404);
      expect(mockWrite).not.toHaveBeenCalled();
   });

   it('400s an oversized body without saving anything', async () => {
      const token = signKeyDropToken('serper');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['x'.repeat(9 * 1024)]), res);
      expect(res.statusCode).toBe(400);
      expect(mockWrite).not.toHaveBeenCalled();
   });

   it('400s an empty body with the paste instruction', async () => {
      const token = signKeyDropToken('serper');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['   \n']), res);
      expect(res.statusCode).toBe(400);
      expect(String(res.payload)).toContain('Ctrl-D');
   });

   it('404s non-POST methods', async () => {
      const getReq = makeConsumeReq(signKeyDropToken('serper'), []);
      (getReq as { method?: string }).method = 'GET';
      const res = makeRes();
      await consumeHandler(getReq, res);
      expect(res.statusCode).toBe(404);
   });

   it('rate-limits a flood from one IP', async () => {
      const ip = '198.51.100.250';
      for (let i = 0; i < 10; i += 1) {
         // eslint-disable-next-line no-await-in-loop
         await consumeHandler(makeConsumeReq(signKeyDropToken('serper'), ['k'], ip), makeRes());
      }
      const blocked = makeRes();
      await consumeHandler(makeConsumeReq(signKeyDropToken('serper'), ['k'], ip), blocked);
      expect(blocked.statusCode).toBe(429);
   });
});
