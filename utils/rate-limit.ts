/**
 * Generic, dependency-free, in-memory fixed-window rate limiter.
 *
 * An abuse brake whose counters live in this single process's memory. It resets on restart. Fixed
 * window (not sliding) on purpose: cheapest correct shape, a flood is just as blocked. Each key holds
 * a window start and a hit count; when the window elapses the entry resets on the next hit. Unbounded
 * growth is prevented two ways: expired entries drop lazily on access, and a hard MAX_KEYS ceiling
 * triggers a sweep (then a clear) so a unique-key flood (spoofed IPs) cannot grow the map without
 * bound. Nothing throws.
 *
 * (Single-user note: the earlier cross-instance Postgres-backed variant, rateLimitAsync, was removed
 * with the multi-tenant SaaS surface. A single-user self-host runs one process, so the in-memory
 * limiter is all that is needed.)
 */

export type RateLimitOptions = {
   /** Max hits allowed per key within the window. */
   limit: number,
   /** Window length in milliseconds. */
   windowMs: number,
};

export type RateLimitResult = {
   /** True if this hit is within the limit; false if the window is exhausted. */
   allowed: boolean,
   /** Ms until the current window resets. 0 when allowed. */
   retryAfterMs: number,
};

type Bucket = { windowStart: number, count: number };

// One shared map for all callers. Keys are caller-namespaced strings (e.g. `collect:1.2.3.4`),
// so distinct limiters never collide even though they share the map.
const buckets = new Map<string, Bucket>();

// Hard ceiling on tracked keys so a unique-key flood (spoofed IPs) cannot grow memory unbounded.
const MAX_KEYS = 50000;

// Global, all-keys request ceiling (defense in depth, audit area 1).
//
// The per-key limiter is bypassable by a flood of UNIQUE keys (spoofed X-Forwarded-For), where
// every request opens a fresh bucket and passes its own first-hit. This global counter bounds the
// TOTAL hits accepted across ALL keys per window, independent of how many distinct keys are used,
// so a unique-key flood is capped regardless. It is intentionally generous (far above any honest
// aggregate load) and exists only to put a hard ceiling under a determined spoofing attack. Set to
// 0 (or a negative) via env to disable. Window is shared with the per-key window passed by callers.
// Read from env on each call so an operator (and tests) can tune it without a rebuild.
const globalMaxHitsPerWindow = (): number => {
   const raw = parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '', 10);
   return Number.isFinite(raw) && raw >= 0 ? raw : 100000;
};
let globalWindowStart = 0;
let globalCount = 0;

// Drop every entry whose window has already elapsed relative to `now`. Cheap O(n) sweep, only run
// when the map crosses MAX_KEYS, so the steady-state hot path stays O(1).
const evictExpired = (now: number): void => {
   for (const [key, bucket] of buckets) {
      // A bucket is dead once a full window has elapsed since its start; window length is not
      // stored per bucket, so use the largest plausible window guard: drop anything older than
      // the entry could possibly still be counting. We approximate with the bucket's own age vs
      // a generous ceiling; callers use minute-scale windows, so 1h of staleness is safely dead.
      if (now - bucket.windowStart >= 3600 * 1000) { buckets.delete(key); }
   }
   // If the sweep did not free enough (pathological burst of fresh unique keys), hard-reset.
   if (buckets.size > MAX_KEYS) { buckets.clear(); }
};

/**
 * Account one hit against `key` and report whether it is allowed.
 * @param {string} key - Caller-namespaced bucket key (e.g. `collect:<ip>`).
 * @param {RateLimitOptions} options - limit (max hits) and windowMs (window length).
 * @param {number} [now] - Current epoch ms; injectable for deterministic tests.
 * @returns {RateLimitResult} allowed + retryAfterMs.
 */
export const rateLimit = (key: string, options: RateLimitOptions, now = Date.now()): RateLimitResult => {
   const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 1;
   const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 1000;

   // Global all-keys ceiling FIRST (cheap, O(1)): a unique-key flood passes every per-key check but
   // still increments this shared counter, so the aggregate is bounded no matter how many keys are
   // spoofed. Disabled when the ceiling is <= 0.
   const globalMax = globalMaxHitsPerWindow();
   if (globalMax > 0) {
      if (globalWindowStart === 0 || (now - globalWindowStart) >= windowMs) {
         globalWindowStart = now;
         globalCount = 0;
      }
      if (globalCount >= globalMax) {
         return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - globalWindowStart)) };
      }
      globalCount += 1;
   }

   const existing = buckets.get(key);

   // New key or elapsed window: start a fresh window counting this hit as the first.
   if (!existing || (now - existing.windowStart) >= windowMs) {
      if (buckets.size >= MAX_KEYS) { evictExpired(now); }
      buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
   }

   if (existing.count >= limit) {
      // Window exhausted. Report time remaining so the caller can set Retry-After.
      const retryAfterMs = Math.max(0, windowMs - (now - existing.windowStart));
      return { allowed: false, retryAfterMs };
   }

   existing.count += 1;
   return { allowed: true, retryAfterMs: 0 };
};

/** Test-only: clear all in-memory rate-limit state (per-key buckets and the global ceiling). */
export const __resetGenericRateLimit = (): void => { buckets.clear(); globalWindowStart = 0; globalCount = 0; };
