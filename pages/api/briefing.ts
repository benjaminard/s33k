import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
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
   EngagementTier,
} from '../../utils/analytics';
import { aggregateTrafficPages } from '../../utils/aggregate-traffic-pages';
import { estimateHumanTraffic } from '../../utils/bot-filter';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. ANALYSIS RUNS IN THE USER'S OWN LLM.
 * ============================================================================
 * s33k NEVER sends customer data to a model trainer and has NO model-training
 * pipeline anywhere in the codebase. This route does NOT call any LLM, does NOT
 * embed, fine-tune, or transmit account data to any external model. It runs
 * transparent, commented rules server-side over the caller's OWN tenant-scoped
 * data and returns a structured, narration-ready bundle. The interpretation
 * ("tell me what this means") happens in the USER's own LLM over MCP: s33k only
 * hands that LLM structured data. The only credentials s33k stores (Search
 * Console / Google Ads keys, scraper key) are encrypted at rest with cryptr +
 * the app SECRET (see utils/searchConsole.ts, utils/adwords.ts, pages/api/
 * settings.ts). Full trust documentation: SECURITY.md (and the security_facts
 * MCP tool that answers "is this safe / do you train on my data / who can see
 * it").
 * ============================================================================
 */

/**
 * Daily briefing: the proactive-analyst, "tell me what to DO, not just what
 * happened" capability.
 *
 * This route is RULES-BASED. It does NOT call any LLM. It pulls every s33k
 * pillar (traffic, human-vs-bot reality, SEO rank, AI referrals, engagement)
 * once, runs a set of small, transparent, commented rules over the joined data,
 * and returns a single narration-ready structure:
 *
 *   {
 *     headline,                       one-line "state of the site" sentence
 *     sections: [{ title, points }],  one section per pillar, each a list of
 *                                     plain-English bullet strings
 *     recommendations: [],            the top 3 (or fewer) actions, in priority
 *                                     order, each a concrete next step
 *     generatedFor: { domain, period }
 *   }
 *
 * The USER's LLM reads this and narrates it as a morning standup. The server
 * does the joins and the prioritization; the model does the storytelling.
 *
 * Robustness: this endpoint NEVER 500s on a sub-signal failure. Each pillar is
 * fetched independently and its error is swallowed into a per-section note so a
 * dead provider or an empty table degrades one section instead of the whole
 * briefing. The only 4xx paths are auth (401) and a missing domain (400).
 */

type Section = {
   title: string,
   points: string[],
};

type BriefingResponse = {
   headline?: string,
   sections?: Section[],
   recommendations?: string[],
   generatedFor?: { domain: string, period: string },
   error?: string | null,
};

// --- Tunable thresholds (kept together so they are easy to audit). -----------

// A page is "high traffic" relative to the site once it clears this share of
// total pageviews. Used to surface opportunity pages worth ranking.
const HIGH_TRAFFIC_SHARE = 0.05; // 5% of site pageviews
// A page counts as having "real traffic" at all once it clears this floor.
// Kept modest so opportunity rules also fire on smaller/low-volume sites.
const MIN_REAL_PAGEVIEWS = 10;
// A keyword ranks "well" at or above this Google position (1 = top).
const GOOD_RANK_MAX = 10;
// "Striking distance": ranks just off page one, the cheapest rank wins.
const STRIKING_DISTANCE_MAX = 20;
// Bot share at/above this gets a loud caveat on every other number.
const BOT_SHARE_WARN = 30; // percent
// How many opportunity pages / striking-distance keywords to list per section.
const MAX_LIST = 5;

/** Round a 0..1 share to one decimal percent (e.g. 0.1234 -> 12.3). */
const pct = (share: number): number => Math.round(share * 1000) / 10;

/** Format a possibly-fractional number of seconds as a short label. */
const secs = (n: number | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}s` : 'n/a');

export default async function handler(req: NextApiRequest, res: NextApiResponse<BriefingResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getBriefing(req, res, account);
}

const getBriefing = async (req: NextApiRequest, res: NextApiResponse<BriefingResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // Verify the caller owns this domain before reading any of its data. With
   // MULTI_TENANT off (default), scopeWhere returns {} so this is just an existence
   // check against the same Domain row the legacy app would have read. With the flag
   // on, a tenant can only brief a domain they own; everything below (Keyword and
   // the analytics providers, all keyed by the domain string) is gated behind this
   // single ownership check.
   const owned = await resolveDomainAccess(account, domain);
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      const provider = getAnalyticsProvider();

      // Fetch + sessionize first-party events so estimateHumanTraffic returns the
      // authoritative is_bot split (the source IP classified datacenter-or-not at
      // ingest), giving the same human number as human_traffic, human_analytics,
      // start_here, and the dashboard. Without these sessions it hits the honest
      // degraded path (estVisitors 0) and the headline below would fall back to the
      // bot-inflated provider visitor total. Tenant-scoped + gated AFTER
      // resolveDomainAccess. Wrapped in .catch so a DB hiccup degrades this one
      // signal into the provider fallback rather than breaking the briefing.
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const firstPartySessions = await S33kEvent.findAll({
         where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
         order: [['created', 'ASC']],
      })
         .then((rows) => sessionize(rows.map((r) => r.get({ plain: true }) as EventLike)))
         .catch(() => [] as ReturnType<typeof sessionize>);

      // Pull every pillar in parallel. Each promise is wrapped so a rejection
      // becomes a recoverable value, never an unhandled throw that 500s the
      // briefing. Analytics providers already resolve (not reject) with an
      // `error` field; the DB query gets an explicit catch.
      const [keywordRows, traffic, referrals, summary, engagement, botEstimate] = await Promise.all([
         Keyword.findAll({ where: { domain, ...scopeWhere(account) } }).catch(() => [] as Keyword[]),
         provider.getPageTraffic(domain, period).catch((e) => ({ pages: [], error: String(e) })),
         provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
         provider.getSummary(domain, period).catch((e) => ({
            pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: String(e),
         })),
         provider.getEngagement(domain, period).catch((e) => ({ tiers: [], error: String(e) })),
         estimateHumanTraffic(provider, domain, period, firstPartySessions).catch((e) => ({
            estVisitors: 0, estHumanVisitors: 0, estBotVisitors: 0, botSharePct: 0, method: '', error: String(e),
         })),
      ]);

      const keywords: KeywordType[] = parseKeywords(
         (keywordRows as Keyword[]).map((e) => e.get({ plain: true })),
      );
      const trafficPages: NormalizedPage[] = (traffic as { pages: NormalizedPage[] }).pages || [];
      const sources: ReferralSource[] = (referrals as { sources: ReferralSource[] }).sources || [];
      const summaryData = summary as SummaryResult;
      const tiers: EngagementTier[] = (engagement as { tiers: EngagementTier[] }).tiers || [];

      // ---------------------------------------------------------------------
      // Shared joins (same aggregation scoreboard.ts uses, via the shared util).
      // Aggregate page rows by clean path FIRST: a provider can return several
      // raw rows that all normalize to one page (e.g. "/", "/?utm_medium=x").
      // ---------------------------------------------------------------------
      const aggregatedPages = aggregateTrafficPages(trafficPages);
      const totalPageviews = aggregatedPages.reduce((sum, p) => sum + (p.page_views || 0), 0);

      // Group tracked keywords by the page they target.
      const keywordsByPath = new Map<string, KeywordType[]>();
      keywords.forEach((kw) => {
         const targetClean = cleanPath(kw.target_page || '');
         if (!targetClean) { return; }
         const list = keywordsByPath.get(targetClean) || [];
         list.push(kw);
         keywordsByPath.set(targetClean, list);
      });

      // Used by recommendations to know which signals actually fired.
      const flags = {
         botHigh: false,
         opportunityPages: false,
         strikingDistance: false,
         aiReferrals: false,
         noAiAtAll: false,
         concentration: false,
         noTraffic: false,
      };

      const sections: Section[] = [];

      // =====================================================================
      // SECTION 1. Traffic and human-vs-bot reality.
      // Lead with the honest number: how many of the measured visitors are
      // actually humans. Most analytics overcount JS-executing scrapers, so the
      // raw total is almost always inflated. The briefing says this out loud.
      // =====================================================================
      const trafficPoints: string[] = [];
      if (summaryData.error) {
         trafficPoints.push(`Traffic numbers are unavailable this period (${summaryData.error}).`);
      } else if ((summaryData.pageviews || 0) === 0 && (summaryData.visitors || 0) === 0) {
         flags.noTraffic = true;
         trafficPoints.push('No measured traffic this period. Either the analytics provider has no data for this '
            + 'domain/window, or the site genuinely had no visits.');
      } else {
         trafficPoints.push(`${summaryData.pageviews} pageviews from ${summaryData.visitors} visitors `
            + `(bounce ${Math.round(summaryData.bounceRate)}%, avg visit ${secs(summaryData.avgDuration)}, `
            + `${(summaryData.pagesPerVisit || 0).toFixed(1)} pages/visit).`);
      }
      if (!botEstimate.error && botEstimate.estVisitors > 0) {
         if (botEstimate.botSharePct >= BOT_SHARE_WARN) {
            flags.botHigh = true;
            trafficPoints.push(`Roughly ${botEstimate.botSharePct}% of visitors look like bots, not humans `
               + `(~${botEstimate.estBotVisitors} of ${botEstimate.estVisitors}). Plan against the human figure: `
               + `about ${botEstimate.estHumanVisitors} real visitors.`);
         } else {
            trafficPoints.push(`Bot share is low (~${botEstimate.botSharePct}%); about `
               + `${botEstimate.estHumanVisitors} of ${botEstimate.estVisitors} visitors look human, so the raw `
               + 'totals are broadly trustworthy this period.');
         }
      } else if (botEstimate.error) {
         trafficPoints.push(`Human-vs-bot estimate unavailable (${botEstimate.error}).`);
      }
      // Traffic concentration on a single page is a resilience risk.
      if (totalPageviews > 0 && aggregatedPages.length > 0) {
         const top = [...aggregatedPages].sort((a, b) => (b.page_views || 0) - (a.page_views || 0))[0];
         const topShare = (top.page_views || 0) / totalPageviews;
         if (topShare >= 0.5) {
            flags.concentration = true;
            trafficPoints.push(`${top.pathClean} alone is ${pct(topShare)}% of all pageviews. Traffic is `
               + 'concentrated on one page; a single ranking or content change there can swing the whole site.');
         }
      }
      sections.push({ title: 'Traffic and human-vs-bot reality', points: trafficPoints });

      // =====================================================================
      // SECTION 2. Search rank movement and opportunity pages.
      // The opportunity pages (high traffic, weak/no rank) are the highest
      // leverage SEO moves; striking-distance keywords are the cheapest wins.
      // =====================================================================
      const seoPoints: string[] = [];
      const ranked = keywords.filter((k) => typeof k.position === 'number' && k.position > 0);
      if (keywords.length === 0) {
         seoPoints.push('No keywords are tracked for this domain yet, so there is no rank picture. '
            + 'Add keywords (ideally with a target_page) to start tracking SEO.');
      } else {
         const top10 = ranked.filter((k) => k.position <= GOOD_RANK_MAX).length;
         const unranked = keywords.length - ranked.length;
         seoPoints.push(`${keywords.length} tracked keywords: ${top10} on page one (top 10), `
            + `${ranked.length - top10} ranked below 10, ${unranked} not yet ranking/scraped.`);
      }

      // Opportunity pages: real traffic, but no keyword or a best rank > top 10.
      const opportunities: string[] = [];
      aggregatedPages.forEach((page) => {
         const views = page.page_views || 0;
         const share = totalPageviews > 0 ? views / totalPageviews : 0;
         if (!(views >= MIN_REAL_PAGEVIEWS && share >= HIGH_TRAFFIC_SHARE)) { return; }
         const covering = keywordsByPath.get(page.pathClean) || [];
         const positions = covering.map((k) => k.position).filter((p) => typeof p === 'number' && p > 0);
         const bestRank = positions.length ? Math.min(...positions) : null;
         if (covering.length === 0) {
            opportunities.push(`${page.pathClean} pulls ${views} pageviews (${pct(share)}% of the site) but has `
               + 'NO tracked keyword. It is proven to matter yet invisible to rank tracking.');
         } else if (bestRank !== null && bestRank > GOOD_RANK_MAX) {
            opportunities.push(`${page.pathClean} pulls ${views} pageviews but its best keyword only ranks `
               + `#${bestRank}. Pushing it onto page one would compound traffic it already earns.`);
         }
      });
      if (opportunities.length) {
         flags.opportunityPages = true;
         opportunities.slice(0, MAX_LIST).forEach((o) => seoPoints.push(o));
         if (opportunities.length > MAX_LIST) {
            seoPoints.push(`(+${opportunities.length - MAX_LIST} more opportunity pages.)`);
         }
      }

      // Striking-distance keywords: ranked 11..20, the cheapest rank wins.
      const striking = ranked
         .filter((k) => k.position > GOOD_RANK_MAX && k.position <= STRIKING_DISTANCE_MAX)
         .sort((a, b) => a.position - b.position);
      if (striking.length) {
         flags.strikingDistance = true;
         const sample = striking.slice(0, MAX_LIST)
            .map((k) => `"${k.keyword}" (#${k.position})`).join(', ');
         seoPoints.push(`${striking.length} keyword(s) sit in striking distance (positions 11-20), the cheapest `
            + `rank wins: ${sample}${striking.length > MAX_LIST ? ', ...' : ''}.`);
      }
      sections.push({ title: 'Search rank movement and opportunity pages', points: seoPoints });

      // =====================================================================
      // SECTION 3. AI visibility (referrals).
      // Referrals are the real AI-driven traffic: which AI answer engines are
      // actually sending visitors, the direct proof AEO is paying off.
      // =====================================================================
      const aiPoints: string[] = [];
      const aiSources = sources.filter((s) => s.isAI);
      const visitorsOf = (s: ReferralSource): number => Number(s.unique_visitors ?? 0);
      const aiVisitors = aiSources.reduce((sum, s) => sum + visitorsOf(s), 0);
      const allReferred = sources.reduce((sum, s) => sum + visitorsOf(s), 0);
      const aiSharePct = allReferred > 0 ? pct(aiVisitors / allReferred) : 0;

      if ((referrals as { error?: string | null }).error) {
         aiPoints.push(`AI referral data unavailable (${(referrals as { error?: string | null }).error}).`);
      } else if (aiVisitors > 0) {
         flags.aiReferrals = true;
         const engineMap = new Map<string, number>();
         aiSources.forEach((s) => {
            const engine = s.engine || s.name || 'Unknown AI';
            engineMap.set(engine, (engineMap.get(engine) || 0) + visitorsOf(s));
         });
         const byEngine = Array.from(engineMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([engine, v]) => `${engine} (${v})`)
            .join(', ');
         aiPoints.push(`AI answer engines are sending real visitors: ${aiVisitors} AI-referred visitors `
            + `(${aiSharePct}% of all referred traffic), led by ${byEngine}. Direct proof AEO is paying off.`);
      } else {
         aiPoints.push('No measurable visitor traffic from AI answer engines this period.');
         if (!(referrals as { error?: string | null }).error) {
            flags.noAiAtAll = true;
         }
      }
      sections.push({ title: 'AI visibility (referrals)', points: aiPoints });

      // =====================================================================
      // SECTION 4. Engagement quality (supporting context for the above).
      // A high bounced/low-engagement share means even the "human" traffic is
      // shallow; it tempers how much weight to put on the volume numbers.
      // =====================================================================
      const engPoints: string[] = [];
      if ((engagement as { error?: string | null }).error) {
         engPoints.push(`Engagement tiers unavailable (${(engagement as { error?: string | null }).error}).`);
      } else if (tiers.length === 0) {
         engPoints.push('No engagement tier data this period.');
      } else {
         const tierLabel = tiers
            .map((t) => `${t.label} ${Math.round(t.percentage)}%`)
            .join(', ');
         engPoints.push(`Session quality split: ${tierLabel}.`);
         const bounced = tiers.find((t) => /bounce/i.test(t.label));
         if (bounced && bounced.percentage >= 70) {
            engPoints.push(`A high ${Math.round(bounced.percentage)}% of sessions bounced; even the human traffic `
               + 'is shallow this period. Treat raw volume cautiously.');
         }
      }
      sections.push({ title: 'Engagement quality', points: engPoints });

      // =====================================================================
      // Recommendations: the top 3 actions, in priority order. Each is a
      // concrete next step derived from the flags the rules above set, not a
      // restatement of a finding. Capped at 3 so the briefing stays a standup,
      // not a backlog. The user's LLM may expand them.
      // =====================================================================
      const candidates: string[] = [];
      if (flags.botHigh) {
         candidates.push('Read every traffic number against the human estimate, not the raw total. A large share '
            + 'of measured visitors looks automated; planning off the inflated number will mislead you.');
      }
      if (flags.opportunityPages) {
         candidates.push('Capture the opportunity pages: add tracked keywords to high-traffic pages that have none, '
            + 'and prioritize on-page SEO for high-traffic pages whose best keyword ranks outside the top 10. '
            + 'They already earn traffic, so a page-one rank compounds it.');
      }
      if (flags.strikingDistance) {
         candidates.push('Push the striking-distance keywords (positions 11-20) onto page one. They are the '
            + 'cheapest rank wins: small on-page and internal-link improvements often move them inside the top 10.');
      }
      if (flags.aiReferrals) {
         candidates.push('Double down on the content AI engines already cite: keep those pages fresh and '
            + 'well-structured so the AI-referred traffic keeps compounding.');
      }
      if (flags.noAiAtAll) {
         candidates.push('Start the AEO loop: no AI referrals yet. Publish an llms.txt, structure key pages as '
            + 'direct answers, and make sure your robots.txt allows AI answer engines so they begin citing you.');
      }
      if (flags.concentration) {
         candidates.push('Diversify entry points: one page carries most of the traffic. Build and rank a second and '
            + 'third page so a single ranking or content change cannot swing the whole site.');
      }
      if (flags.noTraffic) {
         candidates.push('Confirm analytics is reporting for this domain/window before acting on anything else: '
            + 'no traffic was measured, which usually means a tracking or configuration gap rather than zero visits.');
      }
      if (candidates.length === 0) {
         candidates.push('No urgent cross-pillar action this period. Widen the window (e.g. period=90d) or add more '
            + 'tracked keywords to surface opportunities, and keep the current pages fresh.');
      }
      const recommendations = candidates.slice(0, 3);

      // =====================================================================
      // Headline: a single "state of the site" sentence the LLM can lead with.
      // =====================================================================
      let headline: string;
      if (flags.noTraffic) {
         headline = `${domain}: no measured traffic this ${period} window. Check that analytics is reporting.`;
      } else {
         const humanCount = (!botEstimate.error && botEstimate.estVisitors > 0)
            ? botEstimate.estHumanVisitors
            : summaryData.visitors;
         const botNote = flags.botHigh ? ` (about ${botEstimate.botSharePct}% bots filtered out)` : '';
         let aiNote = 'no AI referral traffic yet';
         if (flags.aiReferrals) {
            aiNote = `${aiVisitors} AI-referred visitor(s)`;
         }
         const seoNote = flags.opportunityPages
            ? `${opportunities.length} SEO opportunity page(s) waiting`
            : 'no urgent SEO gaps';
         // Headline is a tight one-line state-of-site only; the action lives in
         // recommendations[] (mirrors daily_brief separating headline from topAction), so
         // the narrating LLM is not handed the same sentence twice.
         headline = `${domain} over ${period}: about ${humanCount} human visitor(s)${botNote}, ${aiNote}, `
            + `${seoNote}.`;
      }

      return res.status(200).json({
         headline,
         sections,
         recommendations,
         generatedFor: { domain, period },
         error: null,
      });
   } catch (error) {
      // Last-resort guard. The per-pillar catches above mean we should never get
      // here, but if a join itself throws we still return a usable (empty-ish)
      // briefing rather than a 500, honoring the "never 500" contract.
      console.log('[ERROR] Building Briefing for ', domain, error);
      return res.status(200).json({
         headline: `Could not build a full briefing for ${domain} this period.`,
         sections: [],
         recommendations: ['Retry shortly, or check the analytics provider and tracked keywords for this domain.'],
         generatedFor: { domain, period },
         error: 'Error Building Briefing for this Domain.',
      });
   }
};
