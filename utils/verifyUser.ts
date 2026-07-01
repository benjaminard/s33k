import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import Cookies from 'cookies';
import jwt from 'jsonwebtoken';
import { allowedApiRoutes } from './allowedApiRoutes';

// LEGACY AUTH HELPER. New multi-tenant routes should use utils/authorize.ts instead, because
// authorize resolves the caller to an Account, applies member/share-key restrictions, and returns
// the account object routes need for scopeWhere(owner). This helper remains for older settings /
// migration / Google Ads paths that are effectively single-admin surfaces. If a route reads or
// writes tenant-owned rows, migrate it to authorize() rather than extending this function.
//
// Keep this file dependency-free except for allowedApiRoutes. Pulling Sequelize models into this
// helper would make every legacy route import the DB layer at module load and has broken Jest before.

// Constant-time string equality. Returns false on a length mismatch (length is not secret for a
// high-entropy key) and otherwise compares in constant time so the API-key check leaks no timing.
const timingSafeEqualStr = (a: string, b: string): boolean => {
   if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) { return false; }
   return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * Psuedo Middleware: Verifies the user by their cookie value or their API Key
 * When accessing with API key only certain routes are accessible.
 * @param {NextApiRequest} req - The Next Request
 * @param {NextApiResponse} res - The Next Response.
 * @returns {string}
 */
const verifyUser = (req: NextApiRequest, res: NextApiResponse): string => {
   const cookies = new Cookies(req, res);
   const token = cookies && cookies.get('token');

   // Constant-time compare on the global APIKEY (audit area 4, low): a plain === short-circuits on
   // the first differing byte. timingSafeEqual needs equal-length buffers, so a length mismatch
   // returns false up front. The key is high-entropy, so this is hardening, not a live exploit fix.
   const presentedKey = req.headers.authorization ? req.headers.authorization.substring('Bearer '.length) : '';
   const verifiedAPI = !!process.env.APIKEY && timingSafeEqualStr(presentedKey, process.env.APIKEY);
   const accessingAllowedRoute = req.url && req.method && allowedApiRoutes.includes(`${req.method}:${req.url.replace(/\?(.*)/, '')}`);

   let authorized: string = '';
   if (token && process.env.SECRET) {
      // Pin the expected algorithm (audit area 3, low): prevents any future alg-confusion regression
      // if an asymmetric verification key is ever introduced. The session JWT is HS256-signed.
      jwt.verify(token, process.env.SECRET, { algorithms: ['HS256'] }, (err) => {
         authorized = err ? 'Not authorized' : 'authorized';
      });
   } else if (verifiedAPI && accessingAllowedRoute) {
      authorized = 'authorized';
   } else {
      if (!token) {
         authorized = 'Not authorized';
      }
      if (token && !process.env.SECRET) {
         authorized = 'Token has not been Setup.';
      }
      if (verifiedAPI && !accessingAllowedRoute) {
         authorized = 'This Route cannot be accessed with API.';
      }
      if (req.headers.authorization && !verifiedAPI) {
         authorized = 'Invalid API Key Provided.';
      }
   }

   return authorized;
};

export default verifyUser;
