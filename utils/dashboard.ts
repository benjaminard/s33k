/*
 * ============================================================================
 * s33k DASHBOARD: the default "show me an overview" composition (RULES-BASED).
 * ============================================================================
 * This module is PURE. It takes already-loaded, ownership-scoped, period-clamped
 * pillar data (tracked keywords, first-party sessions, web-vital rows, goals,
 * referral sources, traffic summary) and composes ONE compact overview object.
 * It does NOT touch the DB, the network, or any LLM: every section is a small,
 * transparent join/aggregation over the inputs, so the user's own LLM can narrate
 * the result. The interpretation ("what does this mean / what next") happens in
 * the connected LLM over MCP; s33k only hands it structured data.
 *
 * Philosophy (Ben): "AI is the UI, but people need their hands held." A marketer
 * often does not know WHAT to ask. The dashboard both SHOWS the key numbers per
 * pillar AND (via the companion suggested-questions catalog) tells them what to
 * ask next. Every section is null/empty-safe: a brand-new domain with almost no
 * data still returns a coherent, honest overview with a per-section "not enough
 * data yet" note instead of a crash or a misleading zero.
 *
 * It REUSES the shared logic the rest of the app already trusts and never
 * re-implements it: isEngaged/channel classification (utils/sessionize.ts), the
 * AI classifier (utils/ai-sources.ts), buildWebVitals (utils/web-vitals.ts), the
 * rank-distribution buckets (mirrors pages/api/seo-report.ts, kept here as a tiny
 * pure pass over already-parsed keywords), and sessionConverted for goals.
 * ============================================================================
 */

import { cleanPath } from './clean-path';
import { classifyReferrer } from './ai-sources';
import {
   SessionAgg, GoalDef, isEngaged, sessionConverted, humanBotSplit,
} from './sessionize';
import { buildWebVitals, WebVitalRow, WebVitalMetric } from './web-vitals';
import type { NormalizedPage, ReferralSource, SummaryResult } from './analytics';
import { normalizeHistoryDateKey } from './history-date';

// --- Tunables, kept together so they are easy to audit. ----------------------
// How many rows each "top N" section shows. The dashboard is a glance, never a
// full dump; drill-down lives in the per-pillar tools.
const TOP_PAGES = 5;
const TOP_SOURCES = 5;
const TOP_REFERRERS = 5;
const TOP_KEYWORDS = 5;
const TOP_MOVERS = 3;
// A keyword ranks "well" at or above this Google position (1 = top).
const GOOD_RANK_MAX = 10;

/** A goal record as already loaded (plain), only the fields the dashboard needs. */
export type DashboardGoal = {
   ID: number,
   name: string,
   kind: string,
   match_value: string,
   match_page: string | null,
   match_mode: string,
   value: number | null,
};

/** A tracked keyword as already parsed (parseKeywords), only what the dashboard reads. */
export type DashboardKeyword = {
   keyword: string,
   position: number,
   url: string,
   target_page?: string,
   // history is parsed to an object of { 'YYYY-MM-DD': position } by parseKeywords; the dashboard
   // only needs first vs last to compute a mover, so it accepts the parsed shape loosely.
   history?: Record<string, number> | unknown,
};

/** Everything the route hands the composer. All already scoped + period-clamped. */
export type DashboardInput = {
   domain: string,
   period: string,
   keywords: DashboardKeyword[],
   // First-party sessions for the window (utils/sessionize). Used for traffic,
   // sources, entry context, engagement, and goal conversion.
   sessions: SessionAgg[],
   // The provider summary (site-wide totals). Optional; null when unavailable.
   summary: SummaryResult | null,
   // Provider per-page traffic rows (already error-stripped to an array).
   trafficPages: NormalizedPage[],
   // Provider referral sources (already error-stripped to an array).
   referralSources: ReferralSource[],
   // Raw web-vital rows for buildWebVitals (already scoped + filtered).
   webVitalRows: WebVitalRow[],
   // Goals defined for this domain (already scoped). Empty = section omitted.
   goals: DashboardGoal[],
   // Per-section provider errors, so a dead pillar degrades to an honest note.
   errors?: {
      summary?: string | null,
      traffic?: string | null,
      referrals?: string | null,
   },
};

