/**
 * Firecrawl-backed keyword recommendation for s33k onboarding.
 *
 * THE GOAL: a user enters their domain and, from a single scrape, s33k recommends the top ~50
 * keyword phrases they should track, so they never type a keyword by hand: they just say "yes".
 *
 * THE METHOD (encoded in the extract prompt below): look at the business/brand name, read the page
 * <title> tags to infer what each page targets, identify the pillar pages (the main product/service/
 * content pages) and infer the phrases those pages are trying to rank for. Prefer multi-word
 * commercial/informational phrases a real searcher types, not brand words or nav labels.
 *
 * HOW: Firecrawl does both the scrape AND the LLM synthesis (its /extract endpoint), so s33k needs
 * only the FIRECRAWL_API_KEY (no separate LLM key). We bound cost + latency by mapping the site
 * first (cheap), selecting the homepage plus a small set of pillar URLs, and running /extract over
 * just those, not the whole site.
 *
 * SAFETY: never throws. Every failure (no key, map error, extract error, timeout, malformed result)
 * resolves to { keywords: [], error } so onboarding can fall back to the heuristic discoverKeywords
 * and never 500s. Firecrawl fetches the pages server-side on its own infrastructure, so the SSRF
 * surface is Firecrawl's, not ours; we still only ever send a canonicalized public domain.
 */

import type { CrawlPage } from './keyword-grader';

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

// How many pillar pages we /scrape for content (the crawl the grader scores against). Kept equal to
// MAX_PILLAR_URLS (15) so the grader judges relevance against the SAME pages the candidates were drawn
// from: scoring against fewer pages than the extractor saw could orphan a candidate that maps to a
// deeper pillar page. The scrapes run CONCURRENTLY with /extract so they add no wall-clock, and each
// page's text is truncated to keep the grader's corpus bounded.
const MAX_SCRAPE_PAGES = 15;
const SCRAPE_TEXT_CAP = 6000;

// Total wall-clock budget for the whole map+extract during onboarding, measured from the start of
// extractKeywords (it bounds the map call, the extract start, AND the poll loop). Kept WELL UNDER the
// request envelope: onboard is called synchronously over the MCP transport / the app, and an MCP
// client or gateway will cut a request long before a minute, so a 90s budget would make the request
// die above us and hide the graceful heuristic fallback from the user. 30s lives inside a typical 60s
// client/gateway timeout and still gives Firecrawl a fair chance on a normal site; a slower site falls
// back to the heuristic (still useful, just less magic). The truly-correct fix for very-slow sites is
// an async "keywords arriving shortly" extract polled from a second call (roadmap), not a longer block.
const EXTRACT_BUDGET_MS = 30000;
// Per-HTTP-call timeout (map, the extract POST, and each poll GET). Kept below the total budget so the
// pre-loop map + extract-start cannot, in the worst case, consume the entire budget before polling.
const CALL_TIMEOUT_MS = 12000;
// Poll cadence while the async extract job runs.
const POLL_INTERVAL_MS = 3000;
// Max pillar URLs we send to /extract. Bounds Firecrawl cost + latency per onboard. Homepage is
// always included; the rest are the shallowest content pages.
const MAX_PILLAR_URLS = 15;
// Hard ceiling on recommended keywords. This is an INDEPENDENT ceiling, not the source of truth: the
// per-site keyword allowance lives in utils/plans.ts and the onboard caller re-derives and clamps to
// the account's real REMAINING allowance, so if that allowance ever changes this 50 just trims and
// the clamp still governs. 50 happens to match today's per-site allowance.
const MAX_KEYWORDS = 50;
// Defensive ceiling on how many mapped URLs we even sort/scan: a pathological sitemap could return
// tens of thousands of links. We only ever keep MAX_PILLAR_URLS, so cap the input before the sort.
const MAX_MAP_LINKS = 2000;

