/**
 * Per-account rate limiter for the AUTHENTICATED server-side crawl endpoints
 * (discover, site-audit, content-gap).
 *
 * SECURITY (audit area 2): each of these routes triggers up to MAX_PAGES (25) outbound fetches per
 * crawled site from s33k's OWN egress IP, and content-gap crawls TWO sites (yours + an arbitrary,
 * unowned competitor) for up to ~50 fetches per request. None of them was rate-limited, so an
 * authenticated tenant (including a GET-only member key) could loop them to turn s33k into a
 * crawl/DoS amplifier against a third-party target, getting s33k's egress IP blocklisted, and burn
 * server resources. This brake caps how many crawl requests one account can make per window.
 *
 * It reuses the dependency-free in-memory utils/rate-limit.ts limiter. Keyed by the resolved account
 * ID so it is per-tenant, not per-IP (the caller is authenticated, so the account is the right
 * subject). Process-local and best-effort like every other limiter here; it blunts abuse, it is not
 * a billing meter. Never throws.
 */

import { rateLimit } from './rate-limit';
import { ADMIN_ACCOUNT_ID } from './scope';
import type Account from '../database/models/account';

// Max crawl requests one account may make per window. Generous for a human running onboarding /
// audits, a hard brake on a scripted loop. Both overridable via env per deployment.
const CRAWL_RATE_LIMIT = (() => {
   const raw = parseInt(process.env.CRAWL_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();
const CRAWL_RATE_WINDOW_MS = (() => {
   const raw = parseInt(process.env.CRAWL_RATE_WINDOW_MS || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
})();

/**
 * Account one crawl request against the caller's account window.
 * @param {Account | null | undefined} account - The resolved calling account.
 * @param {string} [scope] - Optional sub-scope (e.g. the route name) so different crawl routes can
 *   have independent budgets if a caller passes one. Defaults to a shared 'crawl' bucket.
 * @returns {{ allowed: boolean, retryAfterMs: number }} Whether the request is allowed.
 */
export const allowCrawl = (account: Account | null | undefined, scope = 'crawl'): { allowed: boolean, retryAfterMs: number } => {
   const accountId = account && typeof account.ID === 'number' ? account.ID : ADMIN_ACCOUNT_ID;
   return rateLimit(`${scope}:${accountId}`, { limit: CRAWL_RATE_LIMIT, windowMs: CRAWL_RATE_WINDOW_MS });
};

export default allowCrawl;
