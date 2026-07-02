import crypto from 'crypto';
import type { NextApiRequest } from 'next';

/*
 * KEY DROP: enable a secret-gated module (the Serper key for SEO, or a Google Search Console
 * service-account JSON) LATER, from an LLM conversation, WITHOUT the secret ever passing through
 * the chat.
 *
 * The flow: the user's LLM calls the mint_key_drop MCP tool -> POST /api/key-drop (authed) mints a
 * single-use, HMAC-signed, 15-minute drop token and a ready-to-run one-liner:
 *    curl -sS -X POST <base>/api/key-drop/<token> --data-binary @-
 * The user runs it in their own terminal, pastes the key on stdin (so it never lands in shell
 * history or the chat transcript), and hits Ctrl-D. POST /api/key-drop/[nonce] verifies the
 * signature + TTL + single-use and saves the key into the encrypted settings row. The LLM only
 * ever sees the token and a "saved" confirmation, never the key.
 *
 * The signed-token construction mirrors utils/searchConsoleOAuth.ts (the established
 * public-route-secured-by-a-signed-state pattern): base64url(claims).base64url(HMAC-SHA256 keyed
 * by the app SECRET), constant-time verify, tight TTL. The claims carry WHICH secret is being set
 * and a random nonce; they carry no secret themselves.
 */

/** The secrets a drop token can set. Extend the enum as more secret-gated modules appear. */
export const KEY_DROP_SECRETS = ['serper', 'gsc_service_account'] as const;
export type KeyDropSecret = typeof KEY_DROP_SECRETS[number];

/** How long a minted drop token stays valid. Same 15-minute window the GSC OAuth state uses. */
export const KEY_DROP_TTL_MS = 15 * 60 * 1000;

/** Hard cap on the pasted key body AFTER trimming. Serper keys are short; huge input is abuse. */
export const MAX_DROP_KEY_LENGTH = 512;

/** Hard cap on the raw request stream, so an attacker cannot firehose the raw-body reader. */
export const MAX_DROP_BODY_BYTES = 8 * 1024;

/**
 * Per-kind cap on the accepted (trimmed) drop payload. 'serper' keeps the tight 512-char key cap;
 * 'gsc_service_account' is a whole Google service-account JSON file (~2.4KB, with a PEM key
 * inside), so its cap is the raw-body cap itself.
 * @param {KeyDropSecret} secret - The drop kind.
 * @returns {number} The max accepted payload length in characters.
 */
export const maxDropKeyLength = (secret: KeyDropSecret): number => (
   secret === 'gsc_service_account' ? MAX_DROP_BODY_BYTES : MAX_DROP_KEY_LENGTH
);

/**
 * The Google-side walkthrough for getting a service-account JSON, written ONCE here so the mint
 * response and the knowledge layer surface the same steps (an LLM can guide the user without web
 * search). Step 5 happens AFTER the drop, using the client_email the consume route confirms.
 */
export const GSC_SERVICE_ACCOUNT_SETUP_STEPS = [
   '1. Go to console.cloud.google.com and create a project (or select an existing one).',
   '2. Enable the "Google Search Console API" for that project (APIs and Services > Library).',
   '3. Create a service account (IAM and Admin > Service Accounts > Create). No roles are needed.',
   '4. Open the service account > Keys > Add Key > Create new key > JSON, and download the .json file.',
   '5. After you send the file to s33k (the curl command), add the service account\'s email as a user with '
      + 'Full permission on your property at search.google.com/search-console (Settings > Users and permissions).',
] as const;

/** The validated identity fields of a dropped service-account JSON, or the plain-text refusal. */
export type ServiceAccountValidation =
   | { ok: true, clientEmail: string, privateKey: string }
   | { ok: false, reason: string };

/**
 * Validate a dropped Google service-account JSON body BEFORE anything is stored. Pure. Every
 * refusal is a plain-text reason meant for a human at a terminal, and no refusal ever includes
 * the body or any key material (the caller must not echo it either).
 * @param {string} raw - The trimmed request body.
 * @returns {ServiceAccountValidation}
 */