export type RecommendedKeyword = { keyword: string, targetPage: string };
export type FirecrawlResult = {
   businessName: string,
   keywords: RecommendedKeyword[],
   // The scraped pillar pages (the "crawl"), populated on the success path so the deterministic
   // keyword-grader can score candidates for relevance + topical authority. Absent on error paths
   // (onboard falls back to the heuristic there, where no grading runs).
   pages?: CrawlPage[],
   error?: string,
};

/** True when a Firecrawl API key is configured, so the caller can branch to the heuristic when not. */
export const firecrawlConfigured = (): boolean => Boolean(process.env.FIRECRAWL_API_KEY && process.env.FIRECRAWL_API_KEY.trim());

const authHeaders = (): Record<string, string> => ({
   Authorization: `Bearer ${(process.env.FIRECRAWL_API_KEY || '').trim()}`,
   'Content-Type': 'application/json',
});

// fetch with a per-call timeout that never rejects in a way the caller cannot handle: returns the
// Response, or null on timeout/network error. The AbortController guarantees the socket is released.
const timedFetch = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> => {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), timeoutMs);
   try {
      return await fetch(url, { ...init, signal: controller.signal });
   } catch {
      return null;
   } finally {
      clearTimeout(timer);
   }
};

// A path is a low-value (non-pillar) URL we never want to send for keyword analysis: auth, commerce
// funnel, legal, feeds, dated blog permalinks, taxonomy/pagination, and non-HTML assets. Pillar pages
// are the product/service/solution/content pages, which these patterns deliberately exclude. Built
// from an array so no single source line runs long.
const NON_PILLAR_PARTS = [
   'cart', 'checkout', 'login', 'signin', 'sign-in', 'signup', 'sign-up', 'account',
   'privacy', 'terms', 'legal', 'cookie', 'rss', 'feed', 'tag', 'tags', 'category',
   'categories', 'author', 'page\\/\\d+', 'wp-admin', 'wp-login', 'search', '\\d{4}\\/\\d{2}',
];
const NON_PILLAR = new RegExp(`\\/(${NON_PILLAR_PARTS.join('|')})(\\/|$)`, 'i');
const NON_HTML = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|mp4|mp3|css|js|json|xml|woff2?|ttf)(\?|$)/i;

// Choose the homepage plus the shallowest content URLs as the pillar set. Shallow paths (depth 1-2)
// are almost always the product/service/solution/pillar pages; deep dated permalinks and taxonomy are
// dropped. Deterministic ordering (homepage first, then by path depth then alphabetical) so the same
// site yields the same pillar set, which keeps recommendations stable across re-onboards.
const selectPillarUrls = (homepage: string, links: string[]): string[] => {
   const out: string[] = [homepage];
   const seen = new Set<string>([homepage.replace(/\/$/, '')]);
   const ranked = links
      .slice(0, MAX_MAP_LINKS)
      .filter((u) => typeof u === 'string' && u.startsWith('http'))
      .filter((u) => !NON_PILLAR.test(u) && !NON_HTML.test(u))
      .map((u) => {
         let depth = 99;
         try { depth = new URL(u).pathname.split('/').filter(Boolean).length; } catch { depth = 99; }
         return { u, depth };
      })
      .filter((x) => x.depth <= 2)
      .sort((a, b) => (a.depth - b.depth) || a.u.localeCompare(b.u));
   for (const { u } of ranked) {
      const norm = u.replace(/\/$/, '');
      if (!seen.has(norm)) { seen.add(norm); out.push(u); }
      if (out.length >= MAX_PILLAR_URLS) { break; }
   }
   return out;
};

// Firecrawl /map: fast URL discovery for the domain. Returns the homepage-rooted link list, or just
// the homepage when map is unavailable (so /extract still runs on at least the homepage).
const mapSite = async (homepage: string): Promise<string[]> => {
   const res = await timedFetch(`${FIRECRAWL_BASE}/map`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ url: homepage }),
   }, CALL_TIMEOUT_MS);
   if (!res || !res.ok) { return [homepage]; }
   try {
      const body = await res.json();
      const links = Array.isArray(body && body.links) ? body.links : [];
      return links.length ? links : [homepage];
   } catch {
      return [homepage];
   }
};

