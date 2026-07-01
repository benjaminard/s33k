// Period compare: put the key analytics metrics for a window side by side with the immediately
// preceding equal-length window, and report the delta and percent change per metric. This answers
// "is this period better or worse than last period, and by how much", the single most-asked
// analytics question, in one pure pass over first-party data.
//
// The session sets for each window are sessionized + filtered by the caller (human-only by default),
// so this module is pure metric math + diffing with no DB or filtering of its own. No server-side
// LLM: it returns structured rows for the user's own LLM (and the briefing) to narrate.

import { SessionAgg, GoalDef, sessionConverted, isBounce } from './sessionize';

// One metric measured for a single window. bounceRatePct and conversionRatePct are percentages
// (0..100, one decimal); the rest are raw counts.
export type WindowMetrics = {
   humanVisitors: number, // distinct sessions in the window (human-only unless includeBots)
   pageviews: number, // total pageview events across all sessions
   bounceRatePct: number, // share of sessions that bounced (single pageview, no other event)
   conversions?: number, // present only when a goal was supplied
   conversionRatePct?: number, // present only when a goal was supplied
};

// One window's identity (its time bounds in ms) plus its computed metrics. Bounds are echoed so the
// caller and the user's LLM can state exactly which two windows were compared.
export type WindowResult = {
   startMs: number,
   endMs: number,
   metrics: WindowMetrics,
};

// The diff for a single metric: the current and prior raw values, the absolute delta (current minus
// prior), and the percent change relative to prior. pctChange is null when prior is 0, because
// "percent change from zero" is mathematically undefined (any positive current is infinite growth);
// a null lets the caller render "new" instead of a misleading number.
export type MetricDelta = {
   metric: string,
   current: number,
   prior: number,
   delta: number,
   pctChange: number | null,
};

export type PeriodCompareReport = {
   current: WindowResult,
   prior: WindowResult,
   deltas: MetricDelta[],
   hasGoal: boolean,
};

// One decimal place, used for both rate percentages and pctChange so the output reads consistently.
const round1 = (n: number): number => Math.round(n * 10) / 10;

// A rate as a percentage (0..100), guarding divide-by-zero so an empty window reads 0, not NaN.
const ratePct = (numer: number, denom: number): number => (denom > 0 ? round1((100 * numer) / denom) : 0);

// Percent change of current vs prior. Null when prior is 0 (undefined growth from a zero base): the
// caller renders that as "new" rather than a fake infinity. A drop to zero from a positive prior is
// a real -100, so only the PRIOR being zero is the undefined case.
const pctChange = (current: number, prior: number): number | null =>
   (prior === 0 ? null : round1((100 * (current - prior)) / prior));

/**
 * Compute the per-window metrics for one already-filtered set of sessions. A bounce is a session
 * with a single pageview and no other event, the inverse of sessionize's "engaged" definition, so
 * the two never disagree. Conversions are added only when a goal is supplied.
 * @param {SessionAgg[]} sessions - Sessionized, already-filtered (e.g. human-only) sessions.
 * @param {GoalDef | null} goal - Optional conversion goal.
 * @returns {WindowMetrics}
 */
export const computeWindowMetrics = (sessions: SessionAgg[], goal: GoalDef | null): WindowMetrics => {
   const humanVisitors = sessions.length;
   const pageviews = sessions.reduce((sum, s) => sum + s.pageviewCount, 0);
   // Bounce == NOT engaged. Uses the shared isBounce helper (the single engaged/bounce definition) so
   // bounce-rate here and an engagement filter elsewhere are literally the same code, never just a
   // copy that can drift.
   const bounced = sessions.filter((s) => isBounce(s)).length;
   const metrics: WindowMetrics = {
      humanVisitors,
      pageviews,
      bounceRatePct: ratePct(bounced, humanVisitors),
   };
   if (goal) {
      const conversions = sessions.filter((s) => sessionConverted(s, goal)).length;
      metrics.conversions = conversions;
      metrics.conversionRatePct = ratePct(conversions, humanVisitors);
   }
   return metrics;
};

/**
 * Build the side-by-side period-compare report from the two windows' already-filtered sessions plus
 * their time bounds. Emits one MetricDelta per metric, in a stable reading order, only including the
 * conversion metrics when a goal was supplied.
 * @param {SessionAgg[]} currentSessions - Filtered sessions for the current window.
 * @param {{ startMs: number, endMs: number }} currentBounds - Current window bounds.
 * @param {SessionAgg[]} priorSessions - Filtered sessions for the prior equal-length window.
 * @param {{ startMs: number, endMs: number }} priorBounds - Prior window bounds.
 * @param {GoalDef | null} goal - Optional conversion goal; adds conversion metrics when present.
 * @returns {PeriodCompareReport}
 */
export const buildPeriodCompare = (
   currentSessions: SessionAgg[],
   currentBounds: { startMs: number, endMs: number },
   priorSessions: SessionAgg[],
   priorBounds: { startMs: number, endMs: number },
   goal: GoalDef | null,
): PeriodCompareReport => {
   const hasGoal = Boolean(goal);
   const current = computeWindowMetrics(currentSessions, goal);
   const prior = computeWindowMetrics(priorSessions, goal);

   // Stable metric order so the diff reads the same every call. Conversion rows are appended only
   // when a goal exists, so the shape matches the metrics objects above.
   const diff = (metric: string, cur: number, pri: number): MetricDelta => ({
      metric,
      current: cur,
      prior: pri,
      delta: round1(cur - pri),
      pctChange: pctChange(cur, pri),
   });

   const deltas: MetricDelta[] = [
      diff('humanVisitors', current.humanVisitors, prior.humanVisitors),
      diff('pageviews', current.pageviews, prior.pageviews),
      diff('bounceRatePct', current.bounceRatePct, prior.bounceRatePct),
   ];
   if (goal) {
      deltas.push(diff('conversions', current.conversions || 0, prior.conversions || 0));
      deltas.push(diff('conversionRatePct', current.conversionRatePct || 0, prior.conversionRatePct || 0));
   }

   return {
      current: { startMs: currentBounds.startMs, endMs: currentBounds.endMs, metrics: current },
      prior: { startMs: priorBounds.startMs, endMs: priorBounds.endMs, metrics: prior },
      deltas,
      hasGoal,
   };
};