// --- Section shapes (each compact, each empty-safe). -------------------------

export type DashboardHeadline = {
   humanVisitors: number,
   aiReferredVisitors: number,
   topOpportunity: string | null,
   topAction: string | null,
};

export type DashboardTopPage = { path: string, pageviews: number, entries: number };

export type DashboardSourceRow = { channel: string, sessions: number };
export type DashboardReferrerRow = { name: string, visitors: number, isAI: boolean };
export type DashboardTopSources = {
   byChannel: DashboardSourceRow[],
   topReferrers: DashboardReferrerRow[],
   note: string | null,
};

export type DashboardKeywordRow = { keyword: string, position: number, url: string };

export type DashboardRankDistribution = {
   totalKeywords: number,
   inTop3: number,
   inTop10: number,
   onPageOne: number,
   notInTop100: number,
};

export type DashboardAiEngineRow = { engine: string, visitors: number };
export type DashboardAiReferrals = { byEngine: DashboardAiEngineRow[], totalAiVisitors: number, note: string | null };

export type DashboardWebVitals = { metrics: WebVitalMetric[], totalSamples: number, note: string | null };

export type DashboardConversionRow = {
   goal: string,
   conversions: number,
   conversionRatePct: number,
   value: number | null,
};

export type DashboardChange = { kind: 'rank-improved' | 'rank-dropped', keyword: string, from: number, to: number };

export type DashboardSection<T> = { data: T, note: string | null };

export type Dashboard = {
   domain: string,
   period: string,
   headline: DashboardHeadline,
   topPages: DashboardSection<DashboardTopPage[]>,
   topSources: DashboardSection<DashboardTopSources>,
   topKeywords: DashboardSection<DashboardKeywordRow[]>,
   rankDistribution: DashboardSection<DashboardRankDistribution>,
   aiReferrals: DashboardSection<DashboardAiReferrals>,
   webVitals: DashboardSection<DashboardWebVitals>,
   // conversions is null (not an empty section) when no goals are defined, so the
   // renderer and the question selector can cleanly omit the whole pillar.
   conversions: DashboardSection<DashboardConversionRow[]> | null,
   whatChanged: DashboardSection<DashboardChange[]>,
};

/**
 * The compact "state of the data" the question selector reads to decide which
 * questions to surface. Derived from the composed dashboard so selection never
 * re-derives signals the composer already computed.
 */
export type DashboardState = {
   hasTraffic: boolean,
   hasKeywords: boolean,
   hasUnrankedKeywords: boolean,
   hasStrikingDistance: boolean,
   hasAiReferrals: boolean,
   hasGoals: boolean,
   hasWebVitals: boolean,
   hasEntries: boolean,
   isEmpty: boolean,
};

// --- Small local helpers (pure). ---------------------------------------------

/**
 * Parse a keyword's already-parsed history into chronological [date, position]
 * pairs, oldest first, dropping non-positive positions (0 = not in the top 100
 * that day, which would distort a delta). Accepts the loose parsed shape.
 * @param {unknown} history - Parsed history object from parseKeywords.
 * @returns {Array<[string, number]>}
 */
const historyPairs = (history: unknown): Array<[string, number]> => {
   if (!history || typeof history !== 'object' || Array.isArray(history)) { return []; }
   return Object.entries(history as Record<string, unknown>)
      // Normalize the date key to padded ISO so the lexical sort below orders mixed-format history
      // correctly: the old "2026-6-9" form sorts WRONG against padded "2026-06-10" lexically (see
      // utils/history-date.ts). Drop any key that is not a recognizable date.
      .map(([date, pos]) => [normalizeHistoryDateKey(date), Number(pos)] as [string | null, number])
      .filter(([date, pos]) => date !== null && Number.isFinite(pos) && pos > 0)
      .map(([date, pos]) => [date as string, pos] as [string, number])
      .sort((a, b) => a[0].localeCompare(b[0]));
};

