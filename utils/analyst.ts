/**
 * The proactive analyst: a PURE, rules-based change-detection engine.
 *
 * s33k's other cross-pillar surfaces (briefing.ts, insights.ts) answer "what is
 * the state of the site right now?". This engine answers the harder, more useful
 * question: "what CHANGED since last period, and what should I do about it?". It
 * compares a CURRENT period to a PRIOR one across all four pillars (search rank,
 * traffic, AI visibility, engagement/conversions) and emits a prioritized list of
 * plain-English alerts plus the single most important thing to do this week.
 *
 * ============================================================================
 * NO LLM. NO IO. NO MODEL TRAINING.
 * ============================================================================
 * This module is a pure function of its inputs: no DB, no network, no LLM call,
 * no clock, no randomness. The route (pages/api/alerts.ts) does the tenant-scoped
 * reads for both periods and hands the already-shaped numbers here; this file
 * only runs transparent, commented rules over them and returns a structured,
 * narration-ready bundle. The interpretation ("tell me what this means") happens
 * in the USER's own LLM over MCP. Because the engine is pure it is exhaustively
 * unit-testable without booting anything, which is the point: every alert is a
 * rule firing on real deltas, never a guess.
 *
 * HONEST ON MISSING DATA. A signal with no usable data NEVER produces an alert.
 * Rank deltas need a prior position to compare against; traffic and conversion
 * deltas need a non-zero prior baseline; AI "new engine" detection needs the
 * prior set to be known; the conversion-RATE drop additionally needs a meaningful
 * prior visitor denominator. When a baseline is absent the engine stays silent for
 * that rule rather than inventing a 100%-style swing out of a zero. The two places
 * "from nothing" or "to nothing" is itself the signal are a brand-NEW AI engine
 * referring traffic (a leading AEO indicator) and an existing engine that COLLAPSED
 * from a real baseline to near zero (a lost-citation signal). The route reports
 * per-pillar data availability separately; this engine simply does not fire on
 * what it cannot honestly measure.
 *
 * NOT YET MEASURABLE HERE. A bot-traffic-share SURGE would be a valuable signal,
 * but the route passes only { pageviews, visitors } per period (no human-vs-bot
 * estimate), so the engine has no prior bot share to compare against. That detector
 * is intentionally absent rather than fabricated; it can be added once the route
 * threads a per-period bot estimate into PeriodData.
 */

// --- Public input shape ------------------------------------------------------

/** One tracked keyword's rank in a single period, plus enough context to narrate it. */
export type KeywordRank = {
   /** The tracked term. */
   keyword: string,
   /**
    * Google position in this period. 1 = top. A value <= 0 (or null) means NOT
    * RANKED this period (outside the tracked top-N or not yet scraped). Kept
    * distinct from a real numeric rank so "fell off the list" is detectable.
    */
   position: number | null,
   /** The page this keyword targets, if mapped, so an alert can name it. Optional. */
   targetPage?: string,
};

/** One referring AI engine in a single period (e.g. "ChatGPT", visitors). */
export type AiEngineCount = {
   /** Normalized engine label, e.g. "ChatGPT", "Perplexity". */
   engine: string,
   /** Visitors that engine referred in the period. */
   visitors: number,
};

/** Site-wide traffic totals for a single period (the comparable baseline). */
export type TrafficTotals = {
   pageviews: number,
   visitors: number,
};

/**
 * One period's data for every pillar, already shaped by the route. Both the
 * CURRENT and the PRIOR period are passed as this same shape so the engine only
 * has to diff two like objects.
 *
 * Every field is optional/zeroable so a pillar with no data simply yields no
 * alerts for that pillar (the route degrades each pillar independently and may
 * pass empty arrays / zeros). The engine treats:
 *   - keywords        keyed by keyword string for current-vs-prior pairing.
 *   - traffic         compared only when the prior baseline is non-zero.
 *   - aiEngines       compared by engine label; a brand-new label is the signal.
 *   - formSubmissions compared only when the prior baseline is non-zero.
 */
