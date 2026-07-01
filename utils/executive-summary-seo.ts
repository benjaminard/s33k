// Pure SEO helpers for the executive_summary report. Kept out of the route (and distinct from
// striking-distance.ts, which does its OWN window math) so the rank-movement logic is unit-testable
// in isolation and can never quietly diverge from the route's expectations.
//
// One job: given the domain's tracked keywords (each with a current position and a JSON history blob
// of { 'YYYY-MM-DD': position }), summarize the SEO state for a leadership glance: how many keywords
// sit on page one right now, and the single biggest rank GAIN and biggest rank LOSS over the period.
// No server-side LLM, no DB: it takes already-read rows and returns plain numbers and labels.

import { historyDateMs } from './history-date';

export type SeoKeywordInput = {
   keyword: string,
   position: number,
   // history is the raw column value: a JSON string of { 'YYYY-MM-DD': position }. Parsed
   // defensively here so a malformed blob on one row never throws the whole summary.
   history: string,
};

export type RankMove = {
   keyword: string,
   // Positive delta = the keyword IMPROVED (moved UP toward #1). We invert the raw position
   // difference here (improving means the number goes DOWN, e.g. 18 -> 9), so a leadership reader
   // sees "+9" as good news without having to know that lower positions are better.
   delta: number,
   fromPosition: number,
   toPosition: number,
};

export type SeoSummary = {
   trackedKeywords: number,
   // Count of keywords whose CURRENT position is on page one (1..10). The headline SEO number.
   keywordsOnPageOne: number,
   // The single biggest improvement and the single biggest decline over the period, or null when
   // no keyword has two comparable history points inside the window.
   biggestGain: RankMove | null,
   biggestLoss: RankMove | null,
};

const PAGE_ONE_MAX = 10;

// Parse history into chronological [dateMs, position] pairs, oldest first. Keeps a 0 position
// (dropped OUT of rankings that day) as a real worst-case value rather than filtering it, so this
// report agrees with rank-movers.ts: a keyword that fell out of the rankings is the biggest
// worsening signal, not invisible. Mirrors striking-distance.ts's historyPairs shape but with the
// rank-movers convention for drop-outs, kept local so the reports stay independent.
const historyPairs = (raw: string): Array<[number, number]> => {
   const s = String(raw || '').trim();
   if (!s) { return []; }
   try {
      const parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return []; }
      return Object.entries(parsed as Record<string, unknown>)
         // historyDateMs tolerates both the new padded-ISO key and the old "2026-6-9" form and parses
         // UTC-midnight, so mixed-format history sorts and window-clips correctly (see utils/history-date.ts).
         .map(([date, pos]) => [historyDateMs(date), Number(pos)] as [number, number])
         .filter(([d, pos]) => Number.isFinite(d) && Number.isFinite(pos) && pos >= 0)
         .sort((a, b) => a[0] - b[0]);
   } catch {
      return [];
   }
};

/**
 * Compute the rank move for one keyword over a period: the earliest history point AT OR AFTER the
 * period start versus the latest point. delta is inverted so positive = improved (climbed toward #1).
 * Returns null when there are not two comparable in-window points to compare.
 * @param {SeoKeywordInput} kw - One keyword with its raw history blob.
 * @param {number} periodStartMs - The earliest history timestamp (ms) to consider.
 * @returns {RankMove | null}
 */
export const keywordRankMove = (kw: SeoKeywordInput, periodStartMs: number): RankMove | null => {
   const pairs = historyPairs(kw.history);
   // Only points inside the window define the move; an old point before the window would overstate
   // change attributable to "this period". Fall back to all points only if none are in-window AND
   // there are at least two, so a keyword with sparse history still contributes a comparison.
   const inWindow = pairs.filter(([d]) => d >= periodStartMs);
   const usable = inWindow.length >= 2 ? inWindow : (pairs.length >= 2 ? pairs : []);
   if (usable.length < 2) { return null; }
   const from = usable[0][1];
   const to = usable[usable.length - 1][1];
   return { keyword: kw.keyword, delta: from - to, fromPosition: from, toPosition: to };
};

/**
 * Summarize the SEO pillar for the executive summary: page-one count (from current positions) plus
 * the biggest gain and biggest loss over the period (from each keyword's history).
 * @param {SeoKeywordInput[]} keywords - The domain's tracked keywords.
 * @param {number} periodStartMs - The earliest history timestamp (ms) to consider for movement.
 * @returns {SeoSummary}
 */
export const summarizeSeo = (keywords: SeoKeywordInput[], periodStartMs: number): SeoSummary => {
   const keywordsOnPageOne = keywords.filter((k) => k.position > 0 && k.position <= PAGE_ONE_MAX).length;

   const moves = keywords
      .map((k) => keywordRankMove(k, periodStartMs))
      .filter((m): m is RankMove => m !== null && m.delta !== 0);

   // Biggest gain = most positive delta; biggest loss = most negative delta. Ties break on the
   // larger absolute move toward/away from #1 already captured by delta, so a simple sort suffices.
   const gains = moves.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta);
   const losses = moves.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta);

   return {
      trackedKeywords: keywords.length,
      keywordsOnPageOne,
      biggestGain: gains[0] || null,
      biggestLoss: losses[0] || null,
   };
};
