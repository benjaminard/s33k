/**
 * The proactive analyst: a PURE, rules-based change-detection engine.
 *
 * s33k's other cross-pillar surfaces (briefing.ts, insights.ts) answer "what is
 * the state of the site right now?". This engine answers the harder, more useful
 * question: "what CHANGED since last period, and what should I do about it?". It
 * compares a CURRENT period to a PRIOR one across the pillars (search rank,
 * traffic, per-page content decay, AI visibility, engagement/conversions) and
 * emits a prioritized list of plain-English alerts plus the single most
 * important thing to do this week.
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

// cleanPath is a PURE string normalizer (no IO), so importing it keeps this engine pure.
// It is how a keyword's targetPage and a traffic page path compare apples-to-apples.
import { cleanPath } from './clean-path';

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
   /**
    * Domains sitting immediately above the user's position on the keyword's
    * already-STORED SERP (nearest first), computed by the route from lastResult.
    * No new scraping: a local join over data already on disk. Optional; when
    * absent the rank alert simply carries no domainsAbove context.
    */
   serpDomainsAbove?: string[],
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

/** One page's traffic in a single period, keyed by its normalized (cleanPath) path. */
export type PageTraffic = {
   /** The normalized comparable path, e.g. "/blog/some-post". */
   page: string,
   /** Pageviews the page earned in the period. */
   pageviews: number,
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
   /**
    * Per-page traffic this period, for content-decay detection. OPTIONAL so
    * existing callers that do not thread per-page traffic behave byte-for-byte
    * as before (no pages in either period = the decay detector stays silent).
    */
   pages?: PageTraffic[],
};

// --- Public output shape -----------------------------------------------------

export type AlertSeverity = 'high' | 'medium' | 'low';
export type AlertPillar = 'rank' | 'traffic' | 'content_decay' | 'ai' | 'conversions';

/**
 * SERP context attached to RANK alerts, so the narrating LLM can explain a move,
 * not just report it. Built entirely from the keyword's already-stored SERP page
 * (no new scrape). domainsAbove is present only when the stored SERP allows it.
 */
export type RankAlertContext = {
   /** The tracked term the alert is about. */
   keyword: string,
   /** Position in the prior period, or null when it was not ranked. */
   priorPosition: number | null,
   /** Position in the current period, or null when it is not ranked. */
   currentPosition: number | null,
   /** Domains immediately above the user's position now, nearest first. Omitted when unknown. */
   domainsAbove?: string[],
};

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
   /**
    * ADDITIVE, nullable context. Today only RANK alerts carry it (SERP context
    * from the stored results page); every other pillar omits it. Optional so
    * existing consumers of the Alert shape are unaffected.
    */
   context?: RankAlertContext | null,
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
/**
 * CONTENT DECAY. A page's pageviews must fall by at least this fraction period
 * over period to count as decaying (sustained decline, not noise).
 */
const DECAY_DROP_MIN = 0.35; // 35%
/** A decay drop at or above this fraction is high-severity (mirrors the traffic 50% rule). */
const DECAY_DROP_HIGH = 0.5; // 50%
/**
 * A page needs at least this many PRIOR pageviews to be judged for decay, so a
 * 3-view page falling to 1 cannot spam the alert list with statistical noise.
 */
const DECAY_BASELINE_MIN = 20; // prior pageviews
/**
 * A tracked keyword's rank "held" when it worsened by no more than this many
 * positions (or improved). Flat rank + falling traffic = stale content, the
 * highest-value decay variant (the rank did not cause the drop, the page did).
 */
const DECAY_RANK_HELD_TOLERANCE = 2; // positions
/** Cap decay alerts per run so a site-wide traffic event does not drown the list. */
const DECAY_MAX_ALERTS = 5;
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
 * The SERP context every rank alert carries: prior vs current position plus,
 * when the route supplied it from the stored SERP, the domains immediately
 * above the user's position now. Pure; a missing serpDomainsAbove just omits
 * the field rather than inventing one.
 * @param {KeywordRank} now - The current-period keyword (carries serpDomainsAbove).
 * @param {number | null} nowPos - The ranked current position, or null.
 * @param {number | null} beforePos - The ranked prior position, or null.
 * @returns {RankAlertContext}
 */
