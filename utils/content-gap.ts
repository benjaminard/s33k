// Content gap analysis: topics a competitor covers on its site that you do not.
//
// Given two site crawls (yours and a competitor's, from utils/site-crawl.ts) this derives a
// candidate "topic" per page and returns the competitor topics that have NO close match among
// yours: the gaps. A topic is the page slug turned into a phrase, or the head of the page title
// before a separator (whichever is more meaningful), because that is what a page is actually
// "about" for SEO/AEO purposes. The comparison is a pure crawl-based, deterministic string match:
// no LLM, no external API. The user's own LLM reads the gaps and decides what to write.
//
// Why slug-and-title, not full-text similarity: the slug and title head are the strongest, lowest-
// noise signal of a page's primary topic, and a deterministic token-overlap match is explainable
// and cheap. Full-text semantic similarity would need embeddings (an external/model call) which
// s33k forbids server-side.

import type { PageSummary } from './site-crawl';

export type ContentGapItem = {
   /** The derived topic phrase from the competitor page (e.g. "highspot alternative"). */
   topic: string,
   /** The competitor page URL where that topic lives. */
   url: string,
   /** The competitor page path. */
   path: string,
   /** The competitor page title, for context when the slug is terse. */
   title: string,
   /** How content-rich the competitor page looks (excerpt length), the sort key. Longer == richer. */
   richness: number,
};

// Stopwords stripped from derived topics so generic glue words do not dominate the match or read
// as a "topic". Deliberately small: only the words that add no topical meaning.
const STOPWORDS = new Set([
   'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'your', 'our', 'you',
   'is', 'are', 'how', 'what', 'why', 'best', 'top', 'vs', 'guide',
]);

// Title separators: a page title is usually "Primary Topic <sep> Brand / Tagline". We keep only the
// head (before the first separator) because the tail is almost always boilerplate brand suffix.
// Separators include en dash and em dash, matched via \u escapes so no literal em-dash byte
// appears in our source (house rule: zero U+2014 anywhere). U+2013 = en dash, U+2014 = em dash.
const TITLE_SEP = /\s+[|\-\u2013\u2014:·]\s+/;

// Generic / non-content paths that are never a "topic" worth comparing (home, legal, auth, etc.).
// Matching these out keeps the gap list to real content pages.
const SKIP_PATHS = [
   '/', '/privacy', '/terms', '/legal', '/login', '/signup', '/sign-up', '/contact',
   '/about', '/careers', '/cookie', '/cookies', '/sitemap', '/search', '/cart', '/checkout',
];

/** Normalize a phrase to lowercase content tokens with stopwords removed. */
const tokenize = (phrase: string): string[] => String(phrase || '')
   .toLowerCase()
   .replace(/[^a-z0-9]+/g, ' ')
   .trim()
   .split(/\s+/)
   .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/** Turn a path's last meaningful slug segment into a spaced phrase, e.g. "/blog/dam-mcp" -> "dam mcp". */
const slugToPhrase = (path: string): string => {
   const segs = String(path || '').toLowerCase().split('/').filter(Boolean);
   const last = segs.length ? segs[segs.length - 1] : '';
   return last.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').trim();
};

/**
 * Derive a single candidate topic phrase for a page. Prefers the slug phrase when it carries content
 * tokens (slugs are the cleanest topic signal), and falls back to the title head before a separator.
 * Returns '' when neither yields a meaningful topic (e.g. a numeric or empty slug with no title).
 * @param {PageSummary} page - A crawled page summary.
 * @returns {string} The derived topic phrase, lowercased, or '' if none.
 */
export const deriveTopic = (page: PageSummary): string => {
   const slugPhrase = slugToPhrase(page.path);
   if (tokenize(slugPhrase).length > 0) { return slugPhrase; }
   // Slug was empty/numeric: fall back to the title head (before the brand suffix).
   const titleHead = String(page.title || '').split(TITLE_SEP)[0].trim();
   if (tokenize(titleHead).length > 0) { return titleHead.toLowerCase(); }
   return '';
};

