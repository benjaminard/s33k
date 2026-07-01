/**
 * Lightweight, dependency-free site crawler for s33k onboarding.
 *
 * Given a domain, this discovers important page URLs (sitemap.xml first, then a
 * homepage-link fallback), fetches each page, and extracts a compact summary
 * (title, meta description, h1/h2 headings, and a short text excerpt).
 *
 * Design constraints:
 *   - Plain server-side fetch + regex-based HTML parsing. No paid API, no
 *     headless browser, no Firecrawl key.
 *   - Capped at MAX_PAGES pages so one onboarding call stays cheap.
 *   - Never throws. Every failure (DNS, timeout, non-HTML, parse error) is
 *     swallowed and surfaced as an "error" field on the affected item or on the
 *     top-level result, so the LLM always gets a usable answer.
 *
 * The output is meant to be handed to the user's own connected LLM (over MCP),
 * which reads the page summaries and proposes target keywords itself. s33k does
 * not run any server-side LLM here.
 */

import { lookup } from 'dns/promises';

/** Maximum number of pages summarized in a single crawl. */
export const MAX_PAGES = 25;

// undici is loaded LAZILY (a cached require), never at module top.
//
// Importing undici statically eagerly pulls in its web/fetch internals, which reference globals
// (MessagePort) absent in the jsdom test environment and risk the same standalone-bundle footgun
// CLAUDE.md documents for runtime requires. We only need its Agent to PIN the SSRF-validated IP, so
// we require it on first use and cache it. If it cannot load (e.g. jsdom under jest), we degrade to
// the still-strong resolve-and-revalidate guard (isResolvedHostPublic + per-redirect re-checks),
// so the code is correct everywhere and pins for real in production.
type UndiciAgentCtor = new (opts: unknown) => { close: () => Promise<void> };
let undiciAgent: UndiciAgentCtor | null | undefined;
const loadUndiciAgent = (): UndiciAgentCtor | null => {
   if (undiciAgent !== undefined) { return undiciAgent; }
   try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      undiciAgent = require('undici').Agent as UndiciAgentCtor;
   } catch {
      undiciAgent = null;
   }
   return undiciAgent;
};

/** Per-request fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 10000;

/** Max redirect hops we follow (and revalidate) before giving up. */
const MAX_REDIRECTS = 4;

/**
 * Hard ceiling on a fetched body, in bytes. The crawler fetches a caller-supplied domain, so a
 * malicious or accidentally-huge page could otherwise buffer hundreds of MB into memory (a cheap
 * memory-pressure vector as the product moves to untrusted multi-tenant API keys). We stream and
 * abort once this ceiling is crossed. Page text for keyword discovery never needs more than this.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Read a response body as text, but abort once MAX_BODY_BYTES is exceeded so an oversized page cannot
 * exhaust memory. Falls back to res.text() when the body is not a readable stream (older runtimes).
 * @param {Response} res - A fetch Response whose body we want as bounded text.
 * @returns {Promise<string | null>} Decoded text, or null when the cap is exceeded or read fails.
 */
const readBoundedText = async (res: Response): Promise<string | null> => {
   const body = res.body as ReadableStream<Uint8Array> | null;
   if (!body || typeof body.getReader !== 'function') {
      // No stream available: fall back to the full read, then enforce the cap on the decoded length.
      const text = await res.text();
      return text.length > MAX_BODY_BYTES ? null : text;
   }
   const reader = body.getReader();
   const chunks: Uint8Array[] = [];
   let total = 0;
   try {
      for (;;) {
         // eslint-disable-next-line no-await-in-loop
         const { done, value } = await reader.read();
         if (done) { break; }
         if (value) {
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); return null; }
            chunks.push(value);
         }
      }
   } catch {
      return null;
   }
   return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
};

/** A realistic, honest user agent so well-behaved sites do not block us. */
const USER_AGENT = 's33k-onboarding-crawler/0.1 (+https://github.com/s33k)';

export type PageSummary = {
   url: string,
   path: string,
   title: string,
   metaDescription: string,
   h1: string[],
   h2: string[],
   excerpt: string,
   error?: string,
};

export type SiteCrawlResult = {
   domain: string,
   homeUrl: string,
   discoveredVia: 'sitemap' | 'homepage-links' | 'homepage-only',
   pageCount: number,
   pages: PageSummary[],
   error?: string,
};

