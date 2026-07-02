import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import authorize from '../../../utils/authorize';
import {
   KEY_DROP_SECRETS, KeyDropSecret, signKeyDropToken, KEY_DROP_TTL_MS, GSC_SERVICE_ACCOUNT_SETUP_STEPS,
} from '../../../utils/keyDrop';
import { publicBaseUrlHeaderFree } from '../../../utils/setupState';

// POST /api/key-drop: MINT a single-use key-drop token + the ready-to-run one-liner.
//
// This is the AUTHED half of the key-drop flow (the mint_key_drop MCP tool calls it), so it goes
// through authorize() and IS whitelisted in utils/allowedApiRoutes.ts like every other Bearer-key
// route. The public half is POST /api/key-drop/[nonce], secured by the signed token instead.
//
// The command's base URL is HEADER-FREE on purpose (CLAUDE.md section D): the user will paste a
// SECRET to that URL, so deriving it from a forgeable Host / X-Forwarded-Host header would be a
// key-exfiltration primitive. publicBaseUrlHeaderFree reads NEXT_PUBLIC_APP_URL (which production
// boots are guaranteed to have, entrypoint.sh enforces it) and falls back to localhost only for
// local dev.
//
// WRITE-NOTHING, LEAK-NOTHING: minting stores nothing and the response carries no stored secret,
// only the signed token (which itself contains no secret) and instructions.

type MintResponse = {
   secret?: KeyDropSecret,
   token?: string,
   url?: string,
   command?: string,
   expiresInMinutes?: number,
   instructions?: string,
   /** gsc_service_account only: the Google-side walkthrough, so an LLM can guide the user without web search. */
   googleCloudSteps?: string[],
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<MintResponse>) {
   await ensureSynced();
   const { authorized, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed. Use POST.' }); }

   const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
   const requested = typeof body.secret === 'string' ? body.secret : 'serper';
   if (!(KEY_DROP_SECRETS as readonly string[]).includes(requested)) {
      return res.status(400).json({ error: `Unknown secret "${requested}". Supported: ${KEY_DROP_SECRETS.join(', ')}.` });
   }
   const secret = requested as KeyDropSecret;

   try {
      const token = signKeyDropToken(secret);
      const url = `${publicBaseUrlHeaderFree()}/api/key-drop/${token}`;
      // Per-kind delivery: a Serper key is short enough to paste on stdin; a service-account
      // credential is a downloaded JSON FILE, so the one-liner pipes the file explicitly.
      const command = secret === 'gsc_service_account'
         ? `curl -sS -X POST ${url} --data-binary @service-account.json`
         : `curl -sS -X POST ${url} --data-binary @-`;
      const instructions = secret === 'gsc_service_account'
         ? 'Run the command in your own terminal, in the folder holding the service-account JSON you downloaded from '
            + 'Google Cloud (rename the file or edit the @filename part to match). The file goes straight from your '
            + 'terminal to your s33k server: it never passes through this chat. The link is single-use and expires in '
            + '15 minutes. The server response confirms the service-account email; add that email as a user with Full '
            + 'permission on your property at search.google.com/search-console, then ask for get_insight.'
         : 'Run the command in your own terminal, paste the key, press Enter, then Ctrl-D. '
            + 'The key goes straight from your terminal to your s33k server: it never passes through this chat '
            + 'and never lands in shell history. The link is single-use and expires in 15 minutes.';
      return res.status(200).json({
         secret,
         token,
         url,
         command,
         expiresInMinutes: Math.round(KEY_DROP_TTL_MS / 60000),
         instructions,
         // The Google-side walkthrough rides along for the gsc kind so the LLM can guide the user
         // step by step (the steps live ONCE in utils/keyDrop.ts, shared with the knowledge layer).
         ...(secret === 'gsc_service_account' ? { googleCloudSteps: [...GSC_SERVICE_ACCOUNT_SETUP_STEPS] } : {}),
         error: null,
      });
   } catch (error2) {
      console.log('[ERROR] Minting key-drop token. ', error2);
      return res.status(500).json({ error: 'Error minting key-drop token.' });
   }
}
