// Rank movers: which tracked keywords moved the most in Google rank over a window.
//
// A keyword carries its rank history as a JSON string mapping an ISO date ("2026-06-10") to the
// Google position recorded that day (1 = top, smaller is better). To answer "what moved this week"
// we need the FIRST recorded position inside the window and the LAST, then the signed delta. We do
// the parse + window-clip + delta here as a pure helper so the route stays thin and this is unit
// testable without a DB. No server-side LLM: this returns structured rows the user's own LLM narrates.
//
// Direction convention (the non-obvious gotcha): a SMALLER position is BETTER, so an improvement is
// from->to where to < from. We report `delta = from - to` so a POSITIVE delta means the keyword
// IMPROVED (climbed toward #1) and a NEGATIVE delta means it WORSENED (fell). That keeps "biggest
// positive number = best news" intuitive for whoever reads the digest.

import { historyDateMs } from './history-date';

export type MoverInput = {
   keyword: string,
   // The raw history JSON string from the keyword row (date -> position). Parsed defensively here.
   history: string,
   // The current position column, used only as a fallback when the window has < 2 history points.
   currentPosition: number,
   targetPage?: string,
};

export type RankMover = {
   keyword: string,
   targetPage: string,
   from: number, // earliest position inside the window
   to: number, // latest position inside the window (or currentPosition fallback)
   delta: number, // from - to: POSITIVE = improved (climbed), NEGATIVE = worsened (fell)
   direction: 'improved' | 'worsened',
};

export type RankMovers = {
   improved: RankMover[], // biggest climbers first
   worsened: RankMover[], // biggest fallers first
   trackedWithHistory: number, // how many keywords had >= 2 in-window points (a real movement read)
};

// Parse one keyword's history string into [timeMs, position] pairs, dropping unparseable entries.
// A position of 0 means "not in the top results / not yet scraped"; we keep it as a real value so a
// keyword that dropped out of the rankings (good rank -> 0) still surfaces as a big worsening.
const parsePairs = (history: string): { t: number, pos: number }[] => {
   let obj: Record<string, number> = {};
   try {
      const parsed = JSON.parse(history || '{}');
      // history can legitimately be an empty array "[]" (the model default) or an object. Only an
      // object maps date->position; anything else yields no pairs.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { obj = parsed as Record<string, number>; }
   } catch { obj = {}; }
   const pairs: { t: number, pos: number }[] = [];
   for (const dateKey of Object.keys(obj)) {
      // Tolerant of both the new padded-ISO key and the old "2026-6-9" form; parses UTC-midnight so it
      // lines up with the UTC window bounds (see utils/history-date.ts).
      const t = historyDateMs(dateKey);
      const raw = obj[dateKey];
      // Number(null) coerces to 0, which this module reads as "dropped out of rankings" (a real
      // worst-case position) and would manufacture a false big worsening. Drop null/undefined instead.
      if (raw == null) { continue; }
      const pos = Number(raw);
      if (Number.isNaN(t) || Number.isNaN(pos)) { continue; }
      pairs.push({ t, pos });
   }
   return pairs.sort((a, b) => a.t - b.t);
};

/**
 * Compute the keywords that improved or worsened most in rank over a window.
 *
 * For each keyword: clip its history to [startMs, nowMs], take the earliest in-window position as
 * `from` and the latest as `to`. With only one in-window point we cannot read a movement, so we fall
 * back to comparing that single point against the keyword's current position (still a real delta).
 * With no in-window points the keyword is skipped (no signal). Keywords with a zero net delta are
 * dropped from both lists, since "did not move" is not a mover.
 *
 * @param {MoverInput[]} keywords - Tracked keywords with their history JSON and current position.
 * @param {number} startMs - Window start (ms from epoch).
 * @param {number} nowMs - Window end / now (ms from epoch).
 * @param {number} limit - Max rows per list. Defaults to 5.
 * @returns {RankMovers}
 */
export const computeRankMovers = (keywords: MoverInput[], startMs: number, nowMs: number, limit = 5): RankMovers => {
   const movers: RankMover[] = [];
   let trackedWithHistory = 0;

   for (const k of keywords) {
      const inWindow = parsePairs(k.history).filter((p) => p.t >= startMs && p.t <= nowMs);
      if (inWindow.length === 0) { continue; }

      let from: number;
      let to: number;
      if (inWindow.length >= 2) {
         trackedWithHistory += 1;
         from = inWindow[0].pos;
         to = inWindow[inWindow.length - 1].pos;
      } else {
         // Single in-window point: compare it to the live position so a keyword that has only one
         // recent scrape still reports a real, if coarser, movement.
         from = inWindow[0].pos;
         // currentPosition 0 means DROPPED OUT of rankings (a real, worst-case position), not
         // "missing". `|| fallback` would swallow that 0 and hide the biggest worsening. Only fall
         // back when there is genuinely no numeric current position.
         to = Number.isFinite(Number(k.currentPosition)) ? Number(k.currentPosition) : inWindow[0].pos;
      }

      const delta = from - to; // POSITIVE = climbed toward #1 (improved); NEGATIVE = fell.
      if (delta === 0) { continue; } // not a mover.
      movers.push({
         keyword: k.keyword,
         targetPage: k.targetPage || '',
         from,
         to,
         delta,
         direction: delta > 0 ? 'improved' : 'worsened',
      });
   }

   const improved = movers.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit);
   // Worsened: most negative delta is the worst faller, so sort ascending by delta (most negative first).
   const worsened = movers.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit);

   return { improved, worsened, trackedWithHistory };
};
