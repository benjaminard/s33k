/*
 * ============================================================================
 * s33k DAILY BRIEF: the proactive analyst, distilled to a standup (RULES-BASED).
 * ============================================================================
 * This is the fullest expression of "an AI analyst, not a dashboard": a single,
 * tight, prioritized digest of the ONE most important thing to do for a domain
 * right now, composed once and delivered two ways: on demand (the user's own LLM
 * narrates it) and pushed on a schedule (the email IS the structured output,
 * rendered to HTML/text). Where the dashboard SHOWS every number and the briefing
 * LISTS every pillar, the daily brief ANSWERS: "what changed, and what is the one
 * thing to do about it?"
 *
 * It is PURE: no DB, no network, no LLM, no clock, no randomness. The route does
 * the tenant-scoped reads and hands this composer already-shaped signals from the
 * surfaces the rest of the app already trusts:
 *   - the analyst engine (utils/analyst.ts) for the period-over-period changes and
 *     the single topPriority across rank / traffic / AI / conversions;
 *   - the AEO ROI join (utils/aeo-roi.ts) for the top AI-visibility opportunity;
 *   - the dashboard headline (utils/dashboard.ts) for the top opportunity page.
 * It does NOT re-derive any of those: it REUSES their outputs and shapes a short,
 * honest digest. The interpretation happens in the USER's own LLM over MCP, or is
 * simply rendered into the scheduled email.
 *
 * HONEST ON A QUIET WEEK. When nothing material changed and there is no opportunity
 * to enrich the action with, the brief says so plainly ("Quiet period: nothing
 * material changed.") rather than inventing movement. Every section is empty-safe.
 * ============================================================================
 */

import type { AnalystOutput, Alert } from './analyst';
import type { AeoRoi, RoiOpportunity } from './aeo-roi';

// --- Public input shape ------------------------------------------------------

/**
 * The minimal slice of the dashboard headline the brief enriches its action with.
 * The route passes dashboard.headline directly; only these two fields are read so
 * the composer never depends on the full Dashboard shape.
 */
export type DailyBriefDashboardHeadline = {
   topOpportunity: string | null,
   topAction: string | null,
};

/**
 * Everything the route hands the composer, already shaped + ownership-scoped. Each
 * field is independently optional/null so a pillar with no data simply contributes
 * nothing: a missing analyst output, a null AEO ROI, or a null dashboard headline
 * each degrade to "nothing from that surface", never a throw.
 */
export type DailyBriefInput = {
   domain: string,
   period: string,
   /** The period-over-period change detection from utils/analyst.ts (detectChanges). */
   analyst: AnalystOutput,
   /** The AI Visibility P&L from utils/aeo-roi.ts, or null when no goal was resolvable. */
   aeoRoi: AeoRoi | null,
   /** The dashboard headline (topOpportunity + topAction), or null when unavailable. */
   dashboardHeadline: DailyBriefDashboardHeadline | null,
   /**
    * The first-data setup signal, computed by the route from already-loaded keywords +
    * sessions + summary. When present, the domain is still GATHERING its first numbers
    * (no pageviews yet OR a tracked keyword's first rank check has not landed OR there is
    * no prior-window baseline to compare against), so the brief leads with encouraging
    * "tracking is live, first numbers are coming in" copy instead of a flat quiet/zero
    * statement. Absent (undefined) = the normal change-detection path is unchanged.
    */
   setup?: DailyBriefSetup,
};

/**
 * What the route observed about the domain's first-data state, so the composer can write
 * a precise, encouraging setup-aware action without doing any DB work itself. All three
 * flags are computed in the route from data it already loaded.
 */
export type DailyBriefSetup = {
   /** No keyword is tracked yet. The next step is to add keywords. */
   noKeywords: boolean,
   /** No pageviews have been recorded yet (recentEvents === 0). The next step is to install the script / wait. */
   noTraffic: boolean,
   /** At least one tracked keyword's first Google check has not landed yet (rank-pending). The next step is to wait. */
   rankPending: boolean,
};

// --- Public output shape -----------------------------------------------------

/** One "what changed" bullet, carrying enough structure for a render or an LLM. */
export type DailyBriefChange = {
   severity: Alert['severity'],
   pillar: Alert['pillar'],
   text: string,
};

