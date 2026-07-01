// Conversion attribution: the merged-pillar superpower only s33k can do.
//
// s33k is the only place that holds, for one domain in one store: which keywords a page RANKS for
// (SEO), where every human session CAME FROM including AI engines (analytics + AEO), and which
// sessions CONVERTED a named goal (conversions). Merge them and you can answer what no single tool
// can: "what actually drives conversions, SEO vs direct vs AI, down to the keyword and page, and
// what one move drives the most more?"
//
// This module is the join. Given sessionized first-party traffic (which carries channel + landing
// page + human/bot), a goal, and the domain's tracked keywords (each with a target page + Google
// rank), it produces:
//   - byChannel: conversion rate per acquisition channel (direct / organic-search / referral / ai),
//     the "does AI search actually convert?" answer nobody else has.
//   - byKeyword: each tracked keyword credited with the conversions its target page drove, plus its
//     current rank, so keywords rank by CONVERSIONS, not clicks.
//   - opportunities: the money moves. "ranks well, converts nothing" (fix the page) and "converts
//     well, ranks poorly" (push the rank), with a projected-conversions estimate.
// No server-side LLM: it returns structured joins for the user's own LLM (and the briefing) to
// narrate.

import { SessionAgg, GoalDef, sessionConverted } from './sessionize';

export type AttribKeyword = { keyword: string, position: number, targetPage: string };

// revenue is OPTIONAL on every row: present only when the goal carries a monetary value, and equal
// to that row's conversions * goal value. A value-less goal omits revenue everywhere, so the shape
// is byte-for-byte unchanged for goals that have no value.
export type ChannelRow = { channel: string, sessions: number, conversions: number, conversionRatePct: number, revenue?: number };
export type KeywordRow = {
   keyword: string,
   position: number,
   targetPage: string,
   conversions: number,
   landingSessions: number,
   conversionRatePct: number,
   revenue?: number,
};
export type Opportunity = {
   type: 'rank-not-converting' | 'converting-not-ranking' | 'ai-outconverts-search',
   page?: string,
   keyword?: string,
   detail: string,
   projectedConversions?: number,
};

export type ConversionAttribution = {
   totalSessions: number,
   conversions: number,
   conversionRatePct: number,
   // The money worth of one conversion of this goal, when set (else null). When set, totalRevenue is
   // conversions * goalValue and every byChannel / byKeyword row carries its own revenue. When null,
   // totalRevenue is null and the revenue fields are omitted from the rows, so a value-less goal
   // reports exactly as before.
   goalValue: number | null,
   totalRevenue: number | null,
   byChannel: ChannelRow[],
   byKeyword: KeywordRow[],
   // Each keyword is credited with the FULL conversions of its target PAGE, so two keywords sharing
   // one target page each report that page's conversions. Summing byKeyword double-counts; use the
   // top-level distinct-converter `conversions` for any total.
   byKeywordNote: string,
   opportunities: Opportunity[],
};

const rate = (c: number, s: number): number => (s > 0 ? Math.round((1000 * c) / s) / 10 : 0);

// Round money to cents so conversions * a fractional value never reports a long float tail.
const money = (n: number): number => Math.round(n * 100) / 100;

// Normalize a path for comparison: strip trailing slash, lowercase, drop the origin if a full URL.
const normPath = (p: string): string => {
   let s = String(p || '').trim().toLowerCase();
   s = s.replace(/^https?:\/\/[^/]+/, '');
   if (s.length > 1) { s = s.replace(/\/+$/, ''); }
   return s || '/';
};

/**
 * Join sessionized traffic, a goal, and tracked keywords into a cross-pillar conversion attribution.
 * @param {SessionAgg[]} sessions - Already filtered (e.g. human-only) sessionized traffic.
 * @param {GoalDef} goal - The conversion goal to attribute.
 * @param {AttribKeyword[]} keywords - The domain's tracked keywords with target page + rank.
 * @param {number|null} [goalValue] - Optional money worth of one conversion. When a finite number
 *   >= 0, revenue fields (totalRevenue + per-channel + per-keyword revenue) are added; when null or
 *   omitted, revenue is null/omitted and the result is byte-for-byte the value-less shape.
 * @returns {ConversionAttribution}
 */
