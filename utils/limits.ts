// Cost-bearing limits for s33k. These are real, enforced ceilings, NOT just
// documentation. s33k runs the SERP scrape infrastructure server-side on the
// operator's Serper key, so the number of tracked keywords directly bounds the
// recurring cost the operator pays. The security review (SECURITY_REVIEW) flagged
// that the product's own knowledge/help facts CLAIMED per-account keyword caps
// that nothing actually enforced. This module is the enforcement those claims
// refer to, so the claim is behaviorally true and can be verified here.
//
// All values are overridable via env so an operator can tune them per deployment
// without a code change. Defaults are generous enough never to block a real
// marketer (onboarding seeds up to ~20 keywords/domain) while still bounding abuse.

const intFromEnv = (name: string, fallback: number): number => {
   const raw = process.env[name];
   if (!raw) { return fallback; }
   const parsed = parseInt(raw, 10);
   return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Max keywords accepted in a single POST /api/keywords request. Bounds the size of
// one bulk insert and the immediate scrape burst it queues.
export const MAX_KEYWORDS_PER_REQUEST = intFromEnv('MAX_KEYWORDS_PER_REQUEST', 50);

// Max total tracked keywords per domain. Bounds the recurring per-domain SERP cost.
export const MAX_KEYWORDS_PER_DOMAIN = intFromEnv('MAX_KEYWORDS_PER_DOMAIN', 200);

// Hard length caps on free-text fields written by ingest endpoints, so an
// authenticated caller cannot push unbounded blobs into TEXT columns (storage /
// DB pressure). Generous relative to real values (modern UAs run ~300 chars).
export const MAX_CRAWLER_PATH_LEN = intFromEnv('MAX_CRAWLER_PATH_LEN', 2048);
export const MAX_CRAWLER_UA_LEN = intFromEnv('MAX_CRAWLER_UA_LEN', 2048);

// Hard reject ceiling on the number of events in ONE public POST /api/collect batch. This is a
// payload-size brake on the unauthenticated ingest, distinct from the sanitizer's per-batch
// PROCESS cap (sanitizeBatch only sanitizes the first 50). A batch exceeding this is rejected
// outright (413) before any DB work, so a multi-megabyte events array cannot be looped over.
// Deliberately ABOVE the sanitizer's 50-event process cap so a normal client (which never sends
// more than a handful at a time) and every existing collect test are unaffected.
export const MAX_EVENTS_PER_BATCH = intFromEnv('MAX_EVENTS_PER_BATCH', 100);
