import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';

// LEGACY AUTH HELPER, now Bearer-only. The web UI (and with it the cookie/JWT login session) was
// deleted in the headless phase, so the single credential this instance accepts is the APIKEY
// Bearer key. New routes that read or write tenant-owned rows should use utils/authorize.ts, which
// resolves the caller to the admin account and enforces the API-route whitelist; this helper
// remains for the older settings / migration / Google Ads admin-maintenance surfaces.
//
// Why there is no route-whitelist check here (unlike authorize): these admin surfaces were
// previously cookie-only, and the whitelist existed to keep the Bearer key OUT of them while the
// cookie session existed. With the cookie gone, the single APIKEY is the instance's only and
// full-admin credential, so it reaches these routes directly. The whitelist stays the authorize()
// seam for the data routes.
//
// Keep this file dependency-free. Pulling Sequelize models into this helper would make every
// legacy route import the DB layer at module load and has broken Jest before.

// Constant-time string equality. Returns false on a length mismatch (length is not secret for a
// high-entropy key) and otherwise compares in constant time so the API-key check leaks no timing.
const timingSafeEqualStr = (a: string, b: string): boolean => {
   if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) { return false; }
   return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * Psuedo Middleware: Verifies the caller by the APIKEY Bearer key (the only credential).
 * @param {NextApiRequest} req - The Next Request
 * @param {NextApiResponse} res - The Next Response.
 * @returns {string}
 */
// `res` is kept in the signature (unused since the cookie session was removed) so the many call
// sites stay byte-identical: every route calls verifyUser(req, res).
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
const verifyUser = (req: NextApiRequest, res: NextApiResponse): string => {
   // Constant-time compare on the global APIKEY (audit area 4, low): a plain === short-circuits on
   // the first differing byte. timingSafeEqual needs equal-length buffers, so a length mismatch
   // returns false up front. The key is high-entropy, so this is hardening, not a live exploit fix.
   const presentedKey = req.headers.authorization ? req.headers.authorization.substring('Bearer '.length) : '';
   const verifiedAPI = !!process.env.APIKEY && timingSafeEqualStr(presentedKey, process.env.APIKEY);

   if (verifiedAPI) { return 'authorized'; }
   if (req.headers.authorization) { return 'Invalid API Key Provided.'; }
   return 'Not authorized';
};

export default verifyUser;