export type PeriodData = {
   keywords: KeywordRank[],
   traffic: TrafficTotals,
   aiEngines: AiEngineCount[],
   /** Total form submissions this period (the autocapture conversion proxy). */
   formSubmissions: number,
};

// --- Public output shape -----------------------------------------------------

export type AlertSeverity = 'high' | 'medium' | 'low';
export type AlertPillar = 'rank' | 'traffic' | 'ai' | 'conversions';

/** One detected change, ready for an LLM to narrate. */
export type Alert = {
   severity: AlertSeverity,
   pillar: AlertPillar,
   /** A self-contained plain-English sentence stating WHAT changed. */
   headline: string,
   /** Supporting numbers / context behind the headline. */
   detail: string,
   /** A concrete next action, not a restatement of the finding. */
   recommendation: string,
};

export type AnalystOutput = {
   /** Every detected change, sorted highest-signal first (severity, then magnitude). */
   alerts: Alert[],
   /**
    * The single most important thing to do this week: the top alert's
    * recommendation, prefixed with its headline so the LLM can lead with it.
    * Null only when nothing notable changed.
    */
   topPriority: string | null,
};

// --- Tunable thresholds (kept together so they are easy to audit) ------------

/** A keyword rank move of at least this many positions is notable. */
const RANK_MOVE_MIN = 5;
/** Ranks at or above this position are "page one" (top 10). Crossing it is high-severity. */
const PAGE_ONE_MAX = 10;
/** Traffic (pageviews or visitors) change of at least this fraction is notable. */
const TRAFFIC_CHANGE_MIN = 0.25; // 25%
/** A traffic swing at or above this fraction is high-severity, not medium. */
const TRAFFIC_CHANGE_HIGH = 0.5; // 50%
/** AI-referral visitor change of at least this fraction is notable. */
const AI_CHANGE_MIN = 0.3; // 30%
/**
 * An AI engine that had at least this many prior visitors has a "real baseline":
 * a collapse from it to near-zero is a high-severity loss, not the noise of a 1->0
 * blip. Below this, a fall to zero is treated as the normal AI_CHANGE_MIN drop.
 */
const AI_COLLAPSE_BASELINE_MIN = 5; // visitors
/**
 * After a collapse, current visitors at or below this count count as "near zero".
 * Lets a 12->1 fall register as a collapse, not just a >= 30% shrink.
 */
const AI_COLLAPSE_NEAR_ZERO_MAX = 1; // visitors
/** Conversion (form-submission) change of at least this fraction is notable. */
const CONVERSION_CHANGE_MIN = 0.3; // 30%
/**
 * The current conversion RATE must fall below the prior rate by at least this much
 * to fire a rate alert (current rate < prior rate * (1 - this)). A 20% relative
 * rate drop is the medium threshold.
 */
const CONVERSION_RATE_DROP_MIN = 0.2; // 20% relative rate drop
/**
 * A conversion rate that fell to at most this fraction of the prior rate "roughly
 * halved" and is high-severity, not medium.
 */
const CONVERSION_RATE_HALVED_MAX = 0.5; // current rate <= 50% of prior rate
/**
 * A rate alert needs a meaningful prior denominator so a 1-visitor-1-conversion
 * fluke does not look like a rate collapse. Suppress below this many prior visitors.
 */
const CONVERSION_RATE_MIN_PRIOR_VISITORS = 20; // visitors

// Severity ordering for the final sort (high first).
const SEVERITY_RANK: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Round a signed fraction (e.g. -0.182) to a whole-percent integer (e.g. -18). */
const pctChange = (current: number, prior: number): number => {
   if (prior <= 0) { return 0; }
   return Math.round(((current - prior) / prior) * 100);
};

/** True when a position value represents a real, ranked Google position. */
const isRanked = (position: number | null): position is number => (
   typeof position === 'number' && position > 0
);

// --- Per-pillar detectors (each pure, each returns Alert[]) -------------------

