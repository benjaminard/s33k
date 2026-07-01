import crypto from 'crypto';
import type { NextApiRequest } from 'next';
import { OAuth2Client } from 'google-auth-library';
import getConfig from 'next/config';

// Google Search Console OAuth helpers for s33k.
//
// This is the click-to-authorize alternative to pasting a service-account JSON. A domain owner
// clicks a Google consent link, approves read-only Search Console access, and Google redirects
// back to /api/searchconsole/callback with an authorization code. We exchange that code for a
// REFRESH token (long-lived) and store it encrypted on the owned Domain's search_console blob.
// utils/searchConsole.ts then mints short-lived access tokens from that refresh token to call
// the Search Console API, returning the same real query/page/country/device ranking data the
// service-account path returns. The service-account path stays as the fallback (back-compat).
//
// Security model (why two of these helpers exist):
//  - The /api/searchconsole/callback route is hit by GOOGLE's redirect. It carries no API key
//    and no cookie, so it cannot run the normal authorize() account check (mirrors how
//    pages/api/adwords.ts skips auth for its GET-with-code callback). To make the callback safe
//    we bind the whole flow to a SIGNED state: /connect signs a compact state with the app
//    SECRET that encodes the owned domain and the owner account id; /callback re-verifies that
//    signature before trusting either value. A forged or tampered state is rejected, so an
//    attacker cannot drive the callback to attach a token to a domain they do not own.
//  - The state is signed, NOT encrypted, and carries no secret. The domain name and a numeric
//    account id are not sensitive; the only thing that matters is that WE issued the state, which
//    the HMAC proves. The refresh token (the actual secret) never appears in the state, only in
//    the encrypted Domain blob after the code exchange.

// The single read-only Search Console OAuth scope. Identical to the service-account scope, so a
// connected OAuth token can read exactly what the service-account path could, and no more.
export const GSC_OAUTH_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// How long a signed connect-state stays valid. The state is a short-lived, one-trip credential
// for the consent round trip, so a tight window limits any replay surface without inconveniencing
// a real user, who completes the Google consent screen in under a minute or two.
const STATE_TTL_MS = 15 * 60 * 1000;

export type GSCOAuthConfig = { clientId: string, clientSecret: string };

// Reads the GSC OAuth client id/secret from the environment. Returns false when either is unset,
// so the connect endpoint can respond with a friendly "not configured on this instance" message
// instead of constructing a broken OAuth2Client. Secrets come from process.env only.
export const getGSCOAuthConfig = (): false | GSCOAuthConfig => {
   const clientId = process.env.GSC_OAUTH_CLIENT_ID || '';
   const clientSecret = process.env.GSC_OAUTH_CLIENT_SECRET || '';
   if (!clientId || !clientSecret) { return false; }
   return { clientId, clientSecret };
};

// Builds the OAuth redirect URI the same robust way pages/api/adwords.ts builds its redirect:
// prefer NEXT_PUBLIC_APP_URL (read from serverRuntimeConfig so Next does not inline it at build
// time and it stays correct behind reverse proxies), then fall back to X-Forwarded-* headers,
// then req.headers.host. The path is /api/searchconsole/callback. The connect and callback routes
// MUST agree on this exact value, or Google rejects the exchange with redirect_uri_mismatch.
export const buildGSCRedirectURL = (req: NextApiRequest): string => {
   const { serverRuntimeConfig } = getConfig() || {};
   const appURL: string = serverRuntimeConfig?.appURL || '';
   if (appURL) {
      return `${appURL.replace(/\/$/, '')}/api/searchconsole/callback`;
   }
   // No configured app URL: derive from request headers. This is a dev convenience. In production
   // NEXT_PUBLIC_APP_URL MUST be set, because deriving an OAuth redirect from attacker-controllable
   // headers is a security-relevant misconfiguration. Warn loudly so it is never silent (Google's
   // exact-match redirect allowlist still fails a poisoned URI closed, so this cannot leak the code).
   if (process.env.NODE_ENV === 'production') {
      console.warn('[GSC OAuth] NEXT_PUBLIC_APP_URL is unset in production; deriving the redirect URI from request headers. Set it.');
   }
   const fwdProto = req.headers['x-forwarded-proto'] as string | undefined;
   const fwdHost = req.headers['x-forwarded-host'] as string | undefined;
   const proto = fwdProto || (req.headers.host?.includes('localhost:') ? 'http' : 'https');
   const host = fwdHost || req.headers.host;
   return `${proto}://${host}/api/searchconsole/callback`;
};

