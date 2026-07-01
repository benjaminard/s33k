// Keyword cannibalization: a pure join over tracked Keyword rows that flags the cases where Google
// cannot decide which of your pages should rank for a term, so the pages compete and split the
// equity instead of one of them ranking well.
//
// Why this matters: when two of your own pages target the same intent, Google often flip-flops
// between them or ranks a weaker one, and neither earns the click it could. The fix is consolidation
// (merge, redirect, or de-target one page), but first you have to SEE the conflict. That is all this
// module does: surface the clear, conservative cases. It is deliberately strict so it does not cry
// wolf on every loosely related pair.
//
// History is stored as { 'YYYY-MM-DD': position } (date -> position only, no per-day url), so we
// CANNOT read url flip-flopping out of history directly. Instead we detect cannibalization from the
// signals the Keyword rows DO carry:
//   (a) intent split: the keyword currently ranks on a url that is NOT its target_page (Google chose
//       a different page than the one you optimized for, the textbook cannibalization symptom);
//   (b) shared ranking url: two or more DISTINCT tracked keywords rank on the SAME url while their
//       target_pages differ (one page is absorbing intent meant for several pages);
//   (c) near-duplicate terms: two tracked keywords whose normalized terms are near-identical rank on
//       DIFFERENT urls (you are tracking the same intent twice and your pages disagree on who owns it).
//
// No server-side LLM. Returns structured groups for the user's own LLM (and the briefing) to narrate.

export type CannibalKeyword = {
   keyword: string,
   position: number,
   url: string,
   targetPage: string,
};

export type CannibalGroup = {
   // The kind of conflict: 'intent_split' (a), 'shared_url' (b), or 'duplicate_term' (c).
   type: 'intent_split' | 'shared_url' | 'duplicate_term',
   // The term(s) in conflict. For shared_url/duplicate_term this is the set of competing keywords.
   keywords: string[],
   // The competing urls (the urls Google is torn between, or ranking-url vs target-page).
   urls: string[],
   // One-line plain-English why, so an LLM/marketer knows the conflict without re-deriving it.
   why: string,
};

export type CannibalInput = {
   keyword: string,
   position: number,
   // Raw column values. url is a JSON string (array of urls, best-match first) or a bare string;
   // target_page is a plain url string. Both parsed defensively so a malformed blob never throws.
   url: string,
   target_page: string,
};

// SerpBear stores a keyword's ranking url as a JSON array (best-match first) or a bare string on
// older rows. Pull the first usable url out of either shape; empty string when none.
const firstUrl = (raw: string): string => {
   const s = String(raw || '').trim();
   if (!s) { return ''; }
   try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) { return parsed.length ? String(parsed[0] || '') : ''; }
      if (typeof parsed === 'string') { return parsed; }
      return '';
   } catch {
      // Not JSON: treat the raw value as the url itself (the legacy bare-string shape).
      return s;
   }
};

// Normalize a url for comparison: lowercase, strip protocol AND host, drop the query and hash, strip
// a trailing slash, so what remains is the PATH. Two urls that differ only by http/https, the host,
// a trailing slash, or tracking params are the SAME page for cannibalization purposes. Stripping the
// host is essential: SerpBear stores the ranking url ABSOLUTE (https://www.example.com/x) while a
// keyword's target_page is RELATIVE (/x), so without this every keyword whose ranking url matched its
// own target page was a false intent_split ("Google ranks a different page than you optimized").
const normalizeUrl = (raw: string): string => {
   let s = String(raw || '').trim().toLowerCase();
   if (!s) { return ''; }
   s = s.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
   // After dropping the protocol, anything before the first slash is the host: strip it to the path.
   // A bare host with no path (or an empty path) collapses to '/' (the homepage).
   if (!s.startsWith('/')) {
      const slash = s.indexOf('/');
      s = slash === -1 ? '/' : s.slice(slash);
   }
   if (s.length > 1 && s.endsWith('/')) { s = s.slice(0, -1); }
   return s;
};

// Normalize a keyword term for near-duplicate detection: lowercase, collapse whitespace, drop
// punctuation, and sort the words. So "DAM software" and "software dam" and "dam  software!" all
// collapse to the same key. Conservative on purpose: only true word-set duplicates collide, not
// merely related phrases.
const normalizeTerm = (raw: string): string => String(raw || '')
   .toLowerCase()
   .replace(/[^a-z0-9\s]/g, ' ')
   .split(/\s+/)
   .filter(Boolean)
   .sort()
   .join(' ');