/**
 * Normalize a user-supplied domain into a clean hostname (no scheme, no path,
 * no trailing slash, lowercased).
 * @param {string} input - Raw domain or URL the caller passed.
 * @returns {string} A bare hostname, e.g. "example.com".
 */
const normalizeDomain = (input: string): string => String(input || '')
   .trim()
   .toLowerCase()
   .replace(/^https?:\/\//, '')
   .replace(/^www\./, '')
   .replace(/\/.*$/, '')
   .replace(/\/$/, '');

/**
 * SSRF guard. Returns true when a hostname is safe to fetch (a public host) and
 * false when it targets loopback, private, link-local, or cloud-metadata space.
 *
 * This crawler fetches a caller-supplied domain server-side, so without this
 * guard a caller could point it at internal infrastructure (e.g. localhost, an
 * RFC1918 address, or the 169.254.169.254 cloud-metadata endpoint) and read the
 * response back. The product is moving to multi-tenant hosting where API keys are
 * held by untrusted tenants, so block those targets up front. The check is on the
 * literal hostname only (it does not resolve DNS), which blocks the obvious
 * literal-IP and localhost cases cheaply; DNS-rebind / redirect-to-internal is a
 * known residual the hosted deployment should additionally pin at the network
 * egress layer.
 * @param {string} hostname - The URL hostname (already lowercased by URL).
 * @returns {boolean} True if safe to fetch.
 */
// True if a numeric IPv4 (by its first two octets) is in a private/reserved/
// link-local/metadata/multicast range that must never be fetched server-side.
const isPrivateIpv4 = (a: number, b: number): boolean => {
   if (a === 127 || a === 10 || a === 0) { return true; }
   if (a === 169 && b === 254) { return true; } // link-local incl. 169.254.169.254 metadata
   if (a === 172 && b >= 16 && b <= 31) { return true; }
   if (a === 192 && b === 168) { return true; }
   if (a === 100 && b >= 64 && b <= 127) { return true; } // CGNAT
   if (a >= 224) { return true; } // multicast + reserved
   return false;
};

/**
 * True if a raw IP literal (IPv4, IPv6, or IPv4-mapped IPv6 in dotted OR hex form)
 * is private/reserved/loopback/link-local. Unknown shapes are treated as unsafe.
 * IPv4-mapped IPv6 (::ffff:10.0.0.1 / ::ffff:0a00:0001) is the form the previous
 * literal-only guard missed (security review #1).
 * @param {string} ip - An IP literal.
 * @returns {boolean} True if the IP must not be fetched.
 */
export const isPrivateIp = (ip: string): boolean => {
   const host = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
   if (!host) { return true; }
   if (host === '::1' || host === '::' || host === '0.0.0.0') { return true; }
   const mappedDotted = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
   if (mappedDotted) { return isPrivateIpv4(Number(mappedDotted[1]), Number(mappedDotted[2])); }
   const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
   if (mappedHex) { const hi = parseInt(mappedHex[1], 16); return isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff); }
   const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
   if (v4) { return isPrivateIpv4(Number(v4[1]), Number(v4[2])); }
   // IPv6 unique-local (fc/fd) and link-local (fe80::/10 -> fe8/fe9/fea/feb).
   if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) { return true; }
   return false;
};

/**
 * SSRF guard on the LITERAL hostname (no DNS). Cheap first gate: blocks localhost,
 * .local names, and private/reserved IP literals (incl. IPv4-mapped IPv6). A bare
 * hostname passes here; it is resolved and re-checked in isResolvedHostPublic
 * before any fetch.
 * @param {string} hostname - The URL hostname.
 * @returns {boolean} True if safe at the literal level.
 */
export const isPublicHostname = (hostname: string): boolean => {
   const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
   if (!host) { return false; }
   if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) { return false; }
   const looksLikeIp = /^[0-9.]+$/.test(host) || host.includes(':');
   if (looksLikeIp) { return !isPrivateIp(host); }
   return true;
};

/**
 * SSRF guard that RESOLVES the hostname and requires EVERY resolved address to be
 * public. Closes the DNS-rebind / hostname-points-at-private hole the literal-only
 * check cannot (security review #1). Never throws; a resolution failure is unsafe.
 * @param {string} hostname - The URL hostname.
 * @returns {Promise<boolean>} True only if safe to fetch.
 */