const rankContext = (now: KeywordRank, nowPos: number | null, beforePos: number | null): RankAlertContext => ({
   keyword: now.keyword,
   priorPosition: beforePos,
   currentPosition: nowPos,
   ...(now.serpDomainsAbove && now.serpDomainsAbove.length > 0 ? { domainsAbove: now.serpDomainsAbove } : {}),
});

/**
 * The "who is directly above you" sentence appended to a falling rank alert's
 * detail, or '' when the stored SERP gave no domains to name.
 * @param {KeywordRank} now - The current-period keyword.
 * @returns {string}
 */
const domainsAboveSentence = (now: KeywordRank): string => (
   now.serpDomainsAbove && now.serpDomainsAbove.length > 0
      ? ` Directly above you now: ${now.serpDomainsAbove.join(', ')}.`
      : ''
);

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
            context: rankContext(now, nowPos, beforePos),
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
            context: rankContext(now, nowPos, beforePos),
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
            detail: `Leaving the top ${PAGE_ONE_MAX} usually takes entry traffic with it.${domainsAboveSentence(now)}`,
            recommendation: 'Treat this as the priority SEO fix: refresh the page, shore up internal links, '
               + 'and recover the top-10 position before the lost traffic compounds.',
            context: rankContext(now, nowPos, beforePos),
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
            context: rankContext(now, nowPos, beforePos),
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
            detail: `A ${moved}-position move period over period${improved ? ' in your favor' : ' against you'}.`
               + `${improved ? '' : domainsAboveSentence(now)}`,
            recommendation: improved
               ? 'Keep the momentum: the page is trending up, so keep it fresh and well-linked.'
               : 'Investigate the slide early, while it is a few positions, before it leaves page one.',
            context: rankContext(now, nowPos, beforePos),
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
 * CONTENT DECAY. For each page with a real PRIOR baseline (>= DECAY_BASELINE_MIN
 * pageviews), flag a sustained period-over-period traffic decline of
 * DECAY_DROP_MIN+ (>= DECAY_DROP_HIGH is high-severity, mirroring the traffic
 * rule). The highest-value variant: when a tracked keyword TARGETS the decaying
 * page and its rank HELD (worsened by at most DECAY_RANK_HELD_TOLERANCE positions,
 * or improved) across the same two windows, the rank did not cause the drop, so
 * the content itself has gone stale. The alert says so explicitly and the
 * recommendation is always the same concrete move: refresh this content.
 *
 * Honest on missing data: no pages in either period, or a page below the prior
 * baseline, produces NO alert. A page absent from the current period counts as 0
 * current views (a real decline), because its PRIOR baseline is what qualifies it.
 * Capped at DECAY_MAX_ALERTS (biggest declines first) so a site-wide event cannot
 * drown the list; the site-wide story is the traffic pillar's job.
 * @param {PageTraffic[] | undefined} currentPages - This period's per-page traffic.
 * @param {PageTraffic[] | undefined} priorPages - The prior period's per-page traffic.
 * @param {KeywordRank[]} currentKeywords - This period's keyword ranks (for the rank-held join).
 * @param {KeywordRank[]} priorKeywords - The prior period's keyword ranks.
 * @returns {Alert[]}
 */