/**
 * Scan tracked keywords and return conservative, clear keyword-cannibalization groups. Only flags
 * cases backed by hard signals in the Keyword data (ranking-url vs target-page mismatch, a shared
 * ranking url across distinct keywords with different targets, or near-duplicate terms ranking on
 * different urls). Keywords with no live rank (position <= 0, outside the top 100) are ignored,
 * because a page that does not rank cannot be cannibalizing anything.
 * @param {CannibalInput[]} keywords - The domain's tracked keywords (position, url, target_page).
 * @returns {CannibalGroup[]}
 */
export const findCannibalization = (keywords: CannibalInput[]): CannibalGroup[] => {
   // Only ranked keywords can cannibalize. Parse once into a clean shape so the three passes below
   // share normalized urls/terms instead of re-parsing.
   const ranked = keywords
      .map((k) => ({
         keyword: String(k.keyword || ''),
         position: Number(k.position) || 0,
         url: firstUrl(k.url),
         targetPage: String(k.target_page || '').trim(),
      }))
      .filter((k) => k.keyword && k.position > 0 && k.url);

   const groups: CannibalGroup[] = [];

   // (a) Intent split: the keyword ranks on a url that is NOT its target_page. Only flag when a
   // target_page was actually set (otherwise there is nothing to disagree with) and the two urls
   // differ after normalization. This is the textbook single-keyword cannibalization symptom:
   // Google picked a different page than the one you optimized for the term.
   for (const k of ranked) {
      const target = normalizeUrl(k.targetPage);
      const ranking = normalizeUrl(k.url);
      if (target && ranking && target !== ranking) {
         groups.push({
            type: 'intent_split',
            keywords: [k.keyword],
            urls: [k.url, k.targetPage],
            why: `"${k.keyword}" ranks on ${k.url} but its target page is ${k.targetPage}. `
               + 'Google is ranking a different page than the one you optimized, so align or redirect them.',
         });
      }
   }

   // (b) Shared ranking url: two or more DISTINCT tracked keywords rank on the SAME url while their
   // target_pages differ. One page is absorbing intent meant for several pages. We require at least
   // two different target_pages in the group, so keywords that legitimately share one page (same
   // target, same ranking url) are NOT flagged. That distinct-target requirement keeps it conservative.
   const byRankingUrl = new Map<string, typeof ranked>();
   for (const k of ranked) {
      const key = normalizeUrl(k.url);
      if (!key) { continue; }
      const list = byRankingUrl.get(key) || [];
      list.push(k);
      byRankingUrl.set(key, list);
   }
   for (const list of byRankingUrl.values()) {
      if (list.length < 2) { continue; }
      const distinctTargets = new Set(list.map((k) => normalizeUrl(k.targetPage)).filter(Boolean));
      // Need 2+ keywords AND 2+ distinct target pages, so this is a real "many pages' intent funneled
      // into one url" conflict, not several keywords that all correctly point at the same page.
      if (distinctTargets.size < 2) { continue; }
      const terms = list.map((k) => k.keyword);
      const targets = Array.from(new Set(list.map((k) => k.targetPage).filter(Boolean)));
      groups.push({
         type: 'shared_url',
         keywords: terms,
         urls: [list[0].url, ...targets],
         why: `${terms.length} keywords (${terms.join(', ')}) all rank on ${list[0].url}, but they target `
            + `${targets.length} different pages (${targets.join(', ')}). One page is absorbing intent meant for several.`,
      });
   }

   // (c) Near-duplicate terms: two tracked keywords whose normalized word-sets are identical but
   // which rank on DIFFERENT urls. You are tracking the same intent twice and your own pages disagree
   // on who owns it. Identical normalized term + different ranking url is the conflict; same url is
   // fine (one page owns both phrasings). Word-set equality (not substring) keeps it strict.
   const byTerm = new Map<string, typeof ranked>();
   for (const k of ranked) {
      const key = normalizeTerm(k.keyword);
      if (!key) { continue; }
      const list = byTerm.get(key) || [];
      list.push(k);
      byTerm.set(key, list);
   }
   for (const list of byTerm.values()) {
      if (list.length < 2) { continue; }
      const distinctUrls = new Set(list.map((k) => normalizeUrl(k.url)).filter(Boolean));
      // Only a conflict when the duplicate terms rank on DIFFERENT urls. Same url means one page
      // already owns both phrasings, which is healthy, not cannibalization.
      if (distinctUrls.size < 2) { continue; }
      const terms = Array.from(new Set(list.map((k) => k.keyword)));
      const urls = Array.from(new Set(list.map((k) => k.url).filter(Boolean)));
      groups.push({
         type: 'duplicate_term',
         keywords: terms,
         urls,
         why: `Near-identical terms (${terms.join(', ')}) rank on different urls (${urls.join(', ')}). `
            + 'You are tracking the same intent twice and your pages disagree on who owns it. Consolidate to one.',
      });
   }

   return groups;
};