export const isResolvedHostPublic = async (hostname: string): Promise<boolean> => {
   const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
   if (!host) { return false; }
   if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) { return false; }
   const looksLikeIp = /^[0-9.]+$/.test(host) || host.includes(':');
   if (looksLikeIp) { return !isPrivateIp(host); }
   try {
      const addresses = await lookup(host, { all: true });
      if (!addresses || addresses.length === 0) { return false; }
      return addresses.every((a) => !isPrivateIp(a.address));
   } catch {
      return false;
   }
};

/**
 * Resolve a hostname to a SINGLE validated public IP and return an undici dispatcher that PINS the
 * connection to exactly that IP.
 *
 * SECURITY (DNS-rebinding TOCTOU, audit area 2): validating a hostname with a DNS lookup and then
 * calling fetch() by hostname lets fetch re-resolve, so an attacker domain with a low TTL can answer
 * the guard's lookup with a public IP and answer fetch's lookup milliseconds later with a private /
 * metadata IP. Pinning fetch to the address WE validated closes that window: the dispatcher's
 * connect.lookup ignores any later DNS answer and connects only to the pre-validated IP, while TLS
 * still uses the original hostname for SNI and certificate validation. Returns null when no resolved
 * address is public (the host fails the guard), so the caller refuses the fetch.
 * @param {string} hostname - The URL hostname to resolve and pin.
 * @returns {Promise<{ dispatcher: Agent } | null>} A pinned dispatcher, or null if unsafe.
 */
type PinResult = { dispatcher: { close: () => Promise<void> } | null, ok: boolean };
// undici's connect.lookup follows Node's dns.lookup contract, which has two callback shapes depending
// on whether the caller asked for `{ all: true }`. We must satisfy both or the pinned connection fails.
type LookupCallback = {
   (err: Error | null, address: string, family: number): void,
   (err: Error | null, addresses: Array<{ address: string, family: number }>): void,
};

/**
 * Build the undici connect.lookup that pins to exactly one pre-validated IP. undici calls this with
 * Node's dns.lookup contract: when it passes `{ all: true }` it expects the ARRAY form
 * `[{ address, family }]`, otherwise the 3-arg `(address, family)` form. Returning the wrong shape for
 * `{ all: true }` silently fails the connection (real symptom: fetches to Vercel / CDN-fronted hosts
 * like example.com threw "fetch failed" and the crawler reached 0 pages). Handle both shapes.
 * @param {string} ip - The single pre-vetted public IP to pin the connection to.
 * @param {number} family - The IP family (4 or 6).
 * @returns {Function} A lookup function honoring both dns.lookup callback shapes.
 */
export const pinnedLookup = (ip: string, family: number) => (
   _hostname: string,
   opts: { all?: boolean } | undefined,
   cb: LookupCallback,
): void => {
   if (opts && opts.all) { cb(null, [{ address: ip, family }]); }
   else { cb(null, ip, family); }
};

const pinnedDispatcherFor = async (hostname: string): Promise<PinResult> => {
   const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
   if (!host) { return { dispatcher: null, ok: false }; }
   // Explicit name reject FIRST (mirrors isResolvedHostPublic): localhost and the .local / .localhost
   // suffixes never reach a public address and must be refused before any DNS lookup.
   if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      return { dispatcher: null, ok: false };
   }
   // A literal IP host cannot be rebound (no DNS step), so validate it directly and pin to itself.
   const looksLikeIp = /^[0-9.]+$/.test(host) || host.includes(':');
   let pinnedIp: string;
   let family: number;
   if (looksLikeIp) {
      if (isPrivateIp(host)) { return { dispatcher: null, ok: false }; }
      pinnedIp = host;
      family = host.includes(':') ? 6 : 4;
   } else {
      let addresses;
      try { addresses = await lookup(host, { all: true }); } catch { return { dispatcher: null, ok: false }; }
      if (!addresses || addresses.length === 0) { return { dispatcher: null, ok: false }; }
      // EVERY resolved address must be public (a mixed answer is treated as hostile), then pin to
      // the first. Pinning to one means fetch connects to exactly the IP we vetted, not a re-resolve.
      if (!addresses.every((a) => !isPrivateIp(a.address))) { return { dispatcher: null, ok: false }; }
      pinnedIp = addresses[0].address;
      family = addresses[0].family;
   }
   // Host validated. Build the pinned dispatcher if undici is available: its connect.lookup is called
   // by undici instead of system DNS and returns ONLY the pre-validated IP, so no later DNS answer
   // can take effect (closes the rebind window). If undici is not loadable (jsdom/test), ok stays
   // true (the host IS validated) with a null dispatcher, and the caller fetches via the normal path
   // already guarded by this same resolve-and-revalidate logic.
   const AgentCtor = loadUndiciAgent();
   if (!AgentCtor) { return { dispatcher: null, ok: true }; }
   const dispatcher = new AgentCtor({ connect: { lookup: pinnedLookup(pinnedIp, family) } });
   return { dispatcher, ok: true };
};