/**
 * RANK. Pair current and prior keywords by their term, then flag:
 *   - crossing page one (into or out of the top 10), the highest-signal SEO move;
 *   - a swing of RANK_MOVE_MIN+ positions while staying on the same side;
 *   - a keyword that newly ranks (was unranked, now ranks) or newly drops off.
 * A keyword with no prior entry to compare against produces NO alert: a first
 * sighting is not a change. Magnitude is encoded so the final sort can rank the
 * biggest movers first within a severity tier.
 * @param {KeywordRank[]} current - This period's keyword ranks.
 * @param {KeywordRank[]} prior - The prior period's keyword ranks.
 * @returns {Alert[]}
 */
const detectRankChanges = (current: KeywordRank[], prior: KeywordRank[]): Alert[] => {
   const priorByKeyword = new Map<string, KeywordRank>();
   prior.forEach((k) => { priorByKeyword.set(k.keyword, k); });

   const alerts: Alert[] = [];
   current.forEach((now) => {
      const before = priorByKeyword.get(now.keyword);
      // No prior reading: a first sighting is not a change, so stay silent.
      if (!before) { return; }

      // Narrow positions to locals so the compiler tracks ranked-ness on a value,
      // not a property (a property re-read is not narrowed across statements).
      const nowPos = isRanked(now.position) ? now.position : null;
      const beforePos = isRanked(before.position) ? before.position : null;
      const pageRef = now.targetPage ? ` (${now.targetPage})` : '';

      // Newly ranked: was outside the tracked top-N, now appears. A real win.
      if (nowPos !== null && beforePos === null) {
         alerts.push({
            severity: nowPos <= PAGE_ONE_MAX ? 'high' : 'medium',
            pillar: 'rank',
            headline: `"${now.keyword}" started ranking at #${nowPos}${pageRef}.`,
            detail: `It was not ranking in the prior period and now sits at #${nowPos}.`,
            recommendation: 'Reinforce the page that earned this with internal links and a fresh, direct '
               + 'answer up top so the new rank holds and climbs.',
         });
         return;
      }
      // Newly dropped off: had a rank, now gone. A real loss.
      if (nowPos === null && beforePos !== null) {
         alerts.push({
            severity: beforePos <= PAGE_ONE_MAX ? 'high' : 'medium',
            pillar: 'rank',
            headline: `"${now.keyword}" dropped off: it ranked #${beforePos} and is now unranked.`,
            detail: `It fell out of the tracked rankings since last period (was #${beforePos}).`,
            recommendation: 'Check the target page for a recent content, redirect, or indexing change, and '
               + 'review the SERP for a new competitor that displaced it.',
         });
         return;
      }
      // Not both ranked (both unranked, or the cases above): nothing more to compare.
      if (nowPos === null || beforePos === null) { return; }

      // Both ranked: a lower number is better, so delta = before - now (positive = improved).
      const delta = beforePos - nowPos;
      const moved = Math.abs(delta);
      const crossedIntoPageOne = beforePos > PAGE_ONE_MAX && nowPos <= PAGE_ONE_MAX;
      const crossedOutOfPageOne = beforePos <= PAGE_ONE_MAX && nowPos > PAGE_ONE_MAX;

      if (crossedOutOfPageOne) {
         alerts.push({
            severity: 'high',
            pillar: 'rank',
            headline: `You dropped from #${beforePos} to #${nowPos} on "${now.keyword}"`
               + `${pageRef} and fell off page one.`,
            detail: `Leaving the top ${PAGE_ONE_MAX} usually takes entry traffic with it.`,
            recommendation: 'Treat this as the priority SEO fix: refresh the page, shore up internal links, '
               + 'and recover the top-10 position before the lost traffic compounds.',
         });
         return;
      }
      if (crossedIntoPageOne) {
         alerts.push({
            severity: 'high',
            pillar: 'rank',
            headline: `"${now.keyword}"${pageRef} climbed from #${beforePos} to #${nowPos} `
               + 'and reached page one.',
            detail: `Crossing into the top ${PAGE_ONE_MAX} is where clicks accelerate.`,
            recommendation: 'Capitalize now: make sure the ranking page converts, and add supporting internal '
               + 'links so the page-one position sticks.',
         });
         return;
      }
      if (moved >= RANK_MOVE_MIN) {
         const improved = delta > 0;
         alerts.push({
            severity: 'medium',
            pillar: 'rank',
            headline: improved
               ? `"${now.keyword}"${pageRef} rose ${moved} spots, from #${beforePos} to #${nowPos}.`
               : `"${now.keyword}"${pageRef} fell ${moved} spots, from #${beforePos} to #${nowPos}.`,
            detail: `A ${moved}-position move period over period${improved ? ' in your favor' : ' against you'}.`,
            recommendation: improved
               ? 'Keep the momentum: the page is trending up, so keep it fresh and well-linked.'
               : 'Investigate the slide early, while it is a few positions, before it leaves page one.',
         });
      }
   });
   return alerts;
};

