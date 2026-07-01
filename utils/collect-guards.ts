/**
 * Guards for the PUBLIC POST /api/collect ingest endpoint.
 *
 * /api/collect is the one s33k route that takes no API key: it is posted to directly by the
 * s33k.js script on a customer's website, so it cannot carry a secret. That makes it the most
 * abuse-exposed surface in the app. These helpers keep it cheap and safe:
 *   - isLikelyBotUA: drop obvious bot / crawler user-agents so autocapture stays human.
 *   - clientIp: best-effort caller IP from proxy headers for rate-limiting.
 *   - rateLimitCollect: a small in-memory, per-(ip+domain) sliding-window limiter so one
 *     source cannot flood the table. In-memory is intentional: the limiter is a coarse abuse
 *     brake, not an accounting system, and resets per server instance are acceptable.
 *
 * Nothing here throws.
 */

import { classifyCrawler } from './ai-crawlers';

/**
 * Generic non-browser / bot user-agent substrings, on top of the known AI/search crawlers in
 * ai-crawlers.ts. These are tools and libraries that should never be generating real
 * engagement events. Matched case-insensitively as substrings.
 */
const GENERIC_BOT_HINTS: readonly string[] = [
   'bot', 'spider', 'crawler', 'slurp', 'curl', 'wget', 'python-requests',
   'httpclient', 'okhttp', 'java/', 'go-http-client', 'libwww', 'headless',
   'phantomjs', 'puppeteer', 'playwright', 'scrapy', 'axios/', 'node-fetch',
];

/**
 * Whether a user-agent is a likely bot and its events should be dropped.
 * A missing/empty UA is treated as a bot: a real browser always sends one.
 * @param {string | undefined} userAgent - The raw User-Agent header.
 * @returns {boolean}
 */
export const isLikelyBotUA = (userAgent: string | undefined): boolean => {
   const ua = String(userAgent || '').toLowerCase().trim();
   if (!ua) { return true; }
   if (classifyCrawler(ua).isCrawler) { return true; }
   return GENERIC_BOT_HINTS.some((hint) => ua.includes(hint));
};

/**
 * Number of TRUSTED reverse-proxy hops in front of the app (the edge that appends the real
 * client IP to X-Forwarded-For). Railway puts exactly one trusted proxy in front, so the default
 * is 1. Operators behind a different topology (e.g. Cloudflare -> Railway = 2) set TRUSTED_PROXY_HOPS.
 */
const trustedProxyHops = (): number => {
   const raw = parseInt(process.env.TRUSTED_PROXY_HOPS || '', 10);
   return Number.isFinite(raw) && raw >= 1 ? raw : 1;
};

/**
 * Client IP for rate-limiting, derived from the RIGHTMOST trusted X-Forwarded-For hop.
 *
 * SECURITY (rate-limit bypass, audit area 1): X-Forwarded-For is `client, proxy1, proxy2, ...`,
 * appended left-to-right, so the LEFTMOST hop is whatever the untrusted client SENT and is fully
 * spoofable. Trusting it lets an attacker present a unique XFF per request and mint a brand-new
 * rate-limit bucket every time, defeating every limiter. The only entries we can trust are the
 * ones the trusted edge appended on the RIGHT. With N trusted proxies, the real client IP is the
 * hop at index (length - N). We take that hop (clamped into range), falling back to x-real-ip
 * (single value set by a trusted proxy) and then the socket address. Used only as a rate-limit
 * key; it is never stored on an event row.
 * @param {Record<string, string | string[] | undefined>} headers - Request headers.
 * @param {string | undefined} socketRemote - req.socket.remoteAddress.
 * @returns {string}
 */
export const clientIp = (
   headers: Record<string, string | string[] | undefined>,
   socketRemote?: string,
): string => {
   const fwd = headers['x-forwarded-for'];
   const raw = Array.isArray(fwd) ? fwd.join(',') : fwd;
   if (typeof raw === 'string' && raw.trim()) {
      const hops = raw.split(',').map((h) => h.trim()).filter(Boolean);
      if (hops.length) {
         // Index from the right by the trusted-hop count; clamp to the first entry so a short
         // chain (fewer hops than configured) still yields the left-most real client, never undefined.
         const idx = Math.max(0, hops.length - trustedProxyHops());
         return hops[idx];
      }
   }
   const real = headers['x-real-ip'];
   if (typeof real === 'string' && real.trim()) { return real.trim(); }
   return socketRemote || 'unknown';
};

// In-memory sliding-window counters keyed by `${ip}:${domain}`. Each entry holds the start of
// the current window and the count within it. This is per-process and intentionally simple.
type Window = { windowStart: number, count: number };
const windows = new Map<string, Window>();

// Defaults: at most MAX_EVENTS event-rows accepted per key per WINDOW_MS. Generous enough for
// a busy page (batches of up to 50 every ~30s) but a hard brake on flooding.
export const COLLECT_WINDOW_MS = 60 * 1000;
export const COLLECT_MAX_EVENTS = 600;

// Cap the map size so a flood of unique keys cannot grow memory without bound.
const MAX_KEYS = 50000;

// Drop only EXPIRED windows when the map is over the cap.
//
// SECURITY (audit area 1): the previous overflow path did windows.clear(), which under a
// spoofed-key flood would wipe EVERY legitimate visitor's counter, neutering the limiter for
// everyone exactly when it is needed. Evicting only entries whose window has already elapsed
// keeps live counters intact. A hard clear() remains only as the last-resort fallback for the
// pathological case where even after the sweep the map is still over the cap (all entries fresh).
const evictExpiredWindows = (now: number): void => {
   for (const [key, win] of windows) {
      if (now - win.windowStart >= COLLECT_WINDOW_MS) { windows.delete(key); }
   }
   if (windows.size > MAX_KEYS) { windows.clear(); }
};

/**
 * Account `count` events against the (ip+domain) window. Returns whether they are allowed.
 * When a window expires it resets. Never throws.
 * @param {string} ip - The caller IP (rate-limit key part).
 * @param {string} domain - The target domain (rate-limit key part).
 * @param {number} count - Number of event-rows this request wants to add.
 * @param {number} [now] - Current epoch ms (injectable for tests).
 * @returns {boolean} True if allowed, false if the window is exhausted.
 */
export const rateLimitCollect = (ip: string, domain: string, count: number, now = Date.now()): boolean => {
   const key = `${ip}:${domain}`;
   const existing = windows.get(key);

   if (!existing || (now - existing.windowStart) >= COLLECT_WINDOW_MS) {
      // New or expired window. Opportunistically evict expired keys if the map is too large,
      // preserving live counters (see evictExpiredWindows: never a blanket clear under attack).
      if (windows.size > MAX_KEYS) { evictExpiredWindows(now); }
      windows.set(key, { windowStart: now, count: Math.max(0, count) });
      return count <= COLLECT_MAX_EVENTS;
   }

   if (existing.count + count > COLLECT_MAX_EVENTS) {
      return false;
   }
   existing.count += count;
   return true;
};

/** Test-only: clear the in-memory rate-limit state. */
export const __resetRateLimit = (): void => { windows.clear(); };