export type DailyBrief = {
   domain: string,
   period: string,
   /**
    * The single most important sentence right now: the headline of the top change,
    * or, on a quiet period, an honest "nothing material changed" statement. Never
    * empty.
    */
   headline: string,
   /** True when no material change AND no enrichable opportunity was found. */
   quiet: boolean,
   /**
    * 'gathering' while the domain is still collecting its first data (first rank check
    * running, or no visitors seen yet, or no prior window to compare). In that state the
    * headline + topAction are encouraging setup copy, NOT a flat quiet/zero. Undefined
    * once real data has landed (the normal change-detection path).
    */
   dataState?: 'gathering',
   /** 2-4 most important changes this period vs the prior equal window. May be empty on a quiet period. */
   whatChanged: DailyBriefChange[],
   /**
    * The single top action: the analyst's topPriority, enriched (when available)
    * with the AEO ROI top opportunity and the dashboard top opportunity page so the
    * one action points at the highest-leverage concrete move. Never empty: falls
    * back to a calm "keep the current pages fresh" line on a quiet period.
    */
   topAction: string,
};

// --- Tunables ----------------------------------------------------------------

/** Show at most this many "what changed" bullets: a standup, not a report. */
const MAX_CHANGES = 4;

// --- Helpers (pure) ----------------------------------------------------------

/**
 * Pick the single most relevant AEO opportunity to enrich the action with. The
 * opportunity types are ordered by leverage: a page AI already sends traffic to but
 * that does not convert (cited-not-converting) is the most actionable, then a page
 * where AI out-converts organic (ai-outconverts-organic, a "double down" signal).
 * Returns null when there are no opportunities (an honest empty AEO layer).
 * @param {AeoRoi | null} roi - The AI Visibility P&L, or null.
 * @returns {RoiOpportunity | null}
 */
const topAeoOpportunity = (roi: AeoRoi | null): RoiOpportunity | null => {
   if (!roi || !roi.opportunities || roi.opportunities.length === 0) { return null; }
   const order: Record<RoiOpportunity['type'], number> = {
      'cited-not-converting': 0,
      'ai-outconverts-organic': 1,
   };
   return [...roi.opportunities].sort((a, b) => order[a.type] - order[b.type])[0];
};

/**
 * The setup-aware top action for a domain still gathering its first data. Ordered by what
 * the user can DO: add keywords first (the SEO pillar is empty), then install the script
 * (no visitors seen), then just wait (the checks are running and will land on their own).
 * Never names an internal host or provider; never claims a flat zero.
 * @param {DailyBriefSetup} setup - The route-computed first-data flags.
 * @returns {string}
 */
const gatheringAction = (setup: DailyBriefSetup): string => {
   const steps: string[] = [];
   if (setup.noKeywords) {
      steps.push('Add the keywords you want to rank for (ideally each mapped to a target page) so rank tracking can begin.');
   }
   if (setup.noTraffic) {
      steps.push('Add the s33k tracking script to your site (we show you exactly where) so visits start flowing in.');
   }
   if (setup.rankPending && !setup.noKeywords) {
      steps.push('Your first rank check is running; positions populate right after the next scrape, so no action is needed there yet.');
   }
   if (steps.length === 0) {
      // Gathering for a reason already covered by the headline (e.g. no prior window to compare yet).
      return 'Tracking is live and your first numbers are coming in. Check back tomorrow for your first real brief.';
   }
   return steps.join(' ');
};

/**
 * Compose the single, prioritized daily brief from already-shaped signals.
 *
 * Pure and never throws on empty input. The headline and topAction always carry a
 * non-empty, honest sentence; whatChanged carries the top few changes or is empty
 * on a quiet period. The route hands real, tenant-scoped data; ALL shaping lives
 * here so it is unit-testable without HTTP, mirroring analyst/dashboard/aeo-roi.
 *
 * @param {DailyBriefInput} input - Scoped, period-bound signals from the route.
 * @returns {DailyBrief}
 */
