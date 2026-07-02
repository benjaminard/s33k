import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import Goal from '../../database/models/goal';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike, GoalDef } from '../../utils/sessionize';
import {
   getAnalyticsProvider, NormalizedPage, ReferralSource, SummaryResult,
} from '../../utils/analytics';
import type { WebVitalRow } from '../../utils/web-vitals';
import { buildFormSubmissions, EventRow } from '../../utils/eventReports';
import { cleanPath } from '../../utils/clean-path';
import {
   detectChanges, KeywordRank, AiEngineCount, TrafficTotals, PageTraffic,
} from '../../utils/analyst';
import { buildAeoRoi, AeoRoi, RoiKeyword } from '../../utils/aeo-roi';
import { buildDashboard, DashboardKeyword, DashboardGoal } from '../../utils/dashboard';
import { composeDailyBrief, DailyBrief, DailyBriefDashboardHeadline } from '../../utils/daily-brief';
import { renderDailyBriefText } from '../../utils/daily-brief-render';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * Like briefing.ts, alerts.ts, dashboard.ts and aeo-roi.ts, this route NEVER calls
 * an LLM, never embeds/fine-tunes, and never transmits account data to any model.
 * It reads the caller's OWN tenant-scoped data, runs the transparent rules in
 * utils/analyst.ts, utils/aeo-roi.ts and utils/dashboard.ts over it, and hands the
 * composed brief (utils/daily-brief.ts) to the user's own LLM (or renders it to the
 * scheduled email). Trust docs: SECURITY.md / the security_facts MCP tool.
 * ============================================================================
 */

/**
 * daily_brief: the proactive analyst distilled to a single standup.
 *
 * GET /api/daily-brief?domain=example.com&period=7d
 *
 * Where briefing answers "how is my site right now?" and alerts answers "what
 * changed?", the daily brief answers the hardest, most useful question of all in
 * ONE tight digest: "what is the single most important thing to do today?" It joins
 * three surfaces the app already trusts, in pure code, and never re-derives them:
 *   - the analyst engine (period-over-period change detection + topPriority);
 *   - the AEO ROI join (the top AI-visibility opportunity);
 *   - the dashboard headline (the top opportunity page).
 *
 * The same brief is delivered two ways: on demand here (the user's LLM narrates the
 * structured `brief`, or shows the `rendered` text), and pushed on a schedule via
 * composeAndSendDailyBrief in pages/api/notify.ts (the email IS the structured
 * output rendered to HTML).
 *
 * Resilience contract (mirrors alerts/briefing/dashboard): db.sync, authorize -> 401,
 * GET guard -> 405, missing domain -> 400, per-domain ownership gate -> 403. Each
 * upstream signal degrades to "nothing from that surface" on its own error rather
 * than 500-ing the brief; the composer is honest about a quiet period.
 */

type DailyBriefResponse = {
   domain?: string,
   period?: string,
   brief?: DailyBrief,
   rendered?: string,
   note?: string,
   error?: string | null,
};

/** A period parsed into a number of days (the window length). Unparseable -> 30 days. Mirrors alerts.ts. */
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

/** The window boundaries (ms): current is [curStart, now); prior is [priorStart, curStart). */
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

/** Sum AI-referral visitors per normalized engine label for a set of referral sources. */
const aiVisitorsByEngine = (sources: ReferralSource[]): Map<string, number> => {
   const map = new Map<string, number>();
   sources.filter((s) => s.isAI).forEach((s) => {
      const engine = s.engine || s.name || 'Unknown AI';
      map.set(engine, (map.get(engine) || 0) + visitorsOf(s));
   });
   return map;
};

/** Subtract current per-engine counts from the doubled-window counts to recover the prior window. */
const priorEnginesFromDiff = (doubled: Map<string, number>, current: Map<string, number>): AiEngineCount[] => {
   const out: AiEngineCount[] = [];
   doubled.forEach((doubledVisitors, engine) => {
      out.push({ engine, visitors: Math.max(0, doubledVisitors - (current.get(engine) || 0)) });
   });
   return out;
};

/** A Map<engine, visitors> rendered as the engine-count array the engine consumes. */
const engineCounts = (map: Map<string, number>): AiEngineCount[] => (
   Array.from(map.entries()).map(([engine, visitors]) => ({ engine, visitors }))
);

/** Aggregate per-page pageviews by normalized path. Mirrors alerts.ts. */
const pageviewsByPath = (pages: NormalizedPage[]): Map<string, number> => {
   const map = new Map<string, number>();
   (pages || []).forEach((p) => {
      const key = p.pathClean || cleanPath(p.url);
      if (!key) { return; }
      map.set(key, (map.get(key) || 0) + (Number(p.page_views) || 0));
   });
   return map;
};

