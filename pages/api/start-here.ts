/*
 * ============================================================================
 * s33k START HERE ROUTE: the explicit guided entry point.
 * ============================================================================
 * GET /api/start-here?domain=&period=
 *
 * The first call a user should make when they connect their LLM to s33k and do
 * not know what to ask. It answers, in priority order:
 *   1. WHICH domain? (no domain + one tracked -> use it; many -> pick one; none -> add one)
 *   2. What is the SETUP state? (incomplete -> the next step and STOP, do not dump analytics)
 *   3. The single MOST IMPORTANT thing to do now (the dashboard top action)
 *   4. Where to look next (a SHORT curated list that always surfaces entry_pages,
 *      the "which pages did AI search land on" view).
 *
 * Reuses, never re-implements: the dashboard composer (utils/dashboard.ts) for the
 * headline + top action, and the same five setup counts onboarding-status.ts uses,
 * shaped by the pure utils/start-here.ts. This route is the thin loader + auth +
 * ownership gate; ALL shaping lives in the pure utils.
 *
 * RULES-BASED: no LLM call. Robust like briefing/dashboard: each provider pillar is
 * wrapped so a rejection degrades to a safe empty value instead of 500ing. The only
 * 4xx paths are auth (401) and wrong method (405). A missing/ambiguous/unowned domain
 * is answered as a structured 200 mode (pick-domain / no-domain / not-owned setup),
 * never an error, because "I do not know what to ask" must never hit a wall.
 * ============================================================================
 */

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
   buildDashboard, deriveDashboardState, DashboardGoal, DashboardKeyword,
} from '../../utils/dashboard';
import { selectSuggestedQuestions } from '../../utils/suggested-questions';
import { getInstallGuides } from '../../utils/install-guides';
import { findStrikingDistance, StrikingInput } from '../../utils/striking-distance';
import {
   computeSetupState, computeModules, buildOnboarding, buildReady, InstallPayload, ReportTeasers,
   analyticsTeaser, seoTeaser, aeoTeaser, TEASER_UNAVAILABLE,
   OnboardingResult, ReadyResult, ModuleStatus,
} from '../../utils/start-here';
import { isSeoConfigured } from '../../utils/setupState';

type StartHereResponse =
   | { mode: 'no-domain', message: string, error?: string | null }
   | { mode: 'pick-domain', domains: string[], message: string, error?: string | null }
   | (OnboardingResult & { modules?: ModuleStatus[], error?: string | null })
   | (ReadyResult & { modules?: ModuleStatus[], error?: string | null })
   | { error: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<StartHereResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error: error || 'Not authorized' }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getStartHere(req, res, account);
}

