import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, applyFilters, EventLike, GoalDef, SessionAgg } from '../../utils/sessionize';
import { attributeConversions, AttribKeyword, ChannelRow } from '../../utils/conversion-attribution';
import { summarizeSeo, SeoKeywordInput, SeoSummary } from '../../utils/executive-summary-seo';
import { getAnalyticsProvider, ReferralSource } from '../../utils/analytics';
import * as reportCache from '../../utils/report-cache';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. ANALYSIS RUNS IN THE USER'S OWN LLM.
 * ============================================================================
 * s33k NEVER sends customer data to a model trainer and has NO model-training
 * pipeline. This route runs transparent, commented RULES over the caller's own
 * tenant-scoped data and returns a structured, narration-ready bundle. It calls
 * NO LLM. The plain-English healthLine and nextAction are rules-derived strings;
 * the USER's own LLM over MCP does any further storytelling. Full trust facts:
 * SECURITY.md (and the security_facts MCP tool).
 * ============================================================================
 */

/**
 * Executive summary: the leadership one-glance prebuilt report.
 *
 * GET /api/executive-summary?domain=&period=30d[&goal=|goalId=][&includeBots=true]
 *
 * A prebuilt report BUNDLES existing signals into one sectioned answer the user's
 * LLM narrates, so a leader gets the whole picture in one call. It does NOT call
 * other API routes over HTTP: it reuses the shared utils (sessionize,
 * attributeConversions, summarizeSeo) and queries the models directly.
 *
 * Returns:
 *   - headline: humanVisitors, conversions, conversionRatePct (when a goal is set).
 *   - topChannel: the channel with the most human sessions.
 *   - topConvertingChannel: the channel with the highest conversion rate (goal only).
 *   - seo: page-one keyword count, biggest rank gain and biggest rank loss over the period.
 *   - aiVisibility: whether AI engines are sending visitors (yes/no + count).
 *   - healthLine: a 2-3 sentence plain-English state-of-the-site (rules-derived).
 *   - nextAction: the single top opportunity (from attributeConversions when a goal
 *     exists, else the biggest SEO or traffic signal).
 *
 * Human-only by default (datacenter/bot excluded) so leadership numbers are not
 * inflated by scrapers. Pass includeBots=true to fold bots back in.
 */

type HeadlineBlock = {
   humanVisitors: number,
   conversions: number | null,
   conversionRatePct: number | null,
};

type TopChannelBlock = { channel: string, sessions: number } | null;
type TopConvertingChannelBlock = { channel: string, conversionRatePct: number, conversions: number } | null;

type AiVisibilityBlock = {
   sendingVisitors: boolean,
   visitors: number,
   topEngine: string | null,
};

type ExecutiveSummaryResponse = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string } | null,
   headline?: HeadlineBlock,
   topChannel?: TopChannelBlock,
   topConvertingChannel?: TopConvertingChannelBlock,
   seo?: SeoSummary,
   aiVisibility?: AiVisibilityBlock,
   healthLine?: string,
   nextAction?: string,
   note?: string | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<ExecutiveSummaryResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getExecutiveSummary(req, res, account);
}

