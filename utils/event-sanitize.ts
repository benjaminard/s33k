/**
 * Server-side sanitization and PII defense-in-depth for autocaptured engagement events.
 *
 * The s33k.js client is already built to never read input/textarea/select/contenteditable
 * values, so a well-behaved client never sends PII. This module is the SECOND layer: it runs
 * at the /api/collect ingest, assumes the incoming payload is hostile, and guarantees that
 * nothing PII-shaped is ever written to the s33k_event table. The privacy promise ("capture
 * the event, never the PII") must hold even if a tampered or buggy client posts field values.
 *
 * Nothing here throws. Bad input degrades to a dropped field or a dropped event, never an
 * exception, so the ingest endpoint can stay a never-500 skip-and-continue loop.
 */

/** The event types s33k autocaptures. Anything else is rejected at ingest. 'pageview' is the
 *  first-party page-load signal that powers human-only traffic, bounce, and exit-rate analytics
 *  (each pageview row carries the IP-derived is_bot flag, so bots can be excluded at read time). */
export const EVENT_TYPES = ['pageview', 'click', 'form_submit', 'scroll', 'engagement', 'outbound'] as const;
export type EventType = typeof EVENT_TYPES[number];

/** Max stored length of a label / selector. Long blobs are a PII smell and are truncated. */
export const MAX_LABEL_LEN = 120;
export const MAX_SELECTOR_LEN = 160;
export const MAX_PAGE_LEN = 512;
export const MAX_SESSION_LEN = 64;

/**
 * PII-shaped patterns. If a label matches any of these, the WHOLE event is dropped (not just
 * scrubbed) because the only way that text reached us is a misbehaving client reading a value
 * it should never read. Dropping is the safe choice: a lost event beats a stored email.
 */
const PII_PATTERNS: readonly RegExp[] = [
   // Email address.
   /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
   // Credit-card-like run of 13-19 digits, optionally space/dash separated.
   /\b(?:\d[ -]?){13,19}\b/,
   // US SSN.
   /\b\d{3}-\d{2}-\d{4}\b/,
   // Phone-like: a contiguous run of digits and common phone separators (space, dash,
   // parens, plus, dot) that contains at least 10 separator-or-digit chars. Matches
   // "+1 (415) 555-2671" as well as "4155552671".
   /\+?[\d][\d().\s-]{8,}\d/,
];

/** Coerce to a trimmed string; non-strings become ''. Never throws. */
const asString = (value: unknown): string => {
   if (typeof value === 'string') { return value.trim(); }
   if (typeof value === 'number' && Number.isFinite(value)) { return String(value); }
   return '';
};

/**
 * Collapse whitespace and truncate. Control characters are stripped so a label can never
 * carry newline-injected junk into logs or storage.
 * @param {string} value - Raw text.
 * @param {number} max - Max output length.
 * @returns {string}
 */
export const sanitizeText = (value: unknown, max: number): string => {
   const s = asString(value)
      // Strip ASCII control characters (newlines, tabs, NUL, DEL) so a label can never
      // inject junk into logs or storage. Hex-escaped to avoid literal control bytes.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
   return s.length > max ? s.slice(0, max) : s;
};

/**
 * Does this text look like PII? Used to DROP an event rather than store it.
 * @param {string} value - Sanitized text.
 * @returns {boolean}
 */
export const looksLikePII = (value: string): boolean => {
   if (!value) { return false; }
   return PII_PATTERNS.some((re) => re.test(value));
};

