// Content performance: the "which content actually performs" report, ranked by pageviews.
//
// Most analytics tools answer "which page got the most views" and stop there. The performance
// question a marketer actually asks is richer and cross-pillar: for each top page, how much traffic
// does it pull, how much of that traffic does it ACQUIRE (sessions that landed there, not just
// passed through), does it convert, and what does it rank for. This module is the pure join that
// answers all four per page in one pass.
//
// Per page (keyed by pageview path) it computes:
//   - pageviews: total pageview events on that path (the ranking key).
//   - entries: sessions whose first pageview LANDED on that path (the acquisition signal). A page
//     can have many pageviews but few entries (a deep page people reach mid-session) or the reverse
//     (a pure landing page).
//   - conversions + rate (when a goal is given): sessions that VIEWED the page anywhere in their
//     journey AND converted, over sessions that viewed it. This is view-attributed, not last-touch:
//     it answers "of everyone who saw this page, how many converted", the content-influence lens.
//   - keywords: the tracked keywords whose target page is this page, each with its current Google
//     rank, so each top page shows what search work feeds it.
//
// No server-side LLM: it returns the structured join for the user's own LLM to narrate.

import { SessionAgg, GoalDef, sessionConverted } from './sessionize';
import { normPath } from './entry-page-report';

export type PerfKeyword = { keyword: string, position: number, targetPage: string };

export type PerfKeywordOut = { keyword: string, position: number };

export type ContentPerfRow = {
   page: string,
   pageviews: number,
   entries: number,
   conversions: number,
   conversionRatePct: number,
   keywords: PerfKeywordOut[],
};

export type ContentPerfReport = {
   totalPageviews: number,
   hasGoal: boolean,
   pages: ContentPerfRow[],
};

const rate = (c: number, s: number): number => (s > 0 ? Math.round((1000 * c) / s) / 10 : 0);

/**
 * Build the content-performance report by ranking pages by pageviews and joining, per page, the
 * acquisition (entries), conversion (view-attributed), and SEO (tracked keywords) signals.
 * @param {SessionAgg[]} sessions - Already filtered (e.g. human-only) sessionized traffic.
 * @param {PerfKeyword[]} keywords - The domain's tracked keywords with target page + Google rank.
 * @param {GoalDef | null} goal - Optional conversion goal. null = no conversion columns.
 * @param {number} limit - Max pages to return (top N by pageviews). Clamped by the caller.
 * @returns {ContentPerfReport}
 */
export const buildContentPerformance = (
   sessions: SessionAgg[],
   keywords: PerfKeyword[],
   goal: GoalDef | null,
   limit: number,
): ContentPerfReport => {
   // Index tracked keywords by normalized target page. A page that ranks for nothing simply gets an
   // empty keyword list; the join key is normPath so a SERP url and a client pageview path compare
   // apples-to-apples (e.g. "https://x.com/Pricing/" == "/pricing").
   const kwByPage = new Map<string, PerfKeywordOut[]>();
   for (const k of keywords) {
      if (!k.targetPage) { continue; }
      const key = normPath(k.targetPage);
      if (!kwByPage.has(key)) { kwByPage.set(key, []); }
      (kwByPage.get(key) as PerfKeywordOut[]).push({ keyword: k.keyword, position: k.position });
   }

   // Tally per page. pageviews counts every pageview event on the path (so multiple views in one
   // session all count, which is correct for a "views" ranking). entries counts a session once, on
   // its landing path only. conversions counts a session once per page it VIEWED, when it converted,
   // so the same converting session can credit several pages it passed through (view-attribution).
   type Bucket = { page: string, pageviews: number, entries: number, viewers: number, conversions: number };
   const buckets = new Map<string, Bucket>();
   const ensure = (rawPath: string): Bucket => {
      const key = normPath(rawPath);
      if (!buckets.has(key)) {
         buckets.set(key, { page: key, pageviews: 0, entries: 0, viewers: 0, conversions: 0 });
      }
      return buckets.get(key) as Bucket;
   };

   let totalPageviews = 0;
   for (const s of sessions) {
      // Every pageview path in the session feeds pageviews + the viewers/conversions tally. A path
      // viewed twice in one session counts twice toward pageviews but the session only counts once
      // toward that page's viewers/conversions (it is the same session), so dedupe per session.
      const converted = goal ? sessionConverted(s, goal) : false;
      const seenThisSession = new Set<string>();
      for (const rawPath of s.pageviewPaths) {
         const b = ensure(rawPath);
         b.pageviews += 1;
         totalPageviews += 1;
         if (!seenThisSession.has(b.page)) {
            seenThisSession.add(b.page);
            b.viewers += 1;
            if (converted) { b.conversions += 1; }
         }
      }
      // entries: the session's landing page, counted once. Guard on pageviewCount > 0 so a session
      // with no pageview (sessionize falls back landingPage to its first event page) cannot credit an
      // entry to a page that was never viewed. Matches human-analytics, which also guards pageviews>0.
      if (s.pageviewCount > 0) { ensure(s.landingPage).entries += 1; }
   }

   // Union the viewed pages with the keyword target pages, so a tracked-but-never-viewed page still
   // appears (zero pageviews, non-empty keywords). Rank by pageviews, then take the top N.
   const allKeys = new Set<string>([...buckets.keys(), ...kwByPage.keys()]);
   const pages: ContentPerfRow[] = Array.from(allKeys).map((key) => {
      const b = buckets.get(key) || { page: key, pageviews: 0, entries: 0, viewers: 0, conversions: 0 };
      return {
         page: key,
         pageviews: b.pageviews,
         entries: b.entries,
         conversions: b.conversions,
         // rate is conversions over VIEWERS of the page (sessions that saw it), not over pageviews.
         conversionRatePct: rate(b.conversions, b.viewers),
         keywords: (kwByPage.get(key) || []).sort((a, c) => a.position - c.position),
      };
   }).sort((a, c) => c.pageviews - a.pageviews || c.entries - a.entries || c.keywords.length - a.keywords.length)
      .slice(0, limit);

   return {
      totalPageviews,
      hasGoal: Boolean(goal),
      pages,
   };
};
