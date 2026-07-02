import type { NextApiRequest, NextApiResponse } from 'next';
import resolveAccount, { ResolvedAccount } from './resolveAccount';
import { isAllowedApiRoute } from './allowedApiRoutes';

// authorize is the entry point for data routes, collapsed for SINGLE-USER mode. It resolves the
// caller to the single admin account (the APIKEY Bearer key, the only credential now that the web
// UI and its cookie session are deleted) and enforces the API-route whitelist for Bearer-key
// callers, then returns the resolved account so the route can scope its queries with
// scopeWhere(account) (now always {}) / ownerIdFor(account) (now always null).
const authorize = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const resolved = await resolveAccount(req, res);
   if (!resolved.authorized) { return resolved; }

   // Bearer-key callers must be hitting a whitelisted route (matching the original single-tenant
   // SerpBear behavior; the whitelist keeps the key away from routes never meant for API callers,
   // like the analytics ingest). `via` is always 'bearer' now, but keying off it keeps this check
   // byte-compatible with the pre-headless behavior for Bearer callers.
   if (resolved.via === 'bearer' && !isAllowedApiRoute(req)) {
      return { authorized: false, account: null, error: 'This Route cannot be accessed with API.' };
   }
   return resolved;
};

export default authorize;