const getExecutiveSummary = async (
   req: NextApiRequest,
   res: NextApiResponse<ExecutiveSummaryResponse>,
   account?: Account | null,
) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   // Ownership gate: verify the caller owns this domain BEFORE reading any pillar. With MULTI_TENANT
   // off, scopeWhere returns {} so this is a plain by-name existence check; with it on, a tenant can
   // only summarize a domain they own, and every read below inherits that scope.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   // Tenant-scoped cache (key begins with the resolved account ID), built only after ownership
   // passes so a HIT only ever returns this caller's own report. fresh=1 / nocache=1 bypass + refill.
   const cacheKey = reportCache.buildReportCacheKey('executive-summary', req, account);
   if (!reportCache.wantsFresh(req)) {
      const hit = reportCache.get(cacheKey) as ExecutiveSummaryResponse | undefined;
      if (hit) { return res.status(200).json(hit); }
   }

   try {
      // A goal is OPTIONAL for this report (the spec marks goal as goal?). When the caller names one
      // (by goalId or goal name) we add conversions to the headline and pick the next action from the
      // conversion opportunities; without one we summarize traffic + SEO + AI only.
      let goalRow: Goal | null = null;
      const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
      if (typeof q.goalId === 'string' && q.goalId.trim()) {
         goalWhere.ID = parseInt(q.goalId, 10);
         goalRow = await Goal.findOne({ where: goalWhere });
      } else if (typeof q.goal === 'string' && q.goal.trim()) {
         goalWhere.name = q.goal.trim();
         goalRow = await Goal.findOne({ where: goalWhere });
      }
      let goalDef: GoalDef | null = null;
      let goalMeta: { id: number, name: string } | null = null;
      if (goalRow) {
         const g = goalRow.get({ plain: true }) as Record<string, unknown>;
         goalDef = {
            kind: g.kind === 'event' ? 'event' : 'page_reached',
            matchValue: String(g.match_value),
            matchPage: (g.match_page as string) || null,
            matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
         };
         goalMeta = { id: g.ID as number, name: String(g.name) };
      }

      const includeBots = q.includeBots === 'true';
      const startMs = periodStartMs(period, Date.now());
      const startISO = new Date(startMs).toJSON();

      // Pull the pillars. Events + keywords are tenant-scoped DB reads; the AI-referral read goes
      // through the analytics provider. Wrap the provider read so an analytics outage degrades the AI
      // block instead of failing the whole summary (the conversion + SEO halves still answer).
      const [eventRows, keywordRows, referralResult] = await Promise.all([
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }),
         Keyword.findAll({
            where: { domain, ...scopeWhere(account) },
            attributes: ['keyword', 'position', 'target_page', 'history'],
         }),
         getAnalyticsProvider().getReferralSources(domain, period)
            .catch((e) => ({ sources: [] as ReferralSource[], error: String(e) })),
      ]);

      // Human-only by default. Only pageview-bearing sessions count as "visitors".
      const allSessions = sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike));
      const sessions: SessionAgg[] = applyFilters(allSessions, { humanOnly: !includeBots })
         .filter((s) => s.pageviewCount > 0);
      const humanVisitors = sessions.length;

      // Top channel: most human sessions. Computed independently of the goal so it always answers.
      const sessionsByChannel = new Map<string, number>();
      for (const s of sessions) { sessionsByChannel.set(s.channel, (sessionsByChannel.get(s.channel) || 0) + 1); }
      const channelRanked = Array.from(sessionsByChannel.entries()).sort((a, b) => b[1] - a[1]);
      const topChannel: TopChannelBlock = channelRanked.length
         ? { channel: channelRanked[0][0], sessions: channelRanked[0][1] }
         : null;

      // Conversions: only when a goal is set. Reuse attributeConversions so byChannel/opportunities
      // match the dedicated conversion-attribution route exactly (one engine, never diverges).
      const keywords: AttribKeyword[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return { keyword: String(p.keyword), position: Number(p.position) || 0, targetPage: String(p.target_page || '') };
      });
      const attribution = goalDef ? attributeConversions(sessions, goalDef, keywords) : null;

      let conversions: number | null = null;
      let conversionRatePct: number | null = null;
      let topConvertingChannel: TopConvertingChannelBlock = null;
      if (attribution) {
         conversions = attribution.conversions;
         conversionRatePct = attribution.conversionRatePct;
         // Highest-RATE channel among those with at least one converting session, so a single lucky
         // conversion on a tiny channel does not crown it. Falls back to null when nothing converts.
         const converting: ChannelRow[] = attribution.byChannel
            .filter((c) => c.conversions > 0)
            .sort((a, b) => b.conversionRatePct - a.conversionRatePct || b.conversions - a.conversions);
         if (converting.length) {
            topConvertingChannel = {
               channel: converting[0].channel,
               conversionRatePct: converting[0].conversionRatePct,
               conversions: converting[0].conversions,
            };
         }
      }

      // SEO: page-one count from current positions + biggest gain/loss over the period from history.
      const seoInput: SeoKeywordInput[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return { keyword: String(p.keyword), position: Number(p.position) || 0, history: String(p.history || '') };
      });
      const seo = summarizeSeo(seoInput, startMs);

      // AI visibility: are AI engines SENDING visitors? Read referral sources, keep AI engines only.
      const aiSources = (referralResult.sources || []).filter((s) => s.isAI);
      const aiVisitors = aiSources.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
      const aiByEngine = new Map<string, number>();
      aiSources.forEach((s) => {
         const engine = s.engine || s.name || 'Unknown AI';
         aiByEngine.set(engine, (aiByEngine.get(engine) || 0) + Number(s.unique_visitors ?? 0));
      });
      const aiTop = Array.from(aiByEngine.entries()).sort((a, b) => b[1] - a[1])[0];
      const aiVisibility: AiVisibilityBlock = {
         sendingVisitors: aiVisitors > 0,
         visitors: aiVisitors,
         topEngine: aiTop ? aiTop[0] : null,
      };

      const headline: HeadlineBlock = { humanVisitors, conversions, conversionRatePct };

      // ---------------------------------------------------------------------
      // healthLine: 2-3 plain-English sentences, rules-derived (no LLM). Built
      // from the same numbers above so it never contradicts the structured data.
      // ---------------------------------------------------------------------
      const healthParts: string[] = [];
      if (humanVisitors === 0) {
         healthParts.push(`${domain} shows no human traffic in the last ${period}.`);
         healthParts.push('Either the s33k tracking script is not installed yet or the window is empty; install or widen it first.');
      } else {
         const channelNote = topChannel ? ` Most arrive via ${topChannel.channel} (${topChannel.sessions} session(s)).` : '';
         healthParts.push(`${domain} drew ${humanVisitors} human visitor(s) in the last ${period}.${channelNote}`);
         if (goalMeta && conversions !== null) {
            const rateNote = topConvertingChannel
               ? ` ${topConvertingChannel.channel} converts best at ${topConvertingChannel.conversionRatePct}%.`
               : '';
            healthParts.push(`${conversions} completed "${goalMeta.name}" (${conversionRatePct}% of visitors).${rateNote}`);
         }
         // One SEO + AI sentence so leadership sees all three pillars in the line.
         const seoBit = seo.trackedKeywords === 0
            ? 'No keywords are tracked yet, so there is no rank picture.'
            : `${seo.keywordsOnPageOne} of ${seo.trackedKeywords} tracked keyword(s) sit on page one`;
         const aiBit = aiVisibility.sendingVisitors
            ? `AI engines are sending ${aiVisibility.visitors} visitor(s)${aiVisibility.topEngine ? ` (led by ${aiVisibility.topEngine})` : ''}.`
            : 'no AI engines are sending visitors yet.';
         healthParts.push(seo.trackedKeywords === 0 ? `${seoBit} Meanwhile, ${aiBit}` : `${seoBit}, and ${aiBit}`);
      }
      const healthLine = healthParts.join(' ');

      // ---------------------------------------------------------------------
      // nextAction: the single top opportunity. When a goal is set, take the top
      // conversion "money move" from attributeConversions (the highest-leverage
      // join s33k owns). Otherwise fall back to the biggest SEO or traffic signal.
      // ---------------------------------------------------------------------
      const nextAction = pickNextAction({ domain, period, humanVisitors, attribution, seo, aiVisibility, topChannel });

      let note: string | null = null;
      if (humanVisitors === 0) {
         note = 'No human sessions in this window. Install the s33k.js tracking script so the traffic and conversion numbers fill in.';
      } else if (referralResult.error) {
         note = `Traffic and SEO are accurate; AI-referral data was unavailable this run (${referralResult.error}).`;
      }

      const payload: ExecutiveSummaryResponse = {
         domain,
         period,
         goal: goalMeta,
         headline,
         topChannel,
         topConvertingChannel,
         seo,
         aiVisibility,
         healthLine,
         nextAction,
         note,
         error: null,
      };
      // Only successful reports are cached (error paths return before here).
      reportCache.set(cacheKey, payload);
      return res.status(200).json(payload);
   } catch (error) {
      console.log('[ERROR] Building Executive Summary for ', domain, error);
      return res.status(400).json({ error: 'Error Building Executive Summary for this Domain.' });
   }
};

