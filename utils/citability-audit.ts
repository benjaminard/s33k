/**
 * AI-citability audit.
 *
 * Optional enrichment for AI Visibility (pages/api/ai-visibility.ts).
 * When a domain has thin first-party AI-engine behavior (no AI referrals), the
 * per-page view has little to show. This module fills
 * that gap with a forward-looking, deterministic signal: how AI-READY the
 * domain's top pages actually are. It does NOT query an LLM and never asks an
 * AI engine whether it cites the site. It fetches the real pages and scores the
 * concrete on-page signals that make a page easy for AI answer engines to
 * retrieve, parse, and cite:
 *
 *   - llms.txt present at the site root (/llms.txt): a machine-readable index
 *     that tells AI agents what the site is and where the canonical content is.
 *   - a Markdown twin of the page (e.g. /pricing.md for /pricing, or
 *     /index.md / llms-full.txt for the root): clean, chrome-free content that
 *     AI clients can retrieve without parsing HTML.
 *   - JSON-LD structured data on the page (<script type="application/ld+json">):
 *     explicit, typed facts answer engines lift directly.
 *   - clean, answer-shaped content: a real <title>, a meaningful body text
 *     length, and at least one heading, so the page reads as an answer rather
 *     than a thin or nav-only shell.
 *
 * Every fetch is SSRF-guarded and time-bounded by reusing the safe fetch from
 * utils/site-crawl.ts. The module never throws: any per-page or per-signal
 * failure degrades that one signal to false and is reflected in the score.
 */

import { safeFetchText } from './site-crawl';

/** The four scored AI-readiness signals for one page, plus the page's score. */
export type CitabilityPageScore = {
   path: string,
   url: string,
   title: string,
   hasLlmsTxt: boolean,
   hasMdTwin: boolean,
   hasJsonLd: boolean,
   cleanContent: boolean,
   /** 0..100, the share of the four signals this page passes. */
   score: number,
   error?: string,
};

export type CitabilityAudit = {
   audited: true,
   /** The page-level scores, in the order the pages were provided. */
   pages: CitabilityPageScore[],
   /** 0..100, the mean of the per-page scores (0 when no page could be scored). */
   domainScore: number,
   /** Whether a site-root llms.txt was found (true makes every page pass that signal). */
   llmsTxtFound: boolean,
   /** Human-readable note explaining what the audit measures and its limits. */
   note: string,
};

/** Each of the four signals contributes an equal 25 points to a page's score. */
const POINTS_PER_SIGNAL = 25;

/** Body text below this many characters reads as a thin/shell page, not an answer. */
const MIN_ANSWER_TEXT_LENGTH = 400;

/**
 * Build the https origin for a bare domain.
 * @param {string} domain - A bare hostname, e.g. "example.com".
 * @returns {string} The https origin, e.g. "https://example.com".
 */