// Scrape the pillar pages for their text (the "crawl" the grader scores against). Runs all scrapes
// CONCURRENTLY and never throws: a page that fails/times out is simply omitted. Returns up to
// MAX_SCRAPE_PAGES CrawlPage{url,title,text}, each text truncated to SCRAPE_TEXT_CAP so the grader's
// corpus stays bounded. Used only to feed relevance/authority scoring, so partial content is fine.
const scrapePages = async (urls: string[]): Promise<CrawlPage[]> => {
   const targets = urls.slice(0, MAX_SCRAPE_PAGES);
   const results = await Promise.all(targets.map(async (url): Promise<CrawlPage | null> => {
      const res = await timedFetch(`${FIRECRAWL_BASE}/scrape`, {
         method: 'POST', headers: authHeaders(), body: JSON.stringify({ url, formats: ['markdown'] }),
      }, CALL_TIMEOUT_MS);
      if (!res || !res.ok) { return null; }
      try {
         const body = await res.json();
         const data = (body && body.data) || {};
         const md = typeof data.markdown === 'string' ? data.markdown : '';
         const title = (data.metadata && typeof data.metadata.title === 'string') ? data.metadata.title : '';
         if (!md && !title) { return null; }
         return { url, title, text: md.slice(0, SCRAPE_TEXT_CAP) };
      } catch {
         return null;
      }
   }));
   return results.filter((p): p is CrawlPage => p !== null);
};

// The SEO-analyst instruction Firecrawl's LLM follows. Encodes the business-name -> meta-titles ->
// pillar-pages method and the "phrases a real searcher types, not brand/nav" quality bar.
const EXTRACT_PROMPT = [
   'You are an expert SEO analyst. From these pages of one business website, recommend the top 50',
   'keyword phrases this business should track in Google rankings: the phrases a real buyer would type',
   'into Google to find what this business sells. Method, in order: (1) identify the business/brand name',
   'and do NOT return it alone unless it is also a core product/category term; (2) read each page title',
   'to infer the keyword that page targets; (3) identify the pillar pages (the main product, service,',
   'solution, or cornerstone-content pages) and infer the commercial phrases those pages try to rank for.',
   'STRONGLY PREFER multi-word mid-tail phrases with clear commercial intent: "[category] software",',
   '"[product] for [segment]", "[competitor] alternative", "best [category] tool". These are worth the',
   'most. DO NOT return: single generic words ("software", "platform", "agents", "apps", "security");',
   'navigation labels or site-section / doc-chrome headers ("home", "about us", "pricing", "all guides",',
   '"knowledge base", "featured topics", "explore docs", "events", "press", "showcase"); or marketing',
   'slogans / taglines / headlines from the page ("backed by incredible investors", "it comes with',
   'receipts"). Those are not search queries. Return up to 50 UNIQUE phrases, best/most-commercial first.',
   'For each, give the site-relative path of the page it best maps to (e.g. "/software"), or "/" if',
   'unsure. Keep phrases lowercase and under 7 words.',
].join(' ');

const EXTRACT_SCHEMA = {
   type: 'object',
   properties: {
      businessName: { type: 'string' },
      keywords: {
         type: 'array',
         items: {
            type: 'object',
            properties: {
               keyword: { type: 'string' },
               targetPage: { type: 'string' },
            },
            required: ['keyword'],
         },
      },
   },
   required: ['keywords'],
};

