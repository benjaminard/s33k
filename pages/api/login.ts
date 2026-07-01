import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Cookies from 'cookies';
import { rateLimit } from '../../utils/rate-limit';
import { clientIp } from '../../utils/collect-guards';

// Per-IP brute-force brake on the admin login (audit area 3, MEDIUM). Auth is a single shared
// password, so an unthrottled login is the whole keys-to-the-kingdom under a guessing attack.
// Defaults: 10 attempts per minute per IP, overridable via env. The IP comes from the shared,
// spoof-resistant trusted-edge derivation (collect-guards.clientIp).
const LOGIN_RATE_LIMIT = (() => {
   const raw = parseInt(process.env.LOGIN_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();
const LOGIN_RATE_WINDOW_MS = (() => {
   const raw = parseInt(process.env.LOGIN_RATE_WINDOW_MS || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
})();

// Constant-time string equality (audit area 3, low). A plain === on the shared admin password
// short-circuits on the first differing byte, leaking length/prefix timing. timingSafeEqual needs
// equal-length buffers, so a length mismatch returns false up front (length is not itself secret
// for a high-entropy secret, and a single shared password is what this guards).
const safeEqual = (a: string | undefined, b: string | undefined): boolean => {
   if (typeof a !== 'string' || typeof b !== 'string') { return false; }
   const ab = Buffer.from(a);
   const bb = Buffer.from(b);
   if (ab.length !== bb.length) { return false; }
   return crypto.timingSafeEqual(ab, bb);
};

type loginResponse = {
   success?: boolean
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   if (req.method === 'POST') {
      return loginUser(req, res);
   }
   return res.status(401).json({ success: false, error: 'Invalid Method' });
}

// Known SerpBear/s33k demo + placeholder values that must never run a public instance.
//
// SECURITY (audit area 3, CRITICAL): the guard previously only listed the upstream SerpBear demo
// values, but THIS repo's own .env.example ships DIFFERENT placeholders. An operator who copies
// .env.example and only changes the line that obviously says "change me" would boot production with
// a publicly-known SECRET (forge any session + decrypt every stored credential) and APIKEY (full
// admin). So the repo's own example placeholders are listed below too. Belt-and-suspenders, a
// POSITIVE entropy/length floor (isWeakSecret) rejects any future example value that slips in.
const DEMO_SECRETS = [
   '4715aed3216f7b0a38e6b534a958362654e96d10fbc04700770d572af3dce43625dd',
   'replace-with-openssl-rand-hex-34',
];
const DEMO_APIKEYS = [
   '5saedXklbslhnapihe2pihp3pih4fdnakhjwq5',
   'replace-with-openssl-rand-hex-24',
];
const DEMO_PASSWORDS = [
   '0123456789',
   'change-me-please',
   'change-me-to-a-strong-password',
];
const isPlaceholder = (value?: string): boolean => !!value && value.startsWith('REGENERATE_ME');

// Positive-format floors so a weak/short secret can never authenticate a production instance, even
// if it is not one of the literal denylisted placeholders. A real SECRET is `openssl rand -hex 34`
// (68 hex chars) and a real APIKEY is `openssl rand -hex 24` (48 hex chars); requiring a generous
// minimum length catches truncated, hand-typed, or example-derived weak values. Length-only on
// purpose: it must never reject a legitimately-random strong secret.
const MIN_SECRET_LEN = 40;
const MIN_APIKEY_LEN = 32;
const isShort = (value: string | undefined, min: number): boolean => !value || value.length < min;

const loginUser = async (req: NextApiRequest, res: NextApiResponse<loginResponse>) => {
   // Brute-force brake FIRST, before any compare, so a guessing flood is rejected cheaply.
   const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
   const rl = rateLimit(`login:${ip}`, { limit: LOGIN_RATE_LIMIT, windowMs: LOGIN_RATE_WINDOW_MS });
   if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please slow down.' });
   }

   if (!req.body.username || !req.body.password) {
      return res.status(401).json({ error: 'Username Password Missing' });
   }

   // Production safety: refuse to authenticate when the instance is still
   // configured with the public demo / placeholder credentials. Defends against
   // running `node server.js` directly (bypassing entrypoint.sh). Dev is unchanged.
   if (process.env.NODE_ENV === 'production') {
      const usingDemoCreds = DEMO_SECRETS.includes(process.env.SECRET || '')
         || isPlaceholder(process.env.SECRET)
         || isShort(process.env.SECRET, MIN_SECRET_LEN)
         || DEMO_APIKEYS.includes(process.env.APIKEY || '')
         || isPlaceholder(process.env.APIKEY)
         || isShort(process.env.APIKEY, MIN_APIKEY_LEN)
         || DEMO_PASSWORDS.includes(process.env.PASSWORD || '')
         || isPlaceholder(process.env.PASSWORD);
      if (usingDemoCreds) {
         console.error('[SECURITY] Login blocked: instance is using demo/placeholder credentials.'
            + ' Set strong SECRET, APIKEY, and PASSWORD (see DEPLOY.md).');
         return res.status(403).json({ error: 'Server is misconfigured with demo credentials. Set strong SECRET, APIKEY, and PASSWORD.' });
      }
   }

   const userName = process.env.USER_NAME ? process.env.USER_NAME : process.env.USER;

   if (req.body.username === userName
      && safeEqual(req.body.password, process.env.PASSWORD) && process.env.SECRET) {
      // SECURITY (audit area 3, session cluster). Three fixes here:
      //   1. Sign the JWT WITH an explicit expiry, so a stolen token does not stay valid forever
      //      and jwt.verify (in verifyUser / resolveAccount) will reject it once exp passes.
      //   2. Set the cookie maxAge to a RELATIVE duration in milliseconds. The old code passed
      //      expireDate.getTime() (an ABSOLUTE epoch ~1.78e12 ms), but the cookies lib treats
      //      maxAge as ms-from-now, so the cookie was pinned ~56,000 years out and SESSION_DURATION
      //      did nothing. Now the cookie and the JWT expire together after SESSION_DURATION hours.
      //   3. Mark the cookie Secure in production so it is never sent over plaintext HTTP.
      const sessHours = (process.env.SESSION_DURATION && parseInt(process.env.SESSION_DURATION, 10)) || 24;
      const token = jwt.sign({ user: userName }, process.env.SECRET, { expiresIn: `${sessHours}h` });
      // Behind Railway (and any TLS-terminating proxy) the public connection is HTTPS but the
      // internal hop to this process is plain HTTP, so the cookies lib's auto-detection sees an
      // "unencrypted connection" and THROWS on a Secure cookie. That throw only fires on a SUCCESSFUL
      // login (the path that sets the cookie), so a correct password 500'd while a wrong one returned
      // a clean 401: login was unusable in prod. Pass `secure` to the constructor so the lib trusts
      // the terminated-TLS connection in production and still emits the Secure attribute.
      const cookies = new Cookies(req, res, { secure: process.env.NODE_ENV === 'production' });
      cookies.set('token', token, {
         httpOnly: true,
         sameSite: 'lax',
         secure: process.env.NODE_ENV === 'production',
         maxAge: sessHours * 60 * 60 * 1000,
      });
      return res.status(200).json({ success: true, error: null });
   }

   const error = req.body.username !== userName ? 'Incorrect Username' : 'Incorrect Password';

   return res.status(401).json({ success: false, error });
};
