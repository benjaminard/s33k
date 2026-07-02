import type { NextApiRequest, NextApiResponse } from 'next';
import Cryptr from 'cryptr';
import { ensureSynced } from '../../database/database';
import { rateLimit } from '../../utils/rate-limit';
import { clientIp } from '../../utils/collect-guards';
import { isSetupCompleted, markSetupCompleted, verifySetupToken } from '../../utils/setupState';

// POST /api/setup: the write half of the first-run installer (the /setup page posts here).
//
// AUTH MODEL: this is a TOKEN-AUTHED PUBLIC ROUTE, the same pattern as the Search Console OAuth
// callback (see CLAUDE.md section B): it cannot run authorize()/verifyUser because at first run
// there is no session and the caller is a browser, not an API-key client. Security comes from the
// one-time boot token instead: it is >= 32 bytes of entropy, printed only to the server log,
// verified with a constant-time compare, and dead forever once setup completes. The route is
// deliberately NOT in utils/allowedApiRoutes.ts (that list whitelists Bearer-API-key routes;
// whitelisting a route the key never authorizes would be cargo-culting, exactly like the GSC
// callback note says).
//
// CSRF: no cookie is read or trusted anywhere in this handler; the ONLY credential is the token,
// which must arrive in the JSON/form body (or the x-setup-token header), so a cross-site request
// cannot ride an ambient credential. Content-Type is restricted to application/json or
// application/x-www-form-urlencoded, both of which Next's body parser handles, and anything else
// is rejected before the body is looked at.
//
// WRITE-ONLY: the response never contains any stored secret (not the submitted key, not any
// existing settings). It only confirms completion.

type SetupResponse = { completed?: boolean, seoConfigured?: boolean, error?: string };

// Hard cap on a pasted key. Serper keys are short; anything huge is garbage or abuse.
const MAX_KEY_LENGTH = 512;

const isAllowedContentType = (req: NextApiRequest): boolean => {
   const raw = String(req.headers['content-type'] || '').toLowerCase();
   return raw.startsWith('application/json') || raw.startsWith('application/x-www-form-urlencoded');
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<SetupResponse>) {
   await ensureSynced();
   if (req.method !== 'POST') { return res.status(404).json({ error: 'Not Found' }); }

   // Brake token guessing BEFORE any token work. Per-IP, cheap, in-memory (single-user instance,
   // one process, same limiter every public route here uses).
   const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
   const rl = rateLimit(`setup:${ip}`, { limit: 10, windowMs: 15 * 60 * 1000 });
   if (!rl.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many requests.' });
   }

   // Once setup has completed, this route is gone forever: a plain 404 with no hints, so the
   // endpoint's continued existence leaks nothing about the instance. Checked BEFORE the
   // Content-Type reject so a completed instance answers 404 to every shape of request.
   if (await isSetupCompleted()) { return res.status(404).json({ error: 'Not Found' }); }

   if (!isAllowedContentType(req)) {
      return res.status(415).json({ error: 'Content-Type must be application/json or application/x-www-form-urlencoded.' });
   }

   // The token must be presented explicitly (body field or header, never a cookie). Wrong or
   // missing token = the same hintless 404 as the completed state.
   const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
   const presented = typeof body.token === 'string' ? body.token : String(req.headers['x-setup-token'] || '');
   if (!verifySetupToken(presented)) { return res.status(404).json({ error: 'Not Found' }); }

   try {
      const rawKey = typeof body.serper_key === 'string' ? body.serper_key.trim() : '';
      if (rawKey.length > MAX_KEY_LENGTH) {
         return res.status(400).json({ error: 'Key is too long.' });
      }
      // The Serper key is OPTIONAL: skipping still completes setup (SEO stays an off module the
      // user can enable later from their LLM via mint_key_drop). When provided, store it exactly
      // the way pages/api/settings.ts does: cryptr-encrypted scaping_api + scraper_type 'serper'.
      const extra: Record<string, any> = {};
      if (rawKey) {
         const cryptr = new Cryptr(process.env.SECRET as string);
         extra.scaping_api = cryptr.encrypt(rawKey);
         extra.scraper_type = 'serper';
      }
      await markSetupCompleted(extra);
      return res.status(200).json({ completed: true, seoConfigured: Boolean(rawKey) });
   } catch (error) {
      console.log('[ERROR] Completing first-run setup. ', error);
      return res.status(500).json({ error: 'Error completing setup.' });
   }
}
