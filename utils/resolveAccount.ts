import Cookies from 'cookies';
import jwt from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';
import type Account from '../database/models/account';
import { ADMIN_ACCOUNT_ID } from './scope';

// resolveAccount resolves the caller to the single admin account, collapsed for SINGLE-USER mode.
//
// This project is single-user: there is exactly one account (the admin sentinel, ID = 1). A valid
// cookie session or the legacy process.env.APIKEY Bearer key authorizes as that account; anything
// else is unauthorized. The multi-tenant per-key lookup (api_key table, share keys, member keys)
// is gone. The ResolvedAccount shape keeps its `role` / `scopedDomain` fields so authorize() and
// any consumer keep compiling, but they are always 'admin' / undefined here.

export type ResolvedAccount = {
   authorized: boolean,
   account: Account | null,
   // Always 'admin' in single-user mode. Kept so authorize()'s member-key guard compiles.
   role?: 'admin' | 'member',
   // Always undefined in single-user mode (no per-domain share keys). Kept for shape compatibility.
   scopedDomain?: string | null,
   // Which credential authorized the caller. authorize() enforces the API-route whitelist ONLY for
   // 'bearer' callers, so a cookie-authorized UI request that also happens to carry an Authorization
   // header is not wrongly restricted. Undefined when the caller was not authorized.
   via?: 'cookie' | 'bearer',
   error?: string,
};

// The in-memory stand-in for the seeded admin account row (ID = 1). No DB read on the hot path;
// the scoping helpers only care about the ID.
const adminAccount = (): Account => ({ ID: ADMIN_ACCOUNT_ID } as Account);

const resolveAccount = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const cookies = new Cookies(req, res);
   const token = cookies && cookies.get('token');

   // Cookie session resolves to the single admin account.
   if (token && process.env.SECRET) {
      let valid = false;
      jwt.verify(token, process.env.SECRET, { algorithms: ['HS256'] }, (err) => { valid = !err; });
      if (valid) { return { authorized: true, account: adminAccount(), role: 'admin', via: 'cookie' }; }
   }

   const authHeader = req.headers.authorization;
   const bearer = authHeader ? authHeader.substring('Bearer '.length) : '';

   // The single API key (process.env.APIKEY) resolves to the admin account.
   if (bearer && bearer === process.env.APIKEY) {
      return { authorized: true, account: adminAccount(), role: 'admin', via: 'bearer' };
   }

   if (bearer) {
      return { authorized: false, account: null, error: 'Invalid API Key Provided.' };
   }
   return { authorized: false, account: null, error: 'Not authorized' };
};

export default resolveAccount;