export const validateServiceAccountJson = (raw: string): ServiceAccountValidation => {
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch {
      return {
         ok: false,
         reason: 'The body is not valid JSON. Send the downloaded service-account .json file itself, '
            + 'e.g. curl ... --data-binary @service-account.json',
      };
   }
   if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'The body is not a JSON object. Send the downloaded service-account .json file itself.' };
   }
   const obj = parsed as Record<string, unknown>;
   if (obj.type !== 'service_account') {
      return {
         ok: false,
         reason: 'This JSON is not a service-account key (its "type" is not "service_account"). '
            + 'In Google Cloud, create a key for a SERVICE ACCOUNT (IAM and Admin > Service Accounts), not an OAuth client.',
      };
   }
   const clientEmail = typeof obj.client_email === 'string' ? obj.client_email.trim() : '';
   // Tight character classes on purpose: the email is echoed into the plain-text confirmation, so
   // the permissive [^\s@] classes would let control bytes (e.g. ANSI escapes) reach a terminal.
   if (!clientEmail || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(clientEmail)) {
      return {
         ok: false,
         reason: 'The JSON has no usable "client_email". Download a fresh JSON key for the service account and send that file unmodified.',
      };
   }
   const privateKey = typeof obj.private_key === 'string' ? obj.private_key : '';
   if (!privateKey || !privateKey.includes('BEGIN PRIVATE KEY')) {
      return {
         ok: false,
         reason: 'The JSON has no usable "private_key" (expected a PEM block containing BEGIN PRIVATE KEY). '
            + 'Download a fresh JSON key for the service account and send that file unmodified.',
      };
   }
   return { ok: true, clientEmail, privateKey };
};

type KeyDropClaims = { s: KeyDropSecret, n: string, t: number };

const dropSecret = (): string => {
   const secret = process.env.SECRET;
   if (!secret) { throw new Error('SECRET is not configured; cannot sign key-drop tokens.'); }
   return secret;
};

// base64url helpers (URL-safe: the token travels as a path segment in the curl command).
const toB64Url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const signClaims = (encodedClaims: string): string => toB64Url(
   crypto.createHmac('sha256', dropSecret()).update(encodedClaims).digest(),
);

/**
 * Mint a signed, single-use drop token for the given secret. The random nonce makes each token
 * unique (and is the single-use identity); the timestamp bounds it to KEY_DROP_TTL_MS.
 * @param {KeyDropSecret} secret - Which secret this token is allowed to set.
 * @param {number} [now] - Epoch ms; injectable for deterministic tests.
 * @returns {string} The opaque token: "<payload>.<signature>".
 */
export const signKeyDropToken = (secret: KeyDropSecret, now = Date.now()): string => {
   const claims: KeyDropClaims = { s: secret, n: crypto.randomBytes(16).toString('hex'), t: now };
   const encodedClaims = toB64Url(Buffer.from(JSON.stringify(claims), 'utf-8'));
   return `${encodedClaims}.${signClaims(encodedClaims)}`;
};

export type VerifiedKeyDrop = { secret: KeyDropSecret, nonce: string };

/**
 * Verify a presented drop token: signature (constant-time), claim shape, known secret enum value,
 * and TTL. Returns the bound { secret, nonce } or false on ANY failure (tampered, forged, stale,
 * malformed). Single-use enforcement is the route's job (it needs storage); this stays pure.
 * @param {unknown} token - The presented token (the [nonce] path segment).
 * @param {number} [now] - Epoch ms; injectable for deterministic tests.
 * @returns {false | VerifiedKeyDrop}
 */