/** A Map<path, pageviews> rendered as the per-page traffic array the engine consumes. Mirrors alerts.ts. */
const pageCounts = (map: Map<string, number>): PageTraffic[] => (
   Array.from(map.entries()).map(([page, pageviews]) => ({ page, pageviews }))
);

/** Prior per-page pageviews = doubled-window counts minus current (floored at 0). Mirrors alerts.ts. */
const priorPagesFromDiff = (doubled: Map<string, number>, current: Map<string, number>): PageTraffic[] => {
   const out: PageTraffic[] = [];
   doubled.forEach((doubledViews, page) => {
      out.push({ page, pageviews: Math.max(0, doubledViews - (current.get(page) || 0)) });
   });
   return out;
};

/**
 * Resolve a keyword's position within a window from its rank history (most recent in-window
 * entry, or null when nothing lands in the window). Mirrors positionInWindow in alerts.ts.
 * @param {KeywordHistory} history - date-keyed positions.
 * @param {number} start - window start (ms, inclusive).
 * @param {number} end - window end (ms, exclusive).
 * @returns {number | null}
 */
const positionInWindow = (history: KeywordHistory, start: number, end: number): number | null => {
   let bestTime = -1;
   let bestPos: number | null = null;
   Object.keys(history || {}).forEach((dateKey) => {
      const t = new Date(dateKey).getTime();
      if (Number.isNaN(t) || t < start || t >= end) { return; }
      if (t > bestTime) { bestTime = t; bestPos = history[dateKey]; }
   });
   return bestPos;
};

/**
 * Compose the daily brief for one already-owned domain. EXPORTED so the scheduled
 * push (composeAndSendDailyBrief in notify.ts) composes the EXACT same brief the
 * on-demand route returns, with no HTTP round-trip. The caller has already verified
 * ownership (the route via resolveDomainAccess, the cron via the domain it iterates).
 *
 * It loads three pillars worth of data, runs the three pure composers, and joins them
 * via composeDailyBrief. Every read is independently try/caught so any single failure
 * degrades to "nothing from that surface" rather than throwing.
 *
 * @param {string} domain - The owned domain to brief.
 * @param {string} period - The reporting window (e.g. "7d").
 * @param {Account | null | undefined} account - The resolved account for scoping.
 * @returns {Promise<DailyBrief>}
 */
