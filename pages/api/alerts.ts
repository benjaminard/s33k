import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import Domain from '../../database/models/domain';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { getAnalyticsProvider, ReferralSource, SummaryResult } from '../../utils/analytics';
import { buildFormSubmissions, EventRow } from '../../utils/eventReports';
import {
   detectChanges,
   AnalystOutput,
   KeywordRank,
   AiEngineCount,
   TrafficTotals,
} from '../../utils/analyst';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. ANALYSIS RUNS IN THE USER'S OWN LLM.
 * ============================================================================
 * Like briefing.ts and insights.ts, this route NEVER calls an LLM, never embeds
 * or fine-tunes, and never transmits account data to any model. It reads the
 * caller's OWN tenant-scoped data for two periods, runs the transparent,
 * commented rules in utils/analyst.ts over the deltas, and returns a structured,
 * narration-ready bundle. The interpretation ("what does this mean for me?")
 * happens in the USER's own LLM over MCP. Full trust documentation: SECURITY.md
 * (and the security_facts MCP tool).
 * ============================================================================
 */

/**
 * The PROACTIVE ANALYST: "what changed since last period, and what should I do?"
 *
 * Where briefing.ts answers "what is the state of the site right now?", this
 * route answers the harder, more useful question by COMPARING two periods. It
 * pulls the current period and the immediately-prior period across all four
 * pillars (search rank, traffic, AI visibility, engagement/conversions) and runs
 * the pure rules-based engine (utils/analyst.ts) to emit a prioritized list of
 * plain-English alerts plus the single most important thing to do this week.
 *
 * It is RULES-BASED: it does NOT call any LLM. The server reuses the SAME pillar
 * reads the other tools use (the analytics provider for traffic + AI referrals,
 * the s33k_event table for conversions, and Keyword rank history for SEO), shapes
 * the current and prior periods, and hands them to the engine. The USER's LLM
 * narrates the result.
 *
 * Robustness: this endpoint NEVER 500s on a sub-signal failure. Each pillar is
 * fetched independently and degrades to "no data for this pillar" on error,
 * exactly like briefing.ts. The only 4xx paths are auth (401), a non-GET method
 * (405), a missing domain (400), and an unowned domain (403).
 *
 * Prior-period derivation. The analytics provider only accepts a relative period
 * string (it always means "the last N days from now"), so the prior window is
 * derived honestly without a new provider parameter:
 *   - Additive provider totals (traffic, per-engine AI referral visitors) are
 *     fetched for the current window AND a doubled window, and prior = doubled
 *     minus current. Exact for additive quantities.
 *   - The DB-backed pillars this route queries directly (conversions via
 *     s33k_event, rank via Keyword history) use an explicit [priorStart, priorEnd)
 *     window, so those priors are exact too.
 */

type AlertsResponse = {
   alerts?: AnalystOutput['alerts'],
   topPriority?: AnalystOutput['topPriority'],
   period?: string,
   comparedTo?: string,
   generatedFor?: { domain: string, period: string },
   /** Honest, per-pillar note when a signal could not be measured this period. */
   dataAvailability?: {
      rank: string,
      traffic: string,
      ai: string,
      conversions: string,
   },
   error?: string | null,
};

/** A period parsed into a number of days (the window length). Unparseable -> 30 days. */
const periodToDays = (period: string): number => {
   const match = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   if (!match) { return 30; }
   const n = Number(match[1]);
   const unit = match[2].toLowerCase();
   const perUnitDays: Record<string, number> = { h: n / 24, d: n, w: n * 7, m: n * 30 };
   return Math.max(1, perUnitDays[unit] ?? 30);
};

/** The doubled period string (e.g. "7d" -> "14d") used to fetch [prior+current] additive totals. */
const doublePeriod = (period: string): string => {
   const match = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   if (!match) { return '60d'; }
   return `${Number(match[1]) * 2}${match[2].toLowerCase()}`;
};

/** The four window boundaries (ms): current is [curStart, now); prior is [priorStart, curStart). */
const windowBounds = (period: string): { now: number, curStart: number, priorStart: number } => {
   const ms = periodToDays(period) * 24 * 60 * 60 * 1000;
   const now = Date.now();
   const curStart = now - ms;
   const priorStart = curStart - ms;
   return { now, curStart, priorStart };
};

/** A zeroed SummaryResult so a failed summary read degrades to "no traffic" rather than throwing. */
const emptySummary = (error: string): SummaryResult => ({
   pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error,
});

/** Visitor count for a referral source, defaulting a missing/NaN value to 0. */
const visitorsOf = (s: ReferralSource): number => {
   const v = Number(s.unique_visitors ?? 0);
   return Number.isFinite(v) ? v : 0;
};

/**
 * Sum AI-referral visitors per normalized engine label for a set of referral
 * sources. Only AI sources are kept; the engine label falls back to the raw name.
 * @param {ReferralSource[]} sources - Referral sources from the provider.
 * @returns {Map<string, number>} engine label -> total visitors.
 */