/**
 * TRAFFIC. Compare site-wide pageviews and visitors to the prior period. Only
 * fires when the prior baseline is non-zero (a swing measured off zero is not a
 * trustworthy percentage, so the engine stays silent and lets the route note the
 * thin baseline). Pageviews and visitors are reported as separate alerts only
 * when each independently clears the threshold.
 * @param {TrafficTotals} current - This period's totals.
 * @param {TrafficTotals} prior - The prior period's totals.
 * @returns {Alert[]}
 */
const detectTrafficChanges = (current: TrafficTotals, prior: TrafficTotals): Alert[] => {
   const alerts: Alert[] = [];
   const consider = (label: string, now: number, before: number): void => {
      // No usable baseline: do not invent a percentage from a zero prior.
      if (before <= 0) { return; }
      const change = (now - before) / before;
      if (Math.abs(change) < TRAFFIC_CHANGE_MIN) { return; }
      const change_pct = pctChange(now, before);
      const up = change > 0;
      const severity: AlertSeverity = Math.abs(change) >= TRAFFIC_CHANGE_HIGH ? 'high' : 'medium';
      alerts.push({
         severity,
         pillar: 'traffic',
         headline: `${label} ${up ? 'rose' : 'fell'} ${Math.abs(change_pct)}% period over period `
            + `(${before} to ${now}).`,
         detail: `${label} went from ${before} to ${now}, a ${change_pct}% change versus the prior period.`,
         recommendation: up
            ? 'Find what drove the lift (a ranking gain, a referral spike, a new AI source) and double down on it.'
            : 'Trace the drop to a pillar: check whether a rank loss or a fallen referral source explains it, '
               + 'then address that source directly.',
      });
   };
   consider('Pageviews', current.pageviews, prior.pageviews);
   consider('Visitors', current.visitors, prior.visitors);
   return alerts;
};

/**
 * AI VISIBILITY. Three distinct signals, all leading AEO indicators:
 *   1. A brand-NEW AI engine started referring visitors (an engine present now,
 *      absent prior). "From nothing" IS the signal here, so this is one of the two
 *      rules that intentionally fire off a zero prior. High severity.
 *   2. An existing AI engine's referral visitors grew/shrank by AI_CHANGE_MIN+
 *      (medium).
 *   3. An existing AI engine COLLAPSED from a real baseline to near zero (the
 *      inverse of #1: a working source has stopped, the lost-citation signal). High
 *      severity, checked before the ordinary >= 30% shrink so a collapse outranks it.
 * @param {AiEngineCount[]} currentEngines - This period's AI referral engines.
 * @param {AiEngineCount[]} priorEngines - The prior period's AI referral engines.
 * @returns {Alert[]}
 */
