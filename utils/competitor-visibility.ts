/**
 * Competitor share-of-voice from data s33k ALREADY stores.
 *
 * Every tracked keyword persists its full Google SERP page in the `lastResult` column
 * (a KeywordLastResult[] of { position, url, title, skipped? } for up to 100 positions,
 * written by the scraper via buildFullResults -> refresh.ts). That means, for free and
 * with no new data collection, we can read every OTHER domain that ranks for the same
 * terms the tracked domain tracks, and tally how often each external domain shows up.
 *
 * Share of voice for an external domain = (number of the domain's tracked keywords on
 * whose SERP that competitor appears) / (number of tracked keywords that have SERP data).
 * We also report the competitor's average rank across the keywords it appears on, and a
 * per-keyword "who outranks you" view (competitors ranking ABOVE your position for that
 * keyword). No scraping, no LLM, pure read over stored SERP arrays.
 */

/**
 * Extract a bare, comparable hostname from a SERP result URL.
 * Lowercased, scheme stripped, leading "www." removed. Returns '' on a bad/empty URL.
 * Self-contained on purpose so this util drags in no shared model/sequelize imports.
 * @param {string} rawUrl - a result URL, e.g. "https://www.competitor.com/post".
 * @returns {string} bare hostname, e.g. "competitor.com", or '' if unparseable.
 */
export const hostFromUrl = (rawUrl: string): string => {
   const url = String(rawUrl || '').trim();
   if (!url) { return ''; }
   try {
      const parsed = new URL(url.includes('://') ? url : `https://${url}`);
      return parsed.hostname.toLowerCase().replace(/^www\./, '');
   } catch (e) {
      return '';
   }
};