const aiVisitorsByEngine = (sources: ReferralSource[]): Map<string, number> => {
   const map = new Map<string, number>();
   sources.filter((s) => s.isAI).forEach((s) => {
      const engine = s.engine || s.name || 'Unknown AI';
      map.set(engine, (map.get(engine) || 0) + visitorsOf(s));
   });
   return map;
};

/**
 * Subtract the current per-engine visitor counts from the doubled-window counts
 * to recover the prior window's per-engine counts. A non-negative floor guards
 * against tiny provider rounding differences between the two reads.
 * @param {Map<string, number>} doubled - engine -> visitors over [prior+current].
 * @param {Map<string, number>} current - engine -> visitors over [current].
 * @returns {AiEngineCount[]} The prior window's per-engine visitor counts.
 */
const priorEnginesFromDiff = (doubled: Map<string, number>, current: Map<string, number>): AiEngineCount[] => {
   const out: AiEngineCount[] = [];
   doubled.forEach((doubledVisitors, engine) => {
      const prior = Math.max(0, doubledVisitors - (current.get(engine) || 0));
      out.push({ engine, visitors: prior });
   });
   return out;
};

/** A Map<engine, visitors> rendered as the engine-count array the engine consumes. */
const engineCounts = (map: Map<string, number>): AiEngineCount[] => (
   Array.from(map.entries()).map(([engine, visitors]) => ({ engine, visitors }))
);

/** Honest per-pillar note for RANK: explains when no rank change could be measured. */
const rankAvailabilityNote = (keywordCount: number, anyHistory: boolean): string => {
   if (keywordCount === 0) {
      return 'No keywords tracked for this domain, so no rank changes can be detected.';
   }
   if (!anyHistory) {
      return 'Keywords are tracked but have no rank history yet, so no rank change can be measured.';
   }
   return 'Compared current vs prior rank from keyword history.';
};

/** Honest per-pillar note for TRAFFIC: explains a missing baseline or a provider error. */
const trafficAvailabilityNote = (error: string | null, prior: TrafficTotals): string => {
   if (error) { return `Traffic unavailable this period (${error}).`; }
   if (prior.pageviews === 0 && prior.visitors === 0) {
      return 'No prior-period traffic baseline, so traffic-change alerts are suppressed (honest, not a swing from zero).';
   }
   return 'Compared current vs prior traffic totals.';
};

/** Honest per-pillar note for CONVERSIONS: explains a missing baseline or no data at all. */
const conversionsAvailabilityNote = (current: number, prior: number): string => {
   if (prior > 0) { return 'Compared current vs prior form-submission totals.'; }
   if (current === 0) {
      return 'No form submissions in either period (autocapture may not be installed yet).';
   }
   return 'No prior-period submissions to compare against, so a conversion-change alert is suppressed.';
};

/**
 * Resolve a keyword's position within a window from its rank history. The history
 * is a date-keyed map of positions; the most recent entry whose date falls inside
 * [start, end) is the window's position. Returns null when no entry lands in the
 * window, so the engine treats it as "not measured this window" (no false change).
 * @param {KeywordHistory} history - date-keyed positions (keys like "2026-1-5").
 * @param {number} start - window start (ms, inclusive).
 * @param {number} end - window end (ms, exclusive).
 * @returns {number | null} The position at the latest in-window date, or null.
 */
const positionInWindow = (history: KeywordHistory, start: number, end: number): number | null => {
   let bestTime = -1;
   let bestPos: number | null = null;
   Object.keys(history || {}).forEach((dateKey) => {
      const t = new Date(dateKey).getTime();
      if (Number.isNaN(t) || t < start || t >= end) { return; }
      if (t > bestTime) {
         bestTime = t;
         bestPos = history[dateKey];
      }
   });
   return bestPos;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<AlertsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAlerts(req, res, account);
}

