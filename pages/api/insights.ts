import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { cleanPath } from '../../utils/clean-path';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike } from '../../utils/sessionize';
import {
   getAnalyticsProvider,
   NormalizedPage,
   ReferralSource,
   SummaryResult,
} from '../../utils/analytics';
import { estimateHumanTraffic } from '../../utils/bot-filter';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. ANALYSIS RUNS IN THE USER'S OWN LLM.
 * ============================================================================
 * s33k NEVER sends customer data to a model trainer and has NO model-training
 * pipeline anywhere in the codebase. This route does NOT call any LLM, does NOT
 * embed, fine-tune, or transmit account data to any external model. It joins
 * the caller's OWN tenant-scoped pillars with transparent, commented rules and
 * returns structured findings; the narration happens in the USER's own LLM over
 * MCP, which s33k only hands structured data. Stored credentials are encrypted
 * at rest with cryptr + the app SECRET. Full trust documentation: SECURITY.md
 * (and the security_facts MCP tool).
 * ============================================================================
 */

/**
 * Cross-pillar insights: the "analyst, not dashboard" capability.
 *
 * This route is RULES-BASED. It does NOT call any LLM. It joins the three s33k
 * pillars (SEO rank + analytics traffic + AI referrals + engagement) into a
 * single set of structured findings and recommendations that the USER's LLM
 * then interprets and narrates. The server's job is to do the joins and surface
 * the signals dashboards bury; the interpretation lives in the caller's model.
 *
 * Every finding carries:
 *   type      A stable machine-readable category.
 *   severity  'high' | 'medium' | 'low' | 'info' (rough triage weight).
 *   message   A plain-English statement of the signal.
 *   evidence  The structured data behind the message (so the LLM can cite it).
 *
 * Every rule below is small, transparent, and commented so the thresholds are
 * auditable. Nothing here throws: provider errors are collected and returned in
 * a `notes` array, and findings degrade gracefully on missing data.
 */

type Severity = 'high' | 'medium' | 'low' | 'info';

type Finding = {
   type: string,
   severity: Severity,
   message: string,
   evidence: unknown,
};

type InsightsResponse = {
   domain?: string,
   period?: string,
   findings?: Finding[],
   recommendations?: string[],
   // Non-fatal provider/data notes (e.g. a breakdown a provider does not support).
   notes?: string[],
   error?: string | null,
}

// --- Tunable rule thresholds (kept together so they are easy to audit). -------

// A page is "high traffic" relative to the site when it clears this share of
// total pageviews. Used for the traffic-without-rank opportunity rule.
const HIGH_TRAFFIC_SHARE = 0.05; // 5% of site pageviews
// A page counts as having "real traffic" at all once it clears this floor.
// Kept modest so the opportunity rules also fire on smaller/low-volume sites,
// where a 10-pageview page is still a meaningful, optimizable entry point.
const MIN_REAL_PAGEVIEWS = 10;
// A keyword ranks "well" at or above this Google position (1 = top).
const GOOD_RANK_MAX = 10;
// A page is a traffic "concentration" risk when one page is this share of all.
const CONCENTRATION_SHARE = 0.5; // 50% of site pageviews on a single page
// Bot share above this is worth a loud caveat on every other number.
const BOT_SHARE_WARN = 30; // percent

export default async function handler(req: NextApiRequest, res: NextApiResponse<InsightsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getInsights(req, res, account);
}