/** Keep only the path of a URL/path string: strip origin, query, and hash. Never throws. */
export const cleanEventPath = (value: unknown): string => {
   let s = asString(value);
   if (!s) { return ''; }
   // Drop a leading origin if a full URL was sent.
   s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
   // Drop query string and hash; both can carry PII (e.g. ?email=...).
   s = s.replace(/[?#].*$/, '');
   if (!s.startsWith('/')) { s = `/${s}`; }
   return sanitizeText(s, MAX_PAGE_LEN);
};

/** A raw event as it may arrive in a POST /api/collect batch (all fields untrusted). */
export type RawEvent = {
   type?: unknown,
   page?: unknown,
   label?: unknown,
   selector?: unknown,
   value?: unknown,
};

/** A validated, sanitized, PII-free event ready to persist (minus domain/owner/session). */
export type CleanEvent = {
   type: EventType,
   page: string,
   label: string,
   selector: string,
   value: number | null,
   // The session's first-touch source class (or bare host). Applied at batch level from the
   // single session-level source the client computed once; never per-event PII.
   source: SourceValue,
};

/**
 * Validate and sanitize one raw event. Returns null when the event is invalid or PII-shaped,
 * so the caller can skip-and-continue. Never throws.
 *
 * Rules:
 *   - type must be one of the five known types, else drop.
 *   - label/selector are whitespace-collapsed and truncated. If EITHER looks like PII, the
 *     whole event is dropped (a tampered client tried to smuggle a value).
 *   - value is kept only for scroll (clamped 0..100) and engagement (clamped 0..86400s); it
 *     is forced to null for every other type. Non-finite values become null.
 *   - page is reduced to a path with query/hash removed.
 *
 * @param {RawEvent} raw - One untrusted event from the batch.
 * @param {SourceValue} [source] - The session's already-sanitized first-touch source to stamp
 *                                 on the event. Defaults to 'direct'.
 * @returns {CleanEvent | null}
 */
export const sanitizeEvent = (raw: RawEvent, source: SourceValue = 'direct'): CleanEvent | null => {
   if (!raw || typeof raw !== 'object') { return null; }

   const type = asString(raw.type).toLowerCase();
   if (!(EVENT_TYPES as readonly string[]).includes(type)) { return null; }

   const label = sanitizeText(raw.label, MAX_LABEL_LEN);
   const selector = sanitizeText(raw.selector, MAX_SELECTOR_LEN);

   // Defense-in-depth: if a client smuggled a typed value into label/selector, drop the row.
   if (looksLikePII(label) || looksLikePII(selector)) { return null; }

   const page = cleanEventPath(raw.page);

   let value: number | null = null;
   const rawNum = Number(raw.value);
   if (Number.isFinite(rawNum)) {
      if (type === 'scroll') {
         value = Math.max(0, Math.min(100, Math.round(rawNum)));
      } else if (type === 'engagement') {
         // Cap at 24h of active time per event; anything beyond is bogus.
         value = Math.max(0, Math.min(86400, Math.round(rawNum)));
      }
   }

   // The source is re-sanitized here so a caller that passes a raw value still gets a safe one.
   return { type: type as EventType, page, label, selector, value, source: sanitizeSource(source) };
};

/**
 * Sanitize a whole batch. Invalid/PII events are dropped silently. The batch size is capped
 * so a single POST cannot dump unbounded rows. Never throws.
 * @param {unknown} events - The raw events array from the request body.
 * @param {number} [maxBatch] - Max events processed from one POST.
 * @param {unknown} [source] - The session-level first-touch source, stamped on every event in
 *                             the batch after being sanitized to a class label or bare host.
 * @returns {CleanEvent[]}
 */
export const sanitizeBatch = (events: unknown, maxBatch = 50, source?: unknown): CleanEvent[] => {
   if (!Array.isArray(events)) { return []; }
   const sessionSource = sanitizeSource(source);
   const clean: CleanEvent[] = [];
   for (const raw of events.slice(0, maxBatch)) {
      const ok = sanitizeEvent(raw as RawEvent, sessionSource);
      if (ok) { clean.push(ok); }
   }
   return clean;
};

/** Sanitize the cookieless session id: keep a short, safe token only. */
export const sanitizeSession = (value: unknown): string => {
   const s = asString(value).replace(/[^a-zA-Z0-9_-]/g, '');
   return s.slice(0, MAX_SESSION_LEN);
};

/**
 * The four allowed first-touch source CLASSES. These are classifications, never URLs. The
 * client computes one of these once per session from document.referrer and carries it on
 * the batch; the value attributed to each event is one of these or, for an external referral,
 * the bare referrer host (e.g. "news.ycombinator.com"). Note: 'organic-search' is the stored
 * class label for traditional search engines (the AI-referral classifier elsewhere uses the
 * shorter 'search'; this column keeps the user-facing 'organic-search' label).
 */
export const SOURCE_CLASSES = ['direct', 'referral', 'organic-search', 'ai'] as const;
export type SourceValue = typeof SOURCE_CLASSES[number] | string;

/** Max stored length of a source value. A bare host is short; anything longer is a smell. */
export const MAX_SOURCE_LEN = 120;

/**
 * Is this string a bare hostname (e.g. "news.ycombinator.com")? Used to allow a referral
 * host while rejecting anything URL-shaped. Deliberately strict: it must contain a dot, only
 * host-legal characters (letters, digits, dot, hyphen, optional :port), and NO path, query,
 * scheme, '@', or whitespace. Anything with a '/', '?', '#', '://', or '@' is rejected as a
 * potential PII carrier, never stored.
 */
const isBareHost = (value: string): boolean => {
   if (!value || value.length > MAX_SOURCE_LEN) { return false; }
   // Reject anything that is not purely host-and-optional-port shaped.
   if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value)) { return false; }
   // Must look like a real host: at least one dot with a 2+ char TLD-ish tail.
   return /\.[a-z]{2,}$/.test(value.split(':')[0]);
};

/**
 * Validate and normalize the session entry SOURCE for storage. This is the privacy gate for
 * the source column: it returns ONLY one of the four allowed class labels or a bare host, and
 * defaults to 'direct' for anything missing, URL-like, or otherwise unparseable. A full
 * referrer URL with a path or query (which could carry PII like ?email=...) is NEVER stored;
 * it is downgraded to 'direct'. Never throws.
 * @param {unknown} value - The untrusted source from the batch.
 * @returns {SourceValue} One of the four classes, or a bare host, never a URL.
 */
export const sanitizeSource = (value: unknown): SourceValue => {
   const raw = asString(value).toLowerCase();
   if (!raw) { return 'direct'; }
   if ((SOURCE_CLASSES as readonly string[]).includes(raw)) { return raw; }
   // Anything URL-shaped or carrying a path/query/credential is dropped to 'direct'.
   if (isBareHost(raw) && !looksLikePII(raw)) { return raw; }
   return 'direct';
};
