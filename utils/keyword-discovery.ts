/**
 * Heuristic, LLM-free target-keyword discovery for s33k onboarding.
 *
 * Given a domain, this crawls a few of its pages (reusing the SSRF-guarded crawler
 * in utils/site-crawl.ts; it does NOT duplicate any crawl/fetch logic) and proposes
 * candidate target keywords PER PAGE from on-page signals only: the title tag, h1/h2
 * headings, meta description, and the URL slug. No server-side LLM call is made.
 *
 * The output ([{ page, suggestedKeywords[] }]) is meant to seed the onboard flow's
 * keyword tracking with a sane starting set the user can prune or extend. A future
 * layer can enrich this with Google Search Console query data; that is out of scope
 * here.
 *
 * Heuristic ranking, in order of trust:
 *   1. Title tag      - strongest single signal of a page's target phrase.
 *   2. H1             - strong signal, usually the page's primary topic.
 *   3. Meta description - supporting phrases.
 *   4. H2 headings    - sub-topics that refine the page's focus.
 *   5. URL slug       - weak signal; slug tokens joined into a phrase.
 * Phrases are normalized, stripped of a leading brand/site-name segment when a
 * separator is present (e.g. "AI-Ready DAM | Masset" -> "ai-ready dam"), filtered of
 * stop words and noise, deduped, and capped per page.
 *
 * Never throws. Crawl failures surface as a top-level error with whatever partial
 * results were gathered.
 */

import { crawlSite, PageSummary } from './site-crawl';

/** Max keyword candidates proposed per page. */
const MAX_KEYWORDS_PER_PAGE = 5;

// Common separators that split a "<page topic> <sep> <brand>" style title:
// pipe, en dash, em dash, hyphen, colon, middle dot. The non-ASCII separators
// are written as Unicode escapes so the source carries no literal em/en dash.
const TITLE_SEPARATORS = /\s+[|\u2013\u2014\-:\u00b7]\s+/;

/**
 * Stop words filtered out when a candidate phrase is a single low-value token.
 * Kept deliberately small: multi-word phrases are preserved even if they contain
 * a stop word, since "the content home" is a legitimate target phrase.
 */
const STOP_WORDS = new Set([
   'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
   'home', 'about', 'contact', 'login', 'sign', 'page', 'welcome', 'index',
   'learn', 'more', 'read', 'get', 'your', 'our', 'you', 'we', 'is', 'are',
]);

export type KeywordCandidate = {
   page: string,
   suggestedKeywords: string[],
};

export type KeywordDiscoveryResult = {
   domain: string,
   candidates: KeywordCandidate[],
   error?: string,
};

/**
 * Normalize a raw phrase into a clean, lowercased keyword candidate.
 * Collapses whitespace, strips surrounding punctuation, and lowercases.
 * @param {string} raw - Raw heading/title/slug fragment.
 * @returns {string} A cleaned phrase, possibly empty.
 */
const normalizePhrase = (raw: string): string => String(raw || '')
   .toLowerCase()
   .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
   .replace(/[^a-z0-9'&\s-]/g, ' ')
   .replace(/\s+/g, ' ')
   .replace(/^[\s-]+|[\s-]+$/g, '')
   .trim();

/**
 * Decide whether a normalized phrase is worth keeping as a keyword candidate.
 * Rejects empties, very short tokens, pure numbers, and single stop words. Caps
 * the word count so whole-sentence headings do not become keywords.
 * @param {string} phrase - A normalized phrase.
 * @returns {boolean} True if the phrase is a usable candidate.
 */
const isUsablePhrase = (phrase: string): boolean => {
   if (!phrase || phrase.length < 3) { return false; }
   const words = phrase.split(' ').filter(Boolean);
   if (words.length === 0 || words.length > 6) { return false; }
   if (words.length === 1) {
      if (STOP_WORDS.has(words[0])) { return false; }
      if (/^\d+$/.test(words[0])) { return false; }
   }
   return true;
};

/**
 * Turn a page's title tag into 0-1 candidate phrases. When the title contains a
 * separator (pipe, dash, colon, middle dot) it is treated as "<topic> <sep> <brand>"
 * and only the first (topic) segment is kept.
 * @param {string} title - Raw page title.
 * @returns {string[]} Candidate phrases from the title.
 */
const phrasesFromTitle = (title: string): string[] => {
   const t = String(title || '').trim();
   if (!t) { return []; }
   const segments = t.split(TITLE_SEPARATORS).map((s) => s.trim()).filter(Boolean);
   const topic = segments.length > 0 ? segments[0] : t;
   const norm = normalizePhrase(topic);
   return isUsablePhrase(norm) ? [norm] : [];
};

/**
 * Turn a URL slug into a candidate phrase by joining its path tokens.
 * e.g. "/software/mcp-server" -> "software mcp server".
 * @param {string} pageUrl - The absolute page URL.
 * @returns {string[]} Zero or one slug-derived candidate phrase.
 */
const phrasesFromSlug = (pageUrl: string): string[] => {
   let pathname = '';
   try { pathname = new URL(pageUrl).pathname || ''; } catch { return []; }
   const tokens = pathname
      .split('/')
      .filter(Boolean)
      .flatMap((seg) => seg.replace(/\.(html?|php|aspx?)$/i, '').split(/[-_]+/))
      .filter(Boolean);
   if (tokens.length === 0) { return []; }
   const norm = normalizePhrase(tokens.join(' '));
   return isUsablePhrase(norm) ? [norm] : [];
};

/**
 * Derive ranked, deduped keyword candidates for a single crawled page from its
 * on-page signals (title, h1, meta description, h2, slug), in trust order.
 * @param {PageSummary} page - The crawled page summary.
 * @returns {string[]} Up to MAX_KEYWORDS_PER_PAGE candidate keywords.
 */
const candidatesForPage = (page: PageSummary): string[] => {
   const ordered: string[] = [
      ...phrasesFromTitle(page.title),
      ...(page.h1 || []).map(normalizePhrase),
      ...(page.metaDescription ? [normalizePhrase(page.metaDescription)] : []),
      ...(page.h2 || []).map(normalizePhrase),
      ...phrasesFromSlug(page.url),
   ];
   const seen = new Set<string>();
   const out: string[] = [];
   for (const phrase of ordered) {
      if (!isUsablePhrase(phrase) || seen.has(phrase)) { continue; }
      seen.add(phrase);
      out.push(phrase);
      if (out.length >= MAX_KEYWORDS_PER_PAGE) { break; }
   }
   return out;
};

/**
 * Discover candidate target keywords per page for a domain, using only heuristic
 * on-page signals. Reuses the SSRF-guarded site crawler; no server-side LLM.
 * @param {string} domain - Raw domain or URL, e.g. "example.com".
 * @returns {Promise<KeywordDiscoveryResult>} Per-page keyword candidates.
 */
export async function discoverKeywords(domain: string): Promise<KeywordDiscoveryResult> {
   const crawl = await crawlSite(domain);
   const candidates: KeywordCandidate[] = crawl.pages
      .filter((page) => !page.error)
      .map((page) => ({ page: page.url, suggestedKeywords: candidatesForPage(page) }))
      .filter((candidate) => candidate.suggestedKeywords.length > 0);

   return {
      domain: crawl.domain,
      candidates,
      ...(crawl.error ? { error: crawl.error } : {}),
   };
}

export default discoverKeywords;
