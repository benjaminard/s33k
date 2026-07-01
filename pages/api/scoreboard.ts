import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { cleanPath } from '../../utils/clean-path';
import { periodStartMs } from '../../utils/period';
import { sessionize, sessionConverted, EventLike, GoalDef } from '../../utils/sessionize';
import { aiLandingFromSessions } from '../../utils/ai-landing';
import { getAnalyticsProvider, NormalizedPage, ReferralSource } from '../../utils/analytics';
import { aggregateTrafficPages } from '../../utils/aggregate-traffic-pages';

type ScoreboardKeyword = {
   keyword: string,
   position: number,
   device: string,
   url: string,
}

type ScoreboardPage = {
   url: string,
   pathClean: string,
   page_title?: string,
   page_views: number,
   unique_visitors?: number,
   bounce_rate?: number | null,
   avg_duration?: number | null,
   metricsNote?: string,
   aiReferralVisitors: number,
   keywords: ScoreboardKeyword[],
   // Present only when a goal is supplied: conversions = goal conversions whose session LANDED on
   // this page, conversionRate = conversions / first-party sessions that landed here (percent).
   conversions?: number,
   conversionRate?: number | null,
}

type ContentGapPage = {
   url: string,
   pathClean: string,
   page_title?: string,
   page_views: number,
   unique_visitors?: number,
   bounce_rate?: number | null,
   avg_duration?: number | null,
   metricsNote?: string,
   aiReferralVisitors: number,
   conversions?: number,
   conversionRate?: number | null,
}

type UnmatchedKeyword = ScoreboardKeyword & { target_page: string }

type ScoreboardResponse = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   scoreboard?: ScoreboardPage[],
   pagesWithTrafficNoKeywords?: ContentGapPage[],
   keywordsWithNoMatchingPage?: UnmatchedKeyword[],
   analyticsError?: string | null,
   referralError?: string | null,
   aiReferralNote?: string | null,
   conversionsNote?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ScoreboardResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getScoreboard(req, res, account);
}