const getAlerts = async (req: NextApiRequest, res: NextApiResponse<AlertsResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '7d';

   // Ownership gate, identical to scoreboard.ts / briefing.ts. With MULTI_TENANT off
   // scopeWhere returns {} so this is an existence check; with it on, a tenant can only
   // analyze a domain it owns, and every read below is keyed behind this single check.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   const { now, curStart, priorStart } = windowBounds(period);
   const doubled = doublePeriod(period);
   const provider = getAnalyticsProvider();

   try {
      // Pull every pillar in parallel. Each promise is wrapped so a rejection becomes a
      // recoverable value, never an unhandled throw that 500s the route. Analytics
      // providers already resolve (not reject) with an `error` field; the DB queries get
      // explicit catches. Additive provider totals are read for BOTH the current window
      // and the doubled window so the prior window can be derived by subtraction.
      const [
         keywordRows,
         summaryCur, summaryDbl,
         referralsCur, referralsDbl,
         eventCur, eventPrior,
      ] = await Promise.all([
         Keyword.findAll({ where: { domain, ...scopeWhere(account) } }).catch(() => [] as Keyword[]),
         provider.getSummary(domain, period).catch((e) => emptySummary(String(e))),
         provider.getSummary(domain, doubled).catch((e) => emptySummary(String(e))),
         provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
         provider.getReferralSources(domain, doubled).catch((e) => ({ sources: [], error: String(e) })),
         S33kEvent.findAll({
            where: { domain, type: 'form_submit', created: { [Op.gte]: new Date(curStart).toJSON() }, ...scopeWhere(account) },
            raw: true,
         }).catch(() => [] as EventRow[]),
         S33kEvent.findAll({
            where: {
               domain,
               type: 'form_submit',
               created: { [Op.gte]: new Date(priorStart).toJSON(), [Op.lt]: new Date(curStart).toJSON() },
               ...scopeWhere(account),
            },
            raw: true,
         }).catch(() => [] as EventRow[]),
      ]);

      // --- RANK: current vs prior position per keyword, read from rank history. ---------
      const keywords = parseKeywords((keywordRows as Keyword[]).map((e) => e.get({ plain: true })));
      const currentKeywords: KeywordRank[] = [];
      const priorKeywords: KeywordRank[] = [];
      keywords.forEach((kw) => {
         const base = { keyword: kw.keyword, targetPage: kw.target_page || undefined };
         currentKeywords.push({ ...base, position: positionInWindow(kw.history, curStart, now) });
         priorKeywords.push({ ...base, position: positionInWindow(kw.history, priorStart, curStart) });
      });
      const anyRankHistory = keywords.some((kw) => Object.keys(kw.history || {}).length > 0);
      const rankNote = rankAvailabilityNote(keywords.length, anyRankHistory);

      // --- TRAFFIC: current totals, prior = doubled minus current (additive). ------------
      const curSummary = summaryCur as SummaryResult;
      const dblSummary = summaryDbl as SummaryResult;
      const currentTraffic: TrafficTotals = {
         pageviews: curSummary.pageviews || 0,
         visitors: curSummary.visitors || 0,
      };
      const priorTraffic: TrafficTotals = {
         pageviews: Math.max(0, (dblSummary.pageviews || 0) - currentTraffic.pageviews),
         visitors: Math.max(0, (dblSummary.visitors || 0) - currentTraffic.visitors),
      };
      const trafficNote = trafficAvailabilityNote(curSummary.error, priorTraffic);

      // --- AI: per-engine referral visitors (current + derived prior). --
      const curRef = referralsCur as { sources: ReferralSource[], error: string | null };
      const dblRef = referralsDbl as { sources: ReferralSource[], error: string | null };
      const currentEngineMap = aiVisitorsByEngine(curRef.sources || []);
      const doubledEngineMap = aiVisitorsByEngine(dblRef.sources || []);
      const currentAiEngines = engineCounts(currentEngineMap);
      const priorAiEngines = priorEnginesFromDiff(doubledEngineMap, currentEngineMap);

      const aiNote = curRef.error
         ? `AI referral data unavailable (${curRef.error}); AI alerts suppressed this period.`
         : 'Compared current vs prior AI referral engines.';

      // --- CONVERSIONS: total form submissions, current vs prior (exact windows). --------
      const currentFormSubmissions = buildFormSubmissions(eventCur as EventRow[]).totalSubmissions;
      const priorFormSubmissions = buildFormSubmissions(eventPrior as EventRow[]).totalSubmissions;
      const conversionsNote = conversionsAvailabilityNote(currentFormSubmissions, priorFormSubmissions);

      // --- Run the pure engine over the two shaped periods. ------------------------------
      const output = detectChanges(
         {
            keywords: currentKeywords,
            traffic: currentTraffic,
            aiEngines: currentAiEngines,
            formSubmissions: currentFormSubmissions,
         },
         {
            keywords: priorKeywords,
            traffic: priorTraffic,
            aiEngines: priorAiEngines,
            formSubmissions: priorFormSubmissions,
         },
      );

      return res.status(200).json({
         alerts: output.alerts,
         topPriority: output.topPriority,
         period,
         comparedTo: `the prior ${period} window`,
         generatedFor: { domain, period },
         dataAvailability: {
            rank: rankNote,
            traffic: trafficNote,
            ai: aiNote,
            conversions: conversionsNote,
         },
         error: null,
      });
   } catch (error) {
      // Last-resort guard. The per-pillar catches above mean we should never get here, but
      // if the engine or a join itself throws we still return a usable (empty) response
      // rather than a 500, honoring the "never 500" contract.
      console.log('[ERROR] Building Alerts for ', domain, error);
      return res.status(200).json({
         alerts: [],
         topPriority: null,
         period,
         comparedTo: `the prior ${period} window`,
         generatedFor: { domain, period },
         error: 'Error Building Alerts for this Domain.',
      });
   }
};
