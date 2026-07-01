// Parse a period string ("30d" / "24h" / "7d" / "3m") into a start timestamp (ms from epoch).
// Shared by the first-party analytics routes so the window math never diverges. Defaults to 30
// days for anything unparseable.
// Cap any lookback at 365 days. An unbounded `\d+[dhwm]` (e.g. period=99999d) would otherwise pull
// effectively the whole event table into memory, a per-domain OOM/DoS on a busy site. Every route
// using periodStartMs inherits this bound; normal periods are unaffected.
const MAX_LOOKBACK_MS = 365 * 86400e3;

export const periodStartMs = (period: string, nowMs: number): number => {
   const m = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   if (!m) { return nowMs - 30 * 86400e3; }
   const n = parseInt(m[1], 10);
   const unitMs: Record<string, number> = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 };
   const lookbackMs = Math.min(n * (unitMs[m[2].toLowerCase()] || 86400e3), MAX_LOOKBACK_MS);
   return nowMs - lookbackMs;
};