export const composeDailyBrief = (input: DailyBriefInput): DailyBrief => {
   const {
      domain, period, analyst, aeoRoi, dashboardHeadline, setup,
   } = input;

   // ---- GATHERING: the domain is still collecting its first data. --------------------
   // Lead with encouraging "tracking is live, first numbers are coming in" copy instead of a
   // flat quiet/zero. The route sets this only when there is genuinely nothing to report yet
   // (no pageviews, a rank-pending first check, or no prior window to compare), so this branch
   // never hides a real change. quiet stays false: a gathering domain is not a quiet one.
   if (setup) {
      return {
         domain,
         period,
         headline: `First check is running for ${domain}. Rankings populate after the next scrape and traffic flows in `
            + 'as soon as the script sees visitors. Your first real brief lands within a day.',
         quiet: false,
         whatChanged: [],
         topAction: gatheringAction(setup),
         dataState: 'gathering',
      };
   }

   // The changes, already prioritized by the analyst (severity then pillar). Take the
   // top few so the brief stays a standup. Each becomes a compact, render-ready bullet.
   const changes: DailyBriefChange[] = (analyst.alerts || [])
      .slice(0, MAX_CHANGES)
      .map((a) => ({ severity: a.severity, pillar: a.pillar, text: a.headline }));

   const aeoOpp = topAeoOpportunity(aeoRoi);
   const dashOpportunity = dashboardHeadline ? dashboardHeadline.topOpportunity : null;
   const dashAction = dashboardHeadline ? dashboardHeadline.topAction : null;

   // A period is "quiet" only when there is genuinely nothing to act on: no detected
   // change, no analyst priority, no AEO opportunity, and no dashboard opportunity page.
   // We do NOT count the dashboard's generic fallback topAction as a signal, because it is
   // present even on an empty domain; only a real opportunity counts.
   const hasChange = changes.length > 0 || Boolean(analyst.topPriority);
   const hasOpportunity = Boolean(aeoOpp) || Boolean(dashOpportunity);
   const quiet = !hasChange && !hasOpportunity;

   // ---- HEADLINE: the single most important thing right now. -------------------------
   // The top change's headline leads when something moved; otherwise the most concrete
   // opportunity; otherwise an honest quiet-period statement.
   let headline: string;
   if (changes.length > 0) {
      headline = changes[0].text;
   } else if (analyst.topPriority) {
      headline = analyst.topPriority;
   } else if (dashOpportunity) {
      headline = dashOpportunity;
   } else if (aeoOpp) {
      headline = `${aeoOpp.page}: ${aeoOpp.detail}`;
   } else {
      headline = `Quiet period for ${domain}: nothing material changed in the last ${period}.`;
   }

   // ---- TOP ACTION: the single highest-leverage next move, enriched. ------------------
   // Start from the analyst's prioritized topPriority (it already pairs the top change with a
   // concrete recommendation). Enrich it with the AEO opportunity and the dashboard opportunity
   // page when those add a SPECIFIC page-level move the change-based priority does not name. On a
   // quiet period, fall back to the dashboard's action or a calm keep-fresh line.
   const actionParts: string[] = [];
   if (analyst.topPriority) {
      actionParts.push(analyst.topPriority);
   }
   if (aeoOpp) {
      // The AEO opportunity carries a page + a full, concrete recommendation. Add it as the AI
      // angle the change-based priority may not cover (citation gap, double-down, fix-the-page).
      actionParts.push(`AI visibility: ${aeoOpp.detail}`);
   }
   // The dashboard opportunity page is the cross-pillar "page that earns traffic but underranks /
   // has no keyword" signal. Add it only when it is not already implied by the analyst priority.
   if (dashOpportunity && actionParts.length === 0) {
      actionParts.push(dashOpportunity);
   }
   let topAction: string;
   if (actionParts.length > 0) {
      topAction = actionParts.join(' ');
   } else if (dashAction) {
      // No change and no opportunity, but the dashboard still suggests a sensible next step
      // (e.g. "install the tracking script", "add your first keywords"). Use it.
      topAction = dashAction;
   } else {
      topAction = 'No urgent action this period. Keep your top pages fresh and well-linked, and re-check tomorrow.';
   }

   return {
      domain,
      period,
      headline,
      quiet,
      whatChanged: changes,
      topAction,
   };
};

export default composeDailyBrief;
