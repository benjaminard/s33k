// Funnel analysis: where in an ordered multi-step path do sessions fall out?
//
// goal_analytics answers "did a session hit ONE goal?". A funnel asks the harder, ordered question:
// of the sessions that started, how many reached step 1, then step 2 given step 1, and so on, with
// the drop-off named at each step. That ordering is the whole point: a session only counts for step
// N if it also reached steps 1..N-1 (a checkout funnel is meaningless if "viewed thank-you" counts
// without "viewed cart" first).
//
// A pure join over already-sessionized, already-filtered traffic. No DB, no LLM: the route owns the
// load + human-only filter; this owns the ordered step math so it stays unit-testable in isolation.

import { SessionAgg } from './sessionize';

// A single funnel step. A "page" step is reached when the session viewed a path that STARTS WITH
// `match` (prefix, so "/blog" catches "/blog/x"). An "event" step is reached when the session fired
// an event of `type`, optionally constrained to a page (prefix) so "form_submit on /demo" is
// distinct from "form_submit on /contact".
export type FunnelStep = {
   type: 'page' | 'event',
   match: string, // a path prefix (page) or an event type (event)
   page?: string, // event steps only: constrain the event to a page prefix
};

export type FunnelStepResult = {
   step: number, // 1-based position in the ordered funnel
   type: 'page' | 'event',
   match: string,
   page?: string,
   reached: number, // sessions that reached THIS step AND every step before it
   conversionFromPreviousPct: number, // reached / reached(prev step) (100 for step 1)
   dropOffPct: number, // 100 - conversionFromPreviousPct (how many fell out at this step)
};

export type FunnelAnalysis = {
   totalSessions: number, // sessions in the window/filter, the funnel's denominator at step 0
   steps: FunnelStepResult[],
};

const pct = (n: number, d: number): number => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);

// Did a session reach this one step, considered in isolation? Order is enforced by the caller, not
// here. Mirrors the page-prefix / event(+page) semantics goals use, kept local so the funnel does
// not depend on a GoalDef shape it does not need.
const sessionReachedStep = (s: SessionAgg, step: FunnelStep): boolean => {
   if (step.type === 'page') {
      return s.pageviewPaths.some((p) => p.startsWith(step.match));
   }
   // event step: the type must have fired, optionally on a matching page (prefix).
   if (!s.eventTypes.has(step.match)) { return false; }
   if (step.page) {
      return s.pageEvents.some((e) => e.type === step.match && e.page.startsWith(step.page as string));
   }
   return true;
};

/**
 * Compute an ordered funnel over sessionized traffic. For each session we walk the steps IN ORDER
 * and stop at the first step it did not reach, so a session contributes to step N only if it also
 * reached steps 1..N-1. Per step we report sessions reached, conversion from the previous step, and
 * the drop-off there.
 * @param {SessionAgg[]} sessions - Already filtered (e.g. human-only) sessionized traffic.
 * @param {FunnelStep[]} steps - The ordered funnel steps (at least one).
 * @returns {FunnelAnalysis}
 */
export const analyzeFunnel = (sessions: SessionAgg[], steps: FunnelStep[]): FunnelAnalysis => {
   const totalSessions = sessions.length;

   // reached[i] = count of sessions that progressed at least as far as step i (1-based here via i+1).
   const reached: number[] = new Array(steps.length).fill(0);
   for (const s of sessions) {
      for (let i = 0; i < steps.length; i += 1) {
         // The ordered guarantee: bail on the first missed step so later steps are never credited
         // for a session that skipped an earlier one.
         if (!sessionReachedStep(s, steps[i])) { break; }
         reached[i] += 1;
      }
   }

   const stepResults: FunnelStepResult[] = steps.map((step, i) => {
      // The denominator for step 1 is the whole population; for later steps it is the prior step's
      // reached count, so conversionFromPrevious reads as "of those who got here, how many continued".
      const prev = i === 0 ? totalSessions : reached[i - 1];
      const conversionFromPreviousPct = pct(reached[i], prev);
      return {
         step: i + 1,
         type: step.type,
         match: step.match,
         ...(step.page ? { page: step.page } : {}),
         reached: reached[i],
         conversionFromPreviousPct,
         dropOffPct: Math.round((100 - conversionFromPreviousPct) * 10) / 10,
      };
   });

   return { totalSessions, steps: stepResults };
};

// Parse and validate the `steps` query param. It arrives as a JSON string (a funnel is an ordered
// ARRAY, which does not fit flat query params), so we parse it here and fail LOUD with a clear,
// actionable message rather than letting a bad shape become a generic 400 deeper in the route.
// Returns the parsed steps on success, or an { error } the route turns into a 400.
export const parseFunnelSteps = (raw: unknown): { steps?: FunnelStep[], error?: string } => {
   if (typeof raw !== 'string' || !raw.trim()) {
      return { error: 'steps is required: a JSON array of {type:"page"|"event", match:string} objects, passed as a query string.' };
   }
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch {
      return { error: 'steps must be a valid JSON array string, e.g. steps=[{"type":"page","match":"/pricing"}].' };
   }
   if (!Array.isArray(parsed) || parsed.length === 0) {
      return { error: 'steps must be a non-empty JSON array of funnel steps.' };
   }
   const steps: FunnelStep[] = [];
   for (let i = 0; i < parsed.length; i += 1) {
      const s = parsed[i] as Record<string, unknown>;
      if (!s || typeof s !== 'object') {
         return { error: `steps[${i}] must be an object {type:"page"|"event", match:string}.` };
      }
      const type = s.type;
      if (type !== 'page' && type !== 'event') {
         return { error: `steps[${i}].type must be "page" or "event".` };
      }
      const match = s.match;
      if (typeof match !== 'string' || !match.trim()) {
         return { error: `steps[${i}].match must be a non-empty string (a path prefix for page, an event type for event).` };
      }
      const step: FunnelStep = { type, match: match.trim() };
      // page is optional and only meaningful for event steps; accept it when given as a string.
      if (typeof s.page === 'string' && s.page.trim()) { step.page = s.page.trim(); }
      steps.push(step);
   }
   return { steps };
};