/**
 * Choose the single highest-leverage next action, rules-derived (no LLM). Priority: a goal's top
 * conversion opportunity (the money move) > the biggest SEO movement worth acting on > an AEO push >
 * a "install/widen" nudge when there is nothing to act on. Returns one plain-English sentence.
 */
const pickNextAction = (ctx: {
   domain: string,
   period: string,
   humanVisitors: number,
   attribution: ReturnType<typeof attributeConversions> | null,
   seo: SeoSummary,
   aiVisibility: AiVisibilityBlock,
   topChannel: TopChannelBlock,
}): string => {
   const { humanVisitors, attribution, seo, aiVisibility } = ctx;
   if (humanVisitors === 0) {
      return 'Install the s33k.js tracking script (or widen the period) so traffic, conversions, and AI referrals can be measured before acting.';
   }
   // 1. Goal set and a conversion opportunity exists: that join is the strongest move s33k can make.
   if (attribution && attribution.opportunities.length > 0) {
      return attribution.opportunities[0].detail;
   }
   // 2. A real rank loss is the most urgent SEO signal (defend before chasing new wins).
   if (seo.biggestLoss) {
      const l = seo.biggestLoss;
      return `Defend "${l.keyword}": it slipped from #${l.fromPosition} to #${l.toPosition} this ${ctx.period}. `
         + 'Refresh the page and its internal links before the lost rank costs traffic.';
   }
   // 3. A real rank gain worth compounding.
   if (seo.biggestGain) {
      const g = seo.biggestGain;
      return `Compound "${g.keyword}": it climbed from #${g.fromPosition} to #${g.toPosition} this ${ctx.period}. `
         + 'Reinforce that page now while momentum is on its side.';
   }
   // 4. AEO push when no AI engine sends visitors yet.
   if (!aiVisibility.sendingVisitors) {
      return 'Start the AEO loop: no AI engines send visitors yet. Make sure robots.txt allows AI answer engines, '
         + 'publish an llms.txt, and structure key pages as direct answers so engines begin citing the site.';
   }
   // 5. Nothing urgent: keep compounding what already works.
   return 'No urgent action this period. Keep the top pages fresh, add tracked keywords to surface new opportunities, '
      + 'and widen the window (e.g. period=90d) to catch slower movements.';
};
