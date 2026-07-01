// A tiny, dependency-free, in-memory TTL cache for the EXPENSIVE prebuilt reports.
//
// WHY: an LLM driving s33k over MCP re-asks the same report (same domain, same period,
// same goal) many times in a single working session. Each call otherwise re-runs the
// full DB read + sessionize + attribution pass. A short-TTL cache collapses that repeat
// cost without changing any response: a HIT returns the byte-identical payload a MISS
// computed, and the TTL is short enough that "live" reports stay effectively fresh.
//
// CAVEAT (deliberate): this cache is SINGLE-PROCESS / IN-MEMORY. That is correct for the
// single-container Railway deploy s33k runs on (one Next server process). It is NOT shared
// across instances and is wiped on restart. If s33k ever scales to multiple instances,
// this becomes a per-instance cache (still safe: keys are tenant-scoped, so the only effect
// is a lower hit rate, never a wrong or cross-tenant answer). Do not reach for this as a
// correctness primitive: a stale read past TTL is impossible, but a missed read is fine.

import type { NextApiRequest } from 'next';
import type Account from '../database/models/account';
import { ADMIN_ACCOUNT_ID } from './scope';

type Entry = { value: unknown, expiresAt: number };

// Defaults. 60s TTL matches the "feels live to a human, but collapses an LLM's burst of
// identical calls" target. The size cap bounds memory: reports are small JSON objects, so a
// few hundred entries is trivial, and oldest-first eviction keeps it from growing unbounded
// if many distinct (tenant, domain, params) keys appear.
export const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

// One module-level Map is the whole store. Insertion order in a JS Map is stable, so the
// FIRST key is the oldest inserted, which is what we evict when over the size cap. We do not
// refresh insertion order on get(), so this is insertion-order (FIFO) eviction, not LRU:
// simpler, dependency-free, and good enough since every entry expires within the TTL anyway.
const store = new Map<string, Entry>();

// Read a live (unexpired) entry. Returns undefined on miss OR on an expired entry, and prunes
// the expired entry on the way out so it cannot linger and count against the size cap.
export const get = (key: string): unknown => {
   const entry = store.get(key);
   if (!entry) { return undefined; }
   if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
   }
   return entry.value;
};

// Write an entry with a TTL, then enforce the size cap by dropping oldest-inserted entries.
// A re-set of an existing key deletes-then-inserts so it moves to the newest position (its
// freshness was just renewed), keeping eviction order honest.
export const set = (key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): void => {
   if (store.has(key)) { store.delete(key); }
   store.set(key, { value, expiresAt: Date.now() + ttlMs });
   while (store.size > MAX_ENTRIES) {
      // Map iteration yields keys in insertion order, so the first one is the oldest.
      const oldest = store.keys().next().value;
      if (oldest === undefined) { break; }
      store.delete(oldest);
   }
};

// Test/maintenance escape hatch. Not used by routes; lets a test reset state deterministically.
export const clear = (): void => { store.clear(); };

// --- tenant-isolated cache-key construction --------------------------------------------------
//
// CRITICAL TENANT SAFETY: the key MUST begin with the resolved tenant identity so tenant A can
// NEVER read tenant B's cached report, even for the same domain + params. The tenant component
// is the resolved account ID (account.ID), which authorize() has already produced from the
// authorized credential: ADMIN_ACCOUNT_ID (1) for the legacy global key / cookie / admin, or the
// real account ID for a per-tenant key. We derive it via accountTenantId(), which falls back to
// ADMIN_ACCOUNT_ID when account is null/undefined (the MULTI_TENANT-off / single-tenant path),
// so the key is always concrete. Callers MUST build the key only AFTER the ownership check passes,
// so nothing is cached for a caller who does not own the domain.
//
// The remaining components are the route name, the domain, and every other query param (sorted, so
// param order cannot produce two keys for one logical request), with the cache-bypass params
// (fresh / nocache) excluded so toggling bypass does not fork the cache space.

// Resolve the stable tenant component. account.ID is the same identity scopeWhere(account) gates on,
// so the cache key and the DB ownership scope agree by construction.
export const accountTenantId = (account: Account | null | undefined): number => (account && account.ID ? account.ID : ADMIN_ACCOUNT_ID);

// Query params that only control caching, never the report content. Excluded from the key so
// ?fresh=1 and a normal call share one cache slot (fresh just bypasses read + overwrites it).
const BYPASS_PARAMS = new Set(['fresh', 'nocache']);

// True when the caller asked to skip the cache for this request (compute fresh, then refill it).
export const wantsFresh = (req: NextApiRequest): boolean => {
   const { fresh, nocache } = req.query;
   const truthy = (v: unknown): boolean => v === '1' || v === 'true';
   return truthy(fresh) || truthy(nocache);
};

// Build the tenant-scoped cache key: tenantId | route | every query param (sorted, bypass params
// dropped). Array-valued params (Next can parse ?x=a&x=b to an array) are joined stably. The domain
// is just one of the query params, so it is captured here without special-casing.
export const buildReportCacheKey = (route: string, req: NextApiRequest, account: Account | null | undefined): string => {
   const tenant = accountTenantId(account);
   const parts = Object.keys(req.query)
      .filter((k) => !BYPASS_PARAMS.has(k))
      .sort()
      .map((k) => {
         const v = req.query[k];
         const flat = Array.isArray(v) ? v.join(',') : String(v ?? '');
         return `${k}=${flat}`;
      });
   return `t${tenant}|${route}|${parts.join('&')}`;
};