/** True if a path is a generic/non-content page that should not become a topic. */
const isSkippablePath = (path: string): boolean => {
   const p = String(path || '').toLowerCase().replace(/\/$/, '') || '/';
   return SKIP_PATHS.includes(p);
};

/**
 * Decide whether a competitor topic is "covered" by any of your topics. A topic counts as covered
 * when its content tokens substantially overlap one of yours (Jaccard-style: at least half of the
 * shorter token set is shared, OR one token set is a subset of the other). This deliberately treats
 * "dam mcp server" and "dam mcp" as the same topic so trivial slug variations are not false gaps.
 * @param {string[]} compTokens - The competitor topic's content tokens.
 * @param {string[][]} yourTokenSets - Every one of your topics, pre-tokenized.
 * @returns {boolean} True if some topic of yours closely matches.
 */
const isCovered = (compTokens: string[], yourTokenSets: string[][]): boolean => {
   if (compTokens.length === 0) { return true; } // nothing to match -> not a real gap
   const compSet = new Set(compTokens);
   return yourTokenSets.some((yours) => {
      if (yours.length === 0) { return false; }
      const yourSet = new Set(yours);
      let shared = 0;
      compSet.forEach((t) => { if (yourSet.has(t)) { shared += 1; } });
      const smaller = Math.min(compSet.size, yourSet.size);
      // A single shared GENERIC token (e.g. "dam") would mark a 2+-token competitor topic
      // ['dam','mcp'] "covered" by ['dam','software'] under a 50%-of-smaller rule, silently
      // dropping a real gap. Require at least 2 shared tokens once the smaller topic has 2+ tokens;
      // keep the original subset/50% rule only for single-token topics, where 1 shared IS the whole.
      if (smaller >= 2 && shared < 2) { return false; }
      // Subset (one fully contains the other) or >= 50% of the smaller set overlaps == same topic.
      return shared === smaller || shared / smaller >= 0.5;
   });
};

/**
 * Compute the content gaps: competitor topics with no close match among your topics.
 *
 * @param {PageSummary[]} yourPages - Your crawled pages (or known/keyword-derived pages).
 * @param {PageSummary[]} competitorPages - The competitor's crawled pages.
 * @returns {ContentGapItem[]} Gap topics, sorted by competitor page richness (excerpt length) desc.
 */
export const computeContentGaps = (yourPages: PageSummary[], competitorPages: PageSummary[]): ContentGapItem[] => {
   // Pre-tokenize your topics once. Skip your generic pages so they cannot accidentally "cover" a
   // real competitor topic.
   const yourTokenSets: string[][] = (yourPages || [])
      .filter((p) => !isSkippablePath(p.path))
      .map((p) => tokenize(deriveTopic(p)))
      .filter((t) => t.length > 0);

   const gaps: ContentGapItem[] = [];
   const seenTopics = new Set<string>();

   for (const page of competitorPages || []) {
      if (page.error) { continue; } // could not fetch this competitor page, no reliable topic
      if (isSkippablePath(page.path)) { continue; }
      const topic = deriveTopic(page);
      const compTokens = tokenize(topic);
      if (compTokens.length === 0) { continue; }

      // De-dupe by the normalized token signature so two competitor pages on the same topic count once.
      const sig = [...compTokens].sort().join(' ');
      if (seenTopics.has(sig)) { continue; }

      if (isCovered(compTokens, yourTokenSets)) { continue; } // you already cover it, not a gap
      seenTopics.add(sig);

      gaps.push({
         topic,
         url: page.url,
         path: page.path,
         title: page.title || '',
         // Richness proxy: a longer extracted excerpt means a more substantial, content-rich page,
         // so deeper competitor investment in the topic. Used as the sort key (richest first).
         richness: String(page.excerpt || '').length,
      });
   }

   gaps.sort((a, b) => b.richness - a.richness);
   return gaps;
};
