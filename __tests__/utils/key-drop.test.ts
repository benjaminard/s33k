/**
 * utils/keyDrop: the signed, single-use drop-token layer behind mint_key_drop and
 * POST /api/key-drop/[nonce].
 *
 * The whole point of the key drop is that a secret can be set from a conversation without ever
 * passing through the chat, so the token layer must be airtight: HMAC signature (constant-time),
 * tight TTL, unknown-secret rejection, and pure single-use bookkeeping that prunes itself.
 * Mirrors the searchConsoleOAuth signed-state suite in spirit.
 */
import { Readable } from 'stream';
import type { NextApiRequest } from 'next';
import {
   signKeyDropToken, verifyKeyDropToken, isNonceConsumed, markNonceConsumed, readRawBody,
   KEY_DROP_TTL_MS, KEY_DROP_CONSUMED_FIELD,
} from '../../utils/keyDrop';

const savedSecret = process.env.SECRET;
beforeAll(() => { process.env.SECRET = 'test-secret-for-key-drop-signing'; });
afterAll(() => {
   if (savedSecret === undefined) { delete process.env.SECRET; } else { process.env.SECRET = savedSecret; }
});

describe('signKeyDropToken / verifyKeyDropToken', () => {
   it('round-trips a fresh token to its secret + nonce', () => {
      const token = signKeyDropToken('serper');
      const verified = verifyKeyDropToken(token);
      expect(verified).not.toBe(false);
      expect((verified as { secret: string }).secret).toBe('serper');
      expect((verified as { nonce: string }).nonce).toMatch(/^[0-9a-f]{32}$/);
   });

   it('every mint is unique (the nonce IS the single-use identity)', () => {
      const a = verifyKeyDropToken(signKeyDropToken('serper'));
      const b = verifyKeyDropToken(signKeyDropToken('serper'));
      expect((a as { nonce: string }).nonce).not.toBe((b as { nonce: string }).nonce);
   });

   it('rejects a tampered signature', () => {
      const token = signKeyDropToken('serper');
      const flipped = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
      expect(verifyKeyDropToken(flipped)).toBe(false);
   });

   it('rejects tampered claims (payload swapped under the same signature)', () => {
      const token = signKeyDropToken('serper');
      const sig = token.slice(token.lastIndexOf('.') + 1);
      const forgedClaims = Buffer.from(JSON.stringify({ s: 'serper', n: 'attacker', t: Date.now() }))
         .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(verifyKeyDropToken(`${forgedClaims}.${sig}`)).toBe(false);
   });

   it('rejects an expired token (past the 15-minute TTL)', () => {
      const mintedAt = Date.now();
      const token = signKeyDropToken('serper', mintedAt);
      expect(verifyKeyDropToken(token, mintedAt + KEY_DROP_TTL_MS + 1000)).toBe(false);
      expect(verifyKeyDropToken(token, mintedAt + KEY_DROP_TTL_MS - 1000)).not.toBe(false);
   });

   it('rejects a token minted suspiciously far in the future', () => {
      const now = Date.now();
      const token = signKeyDropToken('serper', now + 10 * 60 * 1000);
      expect(verifyKeyDropToken(token, now)).toBe(false);
   });

   it('rejects garbage shapes without throwing', () => {
      expect(verifyKeyDropToken(undefined)).toBe(false);
      expect(verifyKeyDropToken('')).toBe(false);
      expect(verifyKeyDropToken('no-dot-here')).toBe(false);
      expect(verifyKeyDropToken('..')).toBe(false);
      expect(verifyKeyDropToken(['array'] as unknown as string)).toBe(false);
   });
});

describe('single-use bookkeeping (isNonceConsumed / markNonceConsumed)', () => {
   it('marks a nonce consumed and detects it', () => {
      const stored: Record<string, unknown> = {};
      const map = markNonceConsumed(stored, 'nonce-1', 1000);
      expect(isNonceConsumed({ [KEY_DROP_CONSUMED_FIELD]: map }, 'nonce-1')).toBe(true);
      expect(isNonceConsumed({ [KEY_DROP_CONSUMED_FIELD]: map }, 'nonce-2')).toBe(false);
      expect(isNonceConsumed({}, 'nonce-1')).toBe(false);
   });

   it('prunes markers older than the TTL (their tokens can never verify again)', () => {
      const now = Date.now();
      const stale = now - KEY_DROP_TTL_MS - 2 * 60 * 1000;
      const stored = { [KEY_DROP_CONSUMED_FIELD]: { 'old-nonce': stale, 'recent-nonce': now - 1000 } };
      const map = markNonceConsumed(stored, 'new-nonce', now);
      expect(map['old-nonce']).toBeUndefined();
      expect(map['recent-nonce']).toBe(now - 1000);
      expect(map['new-nonce']).toBe(now);
   });
});

describe('readRawBody', () => {
   const asReq = (chunks: (string | Buffer)[]): NextApiRequest => (
      Readable.from(chunks) as unknown as NextApiRequest
   );

   it('reads a small raw body', async () => {
      await expect(readRawBody(asReq(['my-serper-key\n']), 1024)).resolves.toBe('my-serper-key\n');
   });

   it('throws BODY_TOO_LARGE the moment the cap is crossed', async () => {
      const big = 'x'.repeat(4096);
      await expect(readRawBody(asReq([big, big]), 4096)).rejects.toThrow('BODY_TOO_LARGE');
   });
});
