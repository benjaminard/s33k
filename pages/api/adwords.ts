import type { NextApiRequest, NextApiResponse } from 'next';
import { OAuth2Client } from 'google-auth-library';
import Cryptr from 'cryptr';
import getConfig from 'next/config';
import { ensureSynced } from '../../database/database';
import verifyUser from '../../utils/verifyUser';
import { getAdwordsCredentials, getAdwordsKeywordIdeas } from '../../utils/adwords';
import { getStoredSettings, writeStoredSettings } from '../../utils/settingsStore';

type adwordsValidateResp = {
   valid: boolean
   error?: string|null,
}

// LEGACY PUBLIC OAUTH CALLBACK, kept admin-only on purpose (audit A12).
//
// Google redirects back here with ?code and no cookie/API key, so the callback cannot go through
// verifyUser. The newer Search Console flow solves this with a SIGNED state that binds the callback
// to a specific { domain, owner_id } (see utils/searchConsoleOAuth.ts). We deliberately do NOT apply
// that pattern to Google Ads, because the Google Ads flow has nothing tenant-sensitive to bind:
//
//   1. NO server-issued consent URL to stamp. The Google consent link is built by the CALLER (the
//      old web UI built it client-side before the headless phase deleted it; an operator now builds
//      it by hand or via their LLM), not by a server /connect route. There is no server point that
//      issues the consent URL where a signed state could be generated.
//   2. NO per-domain / per-owner target. Google Ads is a SINGLE GLOBAL ADMIN integration: one app-wide
//      client_id / client_secret / refresh_token stored in the global Postgres `setting` row (was
//      data/settings.json), not on any owned Domain row. The GSC signed state exists precisely to stop
//      a forged callback attaching
//      a token to a domain you do not own; Google Ads has no per-domain target, so a signed state would
//      protect nothing here.
//   3. It is already admin-only and lower-risk: the settings reads/writes around it go through
//      verifyUser (the single APIKEY Bearer key, this instance's only credential), and it only ever
//      touches GLOBAL admin credentials.
//
// If Google Ads ever becomes a per-domain/per-owner integration (credentials stored on an owned row),
// move the consent-URL generation to a server /connect route, adopt the searchConsoleOAuth signed-state
// helpers, and migrate this route to authorize() with owner-scoped storage first.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   if (req.method === 'GET' && req.query.code) {
      return getAdwordsRefreshToken(req, res);
   }
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method === 'GET') {
      return getAdwordsRefreshToken(req, res);
   }
   if (req.method === 'POST') {
      return validateAdwordsIntegration(req, res);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const getAdwordsRefreshToken = async (req: NextApiRequest, res: NextApiResponse<string>) => {
   try {
      const code = (req.query.code as string);
      // Build redirect URL using NEXT_PUBLIC_APP_URL (most reliable behind reverse proxies),
      // falling back to X-Forwarded-* headers, then req.headers.host.
      // Read from serverRuntimeConfig to prevent Next.js from inlining the env var at build time.
      const { serverRuntimeConfig } = getConfig() || {};
      const appURL: string = serverRuntimeConfig?.appURL || '';
      let redirectURL = '';
      if (appURL) {
         redirectURL = `${appURL.replace(/\/$/, '')}/api/adwords`;
      } else {
         const fwdProto = req.headers['x-forwarded-proto'] as string | undefined;
         const fwdHost = req.headers['x-forwarded-host'] as string | undefined;
         const proto = fwdProto || (req.headers.host?.includes('localhost:') ? 'http' : 'https');
         const host = fwdHost || req.headers.host;
         redirectURL = `${proto}://${host}/api/adwords`;
      }

      if (code) {
         try {
            // Settings now live in the global Postgres `setting` row (was data/settings.json); the
            // adwords_* fields are cryptr-encrypted. Read the blob, exchange the code, and write back.
            const settings = await getStoredSettings();
            const cryptr = new Cryptr(process.env.SECRET as string);
            const adwords_client_id = settings.adwords_client_id ? cryptr.decrypt(settings.adwords_client_id) : '';
            const adwords_client_secret = settings.adwords_client_secret ? cryptr.decrypt(settings.adwords_client_secret) : '';
            const oAuth2Client = new OAuth2Client(adwords_client_id, adwords_client_secret, redirectURL);
            const r = await oAuth2Client.getToken(code);
            if (r?.tokens?.refresh_token) {
               const adwords_refresh_token = cryptr.encrypt(r.tokens.refresh_token);
               await writeStoredSettings({ ...settings, adwords_refresh_token });
               return res.status(200).send('Google Ads Integrated Successfully! You can close this window.');
            }
            return res.status(400).send('Error Getting the Google Ads Refresh Token. Please Try Again!');
         } catch (error:any) {
            // Guard the .includes (audit area 4): error?.response?.data?.error is undefined for a
            // non-axios error, so calling .includes on it threw a TypeError (swallowed by the outer
            // catch, but still wrong). Type-check first. And do NOT reflect Google's raw error string
            // or the computed redirectURL back to the caller on this PUBLIC callback route: log the
            // detail server-side, return a generic message (mirroring searchconsole/callback.ts).
            const errorMsg = error?.response?.data?.error;
            const detail = (typeof errorMsg === 'string' && errorMsg.includes('redirect_uri_mismatch'))
               ? `${errorMsg} Redirected URL: ${redirectURL}`
               : errorMsg;
            console.log('[Error] Getting Google Ads Refresh Token! Reason: ', detail);
            return res.status(400).send('Error Saving the Google Ads Refresh Token. Please Try Again!');
         }
      } else {
         return res.status(400).send('No Code Provided By Google. Please Try Again!');
      }
   } catch (error) {
      console.log('[ERROR] Getting Google Ads Refresh Token: ', error);
      return res.status(400).send('Error Getting Google Ads Refresh Token. Please Try Again!');
   }
};

const validateAdwordsIntegration = async (req: NextApiRequest, res: NextApiResponse<adwordsValidateResp>) => {
   const errMsg = 'Error Validating Google Ads Integration. Please make sure your provided data are correct!';
   const { developer_token, account_id } = req.body;
   if (!developer_token || !account_id) {
      return res.status(400).json({ valid: false, error: 'Please Provide the Google Ads Developer Token and Test Account ID' });
   }
   try {
      // Save the Adwords Developer Token & Google Ads Test Account ID in App Settings (the global
      // Postgres `setting` row, was data/settings.json). The values are cryptr-encrypted before write.
      const settings = await getStoredSettings();
      const cryptr = new Cryptr(process.env.SECRET as string);
      const adwords_developer_token = cryptr.encrypt(developer_token.trim());
      const adwords_account_id = cryptr.encrypt(account_id.trim());
      const securedSettings = { ...settings, adwords_developer_token, adwords_account_id };
      await writeStoredSettings(securedSettings);

      // Make a test Request to Google Ads
      const adwordsCreds = await getAdwordsCredentials();
      const { client_id, client_secret, refresh_token } = adwordsCreds || {};
      if (adwordsCreds && client_id && client_secret && developer_token && account_id && refresh_token) {
         const keywords = await getAdwordsKeywordIdeas(
            adwordsCreds,
            { country: 'US', language: '1000', keywords: ['compress'], seedType: 'custom' },
             true,
         );
         if (keywords && Array.isArray(keywords) && keywords.length > 0) {
            return res.status(200).json({ valid: true });
         }
      }
      return res.status(400).json({ valid: false, error: errMsg });
   } catch (error) {
      console.log('[ERROR] Validating Google Ads Integration: ', error);
      return res.status(400).json({ valid: false, error: errMsg });
   }
};