export const attributeConversions = (
   sessions: SessionAgg[],
   goal: GoalDef,
   keywords: AttribKeyword[],
   goalValue: number | null = null,
): ConversionAttribution => {
   const hasValue = typeof goalValue === 'number' && Number.isFinite(goalValue) && goalValue >= 0;
   const totalSessions = sessions.length;
   const converters = sessions.filter((s) => sessionConverted(s, goal));
   const conversions = converters.length;

   // By channel (the AEO/analytics merge: which sources convert, AI included).
   const chBucket = new Map<string, { sessions: number, conversions: number }>();
   for (const s of sessions) {
      if (!chBucket.has(s.channel)) { chBucket.set(s.channel, { sessions: 0, conversions: 0 }); }
      const b = chBucket.get(s.channel) as { sessions: number, conversions: number };
      b.sessions += 1;
      if (sessionConverted(s, goal)) { b.conversions += 1; }
   }
   const byChannel: ChannelRow[] = Array.from(chBucket.entries())
      .map(([channel, v]) => {
         const r: ChannelRow = { channel, sessions: v.sessions, conversions: v.conversions, conversionRatePct: rate(v.conversions, v.sessions) };
         if (hasValue) { r.revenue = money(v.conversions * (goalValue as number)); }
         return r;
      })
      .sort((a, b) => b.conversions - a.conversions || b.sessions - a.sessions);

   // By keyword (the SEO merge: credit each keyword's target page with the conversions of sessions
   // that landed on it). A session is credited to a keyword when the keyword's target page is the
   // session's landing page (the page is the acquisition surface the keyword feeds).
   const byKeyword: KeywordRow[] = keywords
      .filter((k) => k.targetPage)
      .map((k) => {
         const target = normPath(k.targetPage);
         const landed = sessions.filter((s) => normPath(s.landingPage) === target);
         const conv = landed.filter((s) => sessionConverted(s, goal)).length;
         const r: KeywordRow = {
            keyword: k.keyword,
            position: k.position,
            targetPage: k.targetPage,
            conversions: conv,
            landingSessions: landed.length,
            conversionRatePct: rate(conv, landed.length),
         };
         if (hasValue) { r.revenue = money(conv * (goalValue as number)); }
         return r;
      })
      .sort((a, b) => b.conversions - a.conversions || a.position - b.position);

   // Opportunities, the money moves.
   const opportunities: Opportunity[] = [];

   // 1. Ranks on page one but its landing sessions convert at zero: the page, not the rank, is the
   //    problem.
   for (const k of byKeyword) {
      if (k.position > 0 && k.position <= 10 && k.landingSessions >= 3 && k.conversions === 0) {
         opportunities.push({
            type: 'rank-not-converting',
            page: k.targetPage,
            keyword: k.keyword,
            detail: `"${k.keyword}" ranks #${k.position} and lands ${k.landingSessions} session(s) on ${k.targetPage}, but none converted. `
               + 'The rank is working; the page is not. Fix the page (clearer offer, stronger CTA) before chasing more rank.',
         });
      }
   }
   // 2. Converts well but ranks poorly (or not in top 10): pushing the rank compounds a proven page.
   for (const k of byKeyword) {
      const landRate = k.conversionRatePct;
      if (k.conversions >= 1 && (k.position === 0 || k.position > 10) && landRate > 0) {
         // Rough estimate: if rank reaches page one, assume landing sessions roughly double, so at a
         // held conversion rate the conversions roughly double too. This is a directional guess, not a forecast.
         const projected = Math.round(k.conversions * 2);
         opportunities.push({
            type: 'converting-not-ranking',
            page: k.targetPage,
            keyword: k.keyword,
            detail: `${k.targetPage} converts landing visitors at ${landRate}% but "${k.keyword}" ranks `
               + `${k.position === 0 ? 'outside the top 100' : `#${k.position}`}. Pushing it onto page one compounds a page that already converts. `
               + `Projected ~${projected} conversion(s) is a rough estimate assuming page-one roughly doubles landing sessions.`,
            projectedConversions: projected,
         });
      }
   }
   // 3. AI search out-converts organic search: lean into AEO for these pages.
   const ai = byChannel.find((c) => c.channel === 'ai');
   const search = byChannel.find((c) => c.channel === 'organic-search');
   if (ai && search && ai.sessions >= 2 && ai.conversionRatePct > search.conversionRatePct && ai.conversionRatePct > 0) {
      opportunities.push({
         type: 'ai-outconverts-search',
         detail: `AI-search visitors convert at ${ai.conversionRatePct}% versus ${search.conversionRatePct}% from organic search. `
            + 'AEO is paying off; make the pages AI engines cite more citation-ready (clear claims up top, structured answers) to compound it.',
      });
   }

   return {
      totalSessions,
      conversions,
      conversionRatePct: rate(conversions, totalSessions),
      goalValue: hasValue ? (goalValue as number) : null,
      totalRevenue: hasValue ? money(conversions * (goalValue as number)) : null,
      byChannel,
      byKeyword: byKeyword.filter((k) => k.landingSessions > 0),
      byKeywordNote: 'Per-keyword conversions are per-page credits and may overlap when keywords share a target page. '
         + 'Do NOT sum byKeyword; use the top-level conversions for the distinct total.',
      opportunities,
   };
};
