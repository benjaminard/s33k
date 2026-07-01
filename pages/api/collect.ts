import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import { sanitizeBatch, sanitizeSession, sanitizeText, looksLikePII, cleanEventPath, sanitizeSource } from '../../utils/event-sanitize';
import { isLikelyBotUA, clientIp, rateLimitCollect } from '../../utils/collect-guards';
import { isDatacenterIp } from '../../utils/datacenter-ip';
import { deviceFromUA, countryFromHeaders } from '../../utils/request-segments';
import { rateLimit } from '../../utils/rate-limit';
import { MAX_EVENTS_PER_BATCH } from '../../utils/limits';
import { canonicalizeDomain } from '../../utils/canonical-domain';

// Per-IP request-rate brake for this PUBLIC endpoint, layered ON TOP of the existing
// per-(ip+domain) EVENT-count limiter in collect-guards. The two guard different things:
//   - rateLimitCollect (existing): bounds how many event ROWS one (ip+domain) can add per minute
//     and swallows an over-cap batch as a no-op 200 so the client does not retry-storm.
//   - this limiter (new): bounds how many REQUESTS one IP can make per minute, across all domains,
//     and answers 429 so an abuser hammering the open endpoint gets an explicit back-off signal.
// It counts REQUESTS, not events, on purpose: the existing resilience test deliberately floods the
// EVENT limiter with ~650 events across ~13 requests from one IP, and counting events here at the
// 600 default would wrongly 429 that test. Counting requests (~13) keeps it green while still
// blunting a real flood. Both defaults are high enough that a normal busy site never trips either.
const COLLECT_RATE_LIMIT = (() => {
   const raw = parseInt(process.env.COLLECT_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 600;
})();
const COLLECT_RATE_WINDOW_MS = (() => {
   const raw = parseInt(process.env.COLLECT_RATE_WINDOW_MS || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
})();

// Hard cap on the stored domain string. A domain name is short; anything longer is junk and must
// never reach a TEXT column or a Domain lookup. Bounds the one route-level free-text field the
// event sanitizer does not own.
const MAX_DOMAIN_LEN = 255;

// Hard cap on each stored UTM / campaign value. A campaign tag is short by convention; anything
// longer is junk or a smuggled blob. Sanitized with the same sanitizeText (control-char strip +
// whitespace collapse) used for every other free-text field so a UTM value can never carry a
// newline-injected payload into storage. The UTM tags are session-level (parsed once from the
// landing URL by the client), so they are sanitized ONCE per request and stamped on every row.
const MAX_UTM_LEN = 150;

// The five standard UTM keys, batch-level. Order is fixed so the read surface and the model line up.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
type UtmKey = typeof UTM_KEYS[number];

// Core Web Vitals (real-user field data) arrive as a NEW additive event type:'webvital' from
// s33k.js. They carry a numeric metric_value and a metric-name label. They are handled on their
// own path below (not through sanitizeBatch, whose CleanEvent shape stays byte-identical for the
// existing five event types and every existing test). The known metric names: LCP / FCP / TTFB
// (timing, ms), INP / FID (interaction latency, ms), CLS (unitless layout-shift score).
const WEBVITAL_LABELS = new Set(['LCP', 'CLS', 'INP', 'FID', 'FCP', 'TTFB']);

// Sane upper bound on any stored web-vital number. CLS is a small fraction and the timing metrics
// are milliseconds; a single page-life metric beyond ~10 minutes (600000 ms) is junk or tampering
// and is rejected. Bounds storage and keeps a poisoned client from skewing percentile aggregates.
const MAX_WEBVITAL_VALUE = 600000;

// A validated, ready-to-store web-vital extracted from one raw event. metric_value is a finite,
// non-negative, bounded number; label is one of the six known metric names; page is a clean path.
type CleanWebVital = { page: string, label: string, metricValue: number };

// Validate one raw event as a web-vital. Returns null (skip-and-continue) when it is not a
// well-formed webvital: wrong type, unknown metric label, or a metric_value that is not a finite,
// non-negative, in-range number. Never throws.
const sanitizeWebVital = (raw: unknown): CleanWebVital | null => {
   if (!raw || typeof raw !== 'object') { return null; }
   const ev = raw as Record<string, unknown>;
   if (ev.type !== 'webvital') { return null; }
   const label = typeof ev.label === 'string' ? ev.label : '';
   if (!WEBVITAL_LABELS.has(label)) { return null; }
   const value = Number(ev.metric_value);
   if (!Number.isFinite(value) || value < 0 || value > MAX_WEBVITAL_VALUE) { return null; }
   return { page: cleanEventPath(ev.page), label, metricValue: value };
};

// Extract + sanitize the five session-level UTM tags from the request body. Each value is
// sanitized and length-capped like the other string fields; a missing/blank/non-string value
// becomes null (untagged). A PII-shaped value (an email, a card number smuggled into a UTM tag by
// a tampered client) is DROPPED to null, upholding this file's own PII-defense guarantee that
// nothing PII-shaped is ever stored. Returns a record keyed by the exact model column names.
// Never throws.
const utmFromBody = (body: Record<string, unknown>): Record<UtmKey, string | null> => {
   const out = {} as Record<UtmKey, string | null>;
   for (const key of UTM_KEYS) {
      const raw = body[key];
      const value = typeof raw === 'string' ? sanitizeText(raw, MAX_UTM_LEN) : '';
      out[key] = (value && !looksLikePII(value)) ? value : null;
   }
   return out;
};

// POST /api/collect  (PUBLIC, no API key)
//
// This is the autocapture ingest. The s33k.js client on a customer's website posts batches of
// engagement events here. It is the GA4-killer feature's write half: one script tag, zero
// per-element setup. It takes NO auth and NO API key on purpose, because the script running in
// a stranger's browser cannot hold a secret. It is therefore deliberately NOT in
// utils/allowedApiRoutes.ts (that list gates Bearer-key callers; this route is reached without
// a key, exactly like the public POST /api/waitlist and the invite-accept route).
//
// Because it is open, it defends itself:
//   1. Domain allow-listing: the posted domain MUST be a known s33k Domain, else 403. An
//      unknown domain cannot write a single row, so the endpoint is not an open sink.
//   2. Bot filtering: known crawlers and obvious non-browser user-agents are dropped, so
//      autocapture stays human engagement.
//   3. Rate limiting: a per-(ip+domain) sliding window caps how many rows one source can add.
//   4. PII defense-in-depth: every event is sanitized; anything PII-shaped (an email, a card
//      number, a typed value smuggled into a label) is DROPPED before it can be stored. The
//      client is built to never read input values; this is the second wall behind that.
//   5. Tenant stamping: owner_id is copied from the owning Domain so every read surface scopes
//      by owner_id and a tenant only ever reads its own events.
//
// It NEVER 500s on a bad event: invalid/PII events are skipped and the rest are stored
// (skip-and-continue). A genuinely broken request gets a 4xx, never a stack trace.

type CollectResponse = {
   recorded?: number,
   skipped?: number,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<CollectResponse>) {
   // CORS: this is posted cross-origin from customer sites. Allow it, but only POST.
   res.setHeader('Access-Control-Allow-Origin', '*');
   res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

   if (req.method === 'OPTIONS') {
      return res.status(204).end();
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }

   await ensureSynced();
   return collect(req, res);
}

// Per-row fallback insert: store each row independently, skipping the offending one. This is the
// resilience floor (a single bad row never fails the batch) and the path taken when bulkCreate is
// unavailable. Returns the count actually stored. Never throws.
const storeRowsPerRow = async (rows: Record<string, unknown>[], domain: string): Promise<number> => {
   let recorded = 0;
   for (const row of rows) {
      try {
         // eslint-disable-next-line no-await-in-loop
         await S33kEvent.create(row);
         recorded += 1;
      } catch (rowError) {
         // Skip the offending row, keep going. Never let one event 500 the batch.
         console.log('[WARN] Skipping bad collect event for ', domain, rowError);
      }
   }
   return recorded;
};

// Store the batch with ONE bulkCreate when the model supports it, falling back to per-row create on
// any bulk failure. bulkCreate({ validate: true }) runs the same per-row validation as create, so an
// invalid row is rejected, not silently coerced. WHY the fallback: a bulk insert is all-or-nothing on
// a single bad row, which would violate the skip-and-continue contract (one PII/oversized row must
// not lose the whole batch); when bulk throws we retry row-by-row so the good rows still land. The
// `typeof bulkCreate === 'function'` guard also keeps the existing tests green: their S33kEvent mock
// exposes only `create`, so they exercise the per-row path with identical behavior to before, while
// the real Sequelize model (which has bulkCreate) takes the single-statement fast path in prod.
const storeRows = async (rows: Record<string, unknown>[], domain: string): Promise<number> => {
   const model = S33kEvent as unknown as { bulkCreate?: (r: unknown[], opts: unknown) => Promise<unknown[]> };
   if (typeof model.bulkCreate === 'function') {
      try {
         const inserted = await model.bulkCreate(rows, { validate: true });
         return Array.isArray(inserted) ? inserted.length : rows.length;
      } catch (bulkError) {
         // A single bad row failed the bulk insert; recover the good rows one at a time.
         console.log('[WARN] Bulk insert failed, falling back to per-row for ', domain, bulkError);
         return storeRowsPerRow(rows, domain);
      }
   }
   return storeRowsPerRow(rows, domain);
};

const collect = async (req: NextApiRequest, res: NextApiResponse<CollectResponse>) => {
   try {
      // Per-IP request-rate brake FIRST, before any parsing/DB work, so a flood is cheapest to
      // reject. x-forwarded-for first hop, falling back to the socket (clientIp handles both).
      const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
      const rl = rateLimit(`collect:${ip}`, { limit: COLLECT_RATE_LIMIT, windowMs: COLLECT_RATE_WINDOW_MS });
      if (!rl.allowed) {
         res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
         return res.status(429).json({ error: 'Too many requests. Please slow down.' });
      }

      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      // Canonicalize the reported domain so the allowlist lookup AND the stored event rows use the
      // ONE canonical form every Domain row is now registered under (third adversarial review). The
      // install snippet already emits the canonical domain, so real clients are unaffected; this just
      // ensures a "www."/trailing-dot/uppercase variant resolves the same row and stores under the
      // same key, never splitting one site's analytics across two keys or missing the allowlist.
      const domain = typeof body.domain === 'string'
         ? canonicalizeDomain(sanitizeText(body.domain, MAX_DOMAIN_LEN))
         : '';
      const session = sanitizeSession(body.session);
      // Session-level UTM / campaign tags, sanitized once and stamped on every row below. Absent
      // tags are null, so behavior is byte-identical for the existing UTM-less clients and tests.
      const utm = utmFromBody(body);

      if (!domain) {
         return res.status(400).json({ error: 'Domain is Required!' });
      }

      // Payload-size brake: reject an oversized events array outright (413) before sanitizing or
      // looping. This is distinct from the sanitizer's 50-event PROCESS cap; it stops a giant
      // array from being walked at all. A normal client never approaches this ceiling.
      const rawEventCount = Array.isArray(body.events) ? body.events.length : 0;
      if (rawEventCount > MAX_EVENTS_PER_BATCH) {
         return res.status(413).json({ error: 'Event batch too large.' });
      }

      // 2. Bot filtering: drop crawler / non-browser traffic up front.
      const userAgent = req.headers['user-agent'];
      if (isLikelyBotUA(typeof userAgent === 'string' ? userAgent : undefined)) {
         return res.status(200).json({ recorded: 0, skipped: 0, error: null });
      }

      // 4a. Sanitize + PII-strip the batch BEFORE any DB work. Invalid/PII events are dropped.
      // The session-level `source` (a classification or bare host) is sanitized and stamped on
      // every event. sanitizeSource downgrades anything URL-like to 'direct', so a full
      // referrer URL with PII in its query can never reach a row. Absent source -> 'direct'.
      const clean = sanitizeBatch(Array.isArray(body.events) ? body.events : [], undefined, body.source);
      const submitted = Array.isArray(body.events) ? body.events.length : 0;

      // 4b. Web-vitals (real-user Core Web Vitals) are an ADDITIVE event type handled on their own
      // path: sanitizeBatch drops them (webvital is not one of its six event types), so they are
      // extracted and validated here in parallel. The existing five-event path above is untouched.
      const rawEvents = Array.isArray(body.events) ? body.events : [];
      // The session-level first-touch source is identical for every webvital row, so resolve it once.
      const wvSource = sanitizeSource(body.source);
      const webvitals: CleanWebVital[] = [];
      // Cap webvitals at the same 50-event process budget the main path uses (sanitizeBatch's default
      // maxBatch), so the public ingest's abuse ceiling is symmetric across event types. The 413 brake
      // above already rejects any batch over MAX_EVENTS_PER_BATCH raw events.
      for (const raw of rawEvents.slice(0, 50)) {
         const wv = sanitizeWebVital(raw);
         if (wv) { webvitals.push(wv); }
      }

      if (clean.length === 0 && webvitals.length === 0) {
         // Nothing valid to store. Not an error from the client's point of view.
         return res.status(200).json({ recorded: 0, skipped: submitted, error: null });
      }

      // 3. Rate limit per (ip + domain). A flood is silently accepted-as-zero (200) so the
      // client does not retry-storm; it just stops being recorded for the window. (`ip` is
      // already derived at the top of this function for the per-IP request brake.) Web-vitals
      // count toward the same per-(ip+domain) row budget so the open endpoint stays bounded.
      if (!rateLimitCollect(ip, domain, clean.length + webvitals.length)) {
         return res.status(200).json({ recorded: 0, skipped: submitted, error: null });
      }

      // THE bot signal: classify the source IP as datacenter/hosting (utils/datacenter-ip.ts) and
      // stamp it on every row in this batch. The IP itself is never stored (cookieless, no PII);
      // only this derived boolean survives, and human-only analytics filter is_bot = false.
      const isBot = isDatacenterIp(ip);
      // Coarse, non-identifying segments for the device and geography filters (never the raw UA/IP).
      const device = deviceFromUA(typeof userAgent === 'string' ? userAgent : undefined);
      const country = countryFromHeaders(req.headers as Record<string, string | string[] | undefined>);

      // 1. Domain allow-listing: the domain must be a known s33k Domain. Unknown -> 403.
      // owner_id is read here so it can be stamped on every event row for tenant-scoped reads.
      const owned = await Domain.findOne({ where: { domain } });
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found' });
      }
      const ownerId = (owned.owner_id ?? null) as number | null;

      // 5 + skip-and-continue: store the batch. Build ALL rows (clean engagement events + the
      // additive web-vital rows) once, then insert them in ONE bulkCreate instead of N awaited
      // per-row creates. At scale a busy site posts batches constantly; one INSERT per batch
      // collapses the per-event round-trips into a single statement, bounding DB connection churn.
      // The UTM tags and segments are stamped on every row exactly as before, so each stored row is
      // byte-for-byte identical to what the old per-row create produced.
      const created = new Date().toJSON();
      const rows: Record<string, unknown>[] = clean.map((ev) => ({
         domain,
         owner_id: ownerId,
         type: ev.type,
         page: ev.page,
         label: ev.label,
         selector: ev.selector,
         value: ev.value,
         session,
         source: ev.source,
         // Session-level UTM tags spread onto every row (utm_source ... utm_content),
         // each already null when the landing URL carried no UTM params.
         ...utm,
         is_bot: isBot,
         device,
         country,
         created,
      }));
      // Web-vital rows, the additive type:'webvital' path. The numeric value lives in metric_value,
      // the metric name in label, value/selector left null/empty. Stamped with the same owner_id /
      // session / source / segments so they scope and attribute like every other row, and inserted in
      // the SAME bulk statement so the open ingest stays one write per batch across event types.
      for (const wv of webvitals) {
         rows.push({
            domain,
            owner_id: ownerId,
            type: 'webvital',
            page: wv.page,
            label: wv.label,
            metric_value: wv.metricValue,
            session,
            // Same session-level first-touch source the clean events carry (sanitizeBatch applied
            // it per-event from body.source; here we reuse the identical hoisted sanitizeSource result).
            source: wvSource,
            ...utm,
            is_bot: isBot,
            device,
            country,
            created,
         });
      }

      const recorded = await storeRows(rows, domain);

      // Total-failure honesty: reaching here guarantees there was at least one clean event OR
      // web-vital to store (the all-empty case already returned a clean 200 above). If NOT ONE
      // row stored across both loops, this is not a partial skip, it is a systemic write failure
      // (schema drift, DB down) that the per-row skip-and-continue would otherwise mask as a
      // healthy 200 recorded:0. Surface it as a 500 so monitoring sees the outage instead of "fine".
      if (recorded === 0) {
         return res.status(500).json({ recorded: 0, skipped: submitted, error: 'Failed to store any events.' });
      }

      return res.status(200).json({ recorded, skipped: submitted - recorded, error: null });
   } catch (error) {
      // Last-resort guard: even an unexpected failure returns a clean 400, never a stack trace.
      console.log('[ERROR] Collecting events: ', error);
      return res.status(400).json({ error: 'Error collecting events.' });
   }
};
