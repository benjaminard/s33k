import type { NextApiRequest, NextApiResponse } from 'next';
import type Account from '../database/models/account';
import { ADMIN_ACCOUNT_ID } from './scope';

// resolveAccount resolves the caller to the single admin account, collapsed for SINGLE-USER mode.
//
// This project is single-user AND headless: there is exactly one account (the admin sentinel,
// ID = 1) and exactly one credential, the process.env.APIKEY Bearer key. The web UI and its
// cookie/JWT login session were deleted in the headless phase, so there is no cookie branch here
// anymore; anything that is not the APIKEY is unauthorized. The ResolvedAccount shape keeps its
// `role` / `scopedDomain` fields so authorize() and any consumer keep compiling, but they are
// always 'admin' / undefined here.

export type ResolvedAccount = {
   authorized: boolean,
   account: Account | null,
   // Always 'admin' in single-user mode. Kept so authorize()'s member-key guard compiles.
   role?: 'admin' | 'member',
   // Always undefined in single-user mode (no per-domain share keys). Kept for shape compatibility.
   scopedDomain?: string | null,
   // Which credential authorized the caller. Always 'bearer' now that the cookie session is gone;
   // kept so authorize()'s whitelist check reads the same as before. Undefined when unauthorized.
   via?: 'bearer',
   error?: string,
};

// The in-memory stand-in for the seeded admin account row (ID = 1). No DB read on the hot path;
// the scoping helpers only care about the ID.
const adminAccount = (): Account => ({ ID: ADMIN_ACCOUNT_ID } as Account);

// The publicly-known demo/example APIKEY values (shipped in the upstream SerpBear demo and this
// repo's .env.example). entrypoint.sh refuses to BOOT production with them, but a direct
// `node server.js` start bypasses entrypoint, and the deleted login route used to carry the
// runtime half of this guard. Rejecting them here restores runtime enforcement at the one auth
// seam every caller passes through: a production instance whose APIKEY is a published value must
// authorize nobody, because everybody on the internet holds that credential.
const PUBLISHED_APIKEYS = [
   '5saedXklbslhnapihe2pihp3pih4fdnakhjwq5',
   'replace-with-openssl-rand-hex-24',
];
const apikeyIsPublished = (): boolean => process.env.NODE_ENV === 'production'
   && PUBLISHED_APIKEYS.includes(process.env.APIKEY || '');

// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
const resolveAccount = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const authHeader = req.headers.authorization;
   const bearer = authHeader ? authHeader.substring('Bearer '.length) : '';

   // The single API key (process.env.APIKEY) resolves to the admin account, unless the instance
   // is running production with a published demo/example key, which authorizes nobody.
   if (bearer && bearer === process.env.APIKEY && !apikeyIsPublished()) {
      return { authorized: true, account: adminAccount(), role: 'admin', via: 'bearer' };
   }

   if (bearer) {
      return { authorized: false, account: null, error: 'Invalid API Key Provided.' };
   }
   return { authorized: false, account: null, error: 'Not authorized' };
};

export default resolveAccount;