/**
 * Fetch a URL as text with a timeout. Never throws; returns null on any failure
 * or non-2xx response. Refuses non-http(s) schemes and non-public hosts (SSRF
 * guard) before making any network call.
 * @param {string} url - Absolute URL to fetch.
 * @param {string} [accept] - Optional Accept header.
 * @returns {Promise<string | null>} The response body text, or null.
 */
export const safeFetchText = async (url: string, accept?: string): Promise<string | null> => {
   let current = url;
   // Follow redirects MANUALLY so every destination (initial + each Location) is re-validated
   // through the DNS-resolving guard. With redirect:'follow', a public URL that 30x-redirects to
   // an internal host would slip past a one-time check (security review #1).
   for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let parsed: URL;
      try { parsed = new URL(current); } catch { return null; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return null; }
      // Resolve + validate ONCE and pin the connection to that exact IP, so the fetch below cannot
      // re-resolve to a different (internal) address between the check and the connect (audit area 2).
      // pinned.ok is the SSRF gate (host validated); pinned.dispatcher pins the IP when available.
      // eslint-disable-next-line no-await-in-loop
      const pinned = await pinnedDispatcherFor(parsed.hostname);
      if (!pinned.ok) { return null; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
         // eslint-disable-next-line no-await-in-loop
         const res = await fetch(current, {
            headers: { 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) },
            signal: controller.signal,
            redirect: 'manual',
            // dispatcher pins the validated IP when undici is available; omitted otherwise. It is a
            // valid undici fetch option not present in the lib DOM RequestInit types, so the options
            // object is widened to carry it without a type error.
            ...(pinned.dispatcher ? { dispatcher: pinned.dispatcher } : {}),
         } as RequestInit & { dispatcher?: unknown });
         if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) { return null; }
            // Resolve the next hop relative to current, then loop so it is re-validated and re-pinned.
            current = new URL(location, current).toString();
            continue;
         }
         if (!res.ok) { return null; }
         // Stream with a byte ceiling so an attacker-controlled domain serving a giant body cannot
         // exhaust memory (audit: unbounded res.text() on a caller-supplied domain).
         // eslint-disable-next-line no-await-in-loop
         return await readBoundedText(res);
      } catch {
         return null;
      } finally {
         clearTimeout(timer);
         // Close the per-hop pinned dispatcher (if any) so its sockets do not leak. Best-effort.
         // eslint-disable-next-line no-await-in-loop
         if (pinned.dispatcher) { await pinned.dispatcher.close().catch(() => {}); }
      }
   }
   return null; // exceeded MAX_REDIRECTS
};

/**
 * Strip HTML tags and collapse whitespace from a fragment of markup.
 * @param {string} html - Raw HTML.
 * @returns {string} Plain text, whitespace-collapsed.
 */