export const composeDailyBriefForDomain = async (
   domain: string,
   period: string,
   account?: Account | null,
): Promise<DailyBrief> => {
   const { now, curStart, priorStart } = windowBounds(period);
   const doubled = doublePeriod(period);
   const provider = getAnalyticsProvider();
   const startISO = new Date(periodStartMs(period, now)).toJSON();

   // ---- Load every upstream signal in parallel, each degrading to a safe value. -------
   const [
      keywordRows,
      summaryCur, summaryDbl,
      referralsCur, referralsDbl,
      eventCur, eventPrior,
      trafficWindow, trafficDbl, referralsWindow, summaryWindow,
      sessionRows, webVitalRows, goalRows,
   ] = await Promise.all([
      Keyword.findAll({ where: { domain, ...scopeWhere(account) } }).catch(() => [] as Keyword[]),
      provider.getSummary(domain, period).catch((e) => emptySummary(String(e))),
      provider.getSummary(domain, doubled).catch((e) => emptySummary(String(e))),
      provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
      provider.getReferralSources(domain, doubled).catch((e) => ({ sources: [], error: String(e) })),
      S33kEvent.findAll({
         where: { domain, type: 'form_submit', created: { [Op.gte]: new Date(curStart).toJSON() }, ...scopeWhere(account) }, raw: true,
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
      // Dashboard pillar (current window): page traffic, referrals, summary for the headline opportunity page.
      // The doubled-window page traffic additionally feeds the analyst's content-decay
      // detector (prior per-page views = doubled minus current, same as the other pillars).
      provider.getPageTraffic(domain, period).catch((e) => ({ pages: [], error: String(e) })),
      provider.getPageTraffic(domain, doubled).catch((e) => ({ pages: [], error: String(e) })),
      provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
      provider.getSummary(domain, period).catch((e) => emptySummary(String(e))),
      // Sessions + web-vitals + goals for the dashboard headline and AEO ROI join.
      S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      }).catch(() => [] as S33kEvent[]),
      S33kEvent.findAll({
         where: { domain, type: 'webvital', is_bot: false, created: { [Op.gte]: startISO }, ...scopeWhere(account) }, raw: true,
      }).catch(() => [] as unknown as WebVitalRow[]),
      Goal.findAll({ where: { domain, ...scopeWhere(account) } }).catch(() => [] as Goal[]),
   ]);

   const keywords = parseKeywords((keywordRows as Keyword[]).map((e) => e.get({ plain: true })));

   // ===== 1. ANALYST: period-over-period change detection. =============================
   const currentKeywords: KeywordRank[] = [];
   const priorKeywords: KeywordRank[] = [];
   keywords.forEach((kw) => {
      const base = { keyword: kw.keyword, targetPage: kw.target_page || undefined };
      currentKeywords.push({ ...base, position: positionInWindow(kw.history, curStart, now) });
      priorKeywords.push({ ...base, position: positionInWindow(kw.history, priorStart, curStart) });
   });

   const curSummary = summaryCur as SummaryResult;
   const dblSummary = summaryDbl as SummaryResult;
   const currentTraffic: TrafficTotals = { pageviews: curSummary.pageviews || 0, visitors: curSummary.visitors || 0 };
   const priorTraffic: TrafficTotals = {
      pageviews: Math.max(0, (dblSummary.pageviews || 0) - currentTraffic.pageviews),
      visitors: Math.max(0, (dblSummary.visitors || 0) - currentTraffic.visitors),
   };

   const curRef = referralsCur as { sources: ReferralSource[], error: string | null };
   const dblRef = referralsDbl as { sources: ReferralSource[], error: string | null };
   const currentEngineMap = aiVisitorsByEngine(curRef.sources || []);
   const doubledEngineMap = aiVisitorsByEngine(dblRef.sources || []);
   const currentAiEngines = engineCounts(currentEngineMap);
   const priorAiEngines = priorEnginesFromDiff(doubledEngineMap, currentEngineMap);

   const currentFormSubmissions = buildFormSubmissions(eventCur as EventRow[]).totalSubmissions;
   const priorFormSubmissions = buildFormSubmissions(eventPrior as EventRow[]).totalSubmissions;

   // Per-page traffic for the content-decay detector: current from the dashboard read,
   // prior derived from the doubled window (additive subtraction, same as the other pillars).
   const currentPageMap = pageviewsByPath((trafficWindow as { pages: NormalizedPage[] }).pages || []);
   const doubledPageMap = pageviewsByPath((trafficDbl as { pages: NormalizedPage[] }).pages || []);

   const analyst = detectChanges(
      {
         keywords: currentKeywords,
         traffic: currentTraffic,
         aiEngines: currentAiEngines,
         formSubmissions: currentFormSubmissions,
         pages: pageCounts(currentPageMap),
      },
      {
         keywords: priorKeywords,
         traffic: priorTraffic,
         aiEngines: priorAiEngines,
         formSubmissions: priorFormSubmissions,
         pages: priorPagesFromDiff(doubledPageMap, currentPageMap),
      },
   );

   // ===== 2. DASHBOARD HEADLINE: the top opportunity page + sensible fallback action. ==
   const sessions = sessionize((sessionRows as S33kEvent[]).map((r) => r.get({ plain: true }) as EventLike));
   const dashKeywords: DashboardKeyword[] = keywords.map((k) => ({
      keyword: k.keyword, position: k.position, url: k.url, target_page: k.target_page, history: k.history,
   }));
   const dashGoals: DashboardGoal[] = (goalRows as Goal[]).map((g) => {
      const p = g.get({ plain: true }) as Record<string, unknown>;
      return {
         ID: Number(p.ID),
         name: String(p.name),
         kind: String(p.kind),
         match_value: String(p.match_value),
         match_page: (p.match_page as string) || null,
         match_mode: String(p.match_mode || 'prefix'),
         value: typeof p.value === 'number' ? p.value : null,
      };
   });
   const windowSummary = summaryWindow as SummaryResult;
   const dashboard = buildDashboard({
      domain,
      period,
      keywords: dashKeywords,
      sessions,
      summary: windowSummary.error ? null : windowSummary,
      trafficPages: (trafficWindow as { pages: NormalizedPage[] }).pages || [],
      referralSources: (referralsWindow as { sources: ReferralSource[] }).sources || [],
      webVitalRows: webVitalRows as unknown as WebVitalRow[],
      goals: dashGoals,
      errors: {
         summary: windowSummary.error,
         traffic: (trafficWindow as { error?: string | null }).error,
         referrals: (referralsWindow as { error?: string | null }).error,
      },
   });
   const dashboardHeadline: DailyBriefDashboardHeadline = {
      topOpportunity: dashboard.headline.topOpportunity,
      topAction: dashboard.headline.topAction,
   };

   // ===== 3. AEO ROI: the top AI-visibility opportunity (best-effort, first goal). =====
   // The AEO P&L needs a goal. Unlike the aeo-roi route (which REQUIRES an explicit selector),
   // the brief is a digest, so it best-effort picks the domain's first goal; with no goals it
   // simply contributes no AEO opportunity (null), which the composer handles honestly.
   let aeoRoi: AeoRoi | null = null;
   const firstGoal = (goalRows as Goal[])[0];
   if (firstGoal) {
      const g = firstGoal.get({ plain: true }) as Record<string, unknown>;
      const goalDef: GoalDef = {
         kind: g.kind === 'event' ? 'event' : 'page_reached',
         matchValue: String(g.match_value),
         matchPage: (g.match_page as string) || null,
         matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
      };
      const rawValue = g.value;
      const goalValue = typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;
      const roiKeywords: RoiKeyword[] = keywords.map((k) => ({ keyword: k.keyword, targetPage: String(k.target_page || '') }));
      const humanSessions = sessions.filter((s) => !s.isBot);
      aeoRoi = buildAeoRoi(humanSessions, goalDef, roiKeywords, goalValue);
   }

   // ===== GATHERING STATE: is this domain still collecting its first data? =============
   // A fresh domain has nothing honest to report yet. Lead with encouraging "tracking is
   // live, first numbers are coming in" copy instead of a flat quiet/zero. We are in the
   // gathering state when ANY of these hold (all computed from data already loaded above):
   //   - a tracked keyword's first Google check has not landed (updating === true);
   //   - no pageviews have been recorded yet (recentEvents === 0: no window summary pageviews
   //     AND no first-party sessions);
   //   - there is no prior-window baseline to compare against (prior traffic + prior ranks
   //     are all empty), so change detection cannot say anything meaningful.
   const noKeywords = keywords.length === 0;
   const rankPending = keywords.some((kw) => kw.updating === true);
   const recentEvents = (currentTraffic.pageviews || 0) + sessions.length;
   const noTraffic = recentEvents === 0;
   const priorPositions = priorKeywords.some((k) => typeof k.position === 'number' && (k.position as number) > 0);
   const noPriorWindow = (priorTraffic.pageviews || 0) === 0 && (priorTraffic.visitors || 0) === 0 && !priorPositions;
   // A real detected change ALWAYS wins: if the analyst found something moved (e.g. a rank drop on a
   // no-traffic-yet domain), report it rather than burying it under gathering copy. Gathering is only
   // for the case where there is genuinely nothing to report yet.
   const hasMaterialChange = (analyst.alerts || []).length > 0 || Boolean(analyst.topPriority);
   const gathering = !hasMaterialChange && (rankPending || noTraffic || noPriorWindow);

   // ===== JOIN: compose the single prioritized brief. ==================================
   // The setup signal is passed ONLY in the gathering state; otherwise the composer runs the
   // normal change-detection path byte-for-byte unchanged.
   return composeDailyBrief({
      domain,
      period,
      analyst,
      aeoRoi,
      dashboardHeadline,
      setup: gathering ? { noKeywords, noTraffic, rankPending } : undefined,
   });
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<DailyBriefResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error: error || 'Not authorized' }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getDailyBrief(req, res, account);
}