const getScoreboard = async (req: NextApiRequest, res: NextApiResponse<ScoreboardResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // Verify the caller owns this domain before exposing any of its data. With MULTI_TENANT
   // off, scopeWhere returns {} so this matches the domain by name exactly as before.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   // OPTIONAL goal: when supplied, add per-page conversions + conversionRate. Resolved exactly like
   // entry-page-report.ts (scoped by domain + account, goalId or goal name). A bad goal returns a
   // clear 400/404; the resolution lives INSIDE the try so a transient Goal.findOne throw degrades to
   // the controlled error, never a 500 (the early 400/404 returns work fine inside a try). Omit the
   // goal and the scoreboard is byte-for-byte unchanged (no conversion fields).
   const goalIdRaw = typeof req.query.goalId === 'string' ? req.query.goalId.trim() : '';
   const goalNameRaw = typeof req.query.goal === 'string' ? req.query.goal.trim() : '';

   try {
      let goal: GoalDef | null = null;
      let goalMeta: { id: number, name: string } | null = null;
      if (goalIdRaw || goalNameRaw) {
         const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
         if (goalIdRaw) {
            const gid = parseInt(goalIdRaw, 10);
            if (!Number.isFinite(gid)) { return res.status(400).json({ error: 'goalId must be a number.' }); }
            goalWhere.ID = gid;
         } else {
            goalWhere.name = goalNameRaw;
         }
         const goalRow = await Goal.findOne({ where: goalWhere });
         if (!goalRow) { return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or list goals.' }); }
         const g = goalRow.get({ plain: true }) as Record<string, unknown>;
         goal = {
            kind: g.kind === 'event' ? 'event' : 'page_reached',
            matchValue: String(g.match_value),
            matchPage: (g.match_page as string) || null,
            matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
         };
         goalMeta = { id: g.ID as number, name: String(g.name) };
      }

      // 1. Load this domain's keywords from the DB (same path as keywords.ts getKeywords).
      const allKeywords: Keyword[] = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
      const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));

      // 2. Fetch per-page traffic from the configured analytics provider, then aggregate by clean
      // path. A provider can return several raw rows that normalize to one page (e.g. "/p" and
      // "/p?utm=x"); without this both pageByPath (plain .set, last wins) and the row-emitting
      // forEach below would drop/double-count that page. briefing.ts aggregates the same way via
      // the shared util, so the two cross-pillar views agree on the same data.
      const provider = getAnalyticsProvider();
      const { pages: rawTrafficPages, error: analyticsError } = await provider.getPageTraffic(domain, period);
      const trafficPages = aggregateTrafficPages(rawTrafficPages);

      // 2b. Per-page AI-search landing counts + (when a goal is given) per-page conversions, both
      // from FIRST-PARTY sessions: sessionize this domain's scoped s33k_event rows once and reuse
      // them. AI counts: take 'ai'-channel sessions grouped by landing page (EXACT, no provider
      // landing_path needed). Conversions: count goal conversions whose session landed on each page,
      // and sessions landed there (the denominator). A failure here NEVER breaks the scoreboard.
      let aiVisitorsByLanding = new Map<string, number>();
      let aiLandingExact = false;
      const goalConversionsByLanding = new Map<string, number>();
      const sessionsByLanding = new Map<string, number>();
      try {
         const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
         const eventRows: S33kEvent[] = await S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         });
         const plainRows = eventRows.map((r) => r.get({ plain: true }) as EventLike);
         const { byLanding, totalAiSessions } = aiLandingFromSessions(plainRows);
         if (totalAiSessions > 0) {
            aiVisitorsByLanding = byLanding;
            aiLandingExact = true;
         }
         if (goal) {
            // Sessionize once more for conversions, HUMAN-only (drop bots), matching the entry-page
            // report's human-only default and the human-only AI-landing counts above so all per-page
            // numbers share one population. Only sessions with a pageview credit a landing page (the
            // pageviewCount guard): a pageview-less session cannot land on a page never viewed.
            sessionize(plainRows).filter((s) => !s.isBot && s.pageviewCount > 0).forEach((s) => {
               const key = cleanPath(s.landingPage);
               sessionsByLanding.set(key, (sessionsByLanding.get(key) || 0) + 1);
               if (goal && sessionConverted(s, goal)) {
                  goalConversionsByLanding.set(key, (goalConversionsByLanding.get(key) || 0) + 1);
               }
            });
         }
      } catch (evErr) {
         console.log('[WARN] scoreboard first-party sessionize failed for ', domain, evErr);
      }

      // 2c. Fallback for AI-by-landing only: when there were NO first-party AI sessions, try the
      // provider's per-source landing_path (most providers, e.g. Umami, expose none). Never let a
      // referral failure break the scoreboard.
      let referralError: string | null = null;
      let aiReferralLandingAvailable = false;
      if (!aiLandingExact) {
         try {
            const { sources, error: refError } = await provider.getReferralSources(domain, period);
            referralError = refError;
            const aiSources = (sources || []).filter((s: ReferralSource) => s.isAI);
            aiSources.forEach((s) => {
               if (s.landing_path) {
                  aiReferralLandingAvailable = true;
                  const key = cleanPath(s.landing_path);
                  const visitors = Number(s.unique_visitors ?? 0);
                  aiVisitorsByLanding.set(key, (aiVisitorsByLanding.get(key) || 0) + visitors);
               }
            });
         } catch (refErr) {
            referralError = refErr instanceof Error ? refErr.message : String(refErr);
            aiVisitorsByLanding = new Map<string, number>();
         }
      }
      // The note clears when per-page AI counts are exact: first-party sessions or a provider
      // landing_path. It stays set only when neither is available.
      const aiReferralNote = (aiLandingExact || aiReferralLandingAvailable)
         ? null
         : 'AI-referral data has no per-landing-page detail from this provider and no first-party AI sessions yet, so '
            + 'aiReferralVisitors is 0 (n/a) on every page. Install the s33k.js tracking script for exact per-page '
            + 'AI-search landing counts, or use the ai_referrals tool for site-wide AI-engine totals.';

      // Per-page conversion attachment helper (no-op when no goal). conversions = goal conversions
      // whose session landed on the page; conversionRate = conversions / first-party sessions landed
      // there (percent, one decimal). null rate when the page had no first-party landing sessions.
      const conversionFieldsFor = (pathClean: string): { conversions?: number, conversionRate?: number | null } => {
         if (!goal) { return {}; }
         const conversions = goalConversionsByLanding.get(pathClean) || 0;
         const landed = sessionsByLanding.get(pathClean) || 0;
         return { conversions, conversionRate: landed > 0 ? Math.round((1000 * conversions) / landed) / 10 : null };
      };
      const conversionsNote = goal
         ? 'conversions = goal conversions whose HUMAN first-party session LANDED on that page; conversionRate is over '
            + 'human first-party sessions that landed there (percent). conversionRate is null on a page with no human '
            + 'first-party landing sessions. Provider page_views and first-party landing sessions are different denominators.'
         : null;

      // 3. Build a lookup of traffic pages by clean path.
      const pageByPath = new Map<string, NormalizedPage>();
      trafficPages.forEach((page) => { pageByPath.set(page.pathClean, page); });

      // 4. Group keywords by their normalized target_page path.
      const keywordsByPath = new Map<string, ScoreboardKeyword[]>();
      const keywordsWithNoMatchingPage: UnmatchedKeyword[] = [];

      keywords.forEach((kw) => {
         const targetPage = kw.target_page || '';
         const targetClean = cleanPath(targetPage);
         const scoreboardKw: ScoreboardKeyword = {
            keyword: kw.keyword,
            position: kw.position,
            device: kw.device,
            url: kw.url,
         };
         // A keyword matches a page when its normalized target_page equals the page pathClean.
         if (targetClean && pageByPath.has(targetClean)) {
            const list = keywordsByPath.get(targetClean) || [];
            list.push(scoreboardKw);
            keywordsByPath.set(targetClean, list);
         } else {
            // No analytics page matched: surface it so nothing is silently dropped.
            keywordsWithNoMatchingPage.push({ ...scoreboardKw, target_page: targetPage });
         }
      });

      // 5. Build the per-page scoreboard for pages that have at least one matched keyword.
      const scoreboard: ScoreboardPage[] = [];
      const pagesWithTrafficNoKeywords: ContentGapPage[] = [];

      trafficPages.forEach((page) => {
         const matched = keywordsByPath.get(page.pathClean) || [];
         const aiReferralVisitors = aiVisitorsByLanding.get(page.pathClean) || 0;
         const conv = conversionFieldsFor(page.pathClean);
         if (matched.length > 0) {
            scoreboard.push({
               url: page.url,
               pathClean: page.pathClean,
               page_title: page.page_title,
               page_views: page.page_views,
               unique_visitors: page.unique_visitors,
               bounce_rate: page.bounce_rate,
               avg_duration: page.avg_duration,
               metricsNote: page.metricsNote,
               aiReferralVisitors,
               keywords: matched,
               ...conv,
            });
         } else {
            // Content-gap signal: this page gets traffic but has no tracked keyword.
            pagesWithTrafficNoKeywords.push({
               url: page.url,
               pathClean: page.pathClean,
               page_title: page.page_title,
               page_views: page.page_views,
               unique_visitors: page.unique_visitors,
               bounce_rate: page.bounce_rate,
               avg_duration: page.avg_duration,
               metricsNote: page.metricsNote,
               aiReferralVisitors,
               ...conv,
            });
         }
      });

      // Sort by page_views desc.
      scoreboard.sort((a, b) => b.page_views - a.page_views);
      pagesWithTrafficNoKeywords.sort((a, b) => b.page_views - a.page_views);

      return res.status(200).json({
         domain,
         period,
         goal: goalMeta,
         scoreboard,
         pagesWithTrafficNoKeywords,
         keywordsWithNoMatchingPage,
         analyticsError,
         referralError,
         aiReferralNote,
         conversionsNote,
      });
   } catch (error) {
      console.log('[ERROR] Building Scoreboard for ', domain, error);
      return res.status(400).json({ error: 'Error Building Scoreboard for this Domain.' });
   }
};
