// Helpers for SAVED SEGMENTS: the stored filter spec a marketer names once and reuses.
//
// A segment's `filters` column is a JSON string of the SegmentFilters spec that the sessionize
// engine (utils/sessionize.ts) understands. These two helpers are the single seam that keeps a
// stored segment using the EXACT same filter vocabulary as the live analytics routes:
//   - normalizeSegmentSpec: clean a create-segment body (object or JSON string) down to known keys.
//   - parseStoredSegmentFilters: turn a stored JSON string back into a SegmentFilters object.
// Reusing parseSegmentFilters for the string keys means channel aliases (seo/aio), device casing,
// and country casing are handled identically to /api/human-analytics and /api/goal-analytics.

import { parseSegmentFilters, SegmentFilters } from './sessionize';

// Coerce an arbitrary stored/posted filters value into a plain string-keyed object so it can flow
// through parseSegmentFilters (which expects a query-like record). Accepts a real object or a JSON
// string; anything else becomes {}.
const toRecord = (input: unknown): Record<string, unknown> => {
   if (input && typeof input === 'object' && !Array.isArray(input)) { return input as Record<string, unknown>; }
   if (typeof input === 'string' && input.trim()) {
      try {
         const parsed = JSON.parse(input);
         if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { return parsed as Record<string, unknown>; }
      } catch { /* fall through to {} */ }
   }
   return {};
};

// humanOnly is a boolean on the segment spec (not a query string), so it is parsed separately from
// the string filters. Accepts a real boolean or the strings "true"/"false".
const coerceHumanOnly = (v: unknown): boolean | undefined => {
   if (typeof v === 'boolean') { return v; }
   if (v === 'true') { return true; }
   if (v === 'false') { return false; }
   return undefined;
};

// Build a clean SegmentFilters spec from a create-segment body, keeping ONLY known keys so junk
// never gets persisted. Undefined keys are dropped so the stored JSON stays minimal. parseSegmentFilters
// handles the string keys (channel/landingPage/page/device/country/engagement) with the same aliasing
// and casing as the analytics routes; humanOnly is added on top.
export const normalizeSegmentSpec = (input: unknown): SegmentFilters => {
   const record = toRecord(input);
   const parsed = parseSegmentFilters(record);
   const spec: SegmentFilters = {};
   if (parsed.channel) { spec.channel = parsed.channel; }
   if (parsed.landingPage) { spec.landingPage = parsed.landingPage; }
   if (parsed.page) { spec.page = parsed.page; }
   if (parsed.device) { spec.device = parsed.device; }
   if (parsed.country) { spec.country = parsed.country; }
   if (parsed.engagement) { spec.engagement = parsed.engagement; }
   const humanOnly = coerceHumanOnly(record.humanOnly);
   if (humanOnly !== undefined) { spec.humanOnly = humanOnly; }
   return spec;
};

// Turn a stored segment `filters` JSON string back into a SegmentFilters object, re-normalized through
// the same path so a hand-edited or legacy row still resolves cleanly.
export const parseStoredSegmentFilters = (stored: string | null | undefined): SegmentFilters =>
   normalizeSegmentSpec(stored);