// Constructs the OAuth2Client used by both routes (consent-URL generation on /connect, code
// exchange on /callback). Same library (google-auth-library) the adwords path already uses.
export const buildGSCOAuthClient = (config: GSCOAuthConfig, redirectURL: string): OAuth2Client => (
   new OAuth2Client(config.clientId, config.clientSecret, redirectURL)
);

export type GSCStatePayload = { domain: string, ownerId: number | null };

// The compact, signed state we hand to Google and verify on the way back. `n` is a random nonce,
// `t` is the issue timestamp (ms). The signature covers all of d/o/n/t so none can be altered.
type GSCStateClaims = { d: string, o: number | null, n: string, t: number };

const stateSecret = (): string => {
   const secret = process.env.SECRET;
   if (!secret) { throw new Error('SECRET is not configured; cannot sign Search Console OAuth state.'); }
   return secret;
};

// base64url helpers (no '+', '/', or '=' so the value is URL-safe inside the Google consent URL).
const toB64Url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// HMAC-SHA256 of the encoded claims, keyed by the app SECRET. This is what proves WE issued the
// state. Returned as base64url so the whole state is one URL-safe token: "<payload>.<signature>".
const signClaims = (encodedClaims: string): string => toB64Url(
   crypto.createHmac('sha256', stateSecret()).update(encodedClaims).digest(),
);

// Signs a connect-state binding the flow to a specific owned domain + owner account. Called by
// /connect; the resulting opaque token travels to Google and back and is verified by /callback.
export const signGSCState = (payload: GSCStatePayload): string => {
   const claims: GSCStateClaims = {
      d: payload.domain,
      o: payload.ownerId,
      n: crypto.randomBytes(12).toString('hex'),
      t: Date.now(),
   };
   const encodedClaims = toB64Url(Buffer.from(JSON.stringify(claims), 'utf-8'));
   return `${encodedClaims}.${signClaims(encodedClaims)}`;
};

// Verifies a state returned by Google. Returns the bound { domain, ownerId } only when the
// signature is valid AND the state has not expired; returns false otherwise. The signature check
// uses a constant-time compare to avoid leaking validity through timing. A false return MUST be
// treated by the callback as a hard reject (do not store any token), since it means the state was
// tampered with, forged, or is stale.
export const verifyGSCState = (state: string | undefined | null): false | GSCStatePayload => {
   if (!state || typeof state !== 'string' || !state.includes('.')) { return false; }
   const dot = state.lastIndexOf('.');
   const encodedClaims = state.slice(0, dot);
   const providedSig = state.slice(dot + 1);
   if (!encodedClaims || !providedSig) { return false; }

   let expectedSig = '';
   try {
      expectedSig = signClaims(encodedClaims);
   } catch {
      return false;
   }
   const a = fromB64Url(providedSig);
   const b = fromB64Url(expectedSig);
   // Length-guard before timingSafeEqual (it throws on unequal-length buffers), then constant-time.
   if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { return false; }

   try {
      const claims = JSON.parse(fromB64Url(encodedClaims).toString('utf-8')) as GSCStateClaims;
      if (!claims || typeof claims.d !== 'string' || typeof claims.t !== 'number') { return false; }
      if (Date.now() - claims.t > STATE_TTL_MS) { return false; }
      const ownerId = typeof claims.o === 'number' ? claims.o : null;
      return { domain: claims.d, ownerId };
   } catch {
      return false;
   }
};