const getDailyBrief = async (req: NextApiRequest, res: NextApiResponse<DailyBriefResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '7d';

   // Ownership gate first, identical to alerts/briefing/dashboard. With MULTI_TENANT off
   // scopeWhere returns {} so this is an existence check; with it on, a tenant can only brief a
   // domain they own, and every read below is keyed behind this single check.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const brief = await composeDailyBriefForDomain(domain, period, account);
      const note = 'Your single most important thing to do for this domain right now, composed across SEO, AI search, '
         + 'and analytics. Lead with the headline and the top action. Say "give me my daily brief" anytime, or enable '
         + 'the scheduled email so s33k pushes this to you.';
      return res.status(200).json({
         domain, period, brief, rendered: renderDailyBriefText(brief), note, error: null,
      });
   } catch (error) {
      // Last-resort guard. The per-read catches inside composeDailyBriefForDomain mean we should
      // never get here; if a join itself throws we still return a usable response, never a 500.
      console.log('[ERROR] Building Daily Brief for ', domain, error);
      const fallback = composeDailyBrief({
         domain, period, analyst: { alerts: [], topPriority: null }, aeoRoi: null, dashboardHeadline: null,
      });
      return res.status(200).json({
         domain,
         period,
         brief: fallback,
         rendered: renderDailyBriefText(fallback),
         note: 'Could not load full data for this domain this period; showing a calm brief. Retry shortly.',
         error: 'Error Building Daily Brief for this Domain.',
      });
   }
};