const stripTags = (html: string): string => html
   .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
   .replace(/<!--[\s\S]*?-->/g, ' ')
   .replace(/<[^>]+>/g, ' ')
   .replace(/&nbsp;/gi, ' ')
   .replace(/&amp;/gi, '&')
   .replace(/&lt;/gi, '<')
   .replace(/&gt;/gi, '>')
   .replace(/&quot;/gi, '"')
   .replace(/&#39;/gi, "'")
   .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ' '; } })
   .replace(/&#(\d+);/g, (_m, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ' '; } })
   .replace(/\s+/g, ' ')
   .trim();

/**
 * Extract all loc URLs from a sitemap or sitemap-index XML body.
 * @param {string} xml - Raw sitemap XML.
 * @returns {string[]} The list of <loc> URLs found.
 */
const extractLocs = (xml: string): string[] => {
   const locs: string[] = [];
   const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
   let m = re.exec(xml);
   while (m) {
      locs.push(m[1].trim());
      m = re.exec(xml);
   }
   return locs;
};

/**
 * Discover page URLs for a domain via sitemap.xml, following one level of
 * sitemap-index nesting. Returns an empty array if no sitemap is reachable.
 * @param {string} origin - The https origin, e.g. "https://example.com".
 * @returns {Promise<string[]>} Discovered absolute page URLs.
 */
const discoverFromSitemap = async (origin: string): Promise<string[]> => {
   const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
   for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const xml = await safeFetchText(candidate, 'application/xml,text/xml');
      if (!xml) { continue; }
      const locs = extractLocs(xml);
      if (locs.length === 0) { continue; }

      // If the sitemap points at other sitemaps (a sitemap index), pull the
      // first few child sitemaps and flatten their page URLs.
      const isIndex = /<sitemapindex/i.test(xml) || locs.some((l) => /\.xml(\?|$)/i.test(l));
      if (isIndex) {
         const pages: string[] = [];
         const childSitemaps = locs.filter((l) => /\.xml(\?|$)/i.test(l)).slice(0, 5);
         for (const child of childSitemaps) {
            // eslint-disable-next-line no-await-in-loop
            const childXml = await safeFetchText(child, 'application/xml,text/xml');
            if (childXml) { pages.push(...extractLocs(childXml).filter((l) => !/\.xml(\?|$)/i.test(l))); }
            if (pages.length >= MAX_PAGES * 2) { break; }
         }
         // Some indexes also list real pages directly; include those too.
         pages.push(...locs.filter((l) => !/\.xml(\?|$)/i.test(l)));
         if (pages.length > 0) { return pages; }
      }
      return locs.filter((l) => !/\.xml(\?|$)/i.test(l));
   }
   return [];
};

/**
 * Discover page URLs by scraping same-origin anchor hrefs from the homepage.
 * Used when no sitemap is available.
 * @param {string} origin - The https origin.
 * @param {string} homeHtml - The fetched homepage HTML.
 * @returns {string[]} Discovered absolute, same-origin page URLs.
 */