const detectAiChanges = (
   currentEngines: AiEngineCount[],
   priorEngines: AiEngineCount[],
): Alert[] => {
   const alerts: Alert[] = [];

   const priorByEngine = new Map<string, number>();
   priorEngines.forEach((e) => { priorByEngine.set(e.engine, (priorByEngine.get(e.engine) || 0) + e.visitors); });

   const currentByEngine = new Map<string, number>();
   currentEngines.forEach((e) => {
      currentByEngine.set(e.engine, (currentByEngine.get(e.engine) || 0) + e.visitors);
   });

   currentByEngine.forEach((nowVisitors, engine) => {
      const beforeVisitors = priorByEngine.get(engine);
      // New referring engine: present now, never seen before. The leading signal.
      if (beforeVisitors === undefined && nowVisitors > 0) {
         alerts.push({
            severity: 'high',
            pillar: 'ai',
            headline: `${engine} started referring visitors (${nowVisitors} this period).`,
            detail: 'A new AI answer engine began sending real traffic, the clearest sign your AEO work is '
               + 'being cited.',
            recommendation: `Identify which pages ${engine} is citing and make them stronger, more direct `
               + 'answers so the new source grows.',
         });
         return;
      }
      if (beforeVisitors === undefined || beforeVisitors <= 0) { return; }
      const change = (nowVisitors - beforeVisitors) / beforeVisitors;
      if (Math.abs(change) < AI_CHANGE_MIN) { return; }
      const up = change > 0;

      // COLLAPSE: an engine that had a real baseline of referrals has fallen to near
      // zero. "Lost the citation" is the most likely cause and the highest-signal AEO
      // loss, so it is HIGH (vs the MEDIUM ordinary >= 30% shrink below). The inverse
      // of the brand-new-engine signal: a source that was working has stopped.
      const collapsedToZero = beforeVisitors >= AI_COLLAPSE_BASELINE_MIN
         && nowVisitors <= AI_COLLAPSE_NEAR_ZERO_MAX;
      if (!up && collapsedToZero) {
         alerts.push({
            severity: 'high',
            pillar: 'ai',
            headline: `${engine} referrals collapsed: ${beforeVisitors} visitors last period, `
               + `${nowVisitors} now.`,
            detail: `An AI engine that was sending real traffic has effectively stopped. The usual cause is a `
               + `lost citation: the pages ${engine} cited changed, were out-ranked, or fell out of its answers.`,
            recommendation: `Investigate what changed on the pages ${engine} cited (a content edit, a lost rank, `
               + 'or a competitor displacing you) and restore the direct answer that earned the citation.',
         });
         return;
      }

      alerts.push({
         severity: 'medium',
         pillar: 'ai',
         headline: `${engine} referrals ${up ? 'grew' : 'fell'} ${Math.abs(pctChange(nowVisitors, beforeVisitors))}% `
            + `(${beforeVisitors} to ${nowVisitors} visitors).`,
         detail: `AI-referred visitors from ${engine} changed ${pctChange(nowVisitors, beforeVisitors)}% versus `
            + 'the prior period.',
         recommendation: up
            ? `Keep the pages ${engine} cites fresh and answer-ready so the gain compounds.`
            : `Review whether the pages ${engine} cited changed or were out-ranked, and restore their clarity `
               + 'before the source dries up.',
      });
   });

   return alerts;
};

/**
 * CONVERSIONS. Two distinct signals off the form-submission proxy:
 *   1. VOLUME: total submissions changed by CONVERSION_CHANGE_MIN+ (drop = high,
 *      rise = medium). Fires only off a non-zero prior submission baseline.
 *   2. RATE: submissions-per-visitor fell materially even when raw volume did not
 *      move enough to trip (1). A rate drop on steady traffic is the leading sign a
 *      form broke or a landing page regressed, so it is surfaced separately. Fires
 *      only when BOTH periods have submissions AND a meaningful prior visitor
 *      denominator, so a tiny sample cannot manufacture a "rate collapse".
 * Both signals can fire together (a real regression often moves both); they are
 * distinct alerts because the rate one localizes the cause (page/form) while the
 * volume one can also be pure traffic loss.
 * @param {number} current - This period's total form submissions.
 * @param {number} prior - The prior period's total form submissions.
 * @param {number} currentVisitors - This period's visitors (the rate denominator).
 * @param {number} priorVisitors - The prior period's visitors (the rate denominator).
 * @returns {Alert[]}
 */
