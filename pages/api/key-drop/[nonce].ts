import type { NextApiRequest, NextApiResponse } from 'next';
import Cryptr from 'cryptr';
import { ensureSynced } from '../../../database/database';
import { rateLimit } from '../../../utils/rate-limit';
import { clientIp } from '../../../utils/collect-guards';
import { getStoredSettings, writeStoredSettings } from '../../../utils/settingsStore';
import {
   verifyKeyDropToken, isNonceConsumed, markNonceConsumed, readRawBody, validateServiceAccountJson,
   maxDropKeyLength, MAX_DROP_BODY_BYTES, KEY_DROP_CONSUMED_FIELD,
} from '../../../utils/keyDrop';

// POST /api/key-drop/[nonce]: CONSUME a key drop. The user runs the minted curl one-liner and
// pastes the secret on stdin; this route saves it into the encrypted settings row.
//
// This is a PUBLIC route secured by a SIGNED single-use token, the same pattern as the Search
// Console OAuth callback (CLAUDE.md section B): it cannot require the API key, because the whole
// point is that the caller is a bare curl in the user's terminal, not an MCP client. It is
// deliberately NOT in utils/allowedApiRoutes.ts (that list is the Bearer-key whitelist; this route
// never authorizes by key). Security = HMAC signature (only this server's SECRET can mint), 15
// minute TTL, single-use nonce, per-IP rate limit, and a hintless 404 on any invalid token.
//
// Next's body parser is DISABLED: curl --data-binary defaults the Content-Type to
// application/x-www-form-urlencoded, and letting Next parse the pasted key as a form would mangle
// it into an object key. We read the raw stream ourselves, hard-capped.
export const config = { api: { bodyParser: false } };

// Within-process replay guard, IN ADDITION to the durable consumed-nonce map in the settings row.
// The durable map survives restarts; this Set closes the tiny read-merge-write race window two
// simultaneous requests would have against the row (see utils/keyDrop.ts for the honest tradeoff).
// On globalThis so every server bundle shares the one instance.
const guardKey = '__s33kKeyDropConsumed';
const globalGuard = globalThis as unknown as { [guardKey]?: Set<string> };
const consumedThisProcess = (): Set<string> => {
   if (!globalGuard[guardKey]) { globalGuard[guardKey] = new Set<string>(); }
   return globalGuard[guardKey] as Set<string>;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   res.setHeader('Content-Type', 'text/plain; charset=utf-8');
   if (req.method !== 'POST') { return res.status(404).send('Not Found'); }

   // Per-IP brake BEFORE any crypto or DB work: guessing signed tokens is hopeless anyway, but the
   // brake keeps a flood from buying free HMAC + settings reads.
   const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
   const rl = rateLimit(`key-drop:${ip}`, { limit: 10, windowMs: 15 * 60 * 1000 });
   if (!rl.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
      return res.status(429).send('Too many requests.');
   }

   // Signature + TTL + enum, constant-time. Any failure is the same hintless 404: an invalid,
   // expired, tampered, or replayed link should be indistinguishable from a nonexistent route.
   const verified = verifyKeyDropToken(req.query.nonce);
   if (!verified) { return res.status(404).send('Not Found'); }

   // Single-use: the within-process guard must check AND claim with no await between them, or two
   // same-instant requests would both pass .has() before either recorded the claim and the guard
   // would assert a protection it does not provide. Claim synchronously right after verification,
   // then consult the durable map for replays minted before this process started.
   if (consumedThisProcess().has(verified.nonce)) { return res.status(404).send('Not Found'); }
   consumedThisProcess().add(verified.nonce);
   const stored = await getStoredSettings();
   if (isNonceConsumed(stored, verified.nonce)) { return res.status(404).send('Not Found'); }

   try {
      let raw = '';
      try {
         raw = await readRawBody(req, MAX_DROP_BODY_BYTES);
      } catch {
         return res.status(400).send('Body too large.');
      }

      // PER-KIND payload normalization. 'serper' strips ALL whitespace (stdin paste commonly
      // carries a trailing newline, and a real API key never contains internal whitespace).
      // 'gsc_service_account' only TRIMS: the body is a whole JSON file whose PEM private_key
      // depends on its internal whitespace/newlines, so stripping would corrupt it.
      const key = verified.secret === 'gsc_service_account' ? raw.trim() : raw.replace(/\s+/g, '');
      if (!key) {
         return res.status(400).send(verified.secret === 'gsc_service_account'
            ? 'Empty body. Send the downloaded service-account .json file, e.g. curl ... --data-binary @service-account.json'
            : 'Empty body. Paste the key, press Enter, then Ctrl-D.');
      }
      if (key.length > maxDropKeyLength(verified.secret)) { return res.status(400).send('Key is too long.'); }

      // Save exactly the way pages/api/settings.ts stores its secret fields (cryptr-encrypted into
      // the settings row), and burn the nonce durably in the same write (one row, one update).
      const cryptr = new Cryptr(process.env.SECRET as string);
      const next: Record<string, any> = {
         ...stored,
         [KEY_DROP_CONSUMED_FIELD]: markNonceConsumed(stored, verified.nonce),
      };
      // Set by the gsc branch; echoed in the confirmation. The client_email is an IDENTIFIER (the
      // user must grant it access in Search Console next), never a secret. The private_key and the
      // raw body are never echoed, on any path.
      let confirmation = 'Saved. The SEO module is now enabled. '
         + 'Tell your AI "the key is in" and ask it to refresh your keywords or run start_here.';
      if (verified.secret === 'serper') {
         next.scaping_api = cryptr.encrypt(key);
         next.scraper_type = 'serper';
      }
      if (verified.secret === 'gsc_service_account') {
         // Validate BEFORE storing. All refusals are plain-text reasons for a human at a terminal
         // and never contain the body or the key material. Validation failures do NOT burn the
         // nonce durably (nothing is written), but the within-process guard above has already
         // claimed it; erring toward burned is the safe side for a single-use credential.
         const validated = validateServiceAccountJson(key);
         if (!validated.ok) {
            return res.status(400).send(`${validated.reason} Then ask your AI to mint a fresh drop command and retry (each link is single-use).`);
         }
         next.search_console_client_email = cryptr.encrypt(validated.clientEmail);
         next.search_console_private_key = cryptr.encrypt(validated.privateKey);
         confirmation = `Saved. Search Console credentials are stored for ${validated.clientEmail}. `
            + `One step left, in Google: add ${validated.clientEmail} as a user with Full permission on your property `
            + 'at search.google.com/search-console (Settings > Users and permissions), '
            + 'then ask your AI to run get_insight.';
      }
      await writeStoredSettings(next);

      // Confirmation only. NEVER echo the key/private_key or the raw body back.
      return res.status(200).send(confirmation);
   } catch (error) {
      console.log('[ERROR] Consuming key drop. ', error);
      // The nonce stays burned in-process on a failed save; the durable marker may not have been
      // written. Erring toward burned is the safe side for a single-use credential.
      return res.status(500).send('Error saving the key. Mint a fresh key-drop command and retry.');
   }
}
