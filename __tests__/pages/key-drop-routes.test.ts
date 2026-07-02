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

   it('mints a gsc_service_account token with an explicit file-piping one-liner + the Google walkthrough', async () => {
      const res = makeRes();
      await mintHandler(makeMintReq({ secret: 'gsc_service_account' }), res);
      expect(res.statusCode).toBe(200);
      const verified = verifyKeyDropToken(res.payload.token);
      expect(verified).not.toBe(false);
      expect((verified as { secret: string }).secret).toBe('gsc_service_account');
      expect(res.payload.command).toBe(
         `curl -sS -X POST https://s33k.example.com/api/key-drop/${res.payload.token} --data-binary @service-account.json`,
      );
      // The mint response carries the 5-step Google Cloud walkthrough so the LLM can guide the
      // user without web search.
      // Length follows the single-source steps array rather than a pinned number, so wording
      // edits to the walkthrough do not break this test.
      const { GSC_SERVICE_ACCOUNT_SETUP_STEPS } = jest.requireActual('../../utils/keyDrop');
      expect(res.payload.googleCloudSteps).toHaveLength(GSC_SERVICE_ACCOUNT_SETUP_STEPS.length);
      expect(res.payload.googleCloudSteps.join(' ')).toContain('console.cloud.google.com');
      expect(res.payload.googleCloudSteps.join(' ')).toContain('search.google.com/search-console');
      expect(res.payload.instructions).toContain('search.google.com/search-console');
   });

   it('the serper mint carries no Google walkthrough', async () => {
      const res = makeRes();
      await mintHandler(makeMintReq({ secret: 'serper' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.googleCloudSteps).toBeUndefined();
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

   it('serper stripping is intact: internal whitespace is removed, not preserved', async () => {
      const token = signKeyDropToken('serper');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['  my-key\n-with-newline  \n']), res);
      expect(res.statusCode).toBe(200);
      const written = mockWrite.mock.calls[0][0];
      expect(new Cryptr(process.env.SECRET as string).decrypt(written.scaping_api)).toBe('my-key-with-newline');
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

describe('POST /api/key-drop/[nonce] (consume, gsc_service_account kind)', () => {
   // A realistic (fake) Google service-account key file. The PEM's internal newlines are the
   // whole point of the trim-only rule: stripping them would corrupt the key.
   const FAKE_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEfakeLINEone\nMIIEfakeLINEtwo\n-----END PRIVATE KEY-----\n';
   const SA_EMAIL = 's33k-reader@test-project.iam.gserviceaccount.com';
   const saJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      private_key_id: 'abc123',
      private_key: FAKE_PEM,
      client_email: SA_EMAIL,
      client_id: '123456789',
      ...overrides,
   });

   it('stores BOTH fields encrypted (round-trip proven), echoes the client_email, never the key material', async () => {
      mockRead.mockResolvedValue({ some_field: 'kept' });
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, [`${saJson()}\n`]), res);
      expect(res.statusCode).toBe(200);

      const written = mockWrite.mock.calls[0][0];
      expect(written.some_field).toBe('kept');
      // Encrypted at rest, exactly like pages/api/settings.ts stores these fields.
      const cryptr = new Cryptr(process.env.SECRET as string);
      expect(written.search_console_client_email).not.toContain(SA_EMAIL);
      expect(cryptr.decrypt(written.search_console_client_email)).toBe(SA_EMAIL);
      expect(written.search_console_private_key).not.toContain('BEGIN PRIVATE KEY');
      // Trim-only: the PEM's internal newlines survive the drop byte-for-byte.
      expect(cryptr.decrypt(written.search_console_private_key)).toBe(FAKE_PEM);
      // The serper fields are untouched by this kind.
      expect(written.scaping_api).toBeUndefined();
      expect(written.scraper_type).toBeUndefined();
      // Nonce burned durably in the same write.
      const nonce = (verifyKeyDropToken(token) as { nonce: string }).nonce;
      expect(written[KEY_DROP_CONSUMED_FIELD][nonce]).toEqual(expect.any(Number));

      // The confirmation carries the client_email (an identifier the user needs for the Search
      // Console grant) and the grant instruction, and NEVER any private-key material.
      const body = String(res.payload);
      expect(body).toContain(SA_EMAIL);
      expect(body).toContain('search.google.com/search-console');
      expect(body).toContain('get_insight');
      expect(body).not.toContain('BEGIN PRIVATE KEY');
      expect(body).not.toContain('MIIEfakeLINEone');
   });

   it('400s a body that is not JSON, without saving, without echoing the body', async () => {
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['this-is-a-serper-style-paste']), res);
      expect(res.statusCode).toBe(400);
      expect(mockWrite).not.toHaveBeenCalled();
      expect(String(res.payload)).toContain('not valid JSON');
      expect(String(res.payload)).not.toContain('this-is-a-serper-style-paste');
   });

   it('400s JSON whose type is not service_account (e.g. an OAuth client file)', async () => {
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, [saJson({ type: 'authorized_user' })]), res);
      expect(res.statusCode).toBe(400);
      expect(mockWrite).not.toHaveBeenCalled();
      expect(String(res.payload)).toContain('service_account');
   });

   it('400s a missing/invalid client_email', async () => {
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, [saJson({ client_email: 'not-an-email' })]), res);
      expect(res.statusCode).toBe(400);
      expect(mockWrite).not.toHaveBeenCalled();
      expect(String(res.payload)).toContain('client_email');
   });

   it('400s a missing/non-PEM private_key, and never echoes what was sent', async () => {
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, [saJson({ private_key: 'sk-plain-secret-value' })]), res);
      expect(res.statusCode).toBe(400);
      expect(mockWrite).not.toHaveBeenCalled();
      expect(String(res.payload)).toContain('private_key');
      expect(String(res.payload)).not.toContain('sk-plain-secret-value');
   });

   it('400s an oversized body (larger than the raw-body cap)', async () => {
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, ['x'.repeat(9 * 1024)]), res);
      expect(res.statusCode).toBe(400);
      expect(mockWrite).not.toHaveBeenCalled();
   });

   it('accepts a real-sized (~2.4KB) service-account file: the per-kind cap is the body cap, not 512', async () => {
      // Pad the PEM so the whole JSON clears 512 chars by a wide margin (the serper cap would
      // reject this) while staying under the 8KB body cap.
      const bigPem = `-----BEGIN PRIVATE KEY-----\n${'MIIEfakeBODY0123456789\n'.repeat(90)}-----END PRIVATE KEY-----\n`;
      const payload = saJson({ private_key: bigPem });
      expect(payload.length).toBeGreaterThan(2000);
      const token = signKeyDropToken('gsc_service_account');
      const res = makeRes();
      await consumeHandler(makeConsumeReq(token, [payload]), res);
      expect(res.statusCode).toBe(200);
   });

   it('404s a replayed gsc nonce after a successful drop', async () => {
      const token = signKeyDropToken('gsc_service_account');
      const first = makeRes();
      await consumeHandler(makeConsumeReq(token, [saJson()]), first);
      expect(first.statusCode).toBe(200);
      const replay = makeRes();
      await consumeHandler(makeConsumeReq(token, [saJson()]), replay);
      expect(replay.statusCode).toBe(404);
      expect(mockWrite).toHaveBeenCalledTimes(1);
   });
});