const getStartHere = async (req: NextApiRequest, res: NextApiResponse<StartHereResponse>, account?: Account | null) => {
   const requested = typeof req.query.domain === 'string' ? req.query.domain.trim() : '';
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // ---- Step 1: resolve WHICH domain to start on. --------------------------
      let domain = requested;
      if (!domain) {
         // No domain given: list the caller's own (scoped) domains and decide.
         const rows = await Domain.findAll({ where: { ...scopeWhere(account) } }).catch(() => [] as Domain[]);
         const names = (rows as Domain[])
            .map((d) => String((d.get({ plain: true }) as { domain?: string }).domain || ''))
            .filter(Boolean);
         if (names.length === 0) {
            return res.status(200).json({
               mode: 'no-domain' as const,
               message: 'You are not tracking any sites yet. Add a domain first (ask "start tracking <yourdomain.com>", '
                  + 'the onboard tool), then call start_here again.',
               error: null,
            });
         }
         if (names.length > 1) {
            return res.status(200).json({
               mode: 'pick-domain' as const,
               domains: names,
               message: `You track ${names.length} domains. Call start_here again with one of these.`,
               error: null,
            });
         }
         [domain] = names;
      }

      // ---- Ownership gate (same as every analytics route). --------------------
      // resolveDomainAccess returns the row only when the caller may read it; null = deny.
      // We answer a not-owned domain as a setup-style 200 (not a 403), because start_here is the
      // "I do not know what to ask" entry point and must always return a usable next move.
      const owned = await resolveDomainAccess(account, domain);

      // ---- Step 2: setup state. Reuse the same five counts onboarding-status reads. ----
      const scope = scopeWhere(account);
      const weekAgo = new Date(Date.now() - 7 * 86400e3).toJSON();
      const [keywordCount, recentEvents, goalCount] = await Promise.all([
         owned ? Keyword.count({ where: { domain, ...scope } }).catch(() => 0) : Promise.resolve(0),
         owned ? S33kEvent.count({ where: { domain, created: { [Op.gte]: weekAgo }, ...scope } }).catch(() => 0) : Promise.resolve(0),
         owned ? Goal.count({ where: { domain, ...scope } }).catch(() => 0) : Promise.resolve(0),
      ]);

      // MODULAR PILLARS: SEO is an optional module, enabled iff a SERP scraper key is configured.
      // With SEO off, computeSetupState omits the keywords step, so a keyless instance with
      // flowing analytics is COMPLETE (healthy with one module off), and ready mode below labels
      // the SEO report "not enabled" with the mint_key_drop enablement path instead of "0
      // keywords". Fail OPEN to the legacy shape on a settings-read error.
      const seoEnabled = await isSeoConfigured().catch(() => true);

      const setup = computeSetupState({
         owned: Boolean(owned), keywordCount, recentEvents, goalCount, domain, seoEnabled,
      });
      const modules = computeModules({ recentEvents, seoEnabled, keywordCount });

      // Incomplete setup (including a not-owned/not-added domain): walk the user through INSTALL and
      // preview what each report UNLOCKS, then STOP. Dumping analytics on a half-set-up site is the
      // overwhelm start_here exists to avoid; but "here is how you put s33k on your site" belongs
      // inline, because installing the tracking script is the gating step for the analytics pillar.
      if (!setup.complete) {
         // The first-party beacon keys every event by domain, so once the caller has ADDED the
         // domain, the domain itself is the site id and we can emit the ready-to-paste snippet. When
         // the domain has not been added yet (not owned), we emit NO copyable snippet: the note tells
         // the user to run onboard first, and the renderer skips the paste line when the snippet is
         // empty. start_here still never walls (it returns the onboarding 200); it just refuses to
         // hand out a snippet before the site exists.
         const install: InstallPayload = owned
            ? (() => {
               const guides = getInstallGuides(domain, domain);
               return {
                  snippet: guides.snippet,
                  scriptUrl: guides.scriptUrl,
                  websiteId: guides.websiteId,
                  platforms: guides.platforms.map((p) => ({ platform: p.platform, steps: p.steps })),
                  note: 'Paste this one line into your site head. It is the gating step for the Analytics and AI-search '
                     + 'pillars. Ask install_instructions for steps on any specific platform.',
               };
            })()
            : {
               snippet: '',
               scriptUrl: '',
               websiteId: '',
               platforms: [],
               note: 'Add your site first (run onboard). s33k will then hand you the ready-to-paste beacon snippet, and a '
                  + 'later start_here (or install_instructions) will show it with your domain.',
            };
         const onboarding = buildOnboarding(domain, setup, install);
         return res.status(200).json({ ...onboarding, modules, error: null });
      }

      // ---- Step 3 + 4: ready. Compose the dashboard for the headline + top action. ----
      // Reuse buildDashboard rather than re-deriving any analytics. Each provider pillar is wrapped
      // so a rejection degrades to a safe empty value (never a 500), exactly like dashboard.ts.
      const provider = getAnalyticsProvider();
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const [keywordRows, eventRows, webVitalRows, goalRows, traffic, referrals, summary] = await Promise.all([
         Keyword.findAll({ where: { domain, ...scope } }).catch(() => [] as Keyword[]),
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scope },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }).catch(() => [] as S33kEvent[]),
         S33kEvent.findAll({
            where: { domain, type: 'webvital', is_bot: false, created: { [Op.gte]: startISO }, ...scope },
            raw: true,
         }).catch(() => [] as unknown as WebVitalRow[]),
         Goal.findAll({ where: { domain, ...scope } }).catch(() => [] as Goal[]),
         provider.getPageTraffic(domain, period).catch((e) => ({ pages: [], error: String(e) })),
         provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
         provider.getSummary(domain, period).catch((e) => ({
            pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: String(e),
         })),
      ]);

      const keywords: DashboardKeyword[] = parseKeywords(
         (keywordRows as Keyword[]).map((k) => k.get({ plain: true })),
      ).map((k) => ({
         keyword: k.keyword, position: k.position, url: k.url, target_page: k.target_page, history: k.history,
      }));
      // RANK-PENDING signal: a freshly-tracked keyword is created updating:true and stays so until its
      // first Google check lands. parseKeywords drops the column, so read `updating` off the raw rows
      // here. Any pending keyword means the SEO teaser must say "first check running", never "0 on
      // page one" (a rank-pending keyword is being checked, not absent from the top 100).
      const anyRankPending = (keywordRows as Keyword[]).some((k) => {
         const p = k.get({ plain: true }) as { updating?: boolean };
         return Boolean(p.updating);
      });
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

      // ---- The 3 LIVE report teasers, computed in parallel, each degrading on its own. ----
      // The brief: show the 3 prebuilt reports WITH THE USER'S OWN NUMBERS. We already loaded
      // everything each teaser needs above (keywords for SEO, referralSources/summary for analytics
      // and AEO), so we compute from those rather than re-querying. Promise.allSettled means one
      // teaser throwing degrades ONLY itself to TEASER_UNAVAILABLE; the others and the whole response
      // never 500. The teaser composers are pure, so a rejection here would only come from a bad
      // input shape, but we still isolate each per the brief's never-500 guarantee.
      const [analyticsT, seoT, aeoT] = await Promise.allSettled([
         // Analytics teaser: total visitors (summary, or human sessions) + the biggest referral source.
         (async () => {
            const visitors = summaryData.error ? dashboard.headline.humanVisitors : (summaryData.visitors || 0);
            // The single biggest specific referral source (skip the direct/blank bucket so it is a
            // real "where did they come from" line). referralSources is already error-stripped.
            const named = referralSources
               .filter((s) => {
                  const n = String(s.name || '').trim().toLowerCase();
                  return n && n !== 'direct' && n !== '(direct)' && n !== '(none)' && n !== 'none';
               })
               .map((s) => ({ name: s.name, visitors: Number(s.unique_visitors ?? 0) }))
               .sort((a, b) => b.visitors - a.visitors);
            const top = named[0] || null;
            return analyticsTeaser({
               visitors,
               period,
               topSourceName: top ? top.name : null,
               topSourceVisitors: top ? top.visitors : 0,
            });
         })(),
         // SEO teaser: tracked count + on-page-one + striking-distance count, reusing the shared
         // util. When the SEO module is OFF, the teaser is the enablement path instead: "0
         // keywords tracked" would read as a failure, but a keyless instance is the designed-for
         // analytics-first path with one optional module off.
         (async () => {
            if (!seoEnabled) {
               return 'SEO module not enabled (optional). Ask me to enable SEO and I will mint a key-drop command '
                  + '(mint_key_drop); your Serper key never passes through this chat.';
            }
            const onPageOne = keywords.filter((k) => {
               const pos = Number(k.position) || 0;
               return pos > 0 && pos <= 10;
            }).length;
            const strikingInput: StrikingInput[] = keywords.map((k) => ({
               keyword: k.keyword,
               position: Number(k.position) || 0,
               url: String(k.url || ''),
               history: typeof k.history === 'string' ? k.history : JSON.stringify(k.history || {}),
            }));
            const striking = findStrikingDistance(strikingInput, 4, 30);
            return seoTeaser({
               keywordsTracked: keywords.length, onPageOne, strikingDistance: striking.length, rankPending: anyRankPending,
            });
         })(),
         // AEO teaser: AI visitors + AI share of referred traffic + top engine, from the dashboard's
         // already-computed AI-engine split and the referral totals.
         (async () => {
            const aiVisitors = dashboard.aiReferrals.data.totalAiVisitors;
            const allVisitors = referralSources.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
            const aiSharePct = allVisitors > 0 ? Math.round((aiVisitors / allVisitors) * 1000) / 10 : 0;
            const topEngineRow = dashboard.aiReferrals.data.byEngine[0] || null;
            return aeoTeaser({
               aiVisitors,
               aiSharePct,
               topEngine: topEngineRow ? topEngineRow.engine : null,
               topEngineVisitors: topEngineRow ? topEngineRow.visitors : 0,
            });
         })(),
      ]);

      const teasers: ReportTeasers = {
         analytics: analyticsT.status === 'fulfilled' ? analyticsT.value : TEASER_UNAVAILABLE,
         seo: seoT.status === 'fulfilled' ? seoT.value : TEASER_UNAVAILABLE,
         aeo: aeoT.status === 'fulfilled' ? aeoT.value : TEASER_UNAVAILABLE,
      };

      // Fold the dashboard's CONTEXTUAL suggested questions into the fixed ask-list (deduped in
      // buildReady), so the questions a user sees match what their actual data supports.
      const extraQuestions = selectSuggestedQuestions(deriveDashboardState(dashboard)).map((q) => q.question);

      const ready = buildReady({
         domain,
         period,
         humanVisitors: dashboard.headline.humanVisitors,
         aiReferredVisitors: dashboard.headline.aiReferredVisitors,
         topAction: dashboard.headline.topAction,
         teasers,
         extraQuestions,
         // GATHERING-state signals: a rank check still running, plus whether any conversion goal exists,
         // so the headline can lead with momentum and whatYouCanSee only promises conversion reporting
         // once a goal is defined. recentEvents already gated us into ready mode, so traffic is flowing.
         rankPending: anyRankPending,
         goalCount,
      });
      return res.status(200).json({ ...ready, modules, error: null });
   } catch (error) {
      // Last-resort guard. The per-pillar catches mean we should never get here; if we do, still
      // return a usable ready payload (curated reports/see/ask, teasers degraded) rather than a 500,
      // honoring "never wall". buildReady gives the full ready shape with the unavailable fallbacks.
      console.log('[ERROR] Building start-here for ', requested || '(no domain)', error);
      const fallback = buildReady({
         domain: requested,
         period,
         humanVisitors: 0,
         aiReferredVisitors: 0,
         topAction: 'Ask dashboard for the full overview, or retry shortly.',
         teasers: { analytics: TEASER_UNAVAILABLE, seo: TEASER_UNAVAILABLE, aeo: TEASER_UNAVAILABLE },
      });
      return res.status(200).json({ ...fallback, error: 'Error Building Start Here for this Domain.' });
   }
};