/**
 * SerpBear stores a keyword url as a JSON array (best first) or a bare string.
 * Return the single best display url. Pure two-liner local to row building.
 * @param {string} raw - The stored url value.
 * @returns {string}
 */
const firstUrl = (raw: string): string => {
   const s = String(raw || '').trim();
   if (!s) { return ''; }
   try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) { return parsed.length ? String(parsed[0] || '') : ''; }
      if (typeof parsed === 'string') { return parsed; }
      return '';
   } catch {
      return s;
   }
};

/**
 * Compose the single overview object from already-loaded pillar data.
 *
 * Pure and never throws on empty input: every section returns coherent, honest
 * output (with a per-section note) for a brand-new domain. The route is a thin
 * loader + ownership gate; ALL shaping lives here so it is unit-testable without
 * HTTP, mirroring how the rest of the app keeps logic in utils/.
 *
 * @param {DashboardInput} input - Scoped, period-clamped pillar data.
 * @returns {Dashboard}
 */
export const buildDashboard = (input: DashboardInput): Dashboard => {
   const {
      domain, period, keywords, sessions, summary, trafficPages, referralSources, webVitalRows, goals,
   } = input;
   const errors = input.errors || {};

   // ---------------------------------------------------------------------
   // Aggregate provider page rows by clean path FIRST. A provider can return
   // several raw rows that all normalize to one page (e.g. "/" and "/?utm=x").
   // Same join the briefing and scoreboard use.
   // ---------------------------------------------------------------------
   const pvByPath = new Map<string, number>();
   trafficPages.forEach((p) => {
      const path = p.pathClean || cleanPath(p.url || '');
      pvByPath.set(path, (pvByPath.get(path) || 0) + (p.page_views || 0));
   });
   const totalPageviews = Array.from(pvByPath.values()).reduce((a, b) => a + b, 0);

   // Entries per landing page come from first-party HUMAN sessions (the
   // acquisition surface). Bots are excluded so the entry count is the real
   // landing picture, matching how human-analytics frames it. Empty map when
   // there are no human sessions.
   const entriesByPath = new Map<string, number>();
   sessions.filter((s) => !s.isBot).forEach((s) => {
      const path = cleanPath(s.landingPage || '');
      if (!path) { return; }
      entriesByPath.set(path, (entriesByPath.get(path) || 0) + 1);
   });

   // ===== topPages: top N by pageviews, with entries joined in. =============
   const allPaths = new Set<string>([...pvByPath.keys(), ...entriesByPath.keys()]);
   const topPagesData: DashboardTopPage[] = Array.from(allPaths)
      .map((path) => ({ path, pageviews: pvByPath.get(path) || 0, entries: entriesByPath.get(path) || 0 }))
      .sort((a, b) => (b.pageviews - a.pageviews) || (b.entries - a.entries))
      .slice(0, TOP_PAGES);
   const topPagesNote = topPagesData.length === 0
      ? 'No page traffic measured yet. Install the s33k.js tracking script (or connect analytics) so per-page views flow in.'
      : null;

   // ===== topSources: sessions by channel + the top specific referrers. =====
   // Human sessions only: the source breakdown is about real visitors, not bots.
   const channelCounts = new Map<string, number>();
   sessions.filter((s) => !s.isBot).forEach((s) => { channelCounts.set(s.channel, (channelCounts.get(s.channel) || 0) + 1); });
   const byChannel: DashboardSourceRow[] = Array.from(channelCounts.entries())
      .map(([channel, count]) => ({ channel, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, TOP_SOURCES);
   // Specific referrers (named hosts/engines) come from the provider referral
   // list, which carries visitor counts and the AI tag. Direct/blank entries are
   // skipped so the list is actual external sources, not the "direct" bucket.
   const referrerRows: DashboardReferrerRow[] = referralSources
      .filter((s) => {
         const n = String(s.name || '').trim().toLowerCase();
         return n && n !== 'direct' && n !== '(direct)' && n !== '(none)' && n !== 'none';
      })
      .map((s) => ({ name: s.name, visitors: Number(s.unique_visitors ?? 0), isAI: Boolean(s.isAI) }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, TOP_REFERRERS);
   let sourcesNote: string | null = null;
   if (byChannel.length === 0 && referrerRows.length === 0) {
      sourcesNote = errors.referrals
         ? `Source data unavailable this period (${errors.referrals}).`
         : 'No session sources yet. Once visitors arrive, this shows where they came from (direct, search, referral, AI).';
   }
   const topSourcesData: DashboardTopSources = { byChannel, topReferrers: referrerRows, note: sourcesNote };

   // ===== topKeywords: best-ranked tracked keywords, best first. ============
   const ranked = keywords.filter((k) => typeof k.position === 'number' && k.position > 0);
   const topKeywordsData: DashboardKeywordRow[] = [...ranked]
      .sort((a, b) => a.position - b.position)
      .slice(0, TOP_KEYWORDS)
      .map((k) => ({ keyword: k.keyword, position: k.position, url: firstUrl(k.url) }));
   let topKeywordsNote: string | null = null;
   if (keywords.length === 0) {
      topKeywordsNote = 'No keywords tracked yet. Add keywords (ideally with a target_page) to start tracking Google rank.';
   } else if (ranked.length === 0) {
      topKeywordsNote = 'Keywords are tracked but none have a live rank yet. They rank after the next scrape, or are outside the top 100.';
   }

   // ===== rankDistribution: mirrors seo-report's bucket logic exactly. ======
   // Buckets are NOT mutually exclusive (top3 also counts in top10/pageOne),
   // matching how a marketer reads "N in the top 3, N in the top 10". notInTop100
   // (position 0) is the disjoint tail.
   let inTop3 = 0; let inTop10 = 0; let onPageOne = 0; let notInTop100 = 0;
   keywords.forEach((k) => {
      const pos = Number(k.position) || 0;
      if (pos === 0) { notInTop100 += 1; return; }
      if (pos <= 3) { inTop3 += 1; }
      if (pos <= 10) { inTop10 += 1; onPageOne += 1; }
   });
   const rankDistData: DashboardRankDistribution = {
      totalKeywords: keywords.length, inTop3, inTop10, onPageOne, notInTop100,
   };
   const rankDistNote = keywords.length === 0
      ? 'No tracked keywords yet, so there is no rank distribution.'
      : null;

   // ===== aiReferrals: AI-engine visitor counts (reuse the classifier). =====
   // Prefer the provider's isAI tag; fall back to classifying the name so
   // referrers that are not pre-tagged as AI still surface AI engines.
   const engineCounts = new Map<string, number>();
   let totalAiVisitors = 0;
   referralSources.forEach((s) => {
      const tagged = s.isAI || classifyReferrer(s.name || '').isAI;
      if (!tagged) { return; }
      const engine = s.engine || classifyReferrer(s.name || '').engine || s.name || 'Unknown AI';
      const v = Number(s.unique_visitors ?? 0);
      engineCounts.set(engine, (engineCounts.get(engine) || 0) + v);
      totalAiVisitors += v;
   });
   const aiByEngine: DashboardAiEngineRow[] = Array.from(engineCounts.entries())
      .map(([engine, visitors]) => ({ engine, visitors }))
      .sort((a, b) => b.visitors - a.visitors);
   let aiNote: string | null = null;
   if (aiByEngine.length === 0) {
      aiNote = errors.referrals
         ? `AI referral data unavailable this period (${errors.referrals}).`
         : 'No measurable visitors from AI answer engines (ChatGPT, Claude, Gemini, Perplexity) this period yet.';
   }
   const aiReferralsData: DashboardAiReferrals = { byEngine: aiByEngine, totalAiVisitors, note: aiNote };

   // ===== webVitals: per-metric p75 + rating (reuse buildWebVitals). ========
   const vitals = buildWebVitals(webVitalRows);
   const webVitalsData: DashboardWebVitals = {
      metrics: vitals.metrics, totalSamples: vitals.totalSamples, note: vitals.note,
   };

   // ===== conversions: each goal's count + rate (omit pillar if no goals). ==
   let conversionsSection: DashboardSection<DashboardConversionRow[]> | null = null;
   if (goals.length > 0) {
      // Human-only denominator, matching goal-analytics' humanOnly default, so a bot-inflated
      // session count never deflates the reported conversion rate.
      const humanSessions = sessions.filter((s) => !s.isBot);
      const totalSessions = humanSessions.length;
      const rows: DashboardConversionRow[] = goals.map((g) => {
         const goalDef: GoalDef = {
            kind: g.kind === 'event' ? 'event' : 'page_reached',
            matchValue: String(g.match_value),
            matchPage: g.match_page || null,
            matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
         };
         const conversions = humanSessions.filter((s) => sessionConverted(s, goalDef)).length;
         const ratePct = totalSessions > 0 ? Math.round((1000 * conversions) / totalSessions) / 10 : 0;
         return { goal: g.name, conversions, conversionRatePct: ratePct, value: g.value };
      }).sort((a, b) => b.conversions - a.conversions);
      const convNote = totalSessions === 0
         ? 'Goals are defined but no first-party sessions arrived this window, so conversion rate cannot be computed yet.'
         : null;
      conversionsSection = { data: rows, note: convNote };
   }

   // ===== whatChanged: the biggest rank movers over tracked history. ========
   type Movement = { keyword: string, from: number, to: number, delta: number };
   const movements: Movement[] = [];
   keywords.forEach((k) => {
      const pairs = historyPairs(k.history);
      if (pairs.length < 2) { return; }
      const from = pairs[0][1];
      const to = pairs[pairs.length - 1][1];
      if (from === to) { return; }
      movements.push({ keyword: k.keyword, from, to, delta: to - from });
   });
   // Most movement (by absolute delta) first; tag direction. Negative delta =
   // climbed toward #1 = improved; positive = dropped.
   const changes: DashboardChange[] = [...movements]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, TOP_MOVERS)
      .map((m) => ({
         kind: m.delta < 0 ? 'rank-improved' : 'rank-dropped',
         keyword: m.keyword,
         from: m.from,
         to: m.to,
      }));
   const changedNote = changes.length === 0
      ? 'Not enough rank history yet to show movement. Changes appear once keywords have been tracked across multiple scrapes.'
      : null;

   // ===== headline: a tiny "state of the site" summary the LLM leads with. ==
   const humanVisitors = humanBotSplit(sessions).human
      || (summary && !errors.summary ? (summary.visitors || 0) : 0);
   // The single best opportunity: a high-traffic page whose best keyword does
   // not rank on page one, or that has no tracked keyword at all.
   const keywordsByPath = new Map<string, DashboardKeyword[]>();
   keywords.forEach((k) => {
      const target = cleanPath(k.target_page || '');
      if (!target) { return; }
      const list = keywordsByPath.get(target) || [];
      list.push(k);
      keywordsByPath.set(target, list);
   });
   let topOpportunity: string | null = null;
   const sortedPages = topPagesData.filter((p) => p.pageviews > 0);
   for (const p of sortedPages) {
      const covering = keywordsByPath.get(p.path) || [];
      const positions = covering.map((k) => k.position).filter((x) => typeof x === 'number' && x > 0);
      const best = positions.length ? Math.min(...positions) : null;
      if (covering.length === 0) {
         topOpportunity = `${p.path} earns ${p.pageviews} pageviews but has no tracked keyword. Add one to start ranking it.`;
         break;
      }
      if (best !== null && best > GOOD_RANK_MAX) {
         topOpportunity = `${p.path} earns ${p.pageviews} pageviews but its best keyword only ranks #${best}. `
            + 'Pushing it onto page one compounds traffic it already gets.';
         break;
      }
   }
   // The single highest-leverage action, derived from the strongest signal.
   const strikingCount = ranked.filter((k) => k.position > GOOD_RANK_MAX && k.position <= 20).length;
   let topAction: string | null = null;
   if (topOpportunity) {
      topAction = 'Capture the top opportunity page above by adding/improving its tracked keyword, then ask insights for the full list.';
   } else if (strikingCount > 0) {
      topAction = `${strikingCount} keyword(s) sit in striking distance (positions 11-20), the cheapest rank wins. `
         + 'Ask striking_distance for the quick-win list.';
   } else if (totalAiVisitors > 0) {
      topAction = 'AI engines are already sending you visitors. Ask ai_referrals to see which engines, then keep those pages fresh.';
   } else if (keywords.length === 0) {
      topAction = 'Add your first keywords so s33k can track rank, then ask discover_pages to find pages worth targeting.';
   } else if (humanVisitors === 0 && totalPageviews === 0) {
      topAction = 'Install the s33k.js tracking script so traffic, sources, and conversions start flowing in.';
   } else {
      topAction = 'No urgent gap this period. Ask weekly_digest for what changed, or widen the window (period=90d).';
   }

   const headline: DashboardHeadline = {
      humanVisitors,
      aiReferredVisitors: totalAiVisitors,
      topOpportunity,
      topAction,
   };

   return {
      domain,
      period,
      headline,
      topPages: { data: topPagesData, note: topPagesNote },
      topSources: { data: topSourcesData, note: null },
      topKeywords: { data: topKeywordsData, note: topKeywordsNote },
      rankDistribution: { data: rankDistData, note: rankDistNote },
      aiReferrals: { data: aiReferralsData, note: aiNote },
      webVitals: { data: webVitalsData, note: vitals.note },
      conversions: conversionsSection,
      whatChanged: { data: changes, note: changedNote },
   };
};

/**
 * Derive the compact DashboardState the question selector reads. Pure: it only
 * inspects an already-composed dashboard, so selection cannot drift from what the
 * composer found.
 * @param {Dashboard} d - A composed dashboard.
 * @returns {DashboardState}
 */
export const deriveDashboardState = (d: Dashboard): DashboardState => {
   const totalPageviews = d.topPages.data.reduce((a, p) => a + p.pageviews, 0);
   const hasTraffic = d.headline.humanVisitors > 0 || totalPageviews > 0;
   const hasKeywords = d.rankDistribution.data.totalKeywords > 0;
   const hasUnrankedKeywords = d.rankDistribution.data.notInTop100 > 0
      || (hasKeywords && d.topKeywords.data.length === 0);
   const hasStrikingDistance = d.rankDistribution.data.onPageOne < d.rankDistribution.data.totalKeywords
      && d.rankDistribution.data.totalKeywords > 0;
   const hasAiReferrals = d.aiReferrals.data.totalAiVisitors > 0;
   const hasGoals = d.conversions !== null;
   const hasWebVitals = d.webVitals.data.totalSamples > 0;
   const hasEntries = d.topPages.data.some((p) => p.entries > 0);
   const isEmpty = !hasTraffic && !hasKeywords && !hasAiReferrals && !hasGoals && !hasWebVitals;
   return {
      hasTraffic,
      hasKeywords,
      hasUnrankedKeywords,
      hasStrikingDistance,
      hasAiReferrals,
      hasGoals,
      hasWebVitals,
      hasEntries,
      isEmpty,
   };
};