const getInsights = async (req: NextApiRequest, res: NextApiResponse<InsightsResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // Verify the caller owns this domain before exposing any of its data. With
      // MULTI_TENANT off, scopeWhere is {} so this matches any existing domain row.
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      const provider = getAnalyticsProvider();

      // Fetch + sessionize first-party events so estimateHumanTraffic returns the
      // authoritative is_bot split (the source IP classified datacenter-or-not at
      // ingest), giving the same human number as human_traffic, human_analytics,
      // start_here, and the dashboard. Without these sessions it hits the honest
      // degraded path (estVisitors 0) and the bot finding below would be suppressed
      // or, worse, falsely read 0 bots. Tenant-scoped + gated AFTER resolveDomainAccess.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const eventRows = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      });
      const firstPartySessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike));

      // Pull every pillar in parallel. None of these throw; each carries its own
      // error field, which we collect into `notes` instead of failing the route.
      const [allKeywordRows, traffic, referrals, summary, botEstimate] = await Promise.all([
         Keyword.findAll({ where: { domain, ...scopeWhere(account) } }),
         provider.getPageTraffic(domain, period),
         provider.getReferralSources(domain, period),
         provider.getSummary(domain, period),
         estimateHumanTraffic(provider, domain, period, firstPartySessions),
      ]);

      const keywords: KeywordType[] = parseKeywords(allKeywordRows.map((e) => e.get({ plain: true })));
      const trafficPages: NormalizedPage[] = traffic.pages || [];
      const sources: ReferralSource[] = referrals.sources || [];
      const summaryData: SummaryResult = summary;

      const notes: string[] = [];
      [traffic.error, referrals.error, summary.error, botEstimate.error]
         .filter(Boolean)
         .forEach((e) => notes.push(e as string));

      const findings: Finding[] = [];
      const recommendations: string[] = [];

      // Aggregate page rows by clean path FIRST. Analytics providers can return
      // several raw rows that all normalize to the same page (e.g. "/",
      // "/?utm_medium=redirect", "/?utm_medium=post_link" all clean to "/").
      // Summing them here gives the page its true total and avoids picking an
      // arbitrary low-traffic query-string variant when looking a page up.
      const aggByPath = new Map<string, NormalizedPage>();
      trafficPages.forEach((p) => {
         const existing = aggByPath.get(p.pathClean);
         if (!existing) {
            aggByPath.set(p.pathClean, {
               url: p.url,
               pathClean: p.pathClean,
               page_views: p.page_views || 0,
               page_title: p.page_title,
               unique_visitors: p.unique_visitors,
               bounce_rate: p.bounce_rate,
               avg_duration: p.avg_duration,
            });
            return;
         }
         existing.page_views += (p.page_views || 0);
         if (typeof p.unique_visitors === 'number') {
            existing.unique_visitors = (existing.unique_visitors || 0) + p.unique_visitors;
         }
         // Prefer the canonical (shortest) url for the aggregated page.
         if (p.url && (!existing.url || p.url.length < existing.url.length)) {
            existing.url = p.url;
         }
      });
      const aggregatedPages = Array.from(aggByPath.values());

      // Lookups shared across rules, all over the aggregated pages.
      const totalPageviews = aggregatedPages.reduce((sum, p) => sum + (p.page_views || 0), 0);
      const pageByPath = aggByPath;

      // Group tracked keywords by the page they target. A keyword "covers" a
      // page when its normalized target_page equals the page's clean path.
      const keywordsByPath = new Map<string, KeywordType[]>();
      keywords.forEach((kw) => {
         const targetClean = cleanPath(kw.target_page || '');
         if (!targetClean) { return; }
         const list = keywordsByPath.get(targetClean) || [];
         list.push(kw);
         keywordsByPath.set(targetClean, list);
      });

      // ---------------------------------------------------------------------
      // RULE 1. Opportunity: pages with real traffic but poor or no rank.
      // A page already pulls meaningful traffic, yet either has no tracked
      // keyword at all, or its best tracked keyword ranks worse than position
      // GOOD_RANK_MAX. That page is already proven to matter; ranking it would
      // compound. This is the highest-leverage SEO move s33k can surface.
      // ---------------------------------------------------------------------
      aggregatedPages.forEach((page) => {
         const views = page.page_views || 0;
         const share = totalPageviews > 0 ? views / totalPageviews : 0;
         const isHighTraffic = views >= MIN_REAL_PAGEVIEWS && share >= HIGH_TRAFFIC_SHARE;
         if (!isHighTraffic) { return; }

         const covering = keywordsByPath.get(page.pathClean) || [];
         // Best (lowest, > 0) ranking position among covering keywords.
         const ranked = covering
            .map((k) => k.position)
            .filter((p) => typeof p === 'number' && p > 0);
         const bestRank = ranked.length ? Math.min(...ranked) : null;

         if (covering.length === 0) {
            const msg = `${page.pathClean} pulls real traffic (${views} pageviews, `
               + `${(share * 100).toFixed(1)}% of the site) but has no tracked keyword. `
               + 'It is proven to matter and is invisible to your rank tracking.';
            findings.push({
               type: 'traffic_no_keyword',
               severity: 'high',
               message: msg,
               evidence: {
                  page: page.pathClean,
                  url: page.url,
                  page_title: page.page_title,
                  page_views: views,
                  share_pct: Math.round(share * 1000) / 10,
                  tracked_keywords: 0,
               },
            });
         } else if (bestRank !== null && bestRank > GOOD_RANK_MAX) {
            const msg = `${page.pathClean} pulls real traffic (${views} pageviews) but its `
               + `best tracked keyword only ranks #${bestRank}. Pushing it onto page one `
               + 'would compound traffic it already earns elsewhere.';
            findings.push({
               type: 'traffic_poor_rank',
               severity: 'high',
               message: msg,
               evidence: {
                  page: page.pathClean,
                  url: page.url,
                  page_views: views,
                  best_rank: bestRank,
                  keywords: covering.map((k) => ({ keyword: k.keyword, position: k.position })),
               },
            });
         }
      });

      // ---------------------------------------------------------------------
      // RULE 2. Mismatch: keywords ranking well but their page gets low traffic.
      // The keyword ranks at or above GOOD_RANK_MAX, but the page it targets
      // has little or no measured traffic. Either the keyword has no real search
      // demand, or the listing/title is not earning the click. Worth a look.
      // ---------------------------------------------------------------------
      keywords.forEach((kw) => {
         const rank = kw.position;
         if (!(typeof rank === 'number' && rank > 0 && rank <= GOOD_RANK_MAX)) { return; }
         const targetClean = cleanPath(kw.target_page || '');
         if (!targetClean) { return; }
         const page = pageByPath.get(targetClean);
         const views = page ? (page.page_views || 0) : 0;
         if (views < MIN_REAL_PAGEVIEWS) {
            const msg = `"${kw.keyword}" ranks #${rank} for ${targetClean}, but that page `
               + `only has ${views} pageviews this period. The ranking is not converting `
               + 'into traffic: check search demand for the term, or whether the '
               + 'title/snippet earns the click.';
            findings.push({
               type: 'rank_low_traffic',
               severity: 'medium',
               message: msg,
               evidence: {
                  keyword: kw.keyword,
                  position: rank,
                  target_page: targetClean,
                  page_views: views,
               },
            });
         }
      });

      // ---------------------------------------------------------------------
      // RULE 3. AI referrals: pages/engines receiving AI answer-engine traffic.
      // Real visitors arriving from ChatGPT, Claude, Perplexity, etc. is the
      // proof that AEO is working. Surface which engines send visitors and the
      // AI share of referred traffic. Low/zero AI share on a content site is
      // itself a (low-severity) signal worth flagging.
      // ---------------------------------------------------------------------
      const aiSources = sources.filter((s) => s.isAI);
      const visitorsOf = (s: ReferralSource): number => Number(s.unique_visitors ?? 0);
      const aiVisitors = aiSources.reduce((sum, s) => sum + visitorsOf(s), 0);
      const allReferredVisitors = sources.reduce((sum, s) => sum + visitorsOf(s), 0);
      const aiSharePct = allReferredVisitors > 0
         ? Math.round((aiVisitors / allReferredVisitors) * 1000) / 10
         : 0;

      if (aiSources.length > 0 && aiVisitors > 0) {
         // Aggregate by normalized engine label for a clean per-engine view.
         const engineMap = new Map<string, number>();
         aiSources.forEach((s) => {
            const engine = s.engine || s.name || 'Unknown AI';
            engineMap.set(engine, (engineMap.get(engine) || 0) + visitorsOf(s));
         });
         const byEngine = Array.from(engineMap.entries())
            .map(([engine, visitors]) => ({ engine, visitors }))
            .sort((a, b) => b.visitors - a.visitors);
         const engineLabel = byEngine.map((e) => `${e.engine} (${e.visitors})`).join(', ');
         const msg = `AI answer engines are already sending real visitors: ${aiVisitors} `
            + `AI referred visitors (${aiSharePct}% of all referred traffic), led by `
            + `${engineLabel}. This is direct evidence AEO is paying off.`;
         findings.push({
            type: 'ai_referral_traffic',
            severity: 'info',
            message: msg,
            evidence: { aiVisitors, aiSharePct, byEngine },
         });
      } else {
         const msg = 'No measurable visitor traffic from AI answer engines (ChatGPT, Claude, '
            + 'Perplexity, etc.) this period. Either AI engines are not yet citing the site, '
            + 'or they cite without sending clicks. Make key pages answer-ready to win citations.';
         findings.push({
            type: 'no_ai_referral_traffic',
            severity: 'low',
            message: msg,
            evidence: { aiVisitors: 0, referredVisitorSources: sources.length },
         });
      }

      // ---------------------------------------------------------------------
      // RULE 4. Concentration: one page is most of the traffic.
      // A single page carrying >= CONCENTRATION_SHARE of all pageviews is a
      // resilience risk: one ranking change or one stale page can swing the
      // whole site. Worth naming so the team diversifies entry points.
      // ---------------------------------------------------------------------
      if (totalPageviews > 0 && aggregatedPages.length > 0) {
         const top = [...aggregatedPages].sort((a, b) => (b.page_views || 0) - (a.page_views || 0))[0];
         const topShare = (top.page_views || 0) / totalPageviews;
         if (topShare >= CONCENTRATION_SHARE) {
            const msg = `${top.pathClean} alone is ${(topShare * 100).toFixed(1)}% of all `
               + `pageviews (${top.page_views} of ${totalPageviews}). Traffic is concentrated `
               + 'on one page; a single ranking or content change there can swing the whole site.';
            findings.push({
               type: 'traffic_concentration',
               severity: 'medium',
               message: msg,
               evidence: {
                  page: top.pathClean,
                  url: top.url,
                  page_views: top.page_views,
                  share_pct: Math.round(topShare * 1000) / 10,
                  total_pageviews: totalPageviews,
               },
            });
         }
      }

      // ---------------------------------------------------------------------
      // RULE 5. Bot caveat: estimated automated traffic is high.
      // Most analytics overcount JS-executing scrapers. If the bounce/duration
      // heuristic estimates a large bot share, EVERY other number in this report
      // (and the dashboard) is inflated. This is the "signals dashboards do not
      // capture" caveat the analyst must say out loud.
      // ---------------------------------------------------------------------
      if (botEstimate.botSharePct >= BOT_SHARE_WARN && botEstimate.estVisitors > 0) {
         const msg = `An estimated ${botEstimate.botSharePct}% of visitors `
            + `(~${botEstimate.estBotVisitors} of ${botEstimate.estVisitors}) look like bots, `
            + 'not humans (near-100% bounce, near-zero time on page). Treat raw visitor and '
            + 'pageview totals as inflated; the human figures are the ones to plan against.';
         findings.push({
            type: 'bot_traffic_caveat',
            severity: 'high',
            message: msg,
            evidence: {
               estVisitors: botEstimate.estVisitors,
               estHumanVisitors: botEstimate.estHumanVisitors,
               estBotVisitors: botEstimate.estBotVisitors,
               botSharePct: botEstimate.botSharePct,
               method: botEstimate.method,
            },
         });
      } else if (botEstimate.estVisitors > 0) {
         const msg = `Estimated bot share is ${botEstimate.botSharePct}% `
            + `(~${botEstimate.estHumanVisitors} of ${botEstimate.estVisitors} visitors look `
            + 'human). Raw totals are broadly trustworthy this period.';
         findings.push({
            type: 'bot_traffic_ok',
            severity: 'info',
            message: msg,
            evidence: {
               estVisitors: botEstimate.estVisitors,
               estHumanVisitors: botEstimate.estHumanVisitors,
               botSharePct: botEstimate.botSharePct,
            },
         });
      }

      // ---------------------------------------------------------------------
      // Recommendations: derived from the findings above, in priority order.
      // These are concrete next actions, not restatements. The user's LLM may
      // expand or reprioritize them, but they stand on their own.
      // ---------------------------------------------------------------------
      const has = (type: string): boolean => findings.some((f) => f.type === type);

      if (has('bot_traffic_caveat')) {
         recommendations.push(
            'Read every traffic number in this report against the human estimate, not the raw '
            + 'total. A large share of measured visitors appears to be bots.',
         );
      }
      if (has('traffic_no_keyword')) {
         recommendations.push(
            'Add tracked keywords for the high-traffic pages that have none, so their rankings '
            + 'stop being invisible and can be optimized.',
         );
      }
      if (has('traffic_poor_rank')) {
         recommendations.push(
            'Prioritize on-page SEO for high-traffic pages whose best keyword ranks outside the '
            + 'top 10. They already earn traffic; page-one rank would compound it.',
         );
      }
      if (has('rank_low_traffic')) {
         recommendations.push(
            'For keywords ranking top-10 on low-traffic pages, recheck real search demand and '
            + 'rewrite the title/meta to earn the click.',
         );
      }
      if (has('ai_referral_traffic')) {
         recommendations.push(
            'Double down on the content AI engines already cite: keep those pages fresh and '
            + 'well-structured so AEO traffic keeps compounding.',
         );
      }
      if (has('no_ai_referral_traffic')) {
         recommendations.push(
            'Start the AEO loop: no AI engines send visitors yet. Publish an llms.txt, structure '
            + 'key pages as direct answers, and make sure robots.txt allows AI answer engines so they '
            + 'begin citing you.',
         );
      }
      if (has('traffic_concentration')) {
         recommendations.push(
            'Diversify entry points: build and rank a second and third page so the site is not '
            + 'dependent on a single top page.',
         );
      }
      if (findings.length === 0) {
         recommendations.push(
            'No notable cross-pillar signals this period. Widen the window (e.g. period=90d) or '
            + 'add more tracked keywords to surface opportunities.',
         );
      }

      // Order findings high -> medium -> low -> info for the reader.
      const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
      findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

      return res.status(200).json({
         domain,
         period,
         findings,
         recommendations,
         notes: notes.length ? notes : undefined,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Insights for ', domain, error);
      return res.status(400).json({ error: 'Error Building Insights for this Domain.' });
   }
};