const originFor = (domain: string): string => `https://${String(domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

/**
 * Detect a site-root llms.txt (or the richer llms-full.txt). One probe per site,
 * not per page, because llms.txt is a single root-level file.
 * @param {string} origin - The https origin.
 * @returns {Promise<boolean>} True if an llms.txt-family file is reachable.
 */
const detectLlmsTxt = async (origin: string): Promise<boolean> => {
   const candidates = [`${origin}/llms.txt`, `${origin}/llms-full.txt`];
   for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const body = await safeFetchText(candidate, 'text/plain,text/markdown');
      if (body && body.trim().length > 0) { return true; }
   }
   return false;
};

/**
 * Map a page path to its candidate Markdown-twin URLs. Covers the common
 * conventions: "/path" -> "/path.md", the root "/" -> "/index.md", and a
 * site-wide "/llms-full.txt" fallback.
 * @param {string} origin - The https origin.
 * @param {string} path - The page path, e.g. "/pricing".
 * @returns {string[]} Candidate twin URLs to probe, most-specific first.
 */
const mdTwinCandidates = (origin: string, path: string): string[] => {
   const clean = (path || '/').split('?')[0].split('#')[0].replace(/\/+$/, '');
   if (clean === '' || clean === '/') {
      return [`${origin}/index.md`, `${origin}/llms-full.txt`];
   }
   if (/\.md$/i.test(clean)) { return [`${origin}${clean}`]; }
   return [`${origin}${clean}.md`];
};

/**
 * Probe for a Markdown twin of a page. A twin must come back as non-empty text
 * that is not obviously an HTML document (some servers answer .md with the HTML
 * page), so a 200-that-is-really-html does not count.
 * @param {string} origin - The https origin.
 * @param {string} path - The page path.
 * @returns {Promise<boolean>} True if a real Markdown twin is reachable.
 */
const detectMdTwin = async (origin: string, path: string): Promise<boolean> => {
   for (const candidate of mdTwinCandidates(origin, path)) {
      // eslint-disable-next-line no-await-in-loop
      const body = await safeFetchText(candidate, 'text/markdown,text/plain');
      if (!body) { continue; }
      const trimmed = body.trim();
      if (trimmed.length === 0) { continue; }
      // Reject an HTML page masquerading as a markdown twin.
      const looksHtml = /^<!doctype html/i.test(trimmed) || /<html[\s>]/i.test(trimmed.slice(0, 500));
      if (!looksHtml) { return true; }
   }
   return false;
};

/**
 * Strip tags and collapse whitespace, for the answer-shaped content check only.
 * @param {string} html - Raw HTML.
 * @returns {string} Plain text.
 */
const toPlainText = (html: string): string => html
   .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
   .replace(/<[^>]+>/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

/**
 * Score one page's HTML for JSON-LD presence and answer-shaped content, and
 * extract its title. llms.txt and md-twin signals are resolved separately
 * (they require their own fetches) and passed in.
 * @param {string} html - The fetched page HTML.
 * @returns {{ title: string, hasJsonLd: boolean, cleanContent: boolean }}
 */
const scoreHtml = (html: string): { title: string, hasJsonLd: boolean, cleanContent: boolean } => {
   const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
   const title = titleMatch ? toPlainText(titleMatch[1]).slice(0, 300) : '';

   const hasJsonLd = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i.test(html);

   const hasHeading = /<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>/i.test(html);
   const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
   const bodyText = toPlainText(bodyMatch ? bodyMatch[1] : html);
   const cleanContent = Boolean(title) && hasHeading && bodyText.length >= MIN_ANSWER_TEXT_LENGTH;

   return { title, hasJsonLd, cleanContent };
};

/**
 * Run the AI-citability audit for a domain over a small set of top pages.
 *
 * One root-level llms.txt probe is shared across all pages. For each page it
 * fetches the HTML (SSRF-guarded), probes for a Markdown twin, and scores
 * JSON-LD and answer-shaped content. Each page scores out of 100 across the
 * four equally-weighted signals; the domain score is the mean of the pages.
 * Never throws.
 *
 * @param {string} domain - The bare domain, e.g. "example.com".
 * @param {string[]} paths - Page paths to audit (e.g. ["/", "/pricing"]). The
 *   caller passes the top pages it knows about; deduped and capped at 8 here.
 * @returns {Promise<CitabilityAudit>} The per-page and domain scores.
 */
export async function auditCitability(domain: string, paths: string[]): Promise<CitabilityAudit> {
   const origin = originFor(domain);
   const note = 'AI-citability audit: a forward-looking, deterministic score of how AI-ready the top pages are '
      + '(llms.txt, a Markdown twin, JSON-LD structured data, and clean answer-shaped content). It fetches the real '
      + 'pages and never queries an LLM. Shown because first-party AI referral data is currently thin.';

   // Normalize, de-duplicate, and cap the page set. Always include the root.
   const seen = new Set<string>();
   const normalized: string[] = [];
   for (const raw of ['/', ...(paths || [])]) {
      const p = String(raw || '/').trim().split('?')[0].split('#')[0] || '/';
      const key = p.replace(/\/+$/, '') || '/';
      if (seen.has(key)) { continue; }
      seen.add(key);
      normalized.push(p);
      if (normalized.length >= 8) { break; }
   }

   const llmsTxtFound = await detectLlmsTxt(origin);

   const pageScores: CitabilityPageScore[] = [];
   for (const path of normalized) {
      const pageUrl = `${origin}${path === '/' ? '/' : path}`;
      // eslint-disable-next-line no-await-in-loop
      const html = await safeFetchText(pageUrl, 'text/html');
      if (html === null) {
         pageScores.push({
            path, url: pageUrl, title: '', hasLlmsTxt: llmsTxtFound,
            hasMdTwin: false, hasJsonLd: false, cleanContent: false,
            score: llmsTxtFound ? POINTS_PER_SIGNAL : 0,
            error: 'Could not fetch this page.',
         });
         continue;
      }
      const { title, hasJsonLd, cleanContent } = scoreHtml(html);
      // eslint-disable-next-line no-await-in-loop
      const hasMdTwin = await detectMdTwin(origin, path);
      const passed = [llmsTxtFound, hasMdTwin, hasJsonLd, cleanContent].filter(Boolean).length;
      pageScores.push({
         path, url: pageUrl, title,
         hasLlmsTxt: llmsTxtFound, hasMdTwin, hasJsonLd, cleanContent,
         score: passed * POINTS_PER_SIGNAL,
      });
   }

   const scored = pageScores.filter((p) => !p.error || p.score > 0);
   const domainScore = scored.length > 0
      ? Math.round(pageScores.reduce((sum, p) => sum + p.score, 0) / pageScores.length)
      : 0;

   return { audited: true, pages: pageScores, domainScore, llmsTxtFound, note };
}

export default auditCitability;
