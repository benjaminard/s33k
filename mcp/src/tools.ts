/**
 * s33k MCP tool + resource registrations (SHARED).
 *
 * This module is the single source of truth for the 73 tools and the knowledge resources the
 * s33k MCP server exposes. It is consumed by TWO transports:
 *   1. mcp/src/index.ts        the stdio entry, bound to process.env.S33K_API_KEY (local install).
 *   2. pages/api/mcp/[[...slug]].ts   the hosted Streamable HTTP endpoint, bound PER REQUEST to the
 *      connecting client's own Bearer key, so the s33k API authorize() enforces that key's scope.
 *
 * SECURITY CRUX: every tool calls the injected `fetchImpl(path, opts)`, NEVER a hardcoded key.
 * The hosted transport injects a fetchImpl carrying ONLY the connecting client's key, so a scoped
 * share key (ApiKey.scoped_domain set) can reach nothing the real API would not already let it.
 * There is no admin/server key path inside any tool handler.
 *
 * The handler bodies below are byte-for-byte the originals from the stdio server; they reference a
 * local `s33kFetch` (aliased to fetchImpl), `jsonResult`, `errorResult`, and `z`, so the extraction
 * required no per-tool edits. The knowledge-coverage jest guard parses the tool-registration calls
 * out of THIS module (it now reads tools.ts), keeping the 73-tool count and the smoke EXPECTED_TOOLS
 * list in lockstep with what is registered here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * A fetch implementation injected by each transport. Same contract as the original s33kFetch:
 * call the s33k REST API and return the parsed JSON body, throwing on non-2xx so each tool can
 * surface the error. The KEY the call carries is the transport's concern, never the tool's.
 */
export type FetchImpl = (
   path: string,
   options?: { method?: string; query?: Record<string, string>; body?: unknown },
) => Promise<any>;

