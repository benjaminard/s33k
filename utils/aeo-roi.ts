// AEO ROI: "The AI Visibility P&L". The cross-pillar report no AEO tool can produce, because no AEO
// tool holds, in one store, all of: which human sessions AI engines REFERRED (analytics + the 'ai'
// channel), which of those sessions CONVERTED a named goal (conversions), and what one conversion is
// WORTH (goal value). This module is the join that closes the loop: AI-referred traffic -> conversions
// -> revenue, per page.
//
// It mirrors attributeConversions in conversion-attribution.ts: a pure function (no IO, no LLM) that
// takes already-read rows and returns a structured join for the user's own LLM (and the briefing) to
// narrate. It reuses the same primitives: normPath for page comparison, the 'ai' channel from
// sessionize, sessionConverted for the goal test, and the goalValue/money revenue pattern.
//
// CRITICAL HONESTY (the whole point of an honest P&L): when a layer has no data, this module stays
// SILENT rather than fabricate a rate off a zero baseline. 0 AI sessions on a page is a normal,
// expected state. Every rate is divide-by-zero guarded, every "opportunity" requires a real signal on
// BOTH sides of the comparison it makes, and the top-level note says plainly when there is simply no
// AI activity in the window.

import { SessionAgg, GoalDef, sessionConverted } from './sessionize';

// A keyword carries its target page so a page with no AI traffic yet can still be NAMED in the P&L
// as a tracked, intended-to-rank page (context), not silently dropped. Only the target page is used.
export type RoiKeyword = { keyword: string, targetPage: string };

export type RoiOpportunity = {
   // ai-outconverts-organic: the page's AI-referred sessions convert materially better than its
   //   organic-search sessions (lean into AEO for this page).
   // cited-not-converting: AI is sending real visitors to the page but none convert (fix the page,
   //   not the AI visibility).
   type: 'ai-outconverts-organic' | 'cited-not-converting',
   page: string,
   detail: string,
};

export type RoiPageRow = {
   page: string,
   aiReferredSessions: number,
   aiConversions: number,
   // Conversion rate of THIS page's AI-referred sessions. 0 when the page has no AI sessions (an
   // honest 0 of a 0 baseline, never a fabricated rate); reading aiReferredSessions tells you which.
   aiConversionRatePct: number,
   // revenue is OPTIONAL-by-null exactly like conversion-attribution: the number when the goal carries
   // a value (aiConversions * value), else null so a value-less goal reports no money anywhere.
   revenue: number | null,
   // Conversion rate of this page's ORGANIC-SEARCH sessions, the honest comparison baseline for the
   // ai-outconverts-organic call. 0 when the page has no organic sessions (again: read the sessions).
   organicConversionRatePct: number,
};

export type AeoRoi = {
   totalAiSessions: number,
   aiConversions: number,
   totalAiRevenue: number | null,
   byPage: RoiPageRow[],
   opportunities: RoiOpportunity[],
   note: string,
};

// Conversion-rate percent, divide-by-zero guarded. 0 sessions reports 0, never NaN. Mirrors the rate
// helper in conversion-attribution.ts (one decimal place).
const rate = (c: number, s: number): number => (s > 0 ? Math.round((1000 * c) / s) / 10 : 0);

// Round money to cents so conversions * a fractional goal value never reports a long float tail.
// Mirrors conversion-attribution.ts.
const money = (n: number): number => Math.round(n * 100) / 100;