const detectConversionChanges = (
   current: number,
   prior: number,
   currentVisitors: number,
   priorVisitors: number,
): Alert[] => {
   const alerts: Alert[] = [];

   // 1. VOLUME change (unchanged behavior).
   if (prior > 0) {
      const change = (current - prior) / prior;
      if (Math.abs(change) >= CONVERSION_CHANGE_MIN) {
         const up = change > 0;
         const delta_pct = pctChange(current, prior);
         alerts.push({
            severity: up ? 'medium' : 'high',
            pillar: 'conversions',
            headline: `Form submissions ${up ? 'rose' : 'fell'} ${Math.abs(delta_pct)}% period over period `
               + `(${prior} to ${current}).`,
            detail: `Captured form submissions changed ${delta_pct}% versus the prior period.`,
            recommendation: up
               ? 'Find the page or source behind the lift and send more traffic to it.'
               : 'Treat a conversion drop as urgent: check whether a form broke, a high-converting page lost traffic, '
                  + 'or a source dried up, and fix the specific cause.',
         });
      }
   }

   // 2. RATE drop. Needs real submissions in BOTH periods and a meaningful prior
   // visitor denominator, else a small sample fabricates a rate collapse.
   if (
      priorVisitors >= CONVERSION_RATE_MIN_PRIOR_VISITORS
      && prior > 0
      && currentVisitors > 0
   ) {
      const priorRate = prior / priorVisitors;
      const currentRate = current / currentVisitors;
      if (priorRate > 0 && currentRate < priorRate * (1 - CONVERSION_RATE_DROP_MIN)) {
         const halved = currentRate <= priorRate * CONVERSION_RATE_HALVED_MAX;
         const priorPct = Math.round(priorRate * 1000) / 10; // one decimal place
         const currentPct = Math.round(currentRate * 1000) / 10;
         alerts.push({
            severity: halved ? 'high' : 'medium',
            pillar: 'conversions',
            headline: `Your conversion rate fell from ${priorPct}% to ${currentPct}% of visitors `
               + 'period over period.',
            detail: `${prior} of ${priorVisitors} prior visitors converted (${priorPct}%); `
               + `${current} of ${currentVisitors} now (${currentPct}%). A rate drop on steady traffic, not just `
               + 'a volume swing.',
            recommendation: 'Check the landing pages and the conversion funnel for a regression: a broken or slow '
               + 'form, a changed CTA, or a step that started losing people. Compare the top converting pages '
               + 'period over period.',
         });
      }
   }

   return alerts;
};

// --- The public entry point --------------------------------------------------

/**
 * Detect what changed between two periods and prioritize it.
 *
 * Pure: a function only of its two arguments. Runs every per-pillar detector,
 * concatenates the alerts, sorts them highest-signal first (severity, then by the
 * pillar order rank/traffic/ai/conversions as a stable tiebreak), and derives the
 * single most important action from the top alert. Returns an empty list and a
 * null topPriority when nothing notable changed (an honest "quiet week", not a
 * fabricated finding).
 * @param {PeriodData} current - The current period's per-pillar data.
 * @param {PeriodData} prior - The prior period's per-pillar data.
 * @returns {AnalystOutput} The prioritized alerts and the single top priority.
 */
export const detectChanges = (current: PeriodData, prior: PeriodData): AnalystOutput => {
   const alerts: Alert[] = [
      ...detectRankChanges(current.keywords, prior.keywords),
      ...detectTrafficChanges(current.traffic, prior.traffic),
      ...detectAiChanges(current.aiEngines, prior.aiEngines),
      ...detectConversionChanges(
         current.formSubmissions,
         prior.formSubmissions,
         current.traffic.visitors,
         prior.traffic.visitors,
      ),
   ];

   // Stable pillar tiebreak so equal-severity alerts have a deterministic order.
   const pillarOrder: Record<AlertPillar, number> = { rank: 0, traffic: 1, ai: 2, conversions: 3 };
   alerts.sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (bySeverity !== 0) { return bySeverity; }
      return pillarOrder[a.pillar] - pillarOrder[b.pillar];
   });

   const top = alerts[0];
   const topPriority = top ? `${top.headline} ${top.recommendation}` : null;

   return { alerts, topPriority };
};

export default detectChanges;