// Normalize Firecrawl's returned data into a clean, deduped, capped RecommendedKeyword[]. Defensive
// against shape drift: tolerates string-only keyword entries and missing target pages.
const normalizeKeywords = (data: unknown): { businessName: string, keywords: RecommendedKeyword[] } => {
   const obj = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
   const businessName = typeof obj.businessName === 'string' ? obj.businessName.trim() : '';
   const rawList = Array.isArray(obj.keywords) ? obj.keywords : [];
   const seen = new Set<string>();
   const keywords: RecommendedKeyword[] = [];
   for (const entry of rawList) {
      let keyword = '';
      let targetPage = '/';
      if (typeof entry === 'string') {
         keyword = entry;
      } else if (entry && typeof entry === 'object') {
         const e = entry as Record<string, unknown>;
         keyword = typeof e.keyword === 'string' ? e.keyword : '';
         if (typeof e.targetPage === 'string' && e.targetPage.trim()) {
            // Keep only the path part, always leading-slash, so it joins to the scoreboard target_page.
            let p = e.targetPage.trim();
            try { p = new URL(p, 'https://x').pathname; } catch { p = p.startsWith('/') ? p : `/${p}`; }
            targetPage = p || '/';
         }
      }
      keyword = keyword.toLowerCase().replace(/\s+/g, ' ').trim();
      if (keyword && keyword.length >= 2 && !seen.has(keyword)) {
         seen.add(keyword);
         keywords.push({ keyword, targetPage });
      }
      if (keywords.length >= MAX_KEYWORDS) { break; }
   }
   return { businessName, keywords };
};

/**
 * Recommend the top keyword phrases for a domain via Firecrawl (map -> select pillar pages ->
 * extract with the SEO-analyst prompt). Bounded by EXTRACT_BUDGET_MS overall. Never throws.
 * @param {string} domain - canonicalized public domain, e.g. "example.com".
 * @returns {Promise<FirecrawlResult>} businessName + recommended keywords, or { keywords: [], error }.
 */
export async function extractKeywords(domain: string): Promise<FirecrawlResult> {
   if (!firecrawlConfigured()) {
      return { businessName: '', keywords: [], error: 'Firecrawl is not configured.' };
   }
   const deadline = Date.now() + EXTRACT_BUDGET_MS;
   const homepage = `https://${domain}`;
   try {
      const links = await mapSite(homepage);
      const urls = selectPillarUrls(homepage, links);

      // Scrape the pillar pages for grader content CONCURRENTLY with the extract job, so the page
      // content adds no wall-clock (it resolves while we poll the extract). Awaited at the success
      // returns below. scrapePages never throws (failed pages are omitted), so this cannot break extract.
      const pagesPromise = scrapePages(urls);

      const startRes = await timedFetch(`${FIRECRAWL_BASE}/extract`, {
         method: 'POST',
         headers: authHeaders(),
         body: JSON.stringify({ urls, prompt: EXTRACT_PROMPT, schema: EXTRACT_SCHEMA }),
      }, CALL_TIMEOUT_MS);
      if (!startRes || !startRes.ok) {
         return { businessName: '', keywords: [], error: 'Firecrawl extract could not start.' };
      }
      const started = await startRes.json().catch(() => null);
      if (!started) { return { businessName: '', keywords: [], error: 'Firecrawl returned no job.' }; }

      // Some Firecrawl responses return data inline (sync); others return a job id to poll (async).
      if (started.data && !started.id) {
         return { ...normalizeKeywords(started.data), pages: await pagesPromise };
      }
      const jobId = started.id;
      if (!jobId) { return { businessName: '', keywords: [], error: 'Firecrawl returned no job id.' }; }

      // Poll the async job until completed/failed or the overall budget runs out.
      while (Date.now() < deadline) {
         // eslint-disable-next-line no-await-in-loop
         await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
         // eslint-disable-next-line no-await-in-loop
         const pollRes = await timedFetch(`${FIRECRAWL_BASE}/extract/${jobId}`, { method: 'GET', headers: authHeaders() }, CALL_TIMEOUT_MS);
         if (pollRes && pollRes.ok) {
            // eslint-disable-next-line no-await-in-loop
            const poll = await pollRes.json().catch(() => null);
            if (poll && poll.status === 'completed') {
               return { ...normalizeKeywords(poll.data), pages: await pagesPromise };
            }
            if (poll && (poll.status === 'failed' || poll.status === 'cancelled')) {
               return { businessName: '', keywords: [], error: 'Firecrawl extract failed.' };
            }
         }
      }
      return { businessName: '', keywords: [], error: 'Firecrawl extract timed out.' };
   } catch (error) {
      return { businessName: '', keywords: [], error: 'Firecrawl extract error.' };
   }
}

export default extractKeywords;