// Normalize a path for comparison: strip origin + trailing slash, lowercase. Mirrors normPath in
// conversion-attribution.ts so the session side joins on identical page keys.
const cleanPath = (p: string): string => {
   let s = String(p || '').trim().toLowerCase();
   s = s.replace(/^https?:\/\/[^/]+/, '');
   const q = s.search(/[?#]/);
   if (q >= 0) { s = s.slice(0, q); }
   if (s.length > 1) { s = s.replace(/\/+$/, ''); }
   return s || '/';
};

// A page is "materially better" at converting via AI than via organic only when the gap clears a
// floor, so a 1-point wobble on tiny samples does not fire an opportunity. Kept explicit, not magic.
const MATERIAL_GAP_PCT = 5;

/**
 * Join AI-referred + organic human sessions, a goal, and tracked keywords into the AI Visibility
 * P&L: referred sessions -> conversions -> revenue, per page.
 *
 * @param {SessionAgg[]} sessions - Sessionized human sessions (the route filters bots out by default).
 *   The 'ai' channel marks AI-referred sessions; 'organic-search' is the comparison baseline.
 * @param {GoalDef} goal - The conversion goal to attribute.
 * @param {RoiKeyword[]} keywords - The domain's tracked keywords with target pages, so a tracked page
 *   with no AI activity yet is still named in the P&L as context.
 * @param {number|null} [goalValue] - Optional money worth of one conversion. A finite number >= 0 adds
 *   revenue (total + per page); null/omitted reports revenue as null everywhere (value-less goal).
 * @returns {AeoRoi}
 */
export const buildAeoRoi = (
   sessions: SessionAgg[],
   goal: GoalDef,
   keywords: RoiKeyword[],
   goalValue: number | null = null,
): AeoRoi => {
   const hasValue = typeof goalValue === 'number' && Number.isFinite(goalValue) && goalValue >= 0;

   const aiSessions = sessions.filter((s) => s.channel === 'ai');
   const organicSessions = sessions.filter((s) => s.channel === 'organic-search');

   const totalAiSessions = aiSessions.length;
   const aiConversions = aiSessions.filter((s) => sessionConverted(s, goal)).length;
   const totalAiRevenue = hasValue ? money(aiConversions * (goalValue as number)) : null;

   // Per-page accumulation keyed by normalized path. A page can be introduced by an AI session, by an
   // organic session, or by a tracked keyword's target page (so tracked-but-quiet pages still appear
   // as honest 0-activity context rows). Every page that touches ANY layer is a key.
   type Acc = {
      page: string, // the first-seen display path for this key
      aiReferredSessions: number,
      aiConversions: number,
      organicSessions: number,
      organicConversions: number,
   };
   const pages = new Map<string, Acc>();
   const ensure = (rawPage: string): Acc => {
      const key = cleanPath(rawPage);
      let acc = pages.get(key);
      if (!acc) {
         acc = { page: key, aiReferredSessions: 0, aiConversions: 0, organicSessions: 0, organicConversions: 0 };
         pages.set(key, acc);
      }
      return acc;
   };

   for (const s of aiSessions) {
      const acc = ensure(s.landingPage);
      acc.aiReferredSessions += 1;
      if (sessionConverted(s, goal)) { acc.aiConversions += 1; }
   }
   for (const s of organicSessions) {
      const acc = ensure(s.landingPage);
      acc.organicSessions += 1;
      if (sessionConverted(s, goal)) { acc.organicConversions += 1; }
   }
   // Tracked keyword target pages: name them in the P&L even with no activity, as context. They add no
   // counts, only a row, so a marketer sees "this page is tracked and AI is doing nothing with it yet".
   for (const k of keywords) {
      if (k.targetPage) { ensure(k.targetPage); }
   }

   const byPage: RoiPageRow[] = Array.from(pages.values())
      .map((a) => {
         const row: RoiPageRow = {
            page: a.page,
            aiReferredSessions: a.aiReferredSessions,
            aiConversions: a.aiConversions,
            aiConversionRatePct: rate(a.aiConversions, a.aiReferredSessions),
            revenue: hasValue ? money(a.aiConversions * (goalValue as number)) : null,
            organicConversionRatePct: rate(a.organicConversions, a.organicSessions),
         };
         return row;
      })
      // Order the P&L by where AI is doing the most: referred sessions, then page name for a stable
      // tiebreak.
      .sort((x, y) => y.aiReferredSessions - x.aiReferredSessions || x.page.localeCompare(y.page));

   // Opportunities, each requiring REAL signal on both sides of its claim. No opportunity is ever
   // emitted off a zero baseline, which is what keeps the P&L honest when a layer has no data.
   const opportunities: RoiOpportunity[] = [];
   for (const a of pages.values()) {
      // ai-outconverts-organic: the page's AI-referred sessions convert materially better than its
      // organic-search sessions. Requires real samples on BOTH sides (so a 0-baseline can never fire),
      // a positive AI rate, and a gap clearing the floor.
      const aiRate = rate(a.aiConversions, a.aiReferredSessions);
      const orgRate = rate(a.organicConversions, a.organicSessions);
      if (a.aiReferredSessions >= 2 && a.organicSessions >= 2 && aiRate > 0 && aiRate - orgRate >= MATERIAL_GAP_PCT) {
         opportunities.push({
            type: 'ai-outconverts-organic',
            page: a.page,
            detail: `On ${a.page}, AI-referred visitors convert at ${aiRate}% versus ${orgRate}% from organic search. `
               + 'AEO is paying off here. Double down on what makes this page get cited and pointed to by AI engines.',
         });
      }
      // cited-not-converting: AI is sending real, repeated traffic (>= 3 sessions) but none convert.
      // The page, not the AI visibility, is the problem. Requires referred sessions >= 3 AND zero
      // conversions, so it never fires off a thin or empty sample.
      if (a.aiReferredSessions >= 3 && a.aiConversions === 0) {
         opportunities.push({
            type: 'cited-not-converting',
            page: a.page,
            detail: `${a.page} gets ${a.aiReferredSessions} AI-referred visitor(s) but none converted. `
               + 'AI visibility is working; the page is not. Fix the page (clearer offer, stronger CTA) before chasing more AI citations.',
         });
      }
   }

   // The top-level note is the honest headline. It NEVER states a rate off a zero baseline; it says
   // plainly when a layer (or the whole AI picture) has no data in the window.
   let note: string;
   if (totalAiSessions === 0) {
      note = 'No AI activity in this window: no AI-referred sessions recorded. '
         + 'AI referral traffic to most sites builds slowly, so an empty AI P&L early on is expected. '
         + 'Re-check as the window fills.';
   } else {
      const revenueNote = totalAiRevenue !== null ? ` Worth ~${totalAiRevenue} at ${goalValue} per conversion.` : '';
      note = `AI engines referred ${totalAiSessions} session(s) producing ${aiConversions} conversion(s) across ${byPage.length} page(s).`
         + `${revenueNote}`;
   }

   return {
      totalAiSessions,
      aiConversions,
      totalAiRevenue,
      byPage,
      opportunities,
      note,
   };
};
