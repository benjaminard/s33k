// Entry-page acquisition lens: the cross-pillar join, viewed through the LANDING page.
//
// Most analytics tools count pageviews. The acquisition question is different: for each page that
// STARTS a session (the entry page), where did that first touch come from, did it convert, and what
// keywords/rank does that page hold? Entry pages are the acquisition surface. A page that gets
// first-touch sessions is doing the work of bringing someone in; the source of that first touch
// (direct / referral / organic-search / ai) tells you HOW, and the keywords it ranks for tell you
// what search work feeds it.
//
// This module is the pure join. Given sessionized first-party traffic (each session carries its
// landing page + channel) and the domain's tracked keywords (each with a target page + Google rank),
// it produces, per entry page: entries, a source breakdown, optional goal conversions+rate, and the
// tracked keywords whose target page is that entry page. The data implicitly surfaces two gaps:
//   - ranking-without-landing: a keyword's target page holds rank but appears with zero entries.
//   - landing-without-ranking: an entry page pulls sessions but carries no tracked keywords.
// No server-side LLM: it returns the structured join for the user's own LLM to narrate.

import { SessionAgg, GoalDef, sessionConverted } from './sessionize';

export type EntryKeyword = { keyword: string, position: number, targetPage: string };

export type SourceBreakdown = {
   direct: number,
   referral: number,
   'organic-search': number,
   ai: number,
};

export type TrackedKeyword = { keyword: string, position: number };

export type EntryPageRow = {
   entryPage: string,
   entries: number,
   sources: SourceBreakdown,
   conversions: number,
   conversionRatePct: number,
   trackedKeywords: TrackedKeyword[],
};

export type EntryPageReport = {
   totalEntries: number,
   hasGoal: boolean,
   entryPages: EntryPageRow[],
};

const rate = (c: number, s: number): number => (s > 0 ? Math.round((1000 * c) / s) / 10 : 0);

// Normalize a path for comparison: strip a leading origin, lowercase, drop a trailing slash. The
// keyword target page and the session landing page come from different sources (a SERP url vs a
// client pageview path) and must compare apples-to-apples, e.g. "https://x.com/Pricing/" == "/pricing".
export const normPath = (p: string): string => {
   let s = String(p || '').trim().toLowerCase();
   s = s.replace(/^https?:\/\/[^/]+/, '');
   if (s.length > 1) { s = s.replace(/\/+$/, ''); }
   return s || '/';
};

const emptySources = (): SourceBreakdown => ({ direct: 0, referral: 0, 'organic-search': 0, ai: 0 });

/**
 * Build the entry-page acquisition report by joining sessionized traffic (segmented by entry page)
 * to the domain's tracked keywords (by target page). When a goal is given, each entry page also
 * carries its conversions and conversion rate over the sessions that started there.
 * @param {SessionAgg[]} sessions - Already filtered (e.g. human-only) sessionized traffic.
 * @param {EntryKeyword[]} keywords - The domain's tracked keywords with target page + Google rank.
 * @param {GoalDef | null} goal - Optional conversion goal. null = no conversion columns.
 * @returns {EntryPageReport}
 */
export const buildEntryPageReport = (
   sessions: SessionAgg[],
   keywords: EntryKeyword[],
   goal: GoalDef | null,
): EntryPageReport => {
   // Index tracked keywords by their normalized target page, so a page with no keyword still shows
   // (landing-without-ranking) and a keyword whose page never lands still shows (ranking-without-
   // landing) once we union the two key sets below.
   const kwByPage = new Map<string, TrackedKeyword[]>();
   for (const k of keywords) {
      if (!k.targetPage) { continue; }
      const key = normPath(k.targetPage);
      if (!kwByPage.has(key)) { kwByPage.set(key, []); }
      (kwByPage.get(key) as TrackedKeyword[]).push({ keyword: k.keyword, position: k.position });
   }

   // Bucket sessions by their entry (landing) page. landingPage is the session's first pageview.
   type Bucket = { entryPage: string, entries: number, sources: SourceBreakdown, conversions: number };
   const buckets = new Map<string, Bucket>();
   const ensure = (rawPage: string): Bucket => {
      const key = normPath(rawPage);
      if (!buckets.has(key)) {
         buckets.set(key, { entryPage: key, entries: 0, sources: emptySources(), conversions: 0 });
      }
      return buckets.get(key) as Bucket;
   };

   for (const s of sessions) {
      // Guard on pageviewCount > 0 so a session with no pageview (sessionize falls back landingPage to
      // its first event page) cannot credit an entry to a page that was never viewed. Matches
      // human-analytics, which also guards pageviews>0.
      if (s.pageviewCount <= 0) { continue; }
      const b = ensure(s.landingPage);
      b.entries += 1;
      // channel is already normalized to one of the four classes by sessionize.normalizeChannel.
      if (s.channel === 'referral') { b.sources.referral += 1; }
      else if (s.channel === 'organic-search') { b.sources['organic-search'] += 1; }
      else if (s.channel === 'ai') { b.sources.ai += 1; }
      else { b.sources.direct += 1; }
      if (goal && sessionConverted(s, goal)) { b.conversions += 1; }
   }

   // Union the landed pages with the keyword target pages, so a ranking page with zero entries still
   // appears (its entries/sources are zero, its trackedKeywords non-empty: the ranking-without-
   // landing signal). Pages that landed but rank for nothing carry an empty trackedKeywords array.
   const allKeys = new Set<string>([...buckets.keys(), ...kwByPage.keys()]);
   const entryPages: EntryPageRow[] = Array.from(allKeys).map((key) => {
      const b = buckets.get(key) || { entryPage: key, entries: 0, sources: emptySources(), conversions: 0 };
      return {
         entryPage: key,
         entries: b.entries,
         sources: b.sources,
         conversions: b.conversions,
         conversionRatePct: rate(b.conversions, b.entries),
         trackedKeywords: (kwByPage.get(key) || []).sort((a, c) => a.position - c.position),
      };
   }).sort((a, c) => c.entries - a.entries || c.trackedKeywords.length - a.trackedKeywords.length);

   // totalEntries must reconcile with the sum of per-page entries: only sessions with a pageview
   // credit an entry page (the pageviewCount > 0 guard above), so a pageview-less session must not
   // inflate the header relative to the breakdown the user can actually sum.
   const totalEntries = sessions.reduce((n, s) => (s.pageviewCount > 0 ? n + 1 : n), 0);
   return {
      totalEntries,
      hasGoal: Boolean(goal),
      entryPages,
   };
};
