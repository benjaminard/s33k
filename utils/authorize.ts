import type { NextApiRequest, NextApiResponse } from 'next';
import resolveAccount, { ResolvedAccount } from './resolveAccount';
import { isAllowedApiRoute } from './allowedApiRoutes';

// authorize is the entry point for data routes, collapsed for SINGLE-USER mode. It resolves the
// caller to the single admin account (cookie or the legacy API key) and enforces the API-route
// whitelist for Bearer-key callers, then returns the resolved account so the route can scope its
// queries with scopeWhere(account) (now always {}) / ownerIdFor(account) (now always null).
const authorize = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const resolved = await resolveAccount(req, res);
   if (!resolved.authorized) { return resolved; }

   // Cookie/UI callers are unrestricted. Only callers authorized BY the Bearer key must be hitting a
   // whitelisted route (matching the original single-tenant SerpBear behavior). We key off the
   // mechanism resolveAccount actually used, not the mere presence of an Authorization header, so a
   // cookie-authorized UI request that also carries a bearer header is not wrongly restricted.
   if (resolved.via === 'bearer' && !isAllowedApiRoute(req)) {
      return { authorized: false, account: null, error: 'This Route cannot be accessed with API.' };
   }
   return resolved;
};

export default authorize;