const detectContentDecay = (
   currentPages: PageTraffic[] | undefined,
   priorPages: PageTraffic[] | undefined,
   currentKeywords: KeywordRank[],
   priorKeywords: KeywordRank[],
): Alert[] => {
   if (!currentPages || !priorPages || priorPages.length === 0) { return []; }

   const currentByPage = new Map<string, number>();
   currentPages.forEach((p) => {
      const key = cleanPath(p.page);
      if (!key) { return; }
      currentByPage.set(key, (currentByPage.get(key) || 0) + p.pageviews);
   });

   // Keywords by the normalized page they target, current and prior, for the rank-held join.
   const curKwByPage = new Map<string, KeywordRank[]>();
   currentKeywords.forEach((k) => {
      const key = cleanPath(k.targetPage || '');
      if (!key) { return; }
      curKwByPage.set(key, [...(curKwByPage.get(key) || []), k]);
   });
   const priorKwPos = new Map<string, number>();
   priorKeywords.forEach((k) => {
      if (isRanked(k.position)) { priorKwPos.set(k.keyword, k.position); }
   });

   type Decayed = { alert: Alert, decline: number };
   const decayed: Decayed[] = [];

   // Aggregate the prior side too (defensive: a caller may pass duplicate paths).
   const priorByPage = new Map<string, number>();
   priorPages.forEach((p) => {
      const key = cleanPath(p.page);
      if (!key) { return; }
      priorByPage.set(key, (priorByPage.get(key) || 0) + p.pageviews);
   });

   priorByPage.forEach((before, page) => {
      if (before < DECAY_BASELINE_MIN) { return; }
      const now = currentByPage.get(page) || 0;
      const decline = (before - now) / before;
      if (decline < DECAY_DROP_MIN) { return; }
      const dropPct = Math.abs(pctChange(now, before));
      const severity: AlertSeverity = decline >= DECAY_DROP_HIGH ? 'high' : 'medium';

      // The rank-held join: a keyword targeting this page that ranked in BOTH windows
      // and did not fall comparably. Flat rank + falling traffic = stale content.
      const heldKeyword = (curKwByPage.get(page) || []).find((k) => {
         if (!isRanked(k.position)) { return false; }
         const beforePos = priorKwPos.get(k.keyword);
         return beforePos !== undefined && k.position <= beforePos + DECAY_RANK_HELD_TOLERANCE;
      });

      const recommendation = 'Refresh this content: update its facts, dates, and examples to match current search '
         + 'intent, sharpen the direct answer up top, and re-link it from your newer pages.';
      if (heldKeyword) {
         const beforePos = priorKwPos.get(heldKeyword.keyword) as number;
         decayed.push({
            decline,
            alert: {
               severity,
               pillar: 'content_decay',
               headline: `${page} is decaying: traffic fell ${dropPct}% (${before} to ${now} pageviews) while its `
                  + 'rank held.',
               detail: `"${heldKeyword.keyword}" still ranks #${heldKeyword.position} (was #${beforePos}), so a rank `
                  + 'loss did not cause the drop. Flat rank with falling traffic is the classic stale-content signal: '
                  + 'the page is losing clicks, not position.',
               recommendation,
            },
         });
         return;
      }
      decayed.push({
         decline,
         alert: {
            severity,
            pillar: 'content_decay',
            headline: `Traffic to ${page} fell ${dropPct}% period over period (${before} to ${now} pageviews).`,
            detail: `A sustained per-page decline off a real baseline of ${before} prior pageviews.`,
            recommendation,
         },
      });
   });

   // Biggest declines first, capped so a site-wide event cannot drown the list.
   return decayed
      .sort((a, b) => b.decline - a.decline)
      .slice(0, DECAY_MAX_ALERTS)
      .map((d) => d.alert);
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
      ...detectContentDecay(current.pages, prior.pages, current.keywords, prior.keywords),
      ...detectAiChanges(current.aiEngines, prior.aiEngines),
      ...detectConversionChanges(
         current.formSubmissions,
         prior.formSubmissions,
         current.traffic.visitors,
         prior.traffic.visitors,
      ),
   ];

   // Stable pillar tiebreak so equal-severity alerts have a deterministic order.
   const pillarOrder: Record<AlertPillar, number> = {
      rank: 0, traffic: 1, content_decay: 2, ai: 3, conversions: 4,
   };
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
