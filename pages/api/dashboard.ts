import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import Goal from '../../database/models/goal';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike } from '../../utils/sessionize';
import {
   getAnalyticsProvider, NormalizedPage, ReferralSource, SummaryResult,
} from '../../utils/analytics';
import type { WebVitalRow } from '../../utils/web-vitals';
import {
   buildDashboard, deriveDashboardState, Dashboard, DashboardGoal, DashboardKeyword,
} from '../../utils/dashboard';
import { selectSuggestedQuestions, SuggestedQuestion } from '../../utils/suggested-questions';
import { renderDashboard } from '../../utils/dashboard-render';

/*
 * ============================================================================
 * s33k DASHBOARD ROUTE: the default "show me an overview" experience.
 * ============================================================================
 * GET /api/dashboard?domain=&period=
 *
 * This is the HEADLINE entry point. It loads every pillar once (SEO keywords,
 * first-party sessions, web-vital samples, goals, and the analytics provider's
 * summary/traffic/referrals), composes them into ONE compact overview via the
 * pure buildDashboard, selects a CONTEXTUAL set of suggested questions, and
 * renders a monospace ASCII view. The user's own LLM can show either the rich
 * structured `dashboard` or the raw `rendered` block.
 *
 * RULES-BASED: this route does NOT call any LLM. All composition is transparent
 * rules over the caller's OWN tenant-scoped data (utils/dashboard.ts).
 *
 * Robustness: like briefing, each provider pillar is wrapped so a rejection
 * degrades to an honest per-section note instead of 500ing the whole overview.
 * The only 4xx paths are auth (401), wrong method (405), missing domain (400),
 * and an unowned domain (403).
 * ============================================================================
 */

type DashboardApiResponse = {
   domain?: string,
   period?: string,
   dashboard?: Dashboard,
   suggestedQuestions?: SuggestedQuestion[],
   rendered?: string,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<DashboardApiResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error: error || 'Not authorized' }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getDashboard(req, res, account);
}

const getDashboard = async (req: NextApiRequest, res: NextApiResponse<DashboardApiResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // Ownership gate first. With MULTI_TENANT off, scopeWhere returns {} so this is an existence
   // check; with it on, a tenant can only see a domain they own. The domain column is globally
   // unique, so everything below (all keyed by the domain string) is gated behind this one check.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const provider = getAnalyticsProvider();
      // periodStartMs clamps the lookback at 365 days (the shared DoS bound), so a hostile period=
      // cannot pull the whole event table into memory. Used for both the session and web-vital reads.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();

      // Pull every pillar in parallel. Each provider promise is wrapped so a rejection becomes a
      // recoverable value, never an unhandled throw that 500s the overview. The DB reads get
      // explicit catches to a safe empty result for the same reason.
      const [
         keywordRows, eventRows, webVitalRows, goalRows, traffic, referrals, summary,
      ] = await Promise.all([
         Keyword.findAll({ where: { domain, ...scopeWhere(account) } }).catch(() => [] as Keyword[]),
         // Sessions: all events in the window (human + bot, so the composer can split human vs bot).
         // 'id' is selected so sessionize's deterministic tiebreaker works on Postgres.
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }).catch(() => [] as S33kEvent[]),
         // Web-vital samples (human-only, matching the web_vitals report) for the speed pillar.
         S33kEvent.findAll({
            where: { domain, type: 'webvital', is_bot: false, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            raw: true,
         }).catch(() => [] as unknown as WebVitalRow[]),
         Goal.findAll({ where: { domain, ...scopeWhere(account) } }).catch(() => [] as Goal[]),
         provider.getPageTraffic(domain, period).catch((e) => ({ pages: [], error: String(e) })),
         provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
         provider.getSummary(domain, period).catch((e) => ({
            pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: String(e),
         })),
      ]);

      // Normalize the loaded rows into the pure composer's input shapes.
      const keywords: DashboardKeyword[] = parseKeywords(
         (keywordRows as Keyword[]).map((k) => k.get({ plain: true })),
      ).map((k) => ({
         keyword: k.keyword,
         position: k.position,
         url: k.url,
         target_page: k.target_page,
         history: k.history,
      }));

      const sessions = sessionize((eventRows as S33kEvent[]).map((r) => r.get({ plain: true }) as EventLike));

      const goals: DashboardGoal[] = (goalRows as Goal[]).map((g) => {
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

      const trafficPages: NormalizedPage[] = (traffic as { pages: NormalizedPage[] }).pages || [];
      const referralSources: ReferralSource[] = (referrals as { sources: ReferralSource[] }).sources || [];
      const summaryData = summary as SummaryResult;

      const dashboard = buildDashboard({
         domain,
         period,
         keywords,
         sessions,
         summary: summaryData.error ? null : summaryData,
         trafficPages,
         referralSources,
         webVitalRows: webVitalRows as unknown as WebVitalRow[],
         goals,
         errors: {
            summary: summaryData.error,
            traffic: (traffic as { error?: string | null }).error,
            referrals: (referrals as { error?: string | null }).error,
         },
      });

      const suggestedQuestions = selectSuggestedQuestions(deriveDashboardState(dashboard));
      const rendered = renderDashboard(dashboard, suggestedQuestions);

      const note = 'This is your s33k overview: the key numbers across SEO, AI search, and analytics in one view. '
         + 'Say "show me my dashboard" anytime to see it again. You do not have to know what to ask: pick any of the '
         + 'suggestedQuestions below and your AI will run it for you.';

      return res.status(200).json({
         domain, period, dashboard, suggestedQuestions, rendered, note, error: null,
      });
   } catch (error) {
      // Last-resort guard. The per-pillar catches mean we should never get here; if a join itself
      // throws we still return a usable (empty) overview rather than a 500.
      console.log('[ERROR] Building Dashboard for ', domain, error);
      const empty = buildDashboard({
         domain,
         period,
         keywords: [],
         sessions: [],
         summary: null,
         trafficPages: [],
         referralSources: [],
         webVitalRows: [],
         goals: [],
      });
      const questions = selectSuggestedQuestions(deriveDashboardState(empty));
      return res.status(200).json({
         domain,
         period,
         dashboard: empty,
         suggestedQuestions: questions,
         rendered: renderDashboard(empty, questions),
         note: 'Could not load full data for this domain this period; showing a starter overview. Retry shortly.',
         error: 'Error Building Dashboard for this Domain.',
      });
   }
};