/** Wrap any value as a single text content block of pretty JSON. */
export function jsonResult(value: unknown) {
   return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Wrap an error as an MCP tool error result rather than throwing out of the handler. */
export function errorResult(err: unknown) {
   const message = err instanceof Error ? err.message : String(err);
   return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/**
 * The knowledge resources exposed alongside the tools. Defined here (rather than inside the
 * registration function) so a transport can read the count for a startup banner without
 * re-deriving it. The registration loop below consumes this same array.
 */
export const KNOWLEDGE_RESOURCES: { uri: string; topic: string; name: string; description: string }[] = [
   {
      uri: 'knowledge://capabilities',
      topic: '',
      name: 'All s33k capabilities',
      description: 'Every s33k MCP tool with what it does, when to use it, and an example prompt, grouped by pillar '
         + '(SEO, AEO, analytics, cross-pillar, onboarding, account, security).',
   },
   {
      uri: 'knowledge://setup',
      topic: 'setup',
      name: 'Setup and installation',
      description: 'How to install s33k, reach value in five minutes, add the tracking code per platform, and connect '
         + 'Google Search Console.',
   },
   {
      uri: 'knowledge://reasoning',
      topic: 'reasoning',
      name: 'Design reasoning',
      description: 'Why s33k is built the way it is: MCP-first control, Serper for rankings, cookieless first-party analytics,'
         + 'the single-user self-hosted design, no-model-training, open source.',
   },
   {
      uri: 'knowledge://troubleshooting',
      topic: 'troubleshooting',
      name: 'Troubleshooting',
      description: 'Fixes for common issues: rankings showing 0, an empty AI funnel, zero analytics, '
         + 'and Search Console not connected.',
   },
   {
      uri: 'knowledge://trust',
      topic: 'trust',
      name: 'Trust and security',
      description: 's33k\'s complete, source-cited trust facts: no model training, single-user (no other accounts), encryption at rest, '
         + 'data ownership, open-source/self-hostable, cookieless/no-PII tracking.',
   },
];

/**
 * Register all 73 s33k tools and the knowledge resources on the given MCP server, routing every
 * underlying API call through `fetchImpl`. Returns the number of tools registered (for banners).
 */
export function registerS33kTools(server: McpServer, fetchImpl: FetchImpl): { tools: number; resources: number } {
   // Alias so the extracted handler bodies (which call s33kFetch) use the injected impl unchanged.
   const s33kFetch = fetchImpl;

   // Single-user: there is no customer-vs-admin surface split and no billing. Every tool below is a
   // customer self-serve tool operating on the one user's own SEO / analytics / AEO data.

// ---------------------------------------------------------------------------
// start_here  (the guided entry point: call this FIRST)
// ---------------------------------------------------------------------------
server.registerTool(
   'start_here',
   {
      title: 'Start here: the 5-minutes-to-value tour (call this FIRST)',
      description:
         'Call this FIRST. The 5-minutes-to-value tour: if a site is not set up it walks you through installing s33k; once set '
         + 'up it shows your 3 prebuilt reports (Analytics, SEO, AI-search) with your own numbers, the data you now have, and '
         + 'the exact questions you can ask. Start here. With no domain it resolves which site to use (one tracked -> uses it; '
         + 'many -> mode "pick-domain" with the list; none -> mode "no-domain"). If setup is incomplete it returns mode "setup" '
         + 'with the checklist, percentComplete, the single next step, the INSTALL snippet plus per-platform steps (installing '
         + 'the tracking script is the gating step), and a preview of what each report unlocks, then stops rather than dumping '
         + 'analytics on a half-set-up site. When the site is set up it returns mode "ready" with a one-line headline, the 3 '
         + 'reports each with a LIVE teaser of your own numbers and the tool to run it, whatYouCanSee (the data surfaces you '
         + 'now have), questionsYouCanAsk (concrete natural-language questions), the single top action, a curated nextSteps '
         + 'list (entry_pages for which pages AI search lands on, striking_distance for the quickest SEO wins, dashboard for '
         + 'the full overview), and a ready-to-show rendered tour. Every response also carries a MODULES block (Analytics: live '
         + 'once beacon events flow; AI referrals: live with analytics; SEO: enabled only when a SERP scraper key is configured, '
         + 'otherwise "not enabled" with the mint_key_drop enablement path). A keyless instance with flowing analytics is HEALTHY '
         + 'with the SEO module off, not incomplete. Composes existing data (dashboard + setup + reports); never queries an LLM; '
         + 'never fails, every mode is a usable next move.',
      inputSchema: {
         domain: z.string().optional().describe('The domain to start on, e.g. "example.com". Omit to pick from your tracked domains.'),
      },
   },
   async ({ domain }) => {
      try {
         const query: Record<string, string> = {};
         if (domain) { query.domain = domain; }
         const data = await s33kFetch('/api/start-here', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

server.registerTool(
   'list_domains',
   {
      title: 'List domains',
      description:
         'List every domain tracked in s33k, each with its name and settings. Use this first to discover which domains exist before calling any domain-scoped tool.',
      inputSchema: {},
   },
   async () => {
      try {
         const data = await s33kFetch('/api/domains');
         return jsonResult(data.domains ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// list_keywords
// ---------------------------------------------------------------------------
server.registerTool(
   'list_keywords',
   {
      title: 'List keywords',
      description:
         'List a domain\'s tracked keywords with each keyword\'s current Google rank, ranking URL, target page, and last-7-days rank history. Use this to read SEO standings, get keyword IDs for update_keyword or delete_keyword, or check whether a keyword has scraped yet.',
      inputSchema: {
         domain: z.string().describe('The domain to list keywords for, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/keywords', { query: { domain } });
         const keywords = (data.keywords ?? []).map((k: any) => ({
            ID: k.ID,
            keyword: k.keyword,
            device: k.device,
            country: k.country,
            position: k.position,
            url: k.url,
            target_page: k.target_page ?? '',
            history: k.history,
         }));
         return jsonResult(keywords);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// add_keyword
// ---------------------------------------------------------------------------
server.registerTool(
   'add_keyword',
   {
      title: 'Add keyword',
      description:
         'Add one keyword to track for a domain and queue a background Google SERP scrape, so its rank appears shortly after. Use this to start tracking a search term, ideally passing target_page so the keyword joins to a page in page_scoreboard. To add many keywords at once, call this tool once per keyword.',
      inputSchema: {
         keyword: z.string().describe('The search keyword/phrase to track.'),
         domain: z.string().describe('The domain to track this keyword for, e.g. "example.com".'),
         country: z
            .string()
            .default('US')
            .describe('Two-letter country code for the search, e.g. "US". Defaults to "US".'),
         device: z
            .enum(['desktop', 'mobile'])
            .default('desktop')
            .describe('Device to track rankings for. Defaults to "desktop".'),
         target_page: z
            .string()
            .optional()
            .describe('Optional target page path/URL this keyword should rank for, e.g. "/software/mcp".'),
      },
   },
   async ({ keyword, domain, country, device, target_page }) => {
      try {
         const payload = {
            keywords: [
               {
                  keyword,
                  domain,
                  country,
                  device,
                  target_page: target_page ?? '',
               },
            ],
         };
         const data = await s33kFetch('/api/keywords', { method: 'POST', body: payload });
         return jsonResult(data.keywords ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// refresh_keywords
// ---------------------------------------------------------------------------
server.registerTool(
   'refresh_keywords',
   {
      title: 'Refresh keywords',
      description:
         'Re-scrape live Google rankings for keywords that may be stale. Pass either a list of keyword IDs or a single domain to refresh all of its keywords, but not both. A small batch scrapes synchronously and returns updated ranks; a larger batch runs in the background, so re-read with list_keywords shortly after.',
      inputSchema: {
         ids: z
            .array(z.number().int())
            .optional()
            .describe('Keyword IDs to refresh. Use this OR "domain", not both.'),
         domain: z
            .string()
            .optional()
            .describe('Refresh every keyword for this domain. Use this OR "ids", not both.'),
      },
   },
   async ({ ids, domain }) => {
      try {
         if ((!ids || ids.length === 0) && !domain) {
            return errorResult(new Error('Provide either "ids" (one or more keyword IDs) or "domain".'));
         }
         let query: Record<string, string>;
         if (ids && ids.length > 0) {
            query = { id: ids.join(',') };
         } else {
            query = { id: 'all', domain: domain as string };
         }
         const data = await s33kFetch('/api/refresh', { method: 'POST', query });
         return jsonResult(data.keywords ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// get_insight
// ---------------------------------------------------------------------------
server.registerTool(
   'get_insight',
   {
      title: 'Get Search Console insight',
      description:
         'Read Google Search Console insight for a domain: its top pages, top keywords, top countries, and aggregate stats. Use this for real impression and click data straight from Google, beyond the keywords you explicitly track. Requires Search Console to be connected for the domain in s33k, otherwise it returns an error.',
      inputSchema: {
         domain: z.string().describe('The domain to get insight for, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/insight', { query: { domain } });
         return jsonResult(data.data ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// connect_search_console
// ---------------------------------------------------------------------------
server.registerTool(
   'connect_search_console',
   {
      title: 'Connect Google Search Console',
      description:
         'Start the click-to-authorize Google Search Console connection for a domain you own. Returns a Google consent link to open and approve, '
         + 'plus a one-line instruction to show the user. Once approved, get_insight returns the real queries each page actually ranks for, the '
         + 'authoritative answer to "what am I ranking for". This replaces pasting a service-account JSON. Connecting requires write access to the '
         + 'domain. If the instance has no GSC OAuth app configured, the response says so.',
      inputSchema: {
         domain: z.string().describe('The domain to connect Google Search Console for, e.g. "example.com". You must own it.'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/searchconsole/connect', { query: { domain } });
         if (data && data.authUrl) {
            return jsonResult({
               authUrl: data.authUrl,
               instruction: 'Open this link to connect Google Search Console, approve access, then come back.',
               details: data.instructions,
            });
         }
         // No authUrl means OAuth is not configured (or another soft error); surface the message.
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// page_scoreboard
// ---------------------------------------------------------------------------
server.registerTool(
   'page_scoreboard',
   {
      title: 'Page scoreboard',
      description:
         'Join per-page traffic with tracked keywords for a domain, the core SEO-plus-analytics view. Use this to see which pages earn traffic, what each ranks for, and where the gaps are. Returns a per-page scoreboard (traffic plus the keywords targeting each page, sorted by page views), pages that have traffic but no tracked keyword (a content-gap signal), and keywords whose target page matched no analytics page. Each page row also carries aiReferralVisitors (AI-engine-referred visitors that landed on that page); this is EXACT from first-party sessions when the s33k.js tracking script is installed, and falls back to a provider landing_path or 0 (aiReferralNote explains) otherwise. OPTIONAL goal parameter: pass a goal name or goalId to add per-page conversions (goal conversions whose first-party session LANDED on that page) and conversionRate (over first-party sessions that landed there, percent) to every page row; conversionsNote explains the denominators and conversionRate is null on a page with no first-party landing sessions. Omit goal and the scoreboard is unchanged (no conversion fields). Per-page bounce_rate and avg_duration may be null when s33k\'s analytics engine cannot report them at page grain; metricsNote explains the null.',
      inputSchema: {
         domain: z.string().describe('The domain to build the scoreboard for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window for analytics, e.g. "30d", "7d". Defaults to "30d".'),
         goal: z
            .string()
            .optional()
            .describe('OPTIONAL goal name to add per-page conversions + conversionRate. Get goal names from list_goals. Mutually exclusive with goalId.'),
         goalId: z
            .string()
            .optional()
            .describe('OPTIONAL goal id (numeric) to add per-page conversions + conversionRate, instead of goal name. Get ids from list_goals.'),
      },
   },
   async ({ domain, period, goal, goalId }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId) { query.goalId = goalId; }
         const data = await s33kFetch('/api/scoreboard', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// entry_pages
// ---------------------------------------------------------------------------
server.registerTool(
   'entry_pages',
   {
      title: 'Entry page analysis: which pages AI search (and every source) lands on',
      description:
         'Answers "which pages did AI search land on" with EXACT per-page counts, and more broadly which landing pages each traffic source first '
         + 'hits. Analyze a domain\'s ENTRY (landing) pages, where sessions START and acquisition actually happens, and behave differently from '
         + 'deeper pages. This is the cross-pillar join nobody else offers: for each entry page it connects "we rank for X" to "X actually LANDS '
         + 'people". Per entry page it returns the first-touch SOURCE split (direct / referral / search / ai), the page\'s tracked keywords with '
         + 'current Google rank, its aiReferrals (AI-search-first entries that landed on that page), and a STATUS: "working" (ranks AND is a real '
         + 'landing page from search), "ranking-not-landing" (s33k tracks ranking keywords for it but it gets little or no entry traffic, the '
         + 'clearest gap to fix), "brand-direct" (lots of direct/referral entries but no tracked ranking, brand-driven not search-driven), '
         + '"ai-landing" (AI search is a meaningful first-touch source for the page), or "opportunity" (entry traffic but neither ranking nor AI, '
         + 'where to invest). Also returns a summary (topLandingPages, biggestRankingNotLandingGap, aiLandingPages, statusCounts) and a statusLegend. '
         + 'AI-LANDING COUNTS ARE EXACT: per-page aiReferrals is the exact count of AI-search-first sessions that landed on each page, computed from '
         + 's33k\'s own first-party sessions (install the s33k.js tracking script); aiReferralNote clears when this exact data is present, and only '
         + 'falls back to a provider landing_path or 0 when there are no first-party AI sessions yet. The per-page entry counts and tracked ranks are '
         + 'also exact. HONEST DATA NOTE: the four-way source SPLIT per page is still APPROXIMATED from the site-wide referrer mix when s33k\'s analytics engine '
         + 'only reports referrers site-wide (sourcesNote flags this). RESPONSE IS SUMMARY-FIRST AND BOUNDED BY DEFAULT: the summary '
         + '(topLandingPages, biggestRankingNotLandingGap, aiLandingPages, statusCounts) covers ALL pages, while the entryPages array returns only the '
         + 'top 20 by entries (see meta.truncated / meta.totalEntryPages). Pass detail=true for every row, or limit=N (1..200) to change the cap. '
         + 'Complements page_scoreboard (all pages) by focusing only on entry pages. Never queries an LLM; degrades gracefully and never fails on a '
         + 'missing sub-signal.',
      inputSchema: {
         domain: z.string().describe('The domain to analyze entry pages for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window for analytics, e.g. "30d", "7d". Defaults to "30d".'),
         limit: z
            .number()
            .optional()
            .describe('Max entry pages returned in the entryPages array, top-N by entries. Clamps to 1..200. Defaults to 20. The summary always covers all pages.'),
         detail: z
            .boolean()
            .optional()
            .describe('Set true to return the FULL per-page entryPages array (can be thousands of rows on a real site). Default false returns the bounded top-N.'),
      },
   },
   async ({ domain, period, limit, detail }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (typeof limit === 'number') { query.limit = String(limit); }
         if (detail) { query.detail = 'true'; }
         const data = await s33kFetch('/api/entry-pages', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// ai_referrals
// ---------------------------------------------------------------------------
server.registerTool(
   'ai_referrals',
   {
      title: 'AI referrals',
      description:
         'Report which AI engines (ChatGPT, Perplexity, Gemini, Claude, Copilot, and more) are sending real visitors to a domain. Use this to measure AEO outcomes: actual traffic that AI answer engines drove. It reads analytics REFERRAL data and never queries an LLM. Returns a per-engine breakdown (visitors, sorted by visitors) plus totals: AI visitors, all referred visitors, and the AI share of referred traffic.',
      inputSchema: {
         domain: z.string().describe('The domain to report AI referrals for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window for analytics, e.g. "90d", "30d". Defaults to "90d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/ai-referrals', { query });
         return jsonResult({ byEngine: data.byEngine, totals: data.totals, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// ai_visibility
// ---------------------------------------------------------------------------
server.registerTool(
   'ai_visibility',
   {
      title: 'AI visibility',
      description:
         'Measure a domain\'s standing in AI search (ChatGPT, Claude, Perplexity, Gemini, Copilot, and more) using ONLY '
         + 'first-party, un-gameable behavior s33k already records: which AI engines actually REFER traffic. It never '
         + 'queries an LLM and never asks an AI engine whether it cites the site, so the signal cannot be gamed. Use this '
         + 'to answer "how visible am I in AI search, and where is the gap?" Returns: pages[] each with a status of '
         + '"ai-cited" (an AI engine referred visitors to the page) or "not-cited" (no AI referral for the page yet); '
         + 'engines[] each with a status of "advocate" (refers traffic) or "absent"; and a summary (totalAIReferrals, '
         + 'topAdvocate engine). Read not-cited pages as the work to do. Note: when the first-party data has '
         + 'referrals only site-wide (no landing page), per-page isCited cannot be attributed, so pages show '
         + 'isCited=false while engine-level referrals and the totals stay accurate (the note field flags this). When '
         + 'first-party referral data is thin, the response also includes a deterministic citabilityAudit that fetches '
         + 'the top pages and scores their AI-readiness (llms.txt, Markdown twins, JSON-LD, answer-shaped content) as a '
         + 'leading indicator. This complements ai_referrals (raw referral detail) by adding the per-page view and the '
         + 'citability audit.',
      inputSchema: {
         domain: z.string().describe('The domain to measure AI-search visibility for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/ai-visibility', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// traffic_summary
// ---------------------------------------------------------------------------
server.registerTool(
   'traffic_summary',
   {
      title: 'Traffic summary',
      description:
         'Get site-wide traffic totals for a domain over a window: pageviews, unique visitors, visits, bounce rate (percent), average visit duration (seconds), and pages per visit. The visitors total here is the RAW provider total and INCLUDES bots; for the real human number use start_here / dashboard / human_traffic (datacenter-filtered). This tool also returns visitorsRaw and humanVisitors side by side, plus a note when they diverge by more than 25 percent. Use this for the one-line health check of a site before drilling into traffic_breakdown, traffic_timeseries, or page_scoreboard. For a guided overview call start_here first.',
      inputSchema: {
         domain: z.string().describe('The domain to summarize, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/summary', { query });
         return jsonResult({
            summary: data.summary,
            visitorsRaw: data.visitorsRaw,
            humanVisitors: data.humanVisitors,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// human_traffic
// ---------------------------------------------------------------------------
server.registerTool(
   'human_traffic',
   {
      title: 'Human vs bot traffic estimate',
      description:
         'Report how much of a domain\'s traffic is humans versus bots. Use this to sanity-check the other traffic numbers, because JavaScript pageview trackers count JavaScript-executing cloud scrapers as real visitors (for example heavy Hong Kong, Singapore, and China datacenter traffic at near-100 percent bounce). The split comes from FIRST-PARTY tracking: each session\'s source IP is classified as datacenter-or-not at ingest (the is_bot signal a JS pageview tracker cannot see), so cloud scrapers are filtered instead of counted. This makes the number EXACT for the first-party sessions it has, and identical to human_analytics, start_here, and the dashboard headline (one source of truth). Returns estVisitors, estHumanVisitors, estBotVisitors, botSharePct, botEstimationAvailable, and method. If no first-party sessions have arrived yet (the s33k.js script is not installed), botEstimationAvailable is false and the bot split is omitted rather than guessed: install s33k.js to populate it.',
      inputSchema: {
         domain: z.string().describe('The domain to estimate human vs bot traffic for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/human-traffic', { query });
         return jsonResult({ estimate: data.estimate, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// human_analytics
// ---------------------------------------------------------------------------
server.registerTool(
   'human_analytics',
   {
      title: 'Human-only analytics (bots excluded), with exit and bounce rate',
      description:
         'Human-only traffic analytics computed from s33k\'s OWN first-party pageview events, with '
         + 'datacenter/bot traffic EXCLUDED by default. This does the one thing a JavaScript pageview '
         + 'tracker cannot: it classifies each pageview\'s source IP as datacenter/hosting '
         + 'or not at ingest (the is_bot flag), so JavaScript-executing scrapers running in the cloud '
         + 'are filtered out instead of counted as visitors. Returns visitors, pageviews, '
         + 'pagesPerSession, bounceRatePct, entryPages (each session\'s first pageview with share), and '
         + 'exitPages WITH exitRatePct (each session\'s last pageview; the exit-rate metric the '
         + 'standard analytics summary cannot produce), plus botVisitorsFiltered and botSharePct for '
         + 'transparency. Requires the s33k.js tracking script to be installed on the site (pageviews '
         + 'flow into /api/collect). Pass includeBots=true to see the raw with-bots numbers for comparison.',
      inputSchema: {
         domain: z.string().describe('The domain to report human-only analytics for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "24h". Defaults to "30d".'),
         includeBots: z
            .boolean()
            .optional()
            .describe('When true, include datacenter/bot pageviews in the numbers (raw view). Defaults to human-only.'),
      },
   },
   async ({ domain, period, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/human-analytics', { query });
         return jsonResult({
            summary: data.summary,
            entryPages: data.entryPages,
            exitPages: data.exitPages,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// create_goal
// ---------------------------------------------------------------------------
server.registerTool(
   'create_goal',
   {
      title: 'Create a named conversion goal',
      description:
         'Define a NAMED conversion to track, e.g. "Demo Booked" or "Newsletter Signup". Two kinds: '
         + 'kind="page_reached" fires when a session views a page whose path matches matchValue (a '
         + 'thank-you / destination page, e.g. "/demo/thanks"; prefix match by default, set '
         + 'matchMode="exact" for an exact path); kind="event" fires when a session triggers an '
         + 'autocaptured event of type matchValue (e.g. "form_submit"), optionally constrained to a '
         + 'page via matchPage. Once a goal exists, goal_analytics reports its conversion rate, filtered '
         + 'and grouped any way.',
      inputSchema: {
         domain: z.string().describe('The domain the goal belongs to, e.g. "example.com".'),
         name: z.string().describe('The goal name used in questions, e.g. "Demo Booked".'),
         kind: z.enum(['page_reached', 'event']).describe('"page_reached" (a path was viewed) or "event" (an event fired).'),
         matchValue: z.string().describe('page_reached: the path/prefix (e.g. "/demo/thanks"). event: the event type (e.g. "form_submit").'),
         matchPage: z.string().optional().describe('event kind only: restrict the event to a page path (prefix).'),
         matchMode: z.enum(['prefix', 'exact']).optional().describe('page_reached only: path match mode. Defaults to "prefix".'),
      },
   },
   async ({ domain, name, kind, matchValue, matchPage, matchMode }) => {
      try {
         const body: Record<string, unknown> = { domain, name, kind, matchValue };
         if (matchPage) { body.matchPage = matchPage; }
         if (matchMode) { body.matchMode = matchMode; }
         const data = await s33kFetch('/api/goals', { method: 'POST', body });
         return jsonResult({ goal: data.goal, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// list_goals
// ---------------------------------------------------------------------------
server.registerTool(
   'list_goals',
   {
      title: 'List conversion goals',
      description: 'List the named conversion goals defined for a domain, with their match rules.',
      inputSchema: {
         domain: z.string().describe('The domain whose goals to list, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/goals', { query: { domain } });
         return jsonResult({ goals: data.goals, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// delete_goal
// ---------------------------------------------------------------------------
server.registerTool(
   'delete_goal',
   {
      title: 'Delete a conversion goal',
      description: 'Delete a named conversion goal by its id (get ids from list_goals).',
      inputSchema: {
         id: z.number().describe('The goal id to delete.'),
      },
   },
   async ({ id }) => {
      try {
         const data = await s33kFetch('/api/goals', { method: 'DELETE', query: { id: String(id) } });
         return jsonResult({ removed: data.removed, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// goal_analytics
// ---------------------------------------------------------------------------
server.registerTool(
   'goal_analytics',
   {
      title: 'Conversion analytics for a goal (filtered + grouped)',
      description:
         'Conversion rate and counts for a named goal, computed from first-party sessions, with a '
         + 'composable filter and groupBy vocabulary. This answers the real questions: '
         + '"conversion rate for <goal> human-only" (default), "how many AI referrals converted" '
         + '(channel="ai"), "compare conversion rate by source" (groupBy="channel"), and "of '
         + 'converters, the most common landing page" (groupBy="landingPage", read the top group). '
         + 'Filters: channel (direct|referral|organic-search|ai; aliases seo/aio accepted), '
         + 'landingPage, page, device (mobile|tablet|desktop), country (ISO), engagement '
         + '(engaged|bounced). Human-only by default; includeBots=true to fold bots in. Returns '
         + 'totalSessions, conversions, conversionRatePct, and (with groupBy) per-group rates.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         goal: z.string().optional().describe('The goal NAME (or pass goalId). e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('The goal id (alternative to goal name).'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         groupBy: z.enum(['channel', 'landingPage', 'exitPage', 'device', 'country']).optional()
            .describe('Break the conversion rate down by this dimension.'),
         channel: z.string().optional().describe('Filter to a traffic channel: direct, referral, organic-search/seo, ai/aio.'),
         landingPage: z.string().optional().describe('Filter to sessions whose landing page is this exact path.'),
         page: z.string().optional().describe('Filter to sessions that viewed this path.'),
         device: z.string().optional().describe('Filter by device: mobile, tablet, or desktop.'),
         country: z.string().optional().describe('Filter by ISO country code (where geo data is available).'),
         engagement: z.enum(['engaged', 'bounced']).optional().describe('Filter by engagement quality.'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, goal, goalId, period, groupBy, channel, landingPage, page, device, country, engagement, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (period) { query.period = period; }
         if (groupBy) { query.groupBy = groupBy; }
         if (channel) { query.channel = channel; }
         if (landingPage) { query.landingPage = landingPage; }
         if (page) { query.page = page; }
         if (device) { query.device = device; }
         if (country) { query.country = country; }
         if (engagement) { query.engagement = engagement; }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/goal-analytics', { query });
         return jsonResult({
            goal: data.goal,
            totalSessions: data.totalSessions,
            conversions: data.conversions,
            conversionRatePct: data.conversionRatePct,
            groupBy: data.groupBy,
            groups: data.groups,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// conversion_attribution
// ---------------------------------------------------------------------------
server.registerTool(
   'conversion_attribution',
   {
      title: 'What drives conversions across SEO, direct, and AI (the cross-pillar join)',
      description:
         'The merged-pillar view only s33k can produce: for a named goal, it attributes the goal\'s '
         + 'conversions across all three channels at once. Returns byChannel (conversion rate per '
         + 'acquisition source, including AI search versus organic search versus direct, the "does AI '
         + 'actually convert" answer no other tool has), byKeyword (each tracked keyword credited with '
         + 'the conversions its target page drove, with the keyword\'s Google rank, so keywords rank by '
         + 'CONVERSIONS not clicks), and opportunities (the money moves: pages that rank but do not '
         + 'convert, pages that convert but do not rank, and where AI out-converts search). Human-only '
         + 'by default; the same composable filters apply. Requires the tracking script installed and '
         + 'at least one goal.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         goal: z.string().optional().describe('The goal NAME (or pass goalId), e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('The goal id (alternative to goal name).'),
         period: z.string().optional().describe('Reporting window, e.g. "30d". Defaults to "30d".'),
         channel: z.string().optional().describe('Optional filter to one channel: direct, referral, organic-search/seo, ai/aio.'),
         landingPage: z.string().optional().describe('Optional filter to one landing page path.'),
         device: z.string().optional().describe('Optional device filter: mobile, tablet, desktop.'),
         country: z.string().optional().describe('Optional ISO country filter.'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, goal, goalId, period, channel, landingPage, device, country, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (period) { query.period = period; }
         if (channel) { query.channel = channel; }
         if (landingPage) { query.landingPage = landingPage; }
         if (device) { query.device = device; }
         if (country) { query.country = country; }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/conversion-attribution', { query });
         return jsonResult({ goal: data.goal, attribution: data.attribution, note: data.note, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// prompt_track
// ---------------------------------------------------------------------------
server.registerTool(
   'prompt_track',
   {
      title: 'Track a buyer prompt to watch for AI citations',
      description:
         'Save a buyer prompt (e.g. "best project management software for remote teams") to watch for '
         + 'AI-engine citations. This ONLY STORES the prompt: s33k has NO server-side LLM and NEVER '
         + 'queries an AI engine itself. After tracking, YOU (the assistant) run the prompt against the '
         + 'engines (ChatGPT, Claude, Perplexity, Gemini) and record what you find with prompt_record. '
         + 'Track the prompts your buyers actually ask.',
      inputSchema: {
         domain: z.string().describe('The domain the prompt is tracked for, e.g. "example.com".'),
         prompt: z.string().describe('The buyer prompt to watch, e.g. "best project management software for remote teams".'),
      },
   },
   async ({ domain, prompt }) => {
      try {
         const data = await s33kFetch('/api/prompt-checks', { method: 'POST', body: { domain, prompt } });
         return jsonResult({ promptCheck: data.promptCheck, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// prompt_record
// ---------------------------------------------------------------------------
server.registerTool(
   'prompt_record',
   {
      title: 'Record an AI-citation result for a tracked prompt',
      description:
         'After YOU (the assistant) query an AI engine with a tracked prompt, call this to record '
         + 'whether s33k\'s domain was cited, at what position, and the cited URL. s33k does NOT query '
         + 'engines itself: it has no server-side LLM, so this is the ONLY way a citation result enters '
         + 's33k. You supply the result; s33k stores it. Target the prompt by id (from prompt_list) or by '
         + 'domain+prompt. When cited is false, position and cited_url are ignored.',
      inputSchema: {
         id: z.number().optional().describe('The tracked prompt id (from prompt_list). Alternative to domain+prompt.'),
         domain: z.string().optional().describe('The domain (with prompt) to identify the tracked prompt, if no id.'),
         prompt: z.string().optional().describe('The tracked prompt text (with domain) to identify it, if no id.'),
         engine: z.enum(['chatgpt', 'claude', 'perplexity', 'gemini', 'copilot']).describe('The AI engine you queried.'),
         cited: z.boolean().describe('Was this domain cited in the engine\'s answer?'),
         position: z.number().optional().describe('Citation position (1 = first cited source), when cited and known.'),
         cited_url: z.string().optional().describe('The exact URL the engine cited for this domain, when given.'),
      },
   },
   async ({ id, domain, prompt, engine, cited, position, cited_url: citedUrl }) => {
      try {
         const body: Record<string, unknown> = { engine, cited };
         if (id !== undefined) { body.id = id; }
         if (domain) { body.domain = domain; }
         if (prompt) { body.prompt = prompt; }
         if (position !== undefined) { body.position = position; }
         if (citedUrl) { body.cited_url = citedUrl; }
         const data = await s33kFetch('/api/prompt-record', { method: 'POST', body });
         return jsonResult({ updated: data.updated, promptCheck: data.promptCheck, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// prompt_list
// ---------------------------------------------------------------------------
server.registerTool(
   'prompt_list',
   {
      title: 'List tracked buyer prompts and their results',
      description:
         'List a domain\'s tracked buyer prompts and the latest recorded citation result for each '
         + '(engine, cited or not, position, cited URL, when checked). Prompts with no result yet show as '
         + 'not-yet-recorded, the ones still needing you to run and record them with prompt_record.',
      inputSchema: {
         domain: z.string().describe('The domain whose tracked prompts to list, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/prompt-checks', { query: { domain } });
         return jsonResult({ promptChecks: data.promptChecks, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// prompt_radar
// ---------------------------------------------------------------------------
server.registerTool(
   'prompt_radar',
   {
      title: 'Prompt radar: AI citations joined to conversions (the cross-pillar money join)',
      description:
         'The money join only s33k can do: for the tracked buyer prompts that have a RECORDED citation, '
         + 'it joins each cited page to that page\'s conversion count and rate (when a goal is named) and '
         + 'its AI-referral sessions, all from owned first-party data. It surfaces the gap between being '
         + 'CITED and CONVERTING (e.g. "you are cited in N of M prompts", "your best-converting cited page '
         + 'is X", or "none of the cited pages converted"). Honest when nothing is recorded yet. s33k NEVER '
         + 'queries an engine: it narrates the results YOU recorded with prompt_record. Track and record '
         + 'prompts first so there is data to join.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window for the conversion/referral join, e.g. "30d". Defaults to "30d".'),
         goal: z.string().optional().describe('A goal NAME (or pass goalId) to join conversion rate per cited page, e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('The goal id (alternative to goal name).'),
      },
   },
   async ({ domain, period, goal, goalId }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         const data = await s33kFetch('/api/prompt-radar', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            goal: data.goal,
            summary: data.summary,
            citedFor: data.citedFor,
            uncited: data.uncited,
            moneyInsight: data.moneyInsight,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// causal_links
// ---------------------------------------------------------------------------
server.registerTool(
   'causal_links',
   {
      title: 'Did my SEO pay off: which rank change LIKELY drove which traffic change (the over-time cross-pillar join)',
      description:
         'The temporal cross-pillar join no single tool can do. For each page that has BOTH tracked-keyword '
         + 'rank history (SEO) AND first-party landing sessions (analytics), it correlates the two series '
         + 'over time and reports which rank change LIKELY drove which traffic change. Ahrefs has rank '
         + 'history but not YOUR sessions; Plausible has sessions but not rank; s33k holds both for one '
         + 'domain in one store. It detects a material rank move (default 3+ positions) and a subsequent '
         + 'traffic move (default 30%+) within a lag window (default 7 days) and classifies each page as one '
         + 'of: rank-gain-drove-traffic, rank-loss-cut-traffic, rank-up-no-traffic (rank improved but traffic '
         + 'flat: a demand or snippet problem), rank-traffic-mismatch (rank and traffic both moved materially '
         + 'but in NON-matching directions, e.g. rank improved yet traffic fell, so the rank change did NOT '
         + 'drive it: another factor is at work), or traffic-fell-rank-flat (traffic dropped with no rank '
         + 'change: check another source, e.g. an AI referral that dried up). CRITICAL: this is CORRELATION, '
         + 'NOT proof. Every link says "likely", attaches both series as evidence, and NEVER asserts '
         + 'causation. When a page lacks enough history it says "not enough history yet" rather than guess. '
         + 'Human-only by default. RULES-BASED: the s33k server does NOT call any LLM; it does the join with '
         + 'transparent thresholds and YOU narrate the links, always framing them as correlation, never cause.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window for the traffic side, e.g. "30d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/causal-links', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            links: data.links,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// suggest_goals
// ---------------------------------------------------------------------------
server.registerTool(
   'suggest_goals',
   {
      title: 'Suggest conversion goals from the site',
      description:
         'Crawls a domain and proposes ready-to-create conversion goals by spotting its likely '
         + 'conversions: thank-you / destination pages (a page_reached goal) and intent / form pages '
         + 'like demo, contact, or signup (a form_submit goal). It only SUGGESTS; review the list and '
         + 'create the ones you want with create_goal. Use this right after onboarding so a user gets '
         + 'conversion tracking without having to think up their own goals.',
      inputSchema: {
         domain: z.string().describe('The domain to suggest goals for, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/suggest-goals', { query: { domain } });
         return jsonResult({ suggestions: data.suggestions, note: data.note, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// setup_status
// ---------------------------------------------------------------------------
server.registerTool(
   'setup_status',
   {
      title: 'Onboarding walkthrough: modules, where you are, and the next step',
      description:
         'The guided-setup walkthrough. Describes the instance as MODULES (Analytics: live once beacon '
         + 'events flow, otherwise waiting for the beacon; AI referrals: live with analytics; SEO: enabled '
         + 'only when a SERP scraper key is configured, otherwise "not enabled" with the enablement path '
         + 'via mint_key_drop) and reports where a domain is in setup as a checklist with percentComplete '
         + 'plus the single next step and the exact tool to call. When the SEO module is off, tracking '
         + 'keywords is NOT a setup step: an analytics-only instance with flowing events reads as healthy '
         + 'and complete, with SEO simply an optional module that is off. Use this to walk a new user from '
         + 'zero to value step by step, and any time someone asks "what should I set up next?", "is my '
         + 's33k configured?", or "which modules are on?".',
      inputSchema: {
         domain: z.string().describe('The domain to check setup for, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/onboarding-status', { query: { domain } });
         return jsonResult({
            percentComplete: data.percentComplete,
            steps: data.steps,
            nextStep: data.nextStep,
            modules: data.modules,
            message: data.message,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// mint_key_drop  (enable a secret-gated module without the secret touching chat)
// ---------------------------------------------------------------------------
server.registerTool(
   'mint_key_drop',
   {
      title: 'Mint a key-drop command (set a secret without pasting it into chat)',
      description:
         'Enable a secret-gated module (today: SEO via a Serper API key) WITHOUT the secret ever passing '
         + 'through this conversation. Returns a single-use, signed drop link (expires in 15 minutes) and a '
         + 'ready-to-run one-liner: `curl -sS -X POST <your-s33k>/api/key-drop/<token> --data-binary @-`. '
         + 'Show the user the command and tell them: run it in your own terminal, paste the key, press '
         + 'Enter, then Ctrl-D. The key goes terminal-to-server (stdin, so it never lands in shell history '
         + 'or this chat) and is saved encrypted on the server. NEVER ask the user to paste the key into '
         + 'the conversation; mint this command instead. After the user confirms they ran it, the SEO '
         + 'module is enabled: verify with setup_status and start tracking keywords.',
      inputSchema: {
         secret: z
            .enum(['serper'])
            .default('serper')
            .describe('Which secret the drop sets. "serper" (the default) enables the SEO module.'),
      },
   },
   async ({ secret }) => {
      try {
         const data = await s33kFetch('/api/key-drop', { method: 'POST', body: { secret } });
         return jsonResult({
            secret: data.secret,
            command: data.command,
            url: data.url,
            expiresInMinutes: data.expiresInMinutes,
            instructions: data.instructions,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// striking_distance
// ---------------------------------------------------------------------------
server.registerTool(
   'striking_distance',
   {
      title: 'Striking distance keywords',
      description:
         'The highest-ROI SEO to-do list for a domain. Scans tracked keyword ranks and returns the near-miss "quick win" keywords currently '
         + 'ranking just off page one (default positions 4 to 30, the striking distance), the cheapest wins because the page already ranks and a '
         + 'small push tends to move it onto page one. For each it returns the keyword, current Google position, the ranking url, and the position '
         + 'delta over the tracked history (negative means it is IMPROVING, climbing toward page one; positive means it is slipping), plus the start '
         + 'and recent positions and how many history points backed the delta. Sorted by closeness to page one then by recent improvement, so the '
         + 'easiest, most upward-moving wins are on top. Pure query over tracked keywords. Never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to scan for striking distance keywords, e.g. "example.com".'),
         min: z
            .number()
            .optional()
            .describe('Inclusive lower bound of the striking window (Google rank position). Defaults to 4 (just off page one).'),
         max: z
            .number()
            .optional()
            .describe('Inclusive upper bound of the striking window (Google rank position). Defaults to 30.'),
      },
   },
   async ({ domain, min, max }) => {
      try {
         const query: Record<string, string> = { domain };
         if (min !== undefined) { query.min = String(min); }
         if (max !== undefined) { query.max = String(max); }
         const data = await s33kFetch('/api/striking-distance', { query });
         return jsonResult({
            domain: data.domain,
            window: data.window,
            total: data.total,
            keywords: data.keywords,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// channel_report
// ---------------------------------------------------------------------------
server.registerTool(
   'channel_report',
   {
      title: 'Sessions by marketing channel (Organic Search / AI Search / Referral / Direct)',
      description:
         'Maps every first-party session to a clean marketing channel a marketer thinks in, then '
         + 'reports sessions (and the share of total) per channel: Organic Search, AI Search, '
         + 'Referral, and Direct. This answers "where is my traffic coming from, by channel". When a '
         + 'goal is supplied (by name or id), it also adds conversions and conversion rate PER '
         + 'channel, so you see in one view which channel sends traffic AND which channel actually '
         + 'converts. It also surfaces the top referring sources WITHIN the Referral channel (which '
         + 'sites send you referral traffic). Human-only by default; set includeBots=true to fold '
         + 'datacenter/bot sessions back in. Requires the s33k.js tracking script installed.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add per-channel conversions, e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('Optional goal id (alternative to goal name).'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/channel-report', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            goal: data.goal,
            report: data.report,
            botSessionsExcluded: data.botSessionsExcluded,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// live_view
// ---------------------------------------------------------------------------
server.registerTool(
   'live_view',
   {
      title: 'Real-time snapshot of who is on the site right now (poll repeatedly)',
      description:
         'A polled real-time snapshot of first-party activity in the last few minutes: who is on the '
         + 'site RIGHT NOW. There is no websocket or stream. Call this repeatedly (every few seconds) '
         + 'to watch a live view. Each call reads the last windowMinutes (default 5) of events and '
         + 'returns activeVisitors (distinct human sessions), pageviewsInWindow, activePages (the pages '
         + 'currently being viewed, with counts), sources and countries breakdowns, and recentEvents '
         + '(the most recent events, newest first) so you can narrate what just happened. Human-only by '
         + 'default; datacenter/bot events are excluded and reported as botEventsExcluded. Requires the '
         + 's33k.js tracking script installed so events flow in.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         windowMinutes: z.number().optional().describe('How many minutes back to look. Defaults to 5, clamped to 1..60.'),
      },
   },
   async ({ domain, windowMinutes }) => {
      try {
         const query: Record<string, string> = { domain };
         if (windowMinutes !== undefined) { query.windowMinutes = String(windowMinutes); }
         const data = await s33kFetch('/api/live-view', { query });
         return jsonResult({
            windowMinutes: data.windowMinutes,
            asOf: data.asOf,
            activeVisitors: data.activeVisitors,
            pageviewsInWindow: data.pageviewsInWindow,
            eventsInWindow: data.eventsInWindow,
            botEventsExcluded: data.botEventsExcluded,
            activePages: data.activePages,
            sources: data.sources,
            countries: data.countries,
            recentEvents: data.recentEvents,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// funnel_analysis
// ---------------------------------------------------------------------------
server.registerTool(
   'funnel_analysis',
   {
      title: 'Multi-step funnel with per-step drop-off',
      description:
         'Where in an ordered, multi-step path do sessions fall out? Given a funnel of ordered steps, '
         + 'computed from first-party sessions, it reports for each step how many sessions reached it '
         + '(counting a session for step N only if it also reached steps 1..N-1), the conversion from '
         + 'the previous step, and the drop-off there. Steps is an ORDERED array of '
         + '{type:"page"|"event", match}: a "page" step is reached when the session viewed a path '
         + 'starting with match (prefix), an "event" step when it fired an event of that type, '
         + 'optionally constrained to a page. Answers "of visitors who hit /pricing, how many reached '
         + 'checkout, and where do they drop?". Human-only by default; includeBots=true folds bots in. '
         + 'The same composable segment filters apply. Deterministic, no LLM.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         steps: z.array(z.object({
            type: z.enum(['page', 'event']).describe('"page" matches a viewed path prefix; "event" matches a fired event type.'),
            match: z.string().describe('A path prefix (page step) or an event type (event step), e.g. "/pricing" or "checkout".'),
            page: z.string().optional().describe('Event steps only: constrain the event to a page prefix, e.g. "/demo".'),
         })).describe('The ordered funnel steps (at least one). Order matters: each step is checked only after the prior step is reached.'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         channel: z.string().optional().describe('Filter to a traffic channel: direct, referral, organic-search/seo, ai/aio.'),
         landingPage: z.string().optional().describe('Filter to sessions whose landing page is this exact path.'),
         page: z.string().optional().describe('Filter to sessions that viewed this path.'),
         device: z.string().optional().describe('Filter by device: mobile, tablet, or desktop.'),
         country: z.string().optional().describe('Filter by ISO country code (where geo data is available).'),
         engagement: z.enum(['engaged', 'bounced']).optional().describe('Filter by engagement quality.'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, steps, period, channel, landingPage, page, device, country, engagement, includeBots }) => {
      try {
         // steps is an ordered array, which the flat query layer cannot carry, so it travels as a JSON string.
         const query: Record<string, string> = { domain, steps: JSON.stringify(steps) };
         if (period) { query.period = period; }
         if (channel) { query.channel = channel; }
         if (landingPage) { query.landingPage = landingPage; }
         if (page) { query.page = page; }
         if (device) { query.device = device; }
         if (country) { query.country = country; }
         if (engagement) { query.engagement = engagement; }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/funnel', { query });
         return jsonResult({
            funnel: data.funnel,
            botSessionsExcluded: data.botSessionsExcluded,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// entry_page_report
// ---------------------------------------------------------------------------
server.registerTool(
   'entry_page_report',
   {
      title: 'The entry-page acquisition lens (which landing pages bring people in, from where)',
      description:
         'Answers "which landing pages did AI search (or any source) land on": segments first-party traffic by the LANDING '
         + '(entry) page where each session STARTS, not by raw '
         + 'pageviews, because entry pages are the acquisition surface. For each entry page it returns: entries '
         + '(first-touch sessions), a source breakdown (direct / referral / organic-search / ai counts, so you see which pages '
         + 'AI-referred visitors first hit), optional '
         + 'goal conversions+rate when a goal is given, and trackedKeywords (the keywords/rank whose target page is '
         + 'that entry page). This connects "we rank for X" to "X actually lands people", the missing attribution '
         + 'link most analytics tools never make. Two gaps fall out of the data: a ranking page with zero entries '
         + '(ranking-without-landing, fix the funnel) and an entry page that pulls sessions but holds no tracked '
         + 'keywords (landing-without-ranking, brand/direct driven). Human-only by default; the goal is optional.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d". Defaults to "30d".'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add per-page conversions+rate, e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('Optional goal id (alternative to goal name).'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/entry-page-report', { query });
         return jsonResult({ goal: data.goal, report: data.report, botSessionsExcluded: data.botSessionsExcluded, note: data.note, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// period_compare
// ---------------------------------------------------------------------------
server.registerTool(
   'period_compare',
   {
      title: 'This period vs last period, side by side, with delta and percent change',
      description:
         'Compares the key analytics metrics for a window against the immediately-preceding '
         + 'equal-length window: humanVisitors, pageviews, bounceRatePct, and (when a goal is '
         + 'supplied) conversions and conversionRatePct. For each metric it returns both windows\' '
         + 'values plus the absolute delta and the percent change, so you see in one view whether this '
         + 'period is better or worse than last period and by how much. The prior window is derived '
         + 'automatically from the period (a 30d window compares against the 30 days before it). '
         + 'pctChange is null when the prior window had zero (growth from zero is undefined; render it '
         + 'as "new"). Human-only by default; set includeBots=true to fold datacenter/bot sessions '
         + 'back in. Requires the s33k.js tracking script installed.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d". The prior equal-length window is derived from it.'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add conversions and conversion rate to the comparison.'),
         goalId: z.number().optional().describe('Optional goal id (alternative to goal name).'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/period-compare', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            goal: data.goal,
            report: data.report,
            botSessionsExcluded: data.botSessionsExcluded,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// site_audit
// ---------------------------------------------------------------------------
server.registerTool(
   'site_audit',
   {
      title: 'Prioritized on-page SEO issue list',
      description:
         'Crawls a domain and returns a prioritized on-page / technical SEO issue list. Runs pure rules over '
         + 'every crawled page: missing title, title too long (over 60) or too short (under 20), missing meta '
         + 'description, meta too long (over 160) or too short (under 50), missing H1, multiple H1s, duplicate '
         + 'titles shared across pages, and thin content. Each issue returns the page, the issue, a severity '
         + '(high / medium / low), and a detail line with the fix. Sorted by severity so the most damaging '
         + 'items (missing titles and H1s) surface first. Pure rules over the crawl. Never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to audit, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/site-audit', { query: { domain } });
         return jsonResult({ domain: data.domain, report: data.report, note: data.note, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// cannibalization_detection
// ---------------------------------------------------------------------------
server.registerTool(
   'cannibalization_detection',
   {
      title: 'Keyword cannibalization detection',
      description:
         'Find keyword cannibalization for a domain: the cases where Google cannot decide which of your pages should rank for a term, so the pages '
         + 'compete and split the equity instead of one ranking well. Pure join over tracked keywords, conservative on purpose (only clear cases). '
         + 'Flags three signals: (a) intent split, a keyword ranks on a url that is not its target page; (b) shared ranking url, distinct keywords '
         + 'ranking on the SAME url while targeting different pages; (c) near-duplicate terms ranking on DIFFERENT urls. Returns flagged groups, each '
         + 'with the conflict type, the competing keywords/urls, and a one-line why. Never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to scan for keyword cannibalization, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/cannibalization', { query: { domain } });
         return jsonResult({
            domain: data.domain,
            total: data.total,
            groups: data.groups,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// content_gap
// ---------------------------------------------------------------------------
server.registerTool(
   'content_gap',
   {
      title: 'Content gap vs a competitor',
      description:
         'Finds the topics a COMPETITOR covers on its site that YOU do not, so you know what to write next. Crawls the competitor to derive their '
         + 'topics (a topic = the page slug as a phrase, or the title head before a separator), crawls your domain (plus your tracked keywords and '
         + 'target pages as extra covered topics) to derive what you already cover, and returns the competitor topics with NO close match in yours: '
         + 'the gaps. Each gap carries the competitor url, the derived topic phrase, and the page path/title, sorted by how content-rich the '
         + 'competitor page looks (excerpt length), richest first. Pure crawl-based string comparison. Never queries an LLM and uses no external API.',
      inputSchema: {
         domain: z.string().describe('Your domain, the one you want gaps found FOR, e.g. "example.com". Must be tracked in s33k.'),
         competitor: z.string().describe('The competitor domain to compare against, e.g. "highspot.com". Only crawled, does not need to be tracked.'),
      },
   },
   async ({ domain, competitor }) => {
      try {
         const data = await s33kFetch('/api/content-gap', { query: { domain, competitor } });
         return jsonResult({
            domain: data.domain,
            competitor: data.competitor,
            total: data.total,
            gaps: data.gaps,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// content_performance_report
// ---------------------------------------------------------------------------
server.registerTool(
   'content_performance_report',
   {
      title: 'Which content actually performs (pages ranked by pageviews, with acquisition + conversion + SEO)',
      description:
         'A prebuilt report that ranks a domain\'s pages by pageviews and, per page, joins the signals that say whether the page is doing real '
         + 'work: pageviews (the rank), entries (sessions that LANDED on the page, the acquisition signal), optional goal conversions and rate '
         + '(view-attributed over the sessions that SAW the page), and the tracked keywords whose target page is that page (what the page ranks for, '
         + 'with current Google position). This is the cross-pillar content scorecard, traffic + acquisition + conversion + SEO, per page, in one '
         + 'view. A tracked page that gets zero traffic still appears (ranking-without-traffic) with empty entries. Human-only by default; set '
         + 'includeBots=true to fold datacenter/bot sessions back in. Sorted by pageviews, capped by limit. Never queries an LLM; returns structured '
         + 'data for your own LLM to narrate. Requires the s33k.js tracking script installed.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add view-attributed conversions per page, e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('Optional goal id (alternative to goal name).'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
         limit: z.number().optional().describe('Max pages to return (top N by pageviews). Defaults to 25, clamped to 1..200.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots, limit }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         if (limit !== undefined) { query.limit = String(limit); }
         const data = await s33kFetch('/api/content-performance', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            goal: data.goal,
            report: data.report,
            botSessionsExcluded: data.botSessionsExcluded,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// weekly_digest
// ---------------------------------------------------------------------------
server.registerTool(
   'weekly_digest',
   {
      title: 'Week in review: one cross-pillar "what happened this week" bundle',
      description:
         'A prebuilt "week in review" report that bundles every s33k pillar into one structured response '
         + 'for a domain over a window (defaults to 7d). Returns: traffic (human visitors, pageviews, '
         + 'bounce rate, bots filtered), topEntryPages (the top 5 landing pages by entries), channels '
         + '(sessions per acquisition channel: organic-search, ai, referral, direct), aiTraffic (count of '
         + 'AI-search sessions), and rankMovers (the tracked keywords that improved or worsened most in '
         + 'Google rank over the window, parsed from each keyword\'s rank history). When you pass a goal '
         + '(by name or id) it also adds conversions (total + rate for that goal) and topOpportunity (the '
         + 'single highest-leverage "money move" from the cross-pillar conversion join). Human-only by '
         + 'default; pass includeBots to fold datacenter/bot sessions back in. The s33k server does NOT '
         + 'call any LLM: it does the joins with transparent rules and hands YOU (the connected LLM) the '
         + 'structured digest to narrate as a weekly standup. Use it for a fast "how did the site do this '
         + 'week?" read, or as a Monday recap.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "7d". Defaults to "7d" (a week in review).'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add conversions + the top opportunity, e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('Optional goal id (alternative to goal name).'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/weekly-digest', { query });
         return jsonResult({
            traffic: data.traffic,
            topEntryPages: data.topEntryPages,
            channels: data.channels,
            conversions: data.conversions,
            rankMovers: data.rankMovers,
            aiTraffic: data.aiTraffic,
            topOpportunity: data.topOpportunity,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// executive_summary
// ---------------------------------------------------------------------------
server.registerTool(
   'executive_summary',
   {
      title: 'Executive summary: the leadership one-glance report',
      description:
         'A single leadership-facing cross-pillar standup for a domain: headline numbers (human visitors, and '
         + 'conversions + conversion rate when a goal is set), the top traffic channel and the top converting '
         + 'channel, an SEO snapshot (keywords on page one plus the biggest rank gain and loss over the period), '
         + 'AI visibility (whether AI engines send visitors), a plain-English healthLine, and the single nextAction. '
         + 'Human-only by default. Rules-based, no server-side LLM.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d". Defaults to "30d".'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add conversions and the top converting channel.'),
         goalId: z.number().optional().describe('Optional goal id.'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/executive-summary', { query });
         return jsonResult({
            goal: data.goal, headline: data.headline, topChannel: data.topChannel,
            topConvertingChannel: data.topConvertingChannel, seo: data.seo, aiVisibility: data.aiVisibility,
            healthLine: data.healthLine, nextAction: data.nextAction, note: data.note, error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// seo_report  (prebuilt report: the whole SEO picture in one call)
// ---------------------------------------------------------------------------
server.registerTool(
   'seo_report',
   {
      title: 'SEO report (prebuilt snapshot)',
      description:
         'A comprehensive, prebuilt SEO snapshot for a domain in ONE call, so the marketer gets the whole picture without chaining '
         + 'separate tools. Pure query over tracked keywords (no crawl, no analytics provider, no LLM). Bundles four sections: '
         + 'summary (total tracked keywords and how many sit in the top 3 / top 10 / page one / not in the top 100, the rank-distribution '
         + 'headline); strikingDistance (the quick-win to-do list, keywords ranking just off page one in positions 4 to 30 by default, each '
         + 'with its position delta over history, sorted by closeness then improvement); topMovers (the biggest rank improvements and the '
         + 'biggest drops over each keyword\'s tracked history, where improvements is most-improved first and drops is biggest-fall first); '
         + 'and rankingPages (tracked keywords grouped by their target_page, busiest page first, each page listing the terms it holds and their '
         + 'positions, best rank first). Use this for the "how is my SEO doing overall and what should I work" question, then drill into '
         + 'striking_distance, page_scoreboard, or keyword detail from there.',
      inputSchema: {
         domain: z.string().describe('The domain to build the SEO report for, e.g. "example.com".'),
         min: z
            .number()
            .optional()
            .describe('Inclusive lower bound of the striking-distance window. Defaults to 4 (positions 1 to 3 are already page one).'),
         max: z
            .number()
            .optional()
            .describe('Inclusive upper bound of the striking-distance window. Defaults to 30.'),
         moversLimit: z
            .number()
            .optional()
            .describe('How many movers to return per side (improvements and drops). Defaults to 5, max 50.'),
      },
   },
   async ({ domain, min, max, moversLimit }) => {
      try {
         const query: Record<string, string> = { domain };
         if (min !== undefined) { query.min = String(min); }
         if (max !== undefined) { query.max = String(max); }
         if (moversLimit !== undefined) { query.moversLimit = String(moversLimit); }
         const data = await s33kFetch('/api/seo-report', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// aeo_report (prebuilt report)
// ---------------------------------------------------------------------------
server.registerTool(
   'aeo_report',
   {
      title: 'AEO report',
      description:
         'One-call AI-search (AEO) snapshot for a domain. Bundles the first-party AI-referral signal so a marketer gets the whole AI-search picture at once, never querying an LLM: aiReferrals (which AI engines actually SENT visitors, per engine, with counts and AI share of referred traffic), and an engineSummary (per engine: referral visitors, plus the topAdvocate). When first-party data is thin the note says so honestly. Use this instead of stitching ai_referrals + ai_visibility by hand. Defaults to a 30-day window.',
      inputSchema: {
         domain: z.string().describe('The domain to build the AEO report for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/aeo-report', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            aiReferrals: data.aiReferrals,
            engineSummary: data.engineSummary,
            referralError: data.referralError,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// traffic_breakdown
// ---------------------------------------------------------------------------
server.registerTool(
   'traffic_breakdown',
   {
      title: 'Traffic breakdown',
      description:
         'Break a domain\'s traffic down by a single dimension. Use this to answer where visitors come from or what they use. Analytics is first-party from the beacon, which collects the country and device dimensions only; those two return real rows. The other dimensions (region, city, browser, os, language, screen) are accepted but have no beacon column in single-beacon mode and return empty rows. Each row has a name, page views, and unique visitors. These per-row visitor counts are the RAW provider total and INCLUDE bots; for the real human number use start_here / dashboard / human_traffic (datacenter-filtered).',
      inputSchema: {
         domain: z.string().describe('The domain to break down, e.g. "example.com".'),
         dimension: z
            .enum(['country', 'region', 'city', 'device', 'browser', 'os', 'language', 'screen'])
            .describe('Which dimension to break traffic down by.'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, dimension, period }) => {
      try {
         const query: Record<string, string> = { domain, dimension };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/breakdown', { query });
         return jsonResult({ dimension: data.dimension, rows: data.rows, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// traffic_timeseries
// ---------------------------------------------------------------------------
server.registerTool(
   'traffic_timeseries',
   {
      title: 'Traffic time series',
      description:
         'Get a daily (or unit-grouped) time series of pageviews and visitors for a domain over a window. Use this to spot trends, spikes, and drops over time, or to compare two periods. Each point has a date label, pageviews, and visitors. These visitor counts are the RAW provider total and INCLUDE bots; for the real human number use start_here / dashboard / human_traffic (datacenter-filtered).',
      inputSchema: {
         domain: z.string().describe('The domain to chart, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         unit: z
            .string()
            .optional()
            .describe('Bucket unit, e.g. "day". Defaults to "day".'),
      },
   },
   async ({ domain, period, unit }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (unit) { query.unit = unit; }
         const data = await s33kFetch('/api/timeseries', { query });
         return jsonResult({ unit: data.unit, series: data.series, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// top_events
// ---------------------------------------------------------------------------
server.registerTool(
   'top_events',
   {
      title: 'Top events',
      description:
         'List a domain\'s custom or tracked events over a window with their fire counts. Use this to see which tracked actions (signups, clicks, downloads, and the like) fired most. Each row has an event name and a count; the list is empty when the site records no custom events.',
      inputSchema: {
         domain: z.string().describe('The domain to list events for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/events', { query });
         return jsonResult({ events: data.events, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// engagement
// ---------------------------------------------------------------------------
server.registerTool(
   'engagement',
   {
      title: 'Engagement tiers',
      description:
         'Break a domain\'s sessions into engagement tiers (such as bounced, browsed, and engaged) over a window. Use this to judge traffic quality, not just volume: a high bounced share signals low-quality or bot traffic. Each tier has a label, session count, percentage of all sessions, and (where available) average duration and average pages per session.',
      inputSchema: {
         domain: z.string().describe('The domain to measure engagement for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/engagement', { query });
         return jsonResult({ tiers: data.tiers, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// top_clicks
// ---------------------------------------------------------------------------
server.registerTool(
   'top_clicks',
   {
      title: 'Top clicks',
      description:
         'List the most-clicked elements on a domain from s33k autocapture, the GA4-killer feature: one script tag on the '
         + 'site captures every button and link click with ZERO per-element setup (no tag manager, no instrumentation). Use '
         + 'this to see which CTAs, nav links, and buttons actually get clicked. Each row has the element\'s visible text '
         + '(label), a stable CSS selector, the total clickCount, and a per-page breakdown (byPage) of where it was clicked, '
         + 'sorted by clickCount. Privacy: this reports THAT an element was clicked and its visible text/selector, NEVER any '
         + 'value typed into an input. Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report top clicks for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/top-clicks', { query });
         return jsonResult({ domain: data.domain, period: data.period, clicks: data.clicks, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// form_submissions
// ---------------------------------------------------------------------------
server.registerTool(
   'form_submissions',
   {
      title: 'Form submissions',
      description:
         'Report form-submission activity on a domain from s33k autocapture: which forms get submitted, how often, and from '
         + 'which pages, with ZERO per-form setup (the single script tag captures submits automatically). Use this to measure '
         + 'conversion or funnel health, signup volume, and contact-form engagement. Returns forms[] (each with the form '
         + 'id/name as label, submissionCount, and a per-page byPage breakdown, sorted by count) plus totalSubmissions. '
         + 'Privacy: this records THAT a form was submitted and its id/name, NEVER any field value or anything typed. '
         + 'Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report form submissions for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/form-submissions', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            forms: data.forms,
            totalSubmissions: data.totalSubmissions,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// scroll_depth
// ---------------------------------------------------------------------------
server.registerTool(
   'scroll_depth',
   {
      title: 'Scroll depth',
      description:
         'Report how far visitors scroll on a domain\'s pages from s33k autocapture, with ZERO setup. Use this to find which '
         + 'pages get read deeply versus abandoned at the top, and whether long pages hold attention. Returns pages[] (each '
         + 'with the page path, avgScrollDepth and maxScrollDepth as percent of page scrolled, and the session count, sorted '
         + 'by avgScrollDepth) plus a site-wide distribution histogram bucketed 0-25 / 25-50 / 50-75 / 75-100 percent. '
         + 'Scroll depth is the max percent reached per session/page. Cookieless, no PII. Reads the first-party event store; '
         + 'never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report scroll depth for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/scroll-depth', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            pages: data.pages,
            distribution: data.distribution,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// page_engagement
// ---------------------------------------------------------------------------
server.registerTool(
   'page_engagement',
   {
      title: 'Page engagement time',
      description:
         'Report active engagement (dwell) time per page on a domain from s33k autocapture, with ZERO setup. Use this to see '
         + 'which pages truly hold attention versus which bounce, beyond raw pageviews. Returns pages[] (each with the page '
         + 'path, avgEngagementSeconds and totalEngagementSeconds, and the unique session count, sorted by total) plus a '
         + 'site-wide siteAvgEngagementSeconds. Engagement is ACTIVE time only: the client pauses the timer when the tab is '
         + 'hidden, the window loses focus, or the visitor goes idle, so this is real attention, not a tab left open. '
         + 'Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report page engagement for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/page-engagement', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            pages: data.pages,
            siteAvgEngagementSeconds: data.siteAvgEngagementSeconds,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// web_vitals
// ---------------------------------------------------------------------------
server.registerTool(
   'web_vitals',
   {
      title: 'Core Web Vitals',
      description:
         'Report real-user Core Web Vitals for a domain from s33k autocapture. For each metric (LCP, CLS, INP, FID, FCP, TTFB) '
         + 'it returns the p75 (the 75th-percentile value Google uses to score CWV) and a rating against Google\'s field thresholds '
         + '(good / needs-improvement / poor) with the sample count behind each. It also returns worstPages: the slowest pages by '
         + 'LCP p75 (or the most-sampled metric when LCP has no samples), so you see WHICH pages to fix. metrics[] carries each '
         + 'metric, its p75, rating, sampleCount, and unit (ms, or score for CLS). This is FIELD data from real visitors, not a lab '
         + 'test, and flows from the same s33k.js tag as the other analytics, so no extra setup is needed. When no samples exist '
         + 'yet, the response includes an explanatory note. Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report Core Web Vitals for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/web-vitals', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            metrics: data.metrics,
            worstPagesMetric: data.worstPagesMetric,
            worstPages: data.worstPages,
            totalSamples: data.totalSamples,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// conversions_by_source
// ---------------------------------------------------------------------------
server.registerTool(
   'conversions_by_source',
   {
      title: 'Conversions by source',
      description:
         'Answer "which traffic sources actually drive my conversions" for a domain, with ZERO GA4 setup. s33k stamps a '
         + 'first-touch source on every autocaptured event at ingest, so this attributes conversions to the source the '
         + 'visitor arrived from and returns the breakdown directly. By default the conversion event is autocaptured form '
         + 'submissions (form_submit); pass event to attribute any other captured event type (e.g. "click", "outbound") '
         + 'instead. Returns conversions[] (one row per source: the source, its conversion count, its share of total '
         + 'conversions as a percent, and an approximate conversionRate), plus totalConversions and topSource (the single '
         + 'best-converting source). source is a CLASSIFICATION: "direct" (typed/bookmarked or self-referral), '
         + '"organic-search" (Google/Bing/etc.), "ai" (ChatGPT/Claude/Perplexity/etc.), or "referral" (another site, shown '
         + 'as its bare host); it is never a full referrer URL. conversionRate is HONESTLY APPROXIMATE: it is conversions '
         + 'divided by the distinct sessions that fired any autocaptured event under that source in the window, so sessions '
         + 'with no event at all are not in the base and the true rate is no higher than reported (read conversionRateNote). '
         + 'Cookieless, no PII. Reads the first-party event store; never queries an LLM, and never errors on a thin sub-signal.',
      inputSchema: {
         domain: z.string().describe('The domain to report conversions for, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
         event: z
            .string()
            .optional()
            .describe('The conversion event type to attribute. Defaults to "form_submit" (autocaptured form submissions).'),
      },
   },
   async ({ domain, period, event }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (event) { query.event = event; }
         const data = await s33kFetch('/api/conversions', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            event: data.event,
            conversions: data.conversions,
            totalConversions: data.totalConversions,
            topSource: data.topSource,
            conversionRateNote: data.conversionRateNote,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// insights
// ---------------------------------------------------------------------------
server.registerTool(
   'insights',
   {
      title: 'Cross-pillar insights',
      description:
         'Get a ready-made cross-pillar analysis for a domain in one call. Use this when you want the highest-leverage findings without running each tool yourself. It joins all three s33k pillars (SEO rank, analytics traffic, AI referrals, and engagement) and returns RULES-BASED structured findings and recommendations for YOU (the LLM) to interpret and narrate. The s33k server does NOT call any LLM; it does the joins and surfaces signals dashboards bury. Findings include high-traffic pages with poor or no keyword rank (an SEO opportunity), keywords ranking well but on low-traffic pages (a demand or click-through mismatch), pages and engines receiving AI answer-engine referral traffic (AEO proof), traffic concentrated on a single page (a resilience risk), and an estimated-bot-traffic caveat (how much measured traffic is likely automated, so the other numbers can be read correctly). Each finding has a type, severity, message, and evidence; recommendations is a prioritized list of concrete next actions.',
      inputSchema: {
         domain: z.string().describe('The domain to analyze, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "90d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/insights', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            findings: data.findings,
            recommendations: data.recommendations,
            notes: data.notes,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// briefing
// ---------------------------------------------------------------------------
server.registerTool(
   'briefing',
   {
      title: 'Daily briefing',
      description:
         'A current point-in-time SNAPSHOT of how a domain is doing right now (not a change report). It composes every s33k pillar (traffic, human-vs-bot reality, SEO rank and opportunity pages, AI visibility from referrals, and engagement) into one ready-to-narrate structure: a headline, sections (each a titled list of plain-English points covering traffic/human-vs-bot, search rank and opportunity pages, AI visibility, and engagement), and the top 3 recommended actions in priority order. (For the daily home and "what changed since the prior period", call daily_brief instead; alerts drills into one change signal in full detail.) The s33k server does NOT call any LLM; it does the joins and the prioritization with transparent rules. YOU (the connected LLM) read this and narrate it, leading with the headline and the recommendations. It never fails on a missing signal: a dead provider or empty data degrades one section instead of the whole briefing.',
      inputSchema: {
         domain: z.string().describe('The domain to brief on, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/briefing', { query });
         return jsonResult({
            headline: data.headline,
            sections: data.sections,
            recommendations: data.recommendations,
            generatedFor: data.generatedFor,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------
server.registerTool(
   'alerts',
   {
      title: 'Proactive alerts: what changed and what to do',
      description:
         'Drill into ONE change signal in full detail across SEO, AI search, and analytics. Where daily_brief is the '
         + 'prioritized daily home and briefing is a current snapshot, alerts answers "what CHANGED since last period, '
         + 'and what should I do about it?" in full. It compares the current period to the immediately-prior period of the same '
         + 'length and surfaces the notable shifts as a PRIORITIZED list of plain-English alerts: keyword rank moves of 5+ '
         + 'positions or crossing page one (the highest-signal SEO move), traffic swings of 25%+ (pageviews and visitors), '
         + 'AI referral signals (a brand-NEW engine sending you visitors, or an existing engine that COLLAPSED to near zero, '
         + 'plus 30%+ moves), CONTENT DECAY (a page whose traffic fell 35%+ off a real prior baseline; when a tracked keyword '
         + 'still ranks for that page the alert says the rank held, the classic stale-content signal, and recommends '
         + 'refreshing the content), and conversion changes by both VOLUME (30%+ change in form submissions) and RATE '
         + '(conversions per visitor falling on steady traffic, the leading sign a form or landing page broke). Each alert '
         + 'carries a severity (high/medium/low), the pillar, a '
         + 'headline stating exactly what changed, a detail with the numbers, and a concrete recommendation. RANK alerts '
         + 'additionally carry a context object (prior vs current position and, when the stored SERP allows it, the domains '
         + 'immediately above you now) so you can explain a move, not just report it. The response '
         + 'also returns topPriority: the single most important thing to do this week, and a per-pillar dataAvailability note '
         + 'so you can tell the user honestly when a signal had no baseline to compare. Pass since=<ISO timestamp> to scope '
         + 'the current window to everything after that moment (the cheap "what changed since yesterday" poll); it takes '
         + 'precedence over period and is echoed back as since. RULES-BASED: the s33k server does NOT '
         + 'call any LLM; it computes the deltas with transparent rules and stays silent on any signal it cannot honestly '
         + 'measure (e.g. no prior traffic baseline) rather than inventing a swing from zero. YOU (the connected LLM) narrate '
         + 'the alerts, leading with topPriority. It never fails on a missing signal: each pillar degrades independently.',
      inputSchema: {
         domain: z.string().describe('The domain to analyze for changes, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('The window to compare against its immediately-prior equivalent, e.g. "7d" (this week vs last week) or '
               + '"30d" (this month vs last month). Defaults to "7d". Ignored when since is set.'),
         since: z
            .string()
            .optional()
            .describe('An ISO 8601 timestamp (e.g. "2026-07-01T00:00:00Z"). Scopes the CURRENT window to [since, now) and '
               + 'compares it to the equal-length window before it: the cheap "what changed since yesterday" poll. Must be in '
               + 'the past and within the last 365 days; an invalid value is a clear 400. Takes precedence over period.'),
      },
   },
   async ({ domain, period, since }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (since) { query.since = since; }
         const data = await s33kFetch('/api/alerts', { query });
         return jsonResult({
            alerts: data.alerts,
            topPriority: data.topPriority,
            period: data.period,
            comparedTo: data.comparedTo,
            since: data.since,
            dataAvailability: data.dataAvailability,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// daily_brief
// ---------------------------------------------------------------------------
server.registerTool(
   'daily_brief',
   {
      title: 'Daily brief: your daily home (call this every day)',
      description:
         'Call this EVERY DAY. Your daily standup and your daily HOME in s33k: the single most important thing to do right '
         + 'now, what changed since the prior period and why, in one tight digest. This is where you start. It composes a '
         + 'HEADLINE (the most important thing right now), 2-4 WHAT-CHANGED bullets (this period vs the prior equal window, '
         + 'across rank movers, traffic delta, AI-referral delta including new AND collapsed engines, and conversion volume '
         + 'and rate), and the SINGLE top ACTION, enriched with the top AI-visibility opportunity and the top opportunity '
         + 'page. The same brief is also delivered by scheduled email when the instance enables it. (For the other two '
         + 'cross-pillar tools: briefing = a current point-in-time snapshot of how the site is doing right now; alerts = '
         + 'drill into one change signal in full detail. daily_brief is the prioritized daily home that sits on top of both.) '
         + 'RULES-BASED: the s33k server does NOT call any LLM; it joins and prioritizes the structured data with transparent '
         + 'rules and is HONEST on a quiet week ("nothing material changed") rather than inventing movement. YOU (the '
         + 'connected LLM) narrate it, leading with the headline and the top action. It never fails on a missing signal: each '
         + 'upstream surface degrades independently.',
      inputSchema: {
         domain: z.string().describe('The domain to brief on, e.g. "example.com".'),
         period: z
            .string()
            .optional()
            .describe('The window compared against its immediately-prior equivalent, e.g. "7d" (this week vs last week). Defaults to "7d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/daily-brief', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            brief: data.brief,
            rendered: data.rendered,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// create_domain
// ---------------------------------------------------------------------------
// CUSTOMER self-serve tool, NOT admin-gated: adding your own site is the very first thing every
// user does, so it must be on the default surface (a new user could not onboard from their LLM
// otherwise). Safe to expose to every connection: POST /api/domains requires a full-account key,
// and a read-only share key is GET-only at the API layer, so a share key cannot create domains.
server.registerTool(
   'create_domain',
   {
      title: 'Create domain',
      description:
         'Add one or more domains to track in s33k. Use this once per site before adding its keywords or reading its analytics. Pass bare domain names (for example "example.com"), not full URLs.',
      inputSchema: {
         domains: z
            .array(z.string())
            .min(1)
            .describe('Domain names to add, e.g. ["example.com"]. Bare hostnames, no protocol.'),
      },
   },
   async ({ domains }) => {
      try {
         const data = await s33kFetch('/api/domains', { method: 'POST', body: { domains } });
         return jsonResult(data.domains ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// update_keyword
// ---------------------------------------------------------------------------
server.registerTool(
   'update_keyword',
   {
      title: 'Update keyword',
      description:
         'Update one or more tracked keywords by ID. Use this to set a keyword\'s target_page (the page that should rank for it) so it joins correctly in page_scoreboard, or to toggle its sticky pin. Get the IDs from list_keywords first. Exactly one of target_page or sticky is applied per call, and target_page takes precedence if both are given.',
      inputSchema: {
         ids: z
            .array(z.number().int())
            .min(1)
            .describe('Keyword IDs to update.'),
         target_page: z
            .string()
            .optional()
            .describe('The target page path/URL this keyword should rank for, e.g. "/software/mcp". Pass "" to clear.'),
         sticky: z
            .boolean()
            .optional()
            .describe('Whether to pin the keyword as sticky. Applied only when target_page is not provided.'),
      },
   },
   async ({ ids, target_page, sticky }) => {
      try {
         if (target_page === undefined && sticky === undefined) {
            return errorResult(new Error('Provide target_page and/or sticky to update.'));
         }
         const body: Record<string, unknown> = {};
         if (target_page !== undefined) {
            body.target_page = target_page;
         } else if (sticky !== undefined) {
            body.sticky = sticky;
         }
         const data = await s33kFetch('/api/keywords', {
            method: 'PUT',
            query: { id: ids.join(',') },
            body,
         });
         return jsonResult(data.keywords ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// delete_keyword
// ---------------------------------------------------------------------------
server.registerTool(
   'delete_keyword',
   {
      title: 'Delete keyword',
      description:
         'Permanently delete one or more tracked keywords by ID. Use this to stop tracking terms you no longer care about. Get the IDs from list_keywords first. This cannot be undone, so confirm the IDs before calling. Returns how many keywords were removed.',
      inputSchema: {
         ids: z
            .array(z.number().int())
            .min(1)
            .describe('Keyword IDs to delete.'),
      },
   },
   async ({ ids }) => {
      try {
         const data = await s33kFetch('/api/keywords', {
            method: 'DELETE',
            query: { id: ids.join(',') },
         });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// discover_pages
// ---------------------------------------------------------------------------
server.registerTool(
   'discover_pages',
   {
      title: 'Discover pages',
      description:
         'Crawl a domain and return a compact summary of each important page, the fastest way to onboard a new site. Use this at the start so you can map keywords to real pages instead of guessing. s33k crawls the domain (sitemap.xml first, then homepage links) and returns url, path, title, meta description, h1 and h2 headings, and a short text excerpt per page. No server-side LLM is used and no API key is needed: YOU (the connected LLM) read these summaries, infer what each page is about, propose 1 to 2 target keywords per important page, and call add_keyword for each (passing the page path as target_page). Capped at 25 pages. Never throws; per-page or top-level failures come back as an "error" field.',
      inputSchema: {
         domain: z.string().describe('The domain to read pages from, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/discover', { query: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// onboard
// ---------------------------------------------------------------------------
// CUSTOMER self-serve tool, NOT admin-gated: this is the one-shot "add my site + discover keywords
// + provision tracking + return the snippet" flow a new user runs first, so it must be on the
// default surface. Safe for the same reason as create_domain: POST /api/onboard needs a full-account
// key; a read-only share key is GET-only at the API and cannot run it.
server.registerTool(
   'onboard',
   {
      title: 'Onboard a domain',
      description:
         'Give me a domain and I set up everything for it in one call, the fastest way to go from nothing to live data. s33k will: create the domain, crawl a few of its pages and heuristically discover candidate target keywords (no LLM needed), add up to 20 of them and immediately queue background Google rank scrapes (rankings appear shortly, so rankingsPending comes back true), provision a dedicated analytics website for the domain, and return the tracking snippet plus copy-paste install guides for common platforms (raw HTML, Google Tag Manager, WordPress, Webflow, Shopify, Squarespace, Wix, Next.js/React). Pass a bare domain like "example.com", not a full URL. Use this as the first thing you do for a brand new site. The first Google rank check runs in the background right after this returns (rankingsPending true only when keywords were added AND a SERP source is configured), so re-check with list_keywords or start_here shortly; rankings then refresh weekly, and a timingNote in the response says the same. Degrades gracefully: if analytics is not set up yet, siteId comes back null, analyticsReady is false, the installSnippet/installGuides are omitted (a blank snippet cannot attribute anything), and a note explains why, while the domain, keywords, and rankings are still set up. Returns { domain, discoveredKeywords, addedKeywords, rankingsPending, siteId, analyticsReady, installSnippet, installGuides, firstRunHint, nextStepMessage, timingNote, note }.',
      inputSchema: {
         domain: z.string().describe('The bare domain to onboard, e.g. "example.com". No protocol, no path.'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/onboard', { method: 'POST', body: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// install_instructions
// ---------------------------------------------------------------------------
server.registerTool(
   'install_instructions',
   {
      title: 'Install instructions',
      description:
         'Show how to add the s33k analytics tracking code to a site, including the exact snippet and step-by-step instructions for the user\'s platform. Use this when someone asks "how do I add the tracking code on <platform>" (WordPress, Webflow, Shopify, Squarespace, Wix, Google Tag Manager, Next.js/React, or raw HTML), or any time after onboarding when they need the snippet again. The domain must already be onboarded. Returns { domain, siteId, installSnippet, installGuides } where installGuides.platforms is a list of { platform, steps }. Read the steps for the platform the user named and walk them through it.',
      inputSchema: {
         domain: z.string().describe('The already-onboarded domain, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/install-instructions', { query: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// export_data
// ---------------------------------------------------------------------------
server.registerTool(
   'export_data',
   {
      title: 'Export all your data',
      description:
         'Download EVERYTHING s33k holds as one JSON bundle: your domains, your keywords (with full Google rank history), '
         + 'and your autocapture analytics events. Use this whenever you want to take your data with you, back it up, or '
         + 'verify exactly what s33k stores. Your data is yours: this is the export side of that promise. It NEVER includes '
         + 'any secret: Search Console / Google Ads credentials are reported only as configured-or-not. Returns the full '
         + 'bundle with a counts summary.',
      inputSchema: {},
   },
   async () => {
      try {
         const data = await s33kFetch('/api/export');
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// security_facts
// ---------------------------------------------------------------------------
server.registerTool(
   'security_facts',
   {
      title: 'Is s33k safe? Get the trust facts',
      description:
         'Answer "is this safe? do you train on my data? who else can see my data?" with s33k\'s '
         + 'complete, verifiable trust facts. Returns structured, source-cited answers covering: NO '
         + 'model training (s33k has no model-training pipeline at all; the AI analysis runs in YOUR '
         + 'own LLM and s33k only hands it structured data), single-user by design (there are no other '
         + 'accounts, no signup, so no one else can see your data), encryption at rest (connected '
         + 'credentials are cryptr-encrypted), data ownership (export your data as one JSON bundle), '
         + 'open-source + self-hostable ("verify us, don\'t trust us"), cookieless / no-PII '
         + 'tracking, and the sub-processors used. Each fact lists the exact files or tests that '
         + 'prove it, so the answer is verifiable, not just asserted. Use this whenever a user asks '
         + 'whether s33k is safe, private, or trustworthy, or whether it trains on or shares their '
         + 'data.',
      inputSchema: {},
   },
   async () => {
      try {
         const data = await s33kFetch('/api/security');
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
server.registerTool(
   'help',
   {
      title: 'Ask s33k anything',
      description:
         'Ask me ANY question about s33k and I answer from s33k\'s single authoritative product-knowledge layer. Call this '
         + 'WHENEVER you are unsure: what a capability does, when to use it, how to set up or install tracking, how to onboard '
         + 'a domain, why s33k made a design decision (MCP-first, Serper, cookieless analytics, the single-user self-hosted '
         + 'design, no-model-training), how to troubleshoot a problem (rankings showing 0, an empty AI funnel, zero analytics, '
         + 'Search Console not connected), whether s33k is safe/private, or pricing, limits, and '
         + 'privacy. This is the first thing to call to confirm whether a capability exists before telling the user it does '
         + 'NOT, and the right tool to answer support-style questions instead of guessing. Returns a structured knowledge '
         + 'slice: matching capabilities (each with what it does, when to use it, and an example prompt) plus any relevant '
         + 'setup, reasoning, troubleshooting, trust, and pricing context. It reads no account data and never queries an LLM.',
      inputSchema: {
         q: z
            .string()
            .describe(
               'Your question in natural language, e.g. "how do I add tracking?", "what does ai_visibility do?", '
               + '"is this safe?", "why is my AI funnel empty?".',
            ),
         topic: z
            .string()
            .optional()
            .describe(
               'Optional scope. A pillar ("seo", "aeo", "analytics", "cross-pillar", "onboarding", "account", '
               + '"security") or a section ("setup", "reasoning", "troubleshooting", "trust", "pricing"). '
               + 'Omit to search everything.',
            ),
      },
   },
   async ({ q, topic }) => {
      try {
         const query: Record<string, string> = { q };
         if (topic) { query.topic = topic; }
         const data = await s33kFetch('/api/help', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// campaign_report
// ---------------------------------------------------------------------------
server.registerTool(
   'campaign_report',
   {
      title: 'Sessions by UTM campaign (with utm_source / utm_medium breakdown)',
      description:
         'Groups every first-party session by its UTM campaign (utm_campaign) and reports sessions '
         + '(and the share of total) per campaign, plus a breakdown of sessions by utm_source and '
         + 'utm_medium. This answers "how is each marketing campaign performing". When a goal is '
         + 'supplied (by name or id), it also adds conversions and conversion rate PER campaign, so you '
         + 'see in one view which campaign sends traffic AND which campaign actually converts. Sessions '
         + 'with no utm_campaign roll into a single "(none)" bucket (always listed last) so untagged '
         + 'traffic stays visible and totals reconcile. Human-only by default; set includeBots=true to '
         + 'fold datacenter/bot sessions back in. Requires the s33k.js tracking script installed and '
         + 'UTM-tagged landing URLs.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         goal: z.string().optional().describe('Optional goal NAME (or pass goalId) to add per-campaign conversions, e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('Optional goal id (alternative to goal name).'),
         includeBots: z.boolean().optional().describe('Include datacenter/bot sessions. Defaults to human-only.'),
      },
   },
   async ({ domain, period, goal, goalId, includeBots }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         if (includeBots) { query.includeBots = 'true'; }
         const data = await s33kFetch('/api/campaign-report', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            goal: data.goal,
            report: data.report,
            botSessionsExcluded: data.botSessionsExcluded,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// segment_save
// ---------------------------------------------------------------------------
server.registerTool(
   'segment_save',
   {
      title: 'Save a named, reusable analytics segment',
      description:
         'Save a NAMED, reusable filter set, e.g. "AI human converters" or "Mobile organic", so it can '
         + 'be applied by name with segment_analytics instead of re-specifying the same filters on every '
         + 'call. Pass any of the composable filters: channel (direct|referral|organic-search|ai; aliases '
         + 'seo/aio accepted), device (mobile|tablet|desktop), country (ISO), landingPage (exact path), '
         + 'page (a path the session viewed), engagement (engaged|bounced), and humanOnly (exclude '
         + 'datacenter bots). At least one filter is required. Unknown keys are ignored.',
      inputSchema: {
         domain: z.string().describe('The domain the segment belongs to, e.g. "example.com".'),
         name: z.string().describe('The segment name used in questions, e.g. "AI human converters".'),
         channel: z.string().optional().describe('Traffic channel: direct, referral, organic-search/seo, ai/aio.'),
         device: z.string().optional().describe('Device: mobile, tablet, or desktop.'),
         country: z.string().optional().describe('ISO country code (where geo data is available).'),
         landingPage: z.string().optional().describe('Restrict to sessions whose landing page is this exact path.'),
         page: z.string().optional().describe('Restrict to sessions that viewed this path.'),
         engagement: z.enum(['engaged', 'bounced']).optional().describe('Restrict by engagement quality.'),
         humanOnly: z.boolean().optional().describe('Exclude datacenter/bot sessions. Defaults to human-only when applied.'),
      },
   },
   async ({ domain, name, channel, device, country, landingPage, page, engagement, humanOnly }) => {
      try {
         const filters: Record<string, unknown> = {};
         if (channel) { filters.channel = channel; }
         if (device) { filters.device = device; }
         if (country) { filters.country = country; }
         if (landingPage) { filters.landingPage = landingPage; }
         if (page) { filters.page = page; }
         if (engagement) { filters.engagement = engagement; }
         if (humanOnly !== undefined) { filters.humanOnly = humanOnly; }
         const data = await s33kFetch('/api/segments', { method: 'POST', body: { domain, name, filters } });
         return jsonResult({ segment: data.segment, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// segment_list
// ---------------------------------------------------------------------------
server.registerTool(
   'segment_list',
   {
      title: 'List saved analytics segments',
      description: 'List the named, reusable segments defined for a domain, with their stored filter rules.',
      inputSchema: {
         domain: z.string().describe('The domain whose segments to list, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/segments', { query: { domain } });
         return jsonResult({ segments: data.segments, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// segment_delete
// ---------------------------------------------------------------------------
server.registerTool(
   'segment_delete',
   {
      title: 'Delete a saved segment',
      description: 'Delete a named segment by its id (get ids from segment_list).',
      inputSchema: {
         id: z.number().describe('The segment id to delete.'),
      },
   },
   async ({ id }) => {
      try {
         const data = await s33kFetch('/api/segments', { method: 'DELETE', query: { id: String(id) } });
         return jsonResult({ removed: data.removed, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// segment_analytics
// ---------------------------------------------------------------------------
server.registerTool(
   'segment_analytics',
   {
      title: 'Traffic analytics for a saved segment (applied by name)',
      description:
         'Apply a SAVED segment by name (or id) and get the same human-analytics-style traffic summary, '
         + 'so you do not re-specify the filters each time. Returns visitors, pageviews, bounceRatePct, '
         + 'pagesPerSession, entryPages, and exitPages for the saved cut, plus bot transparency. The '
         + 'segment\'s stored filters are the only filters applied; human-only unless the segment saved '
         + 'humanOnly=false. Use segment_save to create one first, or segment_list to see the names.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         segment: z.string().optional().describe('The segment NAME (or pass segmentId), e.g. "AI human converters".'),
         segmentId: z.number().optional().describe('The segment id (alternative to segment name).'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, segment, segmentId, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (segment) { query.segment = segment; }
         if (segmentId !== undefined) { query.segmentId = String(segmentId); }
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/segment-analytics', { query });
         return jsonResult({
            segment: data.segment,
            filters: data.filters,
            summary: data.summary,
            entryPages: data.entryPages,
            exitPages: data.exitPages,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
server.registerTool(
   'dashboard',
   {
      title: 'Dashboard: the one-call overview (start here)',
      description:
         'THE starting point. Returns the default "show me an overview" for a domain: the key numbers across all three s33k pillars '
         + '(SEO rank, AI search, analytics) in ONE call, plus a curated list of next questions the user can ask. Reach for this whenever the '
         + 'user says "show me an overview", "show me my dashboard", "how is my site doing", or simply does not know what to ask. It composes a '
         + 'compact set of sections (headline with human visitors / AI-referred visitors / top opportunity / top action; top pages; top sources; '
         + 'best-ranked keywords; rank distribution; AI referrals per engine; Core Web Vitals p75; per-goal conversions when goals exist; and the '
         + 'biggest rank movers) and a CONTEXTUAL set of suggestedQuestions chosen from the actual data. Every section is empty-safe: a brand-new '
         + 'domain still returns a coherent, honest overview. The response also includes `rendered`, a ready-to-show monospace ASCII view of the '
         + 'whole dashboard. RULES-BASED: the server does NOT call any LLM. You can narrate the structured `dashboard` richly OR show the raw '
         + '`rendered` block, then offer the suggestedQuestions so the user always knows what to ask next.',
      inputSchema: {
         domain: z.string().describe('The domain to show the overview for, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/dashboard', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            dashboard: data.dashboard,
            suggestedQuestions: data.suggestedQuestions,
            rendered: data.rendered,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// portfolio_summary
// ---------------------------------------------------------------------------
server.registerTool(
   'portfolio_summary',
   {
      title: 'Portfolio rollup across every domain on the account',
      description:
         'The "how are all my sites doing" rollup. One call summarizes EVERY domain on your account at once, so an agency or multi-site owner '
         + 'gets a single portfolio view instead of calling the per-domain SEO/analytics tools once per site. There is NO domain argument: it '
         + 'spans exactly your own domains. Per domain it returns a COMPACT summary (counts, never full lists): the keyword rank distribution '
         + '(total tracked, inTop3, inTop10, onPageOne, notInTop100), a striking-distance count as the top SEO opportunity signal (the same '
         + 'near-page-one quick-win logic as striking_distance), and, when first-party events exist for that domain in the window, human and '
         + 'AI-referral session counts (AI = sessions whose channel is AI Search). traffic is null for a domain with no events (tracking not '
         + 'installed or no traffic yet), distinguishing that from 0 measured sessions. Domains are sorted by tracked-keyword count, descending. '
         + 'Cross-pillar, pure query over your own data. Never queries an LLM. Drill into one site with striking_distance, page_scoreboard, or '
         + 'channel_report.',
      inputSchema: {
         period: z.string().optional().describe('Reporting window for the traffic half, e.g. "30d", "7d". Defaults to "30d". Lookback is capped at 365 days.'),
      },
   },
   async ({ period }) => {
      try {
         const query: Record<string, string> = {};
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/portfolio', { query });
         return jsonResult({
            period: data.period,
            domains: data.domains,
            note: data.note,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// competitor_visibility
// ---------------------------------------------------------------------------
server.registerTool(
   'competitor_visibility',
   {
      title: 'Competitor share of voice',
      description:
         'Compute competitor share of voice for a domain from SERP data s33k ALREADY stores (no new scrape, no LLM). Every tracked keyword '
         + 'persists its full Google results page, so this reads which OTHER domains rank for the same terms you track. Returns the top competing '
         + 'domains ranked by share of voice (the fraction of your tracked keywords each competitor appears on), each with its appearance count and '
         + 'average rank, plus a per-keyword "who outranks you" view listing the competitors ranking above your position for each keyword (if you do '
         + 'not rank, position 0, every domain on that SERP outranks you). keywordsAnalyzed counts the tracked keywords that have stored SERP data; '
         + 'when 0, a note explains that competitors appear only after keywords have been refreshed at least once.',
      inputSchema: {
         domain: z.string().describe('The domain to analyze competitor share of voice for, e.g. "example.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/competitor-visibility', { query: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// aeo_roi
// ---------------------------------------------------------------------------
server.registerTool(
   'aeo_roi',
   {
      title: 'The AI Visibility P&L: does AI search actually make me money (the flagship cross-pillar join)',
      description:
         'The cross-pillar report no AEO tool can produce: it closes the loop from '
         + 'AI-referred traffic to conversions to revenue, PER PAGE. For a named goal it joins which AI '
         + 'engines referred real visitors to each page, which of those '
         + 'visitors converted, and what each conversion is worth, so you see the actual return on AI '
         + 'visibility. Returns byPage (AI-referred sessions, conversions, AI vs '
         + 'organic conversion rate, and revenue when the goal has a value) and opportunities (the money '
         + 'moves: pages where AI out-converts organic, and pages AI '
         + 'sends traffic to that never convert). Honest by design: when a layer has no data it says so '
         + 'rather than fabricate a rate. Requires the '
         + 'tracking script installed and at least one goal.',
      inputSchema: {
         domain: z.string().describe('The domain, e.g. "example.com".'),
         period: z.string().optional().describe('Reporting window, e.g. "30d". Defaults to "30d".'),
         goal: z.string().optional().describe('The goal NAME (or pass goalId), e.g. "Demo Booked".'),
         goalId: z.number().optional().describe('The goal id (alternative to goal name).'),
      },
   },
   async ({ domain, period, goal, goalId }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (goal) { query.goal = goal; }
         if (goalId !== undefined) { query.goalId = String(goalId); }
         const data = await s33kFetch('/api/aeo-roi', { query });
         return jsonResult({ goal: data.goal, aeoRoi: data.aeoRoi, note: data.note, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// MCP resources: listable/readable knowledge docs.
//
// These expose the SAME single product-knowledge source the `help` tool reads, so a client can
// discover them with resources/list and pull a whole doc into context with resources/read,
// rather than asking a question. Each resource fetches a topic-scoped slice of GET /api/help
// (the knowledge layer is the one source; the MCP build cannot import the server's utils/, so
// it reads them over the same REST path every tool uses). Static, read-only, no account data.
// ---------------------------------------------------------------------------
/** Fetch a topic-scoped knowledge slice from the help endpoint and wrap it as a resource read result. */
async function readKnowledgeResource(uri: string, topic: string) {
   const data = await s33kFetch('/api/help', { query: { q: '', topic } });
   return {
      contents: [
         {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
         },
      ],
   };
}
for (const resource of KNOWLEDGE_RESOURCES) {
   server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.name, description: resource.description, mimeType: 'application/json' },
      async (uri) => {
         try {
            return await readKnowledgeResource(uri.href, resource.topic);
         } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
               contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Failed to load ${resource.uri}: ${message}` }],
            };
         }
      },
   );
}

   // Single-user: a flat 73 tools, no admin gate, no billing tools.
   return { tools: 73, resources: KNOWLEDGE_RESOURCES.length };
}
