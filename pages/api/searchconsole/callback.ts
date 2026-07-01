import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import {
   getGSCOAuthConfig,
   buildGSCRedirectURL,
   buildGSCOAuthClient,
   verifyGSCState,
} from '../../../utils/searchConsoleOAuth';
import { storeSearchConsoleOAuthToken } from '../../../utils/searchConsole';

// GET /api/searchconsole/callback?code=&state=
//
// Google redirects here after the user approves consent. This request carries NO API key and NO
// cookie, so it CANNOT run the normal authorize() account check (the same reason pages/api/adwords.ts
// skips auth on its GET-with-code callback). Security is re-established a different way: the `state`
// returned by Google is the one we SIGNED in /connect with the app SECRET, so verifyGSCState proves
// WE issued it and recovers the bound { domain, ownerId }. The code is then exchanged server-side
// (guarded by the client secret) for a refresh token, which is stored ENCRYPTED on the owned domain
// row, scoped to exactly { domain, owner_id } from the verified state. A forged or tampered state is
// rejected before any token is stored, and because the store is owner-scoped, even a hypothetically
// accepted state could not attach a token to a domain the signer does not own.

const PAGE_STYLE = 'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
   + 'background:#0b0f17;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}'
   + '.card{max-width:520px;text-align:center;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:32px}'
   + 'h1{font-size:20px;margin:0 0 12px}p{font-size:15px;line-height:1.5;color:#9ca3af;margin:0}';

// Escape any value before it is interpolated into the page. Every value rendered here is currently
// server-controlled (the signed-state domain, static strings), so this is defense-in-depth: it keeps
// htmlPage safe-by-construction on this PUBLIC route, so a future edit that passes a raw query param
// (code/state/error) into it cannot become a reflected XSS.
const escapeHtml = (s: string): string => String(s)
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#39;');

const htmlPage = (title: string, body: string): string => {
   const t = escapeHtml(title);
   const b = escapeHtml(body);
   return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<title>${t}</title><style>${PAGE_STYLE}</style></head>`
      + `<body><div class="card"><h1>${t}</h1><p>${b}</p></div></body></html>`;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   res.setHeader('Content-Type', 'text/html; charset=utf-8');

   if (req.method !== 'GET') {
      return res.status(405).send(htmlPage('Unsupported request', 'This endpoint only handles the Google redirect.'));
   }

   const code = req.query.code as string | undefined;
   const state = req.query.state as string | undefined;

   if (!code) {
      const msg = 'Google did not return an authorization code. Please start the connection again.';
      return res.status(400).send(htmlPage('No authorization code', msg));
   }

   // Verify the signed state FIRST. A bad/expired/forged state means we cannot trust which domain or
   // owner this callback is for, so we refuse before touching any credential or row.
   const verified = verifyGSCState(state);
   if (!verified) {
      const msg = 'This connection link could not be verified or has expired. Please start the connection again from s33k.';
      return res.status(400).send(htmlPage('Invalid or expired link', msg));
   }

   const config = getGSCOAuthConfig();
   if (!config) {
      return res.status(400).send(htmlPage('Not configured', 'Google Search Console OAuth is not configured on this instance.'));
   }

   try {
      const redirectURL = buildGSCRedirectURL(req);
      const oAuth2Client = buildGSCOAuthClient(config, redirectURL);
      const { tokens } = await oAuth2Client.getToken(code);
      const refreshToken = tokens?.refresh_token;
      if (!refreshToken) {
         // Google omits the refresh_token when the user already granted access and we did not force
         // a fresh consent. /connect always sets prompt:'consent' + access_type:'offline' to avoid
         // this, but guard anyway and tell the user how to recover.
         const msg = 'Google returned no refresh token. Remove s33k from your Google account permissions, then connect again to re-prompt consent.';
         return res.status(400).send(htmlPage('No refresh token returned', msg));
      }

      // Bind the store to the verified domain AND owner. The owner_id is omitted for the admin /
      // single-tenant / legacy case (ownerId === null), matching how owned rows are stored; a real
      // tenant's token can only ever attach to a row carrying their own owner_id, so a state for a
      // domain they do not own resolves to no row and stores nothing.
      const where: Record<string, unknown> = { domain: verified.domain };
      if (verified.ownerId !== null) { where.owner_id = verified.ownerId; }

      const stored = await storeSearchConsoleOAuthToken(where, refreshToken);
      if (!stored) {
         return res.status(400).send(htmlPage(
            'Could not save connection',
            'We could not find a matching domain to attach this connection to. Please start the connection again from s33k.',
         ));
      }

      return res.status(200).send(htmlPage(
         'Google Search Console connected',
         `Google Search Console is connected for ${verified.domain}. You can close this tab and return to your assistant.`,
      ));
   } catch (err: any) {
      let errorMsg = err?.response?.data?.error || err?.message || 'unknown error';
      if (typeof errorMsg === 'string' && errorMsg.includes('redirect_uri_mismatch')) {
         errorMsg += ' Check that NEXT_PUBLIC_APP_URL matches the authorized redirect URI in your Google OAuth app.';
      }
      console.log('[ERROR] Search Console OAuth callback: ', errorMsg);
      const msg = 'We could not complete the Google Search Console connection. Please start it again from s33k.';
      return res.status(400).send(htmlPage('Connection failed', msg));
   }
}