/** Same normalization for the tracked domain so we can exclude it from "competitors". */
export const normalizeHost = (input: string): string => String(input || '')
   .trim()
   .toLowerCase()
   .replace(/^https?:\/\//, '')
   .replace(/^www\./, '')
   .replace(/\/.*$/, '');

export type CompetitorRow = {
   domain: string,
   appearances: number,
   keywordCount: number,
   shareOfVoice: number,
   avgPosition: number,
};

export type OutrankedKeyword = {
   keyword: string,
   yourPosition: number,
   outrankedBy: { domain: string, position: number, url: string }[],
};

export type CompetitorVisibility = {
   keywordsAnalyzed: number,
   competitors: CompetitorRow[],
   outrankedKeywords: OutrankedKeyword[],
};

export type SerpItem = { position: number, url: string, title?: string, skipped?: boolean };

/**
 * The external domains sitting immediately ABOVE a given position on a stored SERP,
 * nearest first. Used to enrich rank alerts with "who is directly above you now"
 * from data s33k already stores (no new scrape). Each host appears once, at its
 * best (closest-above) position; the tracked domain itself is excluded.
 * @param {SerpItem[]} serp - the keyword's stored SERP page (lastResult, parsed).
 * @param {number} position - the tracked domain's position on that SERP (1 = top).
 * @param {string} trackedDomain - the domain being analyzed, excluded from results.
 * @param {number} max - max hosts returned (default 3: "immediately above", not the whole SERP).
 * @returns {string[]} bare hostnames ordered nearest-above first, e.g. ["a.com", "b.com"].
 */
export const domainsAboveOnSerp = (
   serp: SerpItem[],
   position: number,
   trackedDomain: string,
   max: number = 3,
): string[] => {
   if (!Array.isArray(serp) || !Number.isFinite(position) || position <= 1) { return []; }
   const trackedHost = normalizeHost(trackedDomain);
   // Each host once, at its best (lowest-number) position above the user.
   const bestByHost = new Map<string, number>();
   serp.forEach((item) => {
      if (!item || item.skipped || !item.url || !(item.position > 0) || item.position >= position) { return; }
      const host = hostFromUrl(item.url);
      if (!host || host === trackedHost) { return; }
      const prev = bestByHost.get(host);
      if (prev === undefined || item.position < prev) { bestByHost.set(host, item.position); }
   });
   // Nearest above first = highest position number first (position user-1, then user-2, ...).
   return Array.from(bestByHost.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([host]) => host);
};

type KeywordLike = {
   keyword: string,
   position: number,
   lastResult: SerpItem[],
};

/**
 * Per external domain, the running tally needed to compute share of voice.
 * keywords is a Set of keyword strings so a domain appearing multiple times on one
 * SERP (e.g. two pages of the same site) still counts as ONE keyword appearance.
 */
type Tally = { keywords: Set<string>, positionSum: number, appearances: number };

/**
 * Compute competitor share-of-voice over a domain's tracked keywords.
 * @param {KeywordLike[]} keywords - parsed keywords (lastResult already JSON-parsed).
 * @param {string} trackedDomain - the domain being analyzed, excluded from competitors.
 * @param {number} topLimit - max competitors to return, ranked by share of voice.
 * @returns {CompetitorVisibility}
 */
export const computeCompetitorVisibility = (
   keywords: KeywordLike[],
   trackedDomain: string,
   topLimit: number = 25,
): CompetitorVisibility => {
   const trackedHost = normalizeHost(trackedDomain);
   const tallies = new Map<string, Tally>();
   const outrankedKeywords: OutrankedKeyword[] = [];
   let keywordsAnalyzed = 0;

   keywords.forEach((kw) => {
      const serp = Array.isArray(kw.lastResult) ? kw.lastResult : [];
      // Only real (non-skipped) ranked rows with a URL carry a competitor.
      const ranked = serp.filter((item) => item && !item.skipped && item.url && item.url.trim());
      if (ranked.length === 0) { return; }
      keywordsAnalyzed += 1;

      // Per keyword, count each external host at most once (its best position on this SERP).
      const bestPosByHost = new Map<string, number>();
      ranked.forEach((item) => {
         const host = hostFromUrl(item.url);
         if (!host || host === trackedHost) { return; }
         const prev = bestPosByHost.get(host);
         if (prev === undefined || item.position < prev) { bestPosByHost.set(host, item.position); }
      });

      bestPosByHost.forEach((position, host) => {
         const tally = tallies.get(host) || { keywords: new Set<string>(), positionSum: 0, appearances: 0 };
         tally.keywords.add(kw.keyword);
         tally.positionSum += position;
         tally.appearances += 1;
         tallies.set(host, tally);
      });

      // "Who outranks you": competitors ranking ABOVE the tracked domain's position for
      // this keyword. yourPosition === 0 means not ranked, so everyone on the SERP outranks.
      const yourPosition = kw.position;
      const outrankedBy: { domain: string, position: number, url: string }[] = [];
      ranked.forEach((item) => {
         const host = hostFromUrl(item.url);
         if (!host || host === trackedHost) { return; }
         const beats = yourPosition === 0 ? true : item.position < yourPosition;
         if (beats) { outrankedBy.push({ domain: host, position: item.position, url: item.url }); }
      });
      if (outrankedBy.length > 0) {
         // Dedupe to each competitor's best (lowest) position, then sort by position.
         const bestByHost = new Map<string, { domain: string, position: number, url: string }>();
         outrankedBy.forEach((entry) => {
            const prev = bestByHost.get(entry.domain);
            if (!prev || entry.position < prev.position) { bestByHost.set(entry.domain, entry); }
         });
         outrankedKeywords.push({
            keyword: kw.keyword,
            yourPosition,
            outrankedBy: Array.from(bestByHost.values()).sort((a, b) => a.position - b.position),
         });
      }
   });

   const competitors: CompetitorRow[] = Array.from(tallies.entries())
      .map(([domain, tally]) => {
         const keywordCount = tally.keywords.size;
         return {
            domain,
            appearances: tally.appearances,
            keywordCount,
            shareOfVoice: keywordsAnalyzed > 0 ? Number((keywordCount / keywordsAnalyzed).toFixed(4)) : 0,
            avgPosition: tally.appearances > 0 ? Number((tally.positionSum / tally.appearances).toFixed(2)) : 0,
         };
      })
      // Rank by share of voice, then by better (lower) average position as a tiebreak.
      .sort((a, b) => (b.shareOfVoice - a.shareOfVoice) || (a.avgPosition - b.avgPosition))
      .slice(0, topLimit);

   // Worst gaps first: keywords where the most competitors outrank you.
   outrankedKeywords.sort((a, b) => b.outrankedBy.length - a.outrankedBy.length);

   return { keywordsAnalyzed, competitors, outrankedKeywords };
};