export const verifyKeyDropToken = (token: unknown, now = Date.now()): false | VerifiedKeyDrop => {
   if (!token || typeof token !== 'string' || !token.includes('.')) { return false; }
   const dot = token.lastIndexOf('.');
   const encodedClaims = token.slice(0, dot);
   const providedSig = token.slice(dot + 1);
   if (!encodedClaims || !providedSig) { return false; }

   let expectedSig = '';
   try {
      expectedSig = signClaims(encodedClaims);
   } catch {
      return false;
   }
   const a = fromB64Url(providedSig);
   const b = fromB64Url(expectedSig);
   if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { return false; }

   try {
      const claims = JSON.parse(fromB64Url(encodedClaims).toString('utf-8')) as KeyDropClaims;
      if (!claims || typeof claims.n !== 'string' || typeof claims.t !== 'number') { return false; }
      if (!KEY_DROP_SECRETS.includes(claims.s)) { return false; }
      if (now - claims.t > KEY_DROP_TTL_MS || claims.t > now + 60 * 1000) { return false; }
      return { secret: claims.s, nonce: claims.n };
   } catch {
      return false;
   }
};

// --- Single-use (consumed-nonce) bookkeeping, pure over the stored-settings blob. ----------------
//
// Consumed nonces persist in the encrypted settings row under `key_drop_consumed` (nonce -> epoch
// ms), so single-use survives a process RESTART, not just within-process memory. Honest tradeoff:
// the read-merge-write of the settings row is not a serialized transaction, so two byte-identical
// POSTs landing in the same instant could theoretically both pass the consumed check. On this
// single-user, single-process instance that race window is negligible (and the second write would
// only re-save the same key the same way); a Postgres row lock here would be complexity the threat
// does not justify. The map self-prunes: anything older than the token TTL can never verify again,
// so its marker is dead weight and is dropped on each write.

const CONSUMED_FIELD = 'key_drop_consumed';

/**
 * Was this nonce already consumed, per the stored blob?
 * @param {Record<string, any>} stored - The raw stored settings blob.
 * @param {string} nonce - The verified token nonce.
 * @returns {boolean}
 */
export const isNonceConsumed = (stored: Record<string, any>, nonce: string): boolean => {
   const map = stored[CONSUMED_FIELD];
   return Boolean(map && typeof map === 'object' && map[nonce]);
};

/**
 * Return a pruned copy of the consumed-nonce map with `nonce` marked consumed at `now`. Entries
 * older than the token TTL (plus a minute of slack) are dropped: their tokens can never verify
 * again, so keeping them would only grow the settings blob forever.
 * @param {Record<string, any>} stored - The raw stored settings blob.
 * @param {string} nonce - The nonce to mark consumed.
 * @param {number} [now] - Epoch ms; injectable for deterministic tests.
 * @returns {Record<string, number>} The new value for the key_drop_consumed field.
 */
export const markNonceConsumed = (stored: Record<string, any>, nonce: string, now = Date.now()): Record<string, number> => {
   const previous = (stored[CONSUMED_FIELD] && typeof stored[CONSUMED_FIELD] === 'object')
      ? stored[CONSUMED_FIELD] as Record<string, unknown> : {};
   const pruned: Record<string, number> = {};
   Object.entries(previous).forEach(([key, at]) => {
      if (typeof at === 'number' && now - at <= KEY_DROP_TTL_MS + 60 * 1000) { pruned[key] = at; }
   });
   pruned[nonce] = now;
   return pruned;
};

export { CONSUMED_FIELD as KEY_DROP_CONSUMED_FIELD };

/**
 * Read a request's RAW body up to `maxBytes`. Used by the drop route, which disables Next's body
 * parser (curl --data-binary defaults to an urlencoded Content-Type, and letting Next parse the
 * key as a form would mangle it into an object key). Throws 'BODY_TOO_LARGE' the moment the cap
 * is crossed so a firehose is cut off mid-stream, not buffered.
 * @param {NextApiRequest} req - The request whose body parser is disabled.
 * @param {number} maxBytes - The hard cap on accepted bytes.
 * @returns {Promise<string>} The raw utf-8 body.
 */
export const readRawBody = async (req: NextApiRequest, maxBytes: number): Promise<string> => {
   const chunks: Buffer[] = [];
   let total = 0;
   for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) { throw new Error('BODY_TOO_LARGE'); }
      chunks.push(buf);
   }
   return Buffer.concat(chunks).toString('utf-8');
};