const discoverFromHomepage = (origin: string, homeHtml: string): string[] => {
   const host = origin.replace(/^https?:\/\//, '');
   const found = new Set<string>();
   const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
   let m = re.exec(homeHtml);
   while (m) {
      const raw = m[1].trim();
      let abs: string | null = null;
      try {
         if (raw.startsWith('http://') || raw.startsWith('https://')) {
            const u = new URL(raw);
            if (u.hostname.replace(/^www\./, '') === host.replace(/^www\./, '')) { abs = u.toString(); }
         } else if (raw.startsWith('/')) {
            abs = `${origin}${raw}`;
         }
      } catch {
         abs = null;
      }
      if (abs && !/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|xml|json|woff2?|ttf|mp4|webm)(\?|$)/i.test(abs)) {
         // Drop the fragment/query for de-duplication of the same page.
         found.add(abs.replace(/[?#].*$/, ''));
      }
      m = re.exec(homeHtml);
   }
   return Array.from(found);
};

/**
 * Extract a compact summary from a page's HTML.
 * @param {string} url - The absolute page URL.
 * @param {string} html - The fetched HTML body.
 * @returns {PageSummary} The structured summary.
 */
const summarizePage = (url: string, html: string): PageSummary => {
   let path = url;
   try { path = new URL(url).pathname || '/'; } catch { /* keep url */ }

   const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
   const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 300) : '';

   const descMatch = /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(html)
      || /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i.exec(html);
   let metaDescription = '';
   if (descMatch) {
      const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(descMatch[0]);
      if (contentMatch) { metaDescription = stripTags(contentMatch[1]).slice(0, 500); }
   }

   const collectHeadings = (tag: 'h1' | 'h2'): string[] => {
      const out: string[] = [];
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
      let hm = re.exec(html);
      while (hm && out.length < 10) {
         const text = stripTags(hm[1]);
         if (text) { out.push(text.slice(0, 200)); }
         hm = re.exec(html);
      }
      return out;
   };

   // Excerpt: prefer the <body> text, fall back to the whole doc.
   const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
   const excerpt = stripTags(bodyMatch ? bodyMatch[1] : html).slice(0, 600);

   return {
      url,
      path,
      title,
      metaDescription,
      h1: collectHeadings('h1'),
      h2: collectHeadings('h2'),
      excerpt,
   };
};

/**
 * Rank/prune discovered URLs to a tidy, representative set. Prefers shorter
 * paths (closer to the root, usually the important hub pages), drops obvious
 * non-content paths, de-duplicates, and caps the list.
 * @param {string[]} urls - Raw discovered URLs.
 * @param {string} homeUrl - The homepage URL, always kept first.
 * @returns {string[]} A pruned, ordered URL list.
 */
const prioritize = (urls: string[], homeUrl: string): string[] => {
   const seen = new Set<string>();
   const cleaned: string[] = [];
   const all = [homeUrl, ...urls];
   for (const u of all) {
      // Normalize away scheme, www., query/fragment, and trailing slash so that
      // homepage and host variants (e.g. "https://x.com/" vs "https://www.x.com")
      // collapse to one entry.
      const key = u
         .replace(/^https?:\/\//, '')
         .replace(/^www\./, '')
         .replace(/[?#].*$/, '')
         .replace(/\/$/, '') || u;
      if (seen.has(key)) { continue; }
      if (/\/(wp-admin|wp-json|cdn-cgi|feed|tag\/|category\/|author\/)/i.test(u)) { continue; }
      seen.add(key);
      cleaned.push(u);
   }
   const home = cleaned[0];
   const rest = cleaned.slice(1).sort((a, b) => {
      const depth = (s: string) => (s.replace(/^https?:\/\/[^/]+/, '').match(/\//g) || []).length;
      const da = depth(a);
      const db = depth(b);
      if (da !== db) { return da - db; }
      return a.length - b.length;
   });
   return [home, ...rest].slice(0, MAX_PAGES);
};

/**
 * Crawl a domain and return compact per-page summaries.
 *
 * Tries https first; discovers URLs via sitemap.xml, falling back to homepage
 * links, then to the homepage alone. Fetches each selected page and extracts a
 * summary. Never throws.
 * @param {string} domainInput - Raw domain or URL, e.g. "example.com".
 * @returns {Promise<SiteCrawlResult>} The crawl result with page summaries.
 */
export async function crawlSite(domainInput: string): Promise<SiteCrawlResult> {
   const domain = normalizeDomain(domainInput);
   if (!domain) {
      return {
         domain: String(domainInput || ''),
         homeUrl: '',
         discoveredVia: 'homepage-only',
         pageCount: 0,
         pages: [],
         error: 'A valid domain is required.',
      };
   }

   const origin = `https://${domain}`;
   const homeUrl = `${origin}/`;

   const homeHtml = await safeFetchText(homeUrl, 'text/html');
   if (homeHtml === null) {
      return {
         domain,
         homeUrl,
         discoveredVia: 'homepage-only',
         pageCount: 0,
         pages: [],
         error: `Could not reach ${homeUrl}. The domain may be unreachable, blocking crawlers, or not served over https.`,
      };
   }

   let discoveredVia: SiteCrawlResult['discoveredVia'] = 'homepage-only';
   let urls = await discoverFromSitemap(origin);
   if (urls.length > 0) {
      discoveredVia = 'sitemap';
   } else {
      urls = discoverFromHomepage(origin, homeHtml);
      if (urls.length > 0) { discoveredVia = 'homepage-links'; }
   }

   const selected = prioritize(urls, homeUrl);

   // Fetch and summarize each selected page. The homepage HTML is already in
   // hand, so reuse it instead of re-fetching.
   const pages: PageSummary[] = [];
   for (const url of selected) {
      let html: string | null;
      if (url === homeUrl || url.replace(/\/$/, '') === homeUrl.replace(/\/$/, '')) {
         html = homeHtml;
      } else {
         // eslint-disable-next-line no-await-in-loop
         html = await safeFetchText(url, 'text/html');
      }
      if (html === null) {
         let path = url;
         try { path = new URL(url).pathname || '/'; } catch { /* keep url */ }
         pages.push({ url, path, title: '', metaDescription: '', h1: [], h2: [], excerpt: '', error: 'Could not fetch this page.' });
         continue;
      }
      pages.push(summarizePage(url, html));
   }

   return {
      domain,
      homeUrl,
      discoveredVia,
      pageCount: pages.length,
      pages,
   };
}
