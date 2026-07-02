/**
 * The single source of truth for s33k product knowledge.
 *
 * This module is what makes s33k self-supporting: a user can ask their own LLM ANY
 * question about s33k (what a capability does, how to set up tracking, why a design
 * decision was made, how to troubleshoot, whether it is safe) and the answer comes from
 * here, exposed three ways over MCP:
 *   1. the `help` tool (GET /api/help), an "ask s33k anything" lookup;
 *   2. MCP resources (resources/list + resources/read), listable/readable docs a client
 *      can pull into context;
 *   3. self-explaining tool descriptions (each capability below carries the same facts the
 *      tool description states).
 *
 * Single-source discipline: this module does NOT restate the install guides or the security
 * facts. It REFERENCES them. The setup section points the reader at getInstallGuides()
 * (utils/install-guides.ts) and the trust section embeds the live securityFacts object
 * (utils/securityFacts.ts) by import, so there is exactly one place each fact lives. The
 * capability catalog below is the one new body of knowledge, and the coverage test
 * (durability guarantee) asserts every registered MCP tool has an entry here, so the
 * answers can never silently rot.
 *
 * It is intentionally dependency-light (only the two existing knowledge sources) so the
 * GET /api/help route stays lightweight and the catalog can be imported anywhere.
 */

import { securityFacts, SecurityFacts } from './securityFacts';

/** One MCP tool / capability, described so an LLM can answer "what is this and when do I use it?" */
export type CapabilityEntry = {
   /** Stable id; equals the registered MCP tool name. */
   id: string,
   /** The registered MCP tool name (same as id; kept explicit for the coverage test). */
   toolName: string,
   /** Which s33k pillar this belongs to. */
   category: 'seo' | 'aeo' | 'analytics' | 'cross-pillar' | 'onboarding' | 'account' | 'security' | 'sharing',
   /** Short human title. */
   title: string,
   /** What the capability does, in one or two plain sentences. */
   description: string,
   /** When an LLM should reach for it. */
   whenToUse: string,
   /** A natural-language prompt a user could say that should trigger this capability. */
   examplePrompt: string,
};

/** A reasoning entry: an honest "why we built it this way" answer. */
export type ReasoningEntry = {
   id: string,
   question: string,
   answer: string,
};

/** A troubleshooting entry: a common problem and how to resolve it. */
export type TroubleshootingEntry = {
   id: string,
   problem: string,
   resolution: string,
};

export type KnowledgeBase = {
   /** Every MCP tool, one entry each. The coverage test enforces completeness. */
   capabilities: CapabilityEntry[],
   /** How to install s33k and add tracking. References the install-guide library, never duplicates it. */
   setup: {
      summary: string,
      fiveMinutesToValue: string,
      addTrackingCode: string,
      connectSearchConsole: string,
      installGuidesSource: string,
   },
   /** Honest design reasoning, grounded in SECURITY.md. */
   reasoning: ReasoningEntry[],
   /** Common issues and their fixes. */
   troubleshooting: TroubleshootingEntry[],
   /** Trust + security. References the single securityFacts source, never duplicates it. */
   trust: { summary: string, facts: SecurityFacts },
   /** Pricing, limits, and privacy at a high level. */
   pricingAndLimits: {
      model: string,
      keywordTracking: string,
      access: string,
      privacy: string,
   },
};

// ---------------------------------------------------------------------------
// Capabilities: one entry per registered MCP tool (40 total).
// Keep these in lockstep with mcp/src/index.ts; the coverage test fails the build
// if any registered tool lacks an entry here.
// ---------------------------------------------------------------------------
const capabilities: CapabilityEntry[] = [
   // --- Self-support ---
   {
      id: 'help',
      toolName: 'help',
      category: 'cross-pillar',
      title: 'Ask s33k anything',
      description: 'Answers any question about s33k from its single product-knowledge layer: what a capability does, how to set up tracking, why a '
         + 'design decision was made, how to troubleshoot, whether it is safe, and pricing/limits. Reads no account data and never queries an LLM.',
      whenToUse: 'Use whenever you are unsure how s33k works, and as the first thing to call to confirm whether a capability exists before telling '
         + 'the user it does not.',
      examplePrompt: 'How do I add the s33k tracking code, and is s33k safe?',
   },
   // --- Getting started ---
   {
      id: 'start_here',
      toolName: 'start_here',
      category: 'onboarding',
      title: 'Start here: the 5-minutes-to-value tour (call this first)',
      description: 'The FIRST call to make when you connect your LLM to s33k. The 5-minutes-to-value tour. Give it a domain, or no '
         + 'domain to pick one (one tracked uses it, many returns a pick-domain list, none returns no-domain). If setup is incomplete '
         + 'it returns mode "setup" with the checklist, percentComplete, the single next step, the INSTALL snippet and per-platform '
         + 'steps (installing the tracking script is the gating step for analytics), and a preview of what each report unlocks, then '
         + 'stops rather than dumping analytics on a half-set-up site. Once set up it returns mode "ready" with a headline, your 3 '
         + 'prebuilt reports (Analytics, SEO, AI-search) each with a LIVE teaser of your own numbers and the tool to run it, '
         + 'whatYouCanSee (the data surfaces you now have), questionsYouCanAsk (concrete questions you can say), the single top '
         + 'action, a curated nextSteps list that always surfaces entry_pages (which pages AI search lands on), striking_distance '
         + '(the quickest SEO wins), and dashboard, plus a ready-to-show rendered tour. Composes existing data; never queries an LLM; '
         + 'never fails.',
      whenToUse: 'Use as the very first call when someone connects s33k, does not know where to start, or asks "what should I do?", '
         + '"where do I begin?", "how do I install s33k?", or "give me the most important thing". Prefer it over dashboard for a cold '
         + 'start: it checks setup first, walks install if needed, then shows the 3 reports with your numbers and what to ask.',
      examplePrompt: 'I just connected s33k. Where do I start?',
   },
   // --- SEO (rank tracking + Search Console) ---
   {
      id: 'list_domains',
      toolName: 'list_domains',
      category: 'seo',
      title: 'List domains',
      description: 'Lists every domain tracked in s33k with its name and settings.',
      whenToUse: 'Call this first to discover which domains exist before any domain-scoped tool.',
      examplePrompt: 'What domains am I tracking in s33k?',
   },
   {
      id: 'create_domain',
      toolName: 'create_domain',
      category: 'seo',
      title: 'Create domain',
      description: 'Adds one or more domains to track. Takes bare hostnames, not full URLs.',
      whenToUse: 'Use once per site before adding its keywords or reading its analytics.',
      examplePrompt: 'Start tracking example.com in s33k.',
   },
   {
      id: 'list_keywords',
      toolName: 'list_keywords',
      category: 'seo',
      title: 'List keywords',
      description: 'Lists a domain\'s tracked keywords with current Google rank, ranking URL, target page, and recent rank history.',
      whenToUse: 'Use to read SEO standings, get keyword IDs for update/delete, or check whether a keyword has scraped yet.',
      examplePrompt: 'Show me the keyword rankings for example.com.',
   },
   {
      id: 'add_keyword',
      toolName: 'add_keyword',
      category: 'seo',
      title: 'Add keyword',
      description: 'Adds one keyword to track for a domain and queues a background Google SERP scrape so its rank appears shortly.',
      whenToUse: 'Use to start tracking a term; pass target_page so it joins to a page in the scoreboard. Call once per keyword to add several.',
      examplePrompt: 'Track the keyword "project management software" for example.com, target page /software.',
   },
   {
      id: 'update_keyword',
      toolName: 'update_keyword',
      category: 'seo',
      title: 'Update keyword',
      description: 'Updates tracked keywords by ID: set the target_page that should rank for them, or toggle the sticky pin.',
      whenToUse: 'Use to fix a keyword\'s target page so it joins correctly in page_scoreboard. Get IDs from list_keywords first.',
      examplePrompt: 'Set the target page for keyword 42 to /software/mcp.',
   },
   {
      id: 'delete_keyword',
      toolName: 'delete_keyword',
      category: 'seo',
      title: 'Delete keyword',
      description: 'Permanently deletes tracked keywords by ID. Cannot be undone.',
      whenToUse: 'Use to stop tracking terms you no longer care about. Confirm the IDs first.',
      examplePrompt: 'Stop tracking keywords 12 and 13.',
   },
   {
      id: 'refresh_keywords',
      toolName: 'refresh_keywords',
      category: 'seo',
      title: 'Refresh keywords',
      description: 'Re-scrapes live Google rankings for stale keywords, by a list of IDs or by an entire domain.',
      whenToUse: 'Use when rankings may be out of date. A small batch returns synchronously; a larger one runs in the background.',
      examplePrompt: 'Refresh all rankings for example.com.',
   },
   {
      id: 'get_insight',
      toolName: 'get_insight',
      category: 'seo',
      title: 'Get Search Console insight',
      description: 'Reads Google Search Console insight for a domain: top pages, top keywords, top countries, and aggregate stats. Once Search Console '
         + 'is connected (see connect_search_console), this returns the real queries each page actually ranks for, the authoritative answer to '
         + '"what am I ranking for".',
      whenToUse: 'Use for real impression and click data from Google, beyond the keywords you explicitly track. Requires Search Console connected.',
      examplePrompt: 'What are my top Search Console pages for example.com?',
   },
   {
      id: 'connect_search_console',
      toolName: 'connect_search_console',
      category: 'onboarding',
      title: 'Connect Google Search Console',
      description: 'Starts the click-to-authorize Google Search Console connection for a domain you own and returns a Google consent link. Approving '
         + 'it lets s33k read your real Search Console data, so get_insight returns the real queries each page ranks for, the authoritative answer '
         + 'to "what am I ranking for". This replaces pasting a service-account JSON: you just click the link and approve.',
      whenToUse: 'Use when a user wants their real Google ranking queries, or get_insight reports Search Console is not integrated. Connecting '
         + 'requires write access to the domain (you must own it). Show the user the returned link to open and approve.',
      examplePrompt: 'Connect Google Search Console for example.com.',
   },
   // --- AEO (AI answer-engine visibility) ---
   {
      id: 'ai_referrals',
      toolName: 'ai_referrals',
      category: 'aeo',
      title: 'AI referrals',
      description: 'Reports which AI engines (ChatGPT, Perplexity, Gemini, Claude, Copilot) sent real visitors to a domain, from analytics referral '
         + 'data.',
      whenToUse: 'Use to measure AEO outcomes: actual traffic AI answer engines drove. It reads referral data and never queries an LLM.',
      examplePrompt: 'Which AI engines are sending traffic to example.com?',
   },
   {
      id: 'ai_visibility',
      toolName: 'ai_visibility',
      category: 'aeo',
      title: 'AI visibility',
      description: 'Per-page and per-engine view of AI referrals (which AI engines send you visitors and to which pages), using only '
         + 'first-party un-gameable behavior. When referral data is thin it falls back to a deterministic AI-readiness audit. Never queries an LLM.',
      whenToUse: 'Use to answer "how visible am I in AI search, and where is the gap?" Read not-cited pages as the work to do.',
      examplePrompt: 'How visible is example.com in AI search, and where are the gaps?',
   },
   {
      id: 'prompt_track',
      toolName: 'prompt_track',
      category: 'aeo',
      title: 'Track a buyer prompt to watch for AI citations',
      description: 'Saves a buyer prompt (e.g. "best project management software for remote teams") to watch for AI-engine citations. It only STORES the '
         + 'prompt: s33k has NO server-side LLM and never queries an AI engine itself. After tracking, YOU (the assistant) run the prompt against '
         + 'the engines and record what you find with prompt_record.',
      whenToUse: 'Use to start watching whether AI engines cite this site for a buyer prompt that matters. Track the prompts your buyers actually '
         + 'ask, then run and record them.',
      examplePrompt: 'Track the buyer prompt "best project management software for remote teams" for example.com.',
   },
   {
      id: 'prompt_record',
      toolName: 'prompt_record',
      category: 'aeo',
      title: 'Record an AI-citation result for a tracked prompt',
      description: 'After YOU (the assistant) query an AI engine (ChatGPT, Claude, Perplexity, Gemini) with a tracked prompt, call this to record '
         + 'whether s33k\'s domain was cited, at what position, and the cited URL. s33k does NOT query engines itself: it has no server-side LLM, so '
         + 'this is how a result enters s33k. Target the prompt by id or by domain+prompt.',
      whenToUse: 'Use right after you run a tracked prompt against an AI engine, to save what you saw (cited or not, position, the cited URL) so '
         + 'prompt_radar can join it to conversions. You supply the result; s33k stores it.',
      examplePrompt: 'I asked ChatGPT that prompt and it cited example.com/software at position 2: record that.',
   },
   {
      id: 'prompt_list',
      toolName: 'prompt_list',
      category: 'aeo',
      title: 'List tracked buyer prompts and their results',
      description: 'Lists a domain\'s tracked buyer prompts and the latest recorded citation result for each (engine, cited or not, position, cited '
         + 'URL, when checked). Prompts with no result yet show as not-yet-recorded.',
      whenToUse: 'Use to see which buyer prompts are being watched and which still need you to run and record them with prompt_record.',
      examplePrompt: 'What buyer prompts am I tracking for example.com, and which have results?',
   },
   {
      id: 'prompt_radar',
      toolName: 'prompt_radar',
      category: 'aeo',
      title: 'Prompt radar: AI citations joined to conversions',
      description: 'The money join only s33k can do: for the tracked buyer prompts that have a RECORDED citation, it joins each cited page to that '
         + 'page\'s conversion count and rate (when a goal is named) and its AI-referral sessions, from owned first-party data. It surfaces the gap '
         + 'between being cited and converting (e.g. "your best-converting page is cited in 0 of your buyer prompts", or "you are cited in N of M '
         + 'prompts"). Honest when nothing is recorded yet. s33k never queries an engine; it narrates results the user\'s LLM recorded.',
      whenToUse: 'Use to answer "are AI engines citing me for my buyer prompts, and do those cited pages actually convert?" Pass a goal to fold in '
         + 'conversion rate per cited page. Track and record prompts first (prompt_track, then prompt_record) so there is data to join.',
      examplePrompt: 'For example.com, are AI engines citing me for my buyer prompts, and do those cited pages convert my Demo Booked goal?',
   },
   // --- Analytics (traffic + autocapture engagement) ---
   {
      id: 'traffic_summary',
      toolName: 'traffic_summary',
      category: 'analytics',
      title: 'Traffic summary',
      description: 'Site-wide traffic totals for a domain: pageviews, visitors, visits, bounce rate, average duration, and pages per visit. The visitors total is the RAW provider total and INCLUDES bots; for the real human number use start_here / dashboard / human_traffic (datacenter-filtered). Also returns visitorsRaw and humanVisitors with a note when they diverge.',
      whenToUse: 'Use for the one-line health check before drilling into breakdown, timeseries, or the scoreboard.',
      examplePrompt: 'Give me the traffic summary for example.com over the last 30 days.',
   },
   {
      id: 'traffic_breakdown',
      toolName: 'traffic_breakdown',
      category: 'analytics',
      title: 'Traffic breakdown',
      description: 'Breaks a domain\'s traffic down by one dimension. Analytics is first-party from the beacon, which collects country and device only, so those two return real rows; the other dimensions (region, city, browser, os, language, screen) are accepted but return empty rows in single-beacon mode.',
      whenToUse: 'Use to answer where visitors come from or what device they use. Only the country and device dimensions carry data; region, city, browser, os, language, and screen are not collected by the first-party beacon and return empty.',
      examplePrompt: 'Break down example.com traffic by country.',
   },
   {
      id: 'traffic_timeseries',
      toolName: 'traffic_timeseries',
      category: 'analytics',
      title: 'Traffic time series',
      description: 'A daily (or unit-grouped) time series of pageviews and visitors for a domain over a window.',
      whenToUse: 'Use to spot trends, spikes, and drops over time, or to compare two periods.',
      examplePrompt: 'Show example.com daily pageviews over the last 30 days.',
   },
   {
      id: 'top_events',
      toolName: 'top_events',
      category: 'analytics',
      title: 'Top events',
      description: 'Lists a domain\'s custom or tracked events with their fire counts.',
      whenToUse: 'Use to see which tracked actions (signups, clicks, downloads) fired most. Empty when the site records no custom events.',
      examplePrompt: 'What are the top tracked events on example.com?',
   },
   {
      id: 'engagement',
      toolName: 'engagement',
      category: 'analytics',
      title: 'Engagement tiers',
      description: 'Breaks a domain\'s sessions into engagement tiers (bounced, browsed, engaged) over a window.',
      whenToUse: 'Use to judge traffic quality, not just volume: a high bounced share signals low-quality or bot traffic.',
      examplePrompt: 'How engaged is the traffic on example.com?',
   },
   {
      id: 'human_traffic',
      toolName: 'human_traffic',
      category: 'analytics',
      title: 'Human vs bot traffic estimate',
      description: 'Reports how much of a domain\'s traffic is humans versus bots from FIRST-PARTY tracking: each session\'s source IP is classified '
         + 'as datacenter-or-not at ingest (the is_bot signal a JS pageview tracker cannot see), so cloud scrapers are filtered, not counted. The '
         + 'human number matches human_analytics, start_here, and the dashboard (one source of truth).',
      whenToUse: 'Use to sanity-check the other traffic numbers, because JS pageview trackers count JavaScript-executing scrapers as real visitors. '
         + 'It is exact for the first-party sessions it has. If no first-party sessions have arrived yet, botEstimationAvailable is false and the '
         + 'split is omitted rather than guessed; install the s33k.js script to populate it.',
      examplePrompt: 'How much of example.com traffic is real humans versus bots?',
   },
   {
      id: 'human_analytics',
      toolName: 'human_analytics',
      category: 'analytics',
      title: 'Human-only analytics (bots excluded), with exit and bounce rate',
      description: 'Human-only traffic analytics computed from s33k\'s own first-party pageview events, with datacenter/bot traffic excluded by '
         + 'default. Each pageview\'s source IP is classified as datacenter-or-not at ingest (is_bot), so JavaScript-executing cloud scrapers are '
         + 'filtered instead of counted. Returns visitors, pageviews, pagesPerSession, bounceRatePct, entryPages, and exitPages with exitRatePct, '
         + 'plus botVisitorsFiltered and botSharePct.',
      whenToUse: 'Use when you want real human numbers, including the exit rate a plain pageview summary cannot produce. Both human_analytics '
         + 'and human_traffic now derive the human-vs-bot split from the SAME first-party IP classification (is_bot at ingest), so their human '
         + 'counts agree; this tool adds bounce, entry, and exit detail. Requires the s33k.js tracking script installed so pageviews flow in. Pass '
         + 'includeBots=true for the raw with-bots view.',
      examplePrompt: 'Show me example.com analytics for humans only, with bounce and exit rate.',
   },
   {
      id: 'create_goal',
      toolName: 'create_goal',
      category: 'analytics',
      title: 'Create a named conversion goal',
      description: 'Define a named conversion to track: a thank-you / destination page reached (kind page_reached, matchValue is a path) or an '
         + 'autocaptured event fired (kind event, e.g. form_submit, optionally constrained to a page). Goals are the unit conversion rates are '
         + 'measured against.',
      whenToUse: 'Use to set up a conversion you want to measure, like "Demo Booked" or "Signup", before asking for its rate.',
      examplePrompt: 'Create a goal called Demo Booked when someone reaches /demo/thanks.',
   },
   {
      id: 'list_goals',
      toolName: 'list_goals',
      category: 'analytics',
      title: 'List conversion goals',
      description: 'List the named conversion goals defined for a domain and their match rules.',
      whenToUse: 'Use to see which conversions are defined before reporting on them.',
      examplePrompt: 'What conversion goals are set up for example.com?',
   },
   {
      id: 'delete_goal',
      toolName: 'delete_goal',
      category: 'analytics',
      title: 'Delete a conversion goal',
      description: 'Delete a named conversion goal by its id.',
      whenToUse: 'Use to remove a conversion goal you no longer track.',
      examplePrompt: 'Delete the Newsletter Signup goal.',
   },
   {
      id: 'goal_analytics',
      toolName: 'goal_analytics',
      category: 'analytics',
      title: 'Conversion analytics for a goal',
      description: 'Conversion rate and counts for a named goal, computed from first-party sessions. Filter by traffic source, landing page, device, '
         + 'country, or engagement, and group the rate by any of those. Human-only by default; datacenter bots excluded. When the goal carries a '
         + 'monetary value, it also reports revenue (conversions times value) overall and per group, so you get dollars next to the rate.',
      whenToUse: 'Use for any conversion-rate question: the rate for a goal, the rate for one segment, how many converters came from a given source, '
         + 'or a comparison of the rate across sources. It also answers "of converters, the most common landing page" by grouping on landing page, and '
         + '"what is this conversion worth" once the goal has a value set.',
      examplePrompt: 'What is my Demo Booked conversion rate and revenue from organic search, human only?',
   },
   {
      id: 'conversion_attribution',
      toolName: 'conversion_attribution',
      category: 'cross-pillar',
      title: 'What drives conversions across SEO, direct, and AI',
      description: 'The merged-pillar view only s33k can produce: attributes a goal\'s conversions by acquisition source (including AI search '
         + 'versus organic versus direct), by tracked keyword (each keyword credited with the conversions its target page drove, with its Google '
         + 'rank, so keywords are ranked by conversions not clicks), and into the money moves (pages that rank but do not convert, pages that convert '
         + 'but do not rank, and where AI out-converts organic). When the goal carries a monetary value, it also reports revenue (conversions times '
         + 'value) overall, per channel, and per keyword-bearing page, so you can see which sources and pages drive the most money, not just the most '
         + 'conversions.',
      whenToUse: 'Use to connect effort to outcomes: which keywords, pages, and sources actually drive conversions and revenue, whether AI search '
         + 'converts, and the single highest-value move. This is the join across SEO rank, analytics sources, and conversion goals that no standalone '
         + 'tool has.',
      examplePrompt: 'For example.com, what actually drives demo bookings and revenue, SEO, direct, or AI, and what should I fix?',
   },
   {
      id: 'causal_links',
      toolName: 'causal_links',
      category: 'cross-pillar',
      title: 'Did my SEO pay off: which rank change drove which traffic change',
      description: 'The over-time cross-pillar join no single tool can do: for each page that has BOTH tracked-keyword rank history (SEO) AND '
         + 'first-party landing sessions (analytics), it correlates the two series and reports which rank change LIKELY drove which traffic change. '
         + 'Ahrefs has rank history but not your sessions; Plausible has sessions but not rank; s33k holds both for one domain in one store. It detects '
         + 'a material rank move and a subsequent traffic move within a lag window and classifies each page as rank-gain-drove-traffic, '
         + 'rank-loss-cut-traffic, rank-up-no-traffic (a demand or snippet problem), rank-traffic-mismatch (rank and traffic both moved materially '
         + 'but in non-matching directions, so the rank change did not drive it), or traffic-fell-rank-flat (check another source, e.g. an AI '
         + 'referral that dried up). It is CORRELATION not proof: every link says "likely", attaches both series as evidence, and never asserts '
         + 'causation. When a page lacks enough history it says so rather than guess. Rules-based, human-only by default, no LLM.',
      whenToUse: 'Use to answer "did my SEO actually pay off?" and to connect a specific rank change to a specific traffic change on the same page '
         + 'over time. This is the temporal join across rank history and your own sessions that standalone rank trackers and standalone analytics tools '
         + 'each cannot do alone. Read the links as correlation, never as proof of cause.',
      examplePrompt: 'Did my SEO actually pay off, which rank changes drove traffic on example.com?',
   },
   {
      id: 'suggest_goals',
      toolName: 'suggest_goals',
      category: 'onboarding',
      title: 'Suggest conversion goals from the site',
      description: 'Proposes ready-to-create conversion goals by spotting a domain\'s likely conversions: thank-you / destination pages (a '
         + 'page_reached goal) and intent pages like demo, contact, or signup (a form_submit goal). It only suggests; you confirm and create with '
         + 'create_goal.',
      whenToUse: 'Use right after onboarding so a user gets conversion tracking proposed for them instead of inventing goals from scratch.',
      examplePrompt: 'Suggest conversion goals for example.com.',
   },
   {
      id: 'setup_status',
      toolName: 'setup_status',
      category: 'onboarding',
      title: 'Onboarding walkthrough: where you are and the next step',
      description: 'Reports a domain\'s setup progress as a checklist (site added, keywords tracked, tracking script live, conversion goals '
         + 'defined, first report ready) with percentComplete, and returns the single next step plus the exact tool to call. It also returns a '
         + 'firstRunHint that points at the dashboard as the place to start: even before setup is finished it tells a brand-new user they can ask '
         + '"show me my dashboard" for the full overview, and once setup is complete the dashboard is the headline next move.',
      whenToUse: 'Use to walk a new user from zero to value step by step, or whenever someone asks what to set up next or whether s33k is '
         + 'configured for their site. When they are set up (or just want the big picture), point them at the dashboard tool for the full overview.',
      examplePrompt: 'Walk me through setting up s33k for example.com, then show me my dashboard.',
   },
   {
      id: 'striking_distance',
      toolName: 'striking_distance',
      category: 'seo',
      title: 'Quick-win keywords ranking just off page one',
      description: 'The highest-ROI SEO to-do list: scans tracked keyword ranks and returns the near-miss "striking distance" keywords currently '
         + 'ranking in positions 4 to 30 (configurable), where a small push tends to win page one because the page already ranks. Each returns the '
         + 'keyword, current position, the ranking url, and the position delta over tracked history (negative means improving, positive means '
         + 'slipping). Sorted by closeness to page one then by recent improvement. Pure query over tracked keywords, no LLM.',
      whenToUse: 'Use to get the cheapest, fastest SEO wins first: keywords already close to page one that only need a small push, prioritized so '
         + 'the closest and most-improving show up on top. Reach for this before chasing brand new keywords.',
      examplePrompt: 'What are my striking distance keywords for example.com, the ones closest to page one I should work first?',
   },
   {
      id: 'channel_report',
      toolName: 'channel_report',
      category: 'analytics',
      title: 'Sessions by marketing channel',
      description: 'Maps every first-party session to a clean marketing channel (Organic Search, AI Search, Referral, Direct) and reports sessions and '
         + 'share of total per channel. With an optional goal, it adds conversions and conversion rate per channel, and it surfaces the top referring '
         + 'sources within the Referral channel. Human-only by default; datacenter bots excluded.',
      whenToUse: 'Use for the "where is my traffic coming from, by channel" question, and the follow-ups: which channel converts best (pass a goal) and '
         + 'which sites send referral traffic. It is the channel-level rollup of acquisition, distinct from goal_analytics (one goal, deep filters) and '
         + 'conversion_attribution (the keyword/page join).',
      examplePrompt: 'Break example.com traffic down by marketing channel for the last 30 days, and show which channel converts my Demo Booked goal best.',
   },
   {
      id: 'live_view',
      toolName: 'live_view',
      category: 'analytics',
      title: 'Real-time snapshot of who is on the site right now',
      description: 'A polled real-time snapshot of first-party activity in the last few minutes (windowMinutes, default 5): active visitors (distinct '
         + 'human sessions), pageviews, the pages currently being viewed with counts, source and country breakdowns, and the most recent events newest '
         + 'first. Human-only by default; datacenter/bot events are excluded and reported separately. There is no websocket: the user\'s LLM polls it '
         + 'repeatedly for a live view.',
      whenToUse: 'Use for "who is on the site right now" or any live/real-time question. Call it repeatedly (every few seconds) to watch activity as it '
         + 'happens. Requires the s33k.js tracking script installed so events flow in. For historical traffic over days/weeks use human_analytics or the '
         + 'traffic summary instead.',
      examplePrompt: 'Who is on example.com right now and what pages are they on?',
   },
   {
      id: 'funnel_analysis',
      toolName: 'funnel_analysis',
      category: 'analytics',
      title: 'Multi-step funnel with per-step drop-off',
      description: 'An ordered, multi-step funnel computed from first-party sessions. Define steps as an array of {type:"page"|"event", match}; for '
         + 'each step it reports how many sessions reached it (a session counts for step N only if it also reached every step before it), the '
         + 'conversion from the previous step, and the drop-off there. Human-only by default; the same composable segment filters apply.',
      whenToUse: 'Use for any ordered path question where you care about WHERE people fall out, not just whether one goal fired: a pricing to cart to '
         + 'checkout flow, a signup wizard, a docs to trial to activation path. Reach for it instead of goal_analytics when the order of steps and the '
         + 'per-step drop-off matter.',
      examplePrompt: 'For example.com, build a funnel from /pricing to /cart to the checkout event and show me where people drop off.',
   },
   {
      id: 'entry_page_report',
      toolName: 'entry_page_report',
      category: 'cross-pillar',
      title: 'The entry-page acquisition lens',
      description: 'Segments first-party traffic by the landing (entry) page where each session starts, not by raw pageviews. Per entry page it returns '
         + 'first-touch sessions broken down by source channel (direct / referral / organic-search / ai), optional goal conversions and rate, and the '
         + 'tracked keywords/rank whose target page is that entry page. The join surfaces two gaps in the data: pages that rank but never land '
         + '(ranking-without-landing) and pages that land but rank for nothing (landing-without-ranking). Human-only by default; the goal is optional.',
      whenToUse: 'Use to connect rankings and AI citations to real acquisition: which pages actually bring people in, where that first touch comes from, '
         + 'and whether the pages you rank for are the pages people land on. It answers "which landing pages drive entries, from which source" and, with '
         + 'a goal, "which entry pages convert", and exposes ranking-without-landing and landing-without-ranking gaps to fix.',
      examplePrompt: 'For example.com, show my entry pages with where their first-touch traffic comes from and the keywords each one ranks for.',
   },
   {
      id: 'period_compare',
      toolName: 'period_compare',
      category: 'analytics',
      title: 'This period vs last period, side by side',
      description: 'Compares the key analytics metrics for a window against the immediately-preceding equal-length window: humanVisitors, pageviews, '
         + 'bounceRatePct, and (with an optional goal) conversions and conversion rate. For each metric it returns both windows plus the delta and percent '
         + 'change. The prior window is derived automatically from the period (30d compares against the 30 days before it). Human-only by default.',
      whenToUse: 'Use for any "is this period better or worse than last period, and by how much" question: traffic up or down week over week, did bounce '
         + 'rate improve, did conversions grow. pctChange is null when the prior window had zero, which means "new" (growth from zero is undefined). For a '
         + 'time series of one metric use timeseries; for a single window snapshot use human_analytics.',
      examplePrompt: 'Compare example.com this 30 days vs the previous 30 days. Are visitors, pageviews, and my Demo Booked conversions up or down?',
   },
   {
      id: 'site_audit',
      toolName: 'site_audit',
      category: 'seo',
      title: 'Prioritized on-page SEO issue list',
      description: 'Crawls a domain and returns a prioritized on-page / technical SEO issue list from pure rules: missing title, title too long (over '
         + '60) or short (under 20), missing meta description, meta too long (over 160) or short (under 50), missing H1, multiple H1s, duplicate titles '
         + 'across pages, and thin content. Each issue carries a severity (high / medium / low) and a detail line, sorted by severity. No LLM.',
      whenToUse: 'Use to get a ranked on-page SEO to-do list for a site: the missing-title and missing-H1 high-severity items first, then meta and '
         + 'length issues. Reach for this when someone asks what is wrong with their pages or how to improve their on-page SEO.',
      examplePrompt: 'Audit example.com for on-page SEO issues and tell me what to fix first.',
   },
   {
      id: 'cannibalization_detection',
      toolName: 'cannibalization_detection',
      category: 'seo',
      title: 'Keyword cannibalization: pages competing for the same term',
      description: 'Finds keyword cannibalization, where Google cannot decide which of your pages should rank for a term so they compete and split '
         + 'the equity. Pure conservative join over tracked keywords. Flags three clear signals: a keyword ranking on a url that is not its target '
         + 'page (intent split), distinct keywords ranking on the same url but targeting different pages (shared url), and near-duplicate terms '
         + 'ranking on different urls (duplicate term). Each group returns the competing keywords/urls and a one-line why. No LLM.',
      whenToUse: 'Use when rankings underperform or feel unstable and you suspect two of your own pages are fighting for the same intent. It surfaces '
         + 'the consolidation work: merge, redirect, or de-target one page so a single page owns each term. Detection is deliberately strict, so a '
         + 'hit is a real conflict, not noise.',
      examplePrompt: 'Is any of my content cannibalizing itself on example.com, where two pages compete for the same keyword?',
   },
   {
      id: 'content_gap',
      toolName: 'content_gap',
      category: 'seo',
      title: 'Topics a competitor covers that you do not',
      description: 'Finds content gaps against a competitor: crawls the competitor to derive their per-page topics (slug-as-phrase or the title head '
         + 'before a separator), crawls your site plus your tracked keywords/target pages to derive what you already cover, and returns the competitor '
         + 'topics with no close match in yours. Each gap has the competitor url and derived topic, sorted by how content-rich the competitor page '
         + 'looks (excerpt length). Pure crawl-based string comparison, no LLM, no external API.',
      whenToUse: 'Use to decide what to write next: surface the topics a named competitor has pages for and you do not, prioritized by how substantial '
         + 'the competitor page looks. Reach for this for "what content am I missing vs X" or "what is competitor X ranking on that I am not covering".',
      examplePrompt: 'What topics does highspot.com cover that example.com does not?',
   },
   {
      id: 'content_performance_report',
      toolName: 'content_performance_report',
      category: 'cross-pillar',
      title: 'Which content actually performs',
      description: 'A prebuilt report ranking a domain\'s pages by pageviews, joining per page: entries (sessions that landed there), optional '
         + 'view-attributed goal conversions and rate (over sessions that saw the page), and the tracked keywords whose target page is that page '
         + '(with current Google rank). The cross-pillar content scorecard: traffic + acquisition + conversion + SEO, per page. A tracked page with '
         + 'zero traffic still appears (ranking-without-traffic). Human-only by default; no LLM, returns structured data to narrate.',
      whenToUse: 'Use for the "which of my pages actually perform" question: see top pages by traffic, then whether each one acquires (entries), '
         + 'converts (pass a goal), and what it ranks for, all in one report. Distinct from entry_pages (focused only on landing pages) and '
         + 'page_scoreboard, this ranks by pageviews and view-attributes conversions to every page a converting session saw.',
      examplePrompt: 'Show me which content actually performs on example.com over the last 30 days: top pages by traffic, how many sessions they land, what they rank for, and which convert my Demo Booked goal.',
   },
   {
   id: 'weekly_digest',
   toolName: 'weekly_digest',
   category: 'cross-pillar',
   title: 'Weekly digest (week in review)',
   description:
      'A prebuilt cross-pillar "week in review" for a domain (defaults to a 7d window). Bundles traffic '
      + '(human visitors, pageviews, bounce), the top 5 entry pages, sessions per channel, a count of AI-search '
      + 'sessions, and the keywords that moved most in Google rank (improved or worsened) over the window. When '
      + 'a goal is supplied it also returns that goal\'s conversions (total + rate) and the single top '
      + 'opportunity (money move). Human-only by default. s33k runs the joins with transparent rules and calls no '
      + 'LLM; the connected LLM narrates the structured digest.',
   whenToUse:
      'Reach for it for a fast weekly recap of a site, a "how did we do this week?" question, or a Monday '
      + 'standup. It is the broad weekly bundle; use briefing for the deeper daily proactive analysis, or the '
      + 'individual pillar tools (human_analytics, channel_report, conversion_attribution) for one slice in depth.',
   examplePrompt: 'Give me the weekly digest for example.com, and include the Demo Booked goal.',
},
   {
  id: 'executive_summary',
  toolName: 'executive_summary',
  category: 'cross-pillar',
  title: 'Executive summary: the leadership one-glance report',
  description: 'A single leadership-facing standup for a domain that bundles all three pillars into one call: headline numbers (human '
     + 'visitors, plus conversions and conversion rate when a goal is named), the top traffic channel and the top CONVERTING channel, an SEO '
     + 'snapshot (how many keywords sit on page one, and the biggest rank gain and biggest rank loss over the period from rank history), AI '
     + 'visibility (are AI engines sending visitors, yes/no plus a count and the top engine), a 2-3 sentence plain-English healthLine, and the '
     + 'single most important nextAction. Human-only by default so the numbers are not inflated by bots. Rules-based: it never calls an LLM; the '
     + 'healthLine and nextAction are deterministic strings the user\'s own LLM can narrate.',
  whenToUse: 'Use when a leader (or you, on their behalf) wants the whole picture in one glance without running each pillar tool. Where briefing '
     + 'is the operator\'s daily standup and alerts answers "what moved", this answers "how are we doing, in one screen, for someone who will not '
     + 'run five tools". Pass a goal to fold conversions and the top converting channel into the headline.',
  examplePrompt: 'Give me the executive summary for example.com for the demo-booked goal over the last 30 days.',
},
   {
      id: 'seo_report',
      toolName: 'seo_report',
      category: 'seo',
      title: 'Comprehensive prebuilt SEO snapshot in one call',
      description: 'A prebuilt SEO report that bundles the whole picture for a domain into one structured response, so a marketer does not have to '
         + 'chain separate SEO tools. Pure query over tracked keywords: no crawl, no analytics provider, no LLM. Returns four sections. summary: total '
         + 'tracked keywords and how many sit in the top 3, top 10, page one, and not in the top 100 (the rank-distribution headline). summary also '
         + 'reports rankingsPending: keywords whose first Google check is still running (counted as pending, NOT as "not in the top 100"); when any are '
         + 'pending the note leads with that, and if most checks are failing for a config or quota reason the note says the SERP source needs setup. strikingDistance: '
         + 'the quick-win keywords ranking just off page one (positions 4 to 30 by default, configurable via min/max), each with its position delta over '
         + 'history, reusing the same logic as striking_distance. topMovers: the biggest rank improvements and the biggest drops over each keyword\'s '
         + 'tracked history (improvements most-improved first, drops biggest-fall first), capped by moversLimit (default 5). rankingPages: tracked '
         + 'keywords grouped by their target_page, busiest page first, each page listing the terms and positions it holds (best rank first).',
      whenToUse: 'Use for the one-call "how is my SEO doing overall and what should I work on" question, when you want the full snapshot (distribution '
         + 'plus quick wins plus what changed plus per-page coverage) at once rather than calling summary, striking_distance, and scoreboard separately. '
         + 'Drill into striking_distance, page_scoreboard, or keyword detail from its sections.',
      examplePrompt: 'Give me the full SEO report for example.com: how am I ranking overall, my quick wins, what moved, and which pages rank for what.',
   },
   {
      id: 'aeo_report',
      toolName: 'aeo_report',
      category: 'aeo',
      title: 'AEO report (prebuilt snapshot)',
      description: 'One-call AI-search snapshot for a domain: aiReferrals (AI engines that sent visitors, per engine) and an engineSummary '
         + '(referral visitors per engine plus the top advocate). Bundles the AEO referral signal, never queries an LLM.',
      whenToUse: 'Use for a single whole-picture AEO read instead of calling ai_referrals and ai_visibility separately. The note '
         + 'flags thin first-party data.',
      examplePrompt: 'Give me the full AEO snapshot for example.com over the last 30 days.',
   },
   {
      id: 'top_clicks',
      toolName: 'top_clicks',
      category: 'analytics',
      title: 'Top clicks',
      description: 'Lists the most-clicked elements on a domain from s33k autocapture (zero per-element setup). Reports the element text and '
         + 'selector, never any typed value.',
      whenToUse: 'Use to see which CTAs, nav links, and buttons actually get clicked. Cookieless, no PII.',
      examplePrompt: 'Which buttons get clicked most on example.com?',
   },
   {
      id: 'form_submissions',
      toolName: 'form_submissions',
      category: 'analytics',
      title: 'Form submissions',
      description: 'Reports form-submission activity from s33k autocapture: which forms get submitted, how often, and from which pages. Records the '
         + 'form id/name only, never field values.',
      whenToUse: 'Use to measure conversion or funnel health, signup volume, and contact-form engagement. Cookieless, no PII.',
      examplePrompt: 'How many form submissions did example.com get this month?',
   },
   {
      id: 'scroll_depth',
      toolName: 'scroll_depth',
      category: 'analytics',
      title: 'Scroll depth',
      description: 'Reports how far down each of a domain\'s pages visitors scroll, from s33k autocapture, with a site-wide scroll-depth '
         + 'distribution histogram.',
      whenToUse: 'Use to find how far down each page visitors actually scroll, which pages get read deeply versus abandoned at the top. '
         + 'Cookieless, no PII.',
      examplePrompt: 'How far down each page do visitors scroll on example.com?',
   },
   {
      id: 'page_engagement',
      toolName: 'page_engagement',
      category: 'analytics',
      title: 'Page engagement time',
      description: 'Reports active engagement (dwell) time per page from s33k autocapture, pausing the timer when the tab is hidden or the visitor '
         + 'goes idle.',
      whenToUse: 'Use to see which pages truly hold attention versus which bounce, beyond raw pageviews. Cookieless, no PII.',
      examplePrompt: 'Which pages hold attention longest on example.com?',
   },
   {
      id: 'conversions_by_source',
      toolName: 'conversions_by_source',
      category: 'analytics',
      title: 'Conversions by source',
      description: 'Attributes conversions (autocaptured form submissions by default, or any chosen event type) to the first-touch source the '
         + 'visitor arrived from (direct, organic-search, ai, or a referral host), with per-source counts, share of total, the top converting '
         + 'source, and an honestly-approximate conversion rate. Answers which traffic sources actually convert with no GA4 setup. Cookieless, '
         + 'no PII; the source is a classification or bare host, never a full referrer URL.',
      whenToUse: 'Use to find which channels drive real business outcomes (form fills, signups) and not just traffic volume, and to decide where '
         + 'to invest. Where form_submissions counts conversions by form/page, this splits them by acquisition source.',
      examplePrompt: 'Which traffic sources drive the most conversions on example.com?',
   },
   {
      id: 'web_vitals',
      toolName: 'web_vitals',
      category: 'analytics',
      title: 'Core Web Vitals',
      description: 'Reports real-user Core Web Vitals for a domain from s33k autocapture. For each metric (LCP, CLS, INP, FID, FCP, '
         + 'TTFB) it computes the p75 (the 75th-percentile value Google uses to score CWV) and classifies it against Google\'s field '
         + 'thresholds into good, needs-improvement, or poor, with the sample count behind each. It also returns the worst pages by '
         + 'LCP p75 (or the most-sampled metric) so you see WHICH pages are slow. Field data from real visitors, not a lab test; '
         + 'cookieless, no PII. Returns a clear note when no samples exist yet.',
      whenToUse: 'Use to judge a site\'s real-world loading, interactivity, and visual-stability performance the way Google ranks it, '
         + 'and to find the specific slow pages to fix. The web-vital samples flow from the same s33k.js script as the other analytics, '
         + 'so no extra setup is needed beyond an up-to-date tracking tag.',
      examplePrompt: 'How are example.com\'s Core Web Vitals, and which pages are slowest?',
   },
   // --- Cross-pillar analyst ---
   {
      id: 'page_scoreboard',
      toolName: 'page_scoreboard',
      category: 'cross-pillar',
      title: 'Page scoreboard',
      description: 'Joins per-page traffic with tracked keywords for a domain: which pages earn traffic, what each ranks for, and where the content '
         + 'gaps are. Pass an OPTIONAL goal (name or goalId) to add per-page conversions (goal conversions whose first-party session LANDED on that '
         + 'page) and conversionRate (over first-party sessions that landed there); omit it and the scoreboard is unchanged.',
      whenToUse: 'Use for the core SEO-plus-analytics view, to find pages with traffic but no tracked keyword (a content-gap signal), and with a '
         + 'goal to see which pages convert.',
      examplePrompt: 'Show the per-page scoreboard for example.com, with conversions for the "demo-request" goal.',
   },
   {
      id: 'entry_pages',
      toolName: 'entry_pages',
      category: 'cross-pillar',
      title: 'Entry page analysis',
      description: 'Analyzes a domain\'s ENTRY (landing) pages, where sessions start and acquisition happens. For each entry page it joins the '
         + 'first-touch source split (direct/referral/search/ai), the page\'s tracked keywords and current Google rank, and its AI referrals, '
         + 'then assigns a status: working (ranks AND lands from search), ranking-not-landing (tracks ranking keywords but gets little entry '
         + 'traffic, a gap to fix), brand-direct (lots of direct/referral entries but no tracked ranking), ai-landing (AI search is a meaningful '
         + 'first-touch source), or opportunity (entry traffic but neither ranking nor AI). Per-page AI-search landing counts are EXACT, computed '
         + 'from s33k\'s own first-party sessions (which pages AI search actually landed on); the four-way source split per page is still '
         + 'approximated from the site-wide referrer mix and the response says so. The response is summary-first and bounded: the summary covers '
         + 'all pages while the entryPages array defaults to the top 20 by entries (meta.truncated flags this); pass detail=true for the full array '
         + 'or limit=N (1..200) to change the cap.',
      whenToUse: 'Use to see which pages are the real acquisition surface, connect "we rank for X" to "X actually lands people", find pages '
         + 'that rank but drive no entry traffic, and decide where to invest. Complements page_scoreboard (all pages) by focusing only on '
         + 'entry pages.',
      examplePrompt: 'Which entry pages on example.com rank AND land, and which rank but drive no traffic?',
   },
   {
      id: 'insights',
      toolName: 'insights',
      category: 'cross-pillar',
      title: 'Cross-pillar insights',
      description: 'A ready-made rules-based analysis joining SEO rank, traffic, AI referrals, and engagement into structured findings and '
         + 'recommendations. The server does the joins; it never calls an LLM.',
      whenToUse: 'Use when you want the highest-leverage findings without running each tool yourself.',
      examplePrompt: 'What are the biggest SEO and analytics opportunities for example.com?',
   },
   {
      id: 'briefing',
      toolName: 'briefing',
      category: 'cross-pillar',
      title: 'Daily briefing',
      description: 'A single proactive cross-pillar daily standup for a domain: a headline, sections, and the top 3 recommended actions in priority '
         + 'order. Rules-based, never calls an LLM.',
      whenToUse: 'Use for a current snapshot of how the site is doing right now, not a change report. For the daily home and '
         + '"what changed since yesterday" use daily_brief instead; for one change signal in detail use alerts.',
      examplePrompt: 'Give me the daily briefing for example.com.',
   },
   {
      id: 'alerts',
      toolName: 'alerts',
      category: 'cross-pillar',
      title: 'Proactive alerts: what changed and what to do',
      description: 'Your "what changed and what to do" standup across SEO, AI search, and analytics. Compares the current period to the prior '
         + 'one and surfaces notable shifts as a prioritized list of plain-English alerts: keyword rank moves of 5+ positions or crossing page one, '
         + 'traffic swings of 25%+, CONTENT DECAY (a page whose traffic fell 35%+ off a real prior baseline, called out explicitly when a tracked '
         + 'keyword\'s rank HELD, the classic stale-content signal, with a "refresh this content" recommendation), any NEW AI referral engine '
         + '(a leading AEO signal), and form-submission/conversion shifts of 30%+. '
         + 'Each alert carries a severity, the headline shift, a detail, and a concrete recommendation; RANK alerts also carry a context object '
         + 'with the prior vs current position and, when the stored SERP allows it, the domains immediately above you now. The response also '
         + 'returns the single most important thing to act on right now. Pass since=<ISO timestamp> to scope the current window to everything '
         + 'after that moment (the cheap "what changed since yesterday" poll; takes precedence over period). Rules-based: it never calls an LLM, '
         + 'and it stays silent on a signal it cannot honestly measure rather than inventing a movement.',
      whenToUse: 'Use to drill into one change signal in full detail, or with since to poll cheaply for anything new since your last check. '
         + 'daily_brief gives the prioritized daily summary; this lists every '
         + 'change since the prior window with the numbers and a concrete next action for each.',
      examplePrompt: 'What moved on my site since the prior period, and what should I do about it?',
   },
   {
      id: 'daily_brief',
      toolName: 'daily_brief',
      category: 'cross-pillar',
      title: 'Daily brief: your daily home (call this every day)',
      description: 'Your daily standup and daily HOME in s33k: the single most important thing to do right now, what changed since the prior period '
         + 'and why, in one tight digest. It composes a headline (the most important thing right now), 2-4 what-changed bullets (this period vs the '
         + 'prior equal window across rank, traffic, AI referrals including new AND collapsed engines, and conversion volume and rate), and the single '
         + 'top action enriched with the top AI-visibility opportunity and the top opportunity page. The same brief is also delivered by scheduled '
         + 'email when the instance enables it. Rules-based: it never calls an LLM and is honest on a quiet week ("nothing material changed") rather '
         + 'than inventing movement.',
      whenToUse: 'Call FIRST every day, or enable scheduled email delivery. This is the daily home. briefing gives a current snapshot; alerts drills '
         + 'into one change signal; daily_brief is the prioritized summary that sits on top of both.',
      examplePrompt: 'What should I focus on today?',
   },
   // --- Onboarding ---
   {
      id: 'discover_pages',
      toolName: 'discover_pages',
      category: 'onboarding',
      title: 'Discover pages',
      description: 'Crawls a domain (sitemap first, then homepage links) and returns a compact summary of each important page: url, title, meta, '
         + 'headings, excerpt. No server-side LLM.',
      whenToUse: 'Use at the start so you can map keywords to real pages instead of guessing. Capped at 25 pages.',
      examplePrompt: 'Crawl example.com and list its main pages.',
   },
   {
      id: 'onboard',
      toolName: 'onboard',
      category: 'onboarding',
      title: 'Onboard a domain',
      description: 'One call from nothing to live data: creates the domain, discovers keywords, adds up to 20 and queues a background Google rank check, '
         + 'and (when analytics is set up) returns the tracking snippet plus install guides with analyticsReady true. It also returns a timingNote '
         + '(when to re-check rankings) and a firstRunHint that hands the user off to the dashboard, so right after onboarding they can ask '
         + '"show me my dashboard" or "show me an overview" to see everything in one place.',
      whenToUse: 'Use as the first thing you do for a brand new site. The only input is the bare domain. After it returns, point the user at the '
         + 'dashboard tool ("show me my dashboard") so they start from the full overview instead of a blank slate.',
      examplePrompt: 'Set up everything in s33k for example.com, then show me my dashboard.',
   },
   {
      id: 'install_instructions',
      toolName: 'install_instructions',
      category: 'onboarding',
      title: 'Install instructions',
      description: 'Returns the tracking snippet plus step-by-step install guides for the user\'s platform (WordPress, Webflow, Shopify, '
         + 'Squarespace, Wix, GTM, Next.js/React, raw HTML) for an already-onboarded domain.',
      whenToUse: 'Use when someone asks "how do I add the tracking code on <platform>" or needs the snippet again after onboarding.',
      examplePrompt: 'How do I add the s33k tracking code on Webflow?',
   },
   // --- Security / data ownership ---
   {
      id: 'export_data',
      toolName: 'export_data',
      category: 'security',
      title: 'Export all your data',
      description: 'Downloads everything s33k holds as one JSON bundle: domains, keywords with rank history, and autocapture events. Never '
         + 'includes a secret.',
      whenToUse: 'Use whenever you want to take your data with you, back it up, or verify exactly what s33k stores.',
      examplePrompt: 'Export all of my s33k data.',
   },
   {
      id: 'security_facts',
      toolName: 'security_facts',
      category: 'security',
      title: 'Is s33k safe? Get the trust facts',
      description: 'Returns s33k\'s complete, source-cited trust facts: no model training, single-user by design (no other accounts, no signup, '
         + 'so no one else can see your data), encryption at rest (connected credentials, with the honest plaintext-analytics residual), '
         + 'data ownership (export your data), open-source/self-hostable, and cookieless/no-PII tracking.',
      whenToUse: 'Use whenever a user asks whether s33k is safe, private, or trustworthy, or whether it trains on or shares their data.',
      examplePrompt: 'Is s33k safe? Do you train on my data?',
   },
   {
      id: 'campaign_report',
      toolName: 'campaign_report',
      category: 'analytics',
      title: 'Sessions by UTM campaign',
      description: 'Groups every first-party session by its UTM campaign (utm_campaign) and reports sessions and share of total per campaign, with a '
         + 'breakdown of sessions by utm_source and utm_medium. With an optional goal, it adds conversions and conversion rate per campaign. Untagged '
         + 'sessions roll into a single "(none)" bucket (listed last) so totals reconcile. Human-only by default; datacenter bots excluded.',
      whenToUse: 'Use for the "how is each marketing campaign performing" question and its follow-ups: which campaign sends the most traffic, which '
         + 'converts best (pass a goal), and how source/medium split. It is the UTM-campaign rollup of acquisition, distinct from channel_report (clean '
         + 'channel buckets) and conversion_attribution (the keyword/page join). Requires UTM-tagged landing URLs.',
      examplePrompt: 'Break example.com traffic down by UTM campaign for the last 30 days, and show which campaign converts my Demo Booked goal best.',
   },
   {
      id: 'segment_save',
      toolName: 'segment_save',
      category: 'analytics',
      title: 'Save a named, reusable segment',
      description: 'Save a named filter set (e.g. "AI human converters") once, built from the composable analytics filters: channel '
         + '(direct|referral|organic-search|ai; aliases seo/aio), device, country, landingPage, page, engagement, and humanOnly. At least one '
         + 'filter is required; unknown keys are ignored.',
      whenToUse: 'Use to name a filter combination you ask for repeatedly, so you can apply it by name with segment_analytics instead of '
         + 're-specifying every filter.',
      examplePrompt: 'Save a segment called "AI human converters" for AI traffic, humans only.',
   },
   {
      id: 'segment_list',
      toolName: 'segment_list',
      category: 'analytics',
      title: 'List saved segments',
      description: 'List the named, reusable segments defined for a domain and the filter rules each one stores.',
      whenToUse: 'Use to see which saved segments exist before applying or deleting one.',
      examplePrompt: 'What saved segments do I have for example.com?',
   },
   {
      id: 'segment_delete',
      toolName: 'segment_delete',
      category: 'analytics',
      title: 'Delete a saved segment',
      description: 'Delete a named segment by its id (get ids from segment_list).',
      whenToUse: 'Use to remove a saved segment you no longer need.',
      examplePrompt: 'Delete the "Mobile organic" segment.',
   },
   {
      id: 'segment_analytics',
      toolName: 'segment_analytics',
      category: 'analytics',
      title: 'Traffic analytics for a saved segment',
      description: 'Apply a saved segment by name (or id) and get the same human-analytics-style traffic summary (visitors, pageviews, bounce '
         + 'rate, pages per session, entry and exit pages) with the segment\'s stored filters applied. Human-only unless the segment saved '
         + 'humanOnly=false.',
      whenToUse: 'Use to pull a reusable filtered traffic view by name, instead of re-specifying channel/device/country/engagement/humanOnly on '
         + 'every call.',
      examplePrompt: 'Show me the "AI human converters" segment for example.com over the last 30 days.',
   },
   {
      id: 'portfolio_summary',
      toolName: 'portfolio_summary',
      category: 'cross-pillar',
      title: 'Portfolio rollup across all your sites',
      description: 'Summarizes EVERY domain on your account in one call (no domain argument), for the multi-site / agency view. Per domain it returns a '
         + 'compact summary: the keyword rank distribution (total tracked, in top 3, in top 10, on page one, not in top 100), a striking-distance '
         + 'quick-win count (the same near-page-one logic as striking_distance), and human plus AI-referral session counts when first-party events '
         + 'exist in the window (traffic is null when a site has no events yet). Domains are sorted by tracked-keyword count, descending. Pure query, no LLM.',
      whenToUse: 'Use for the "how are all my sites doing" question when you manage more than one domain (an agency or a multi-site owner), instead of '
         + 'calling summary / striking_distance / channel_report once per site. Then drill into a single site with the per-domain tools.',
      examplePrompt: 'Give me a portfolio rollup of all my sites: rank distribution, quick-win count, and human vs AI traffic for each over the last 30 days.',
   },
   {
      id: 'competitor_visibility',
      toolName: 'competitor_visibility',
      category: 'seo',
      title: 'Competitor share of voice',
      description: 'Reads the full Google SERP page that every tracked keyword already stores and tallies how often each external domain ranks for the '
         + 'same terms you track. Returns competitors ranked by share of voice (the fraction of your tracked keywords they appear on) with average '
         + 'rank, plus a per-keyword view of who outranks you. No new scrape and no LLM, it reads stored data only.',
      whenToUse: 'Use to see who you compete with in search and where rivals outrank you, once your tracked keywords have been refreshed at least once '
         + 'so their SERP results are on disk.',
      examplePrompt: 'Who are my top competitors in search for example.com, and which keywords do they outrank me on?',
   },
   {
      id: 'dashboard',
      toolName: 'dashboard',
      category: 'cross-pillar',
      title: 'The one-call overview (start here)',
      description: 'The default "show me an overview" experience: the key numbers across SEO rank, AI search, and analytics in ONE call, plus a '
         + 'contextual list of next questions to ask. Composes a headline (human visitors, AI-referred visitors, top opportunity, top action), top '
         + 'pages, top sources, best keywords, rank distribution, AI referrals per engine, Core Web Vitals, per-goal conversions, and the biggest rank '
         + 'movers. Every section is empty-safe, so a brand-new domain still gets a coherent, honest overview. Returns a rendered ASCII view too. '
         + 'Rules-based: reads only your scoped data and never queries an LLM.',
      whenToUse: 'The FIRST thing to reach for when the user says "show me an overview" or "show me my dashboard", asks how their site is doing, or '
         + 'does not know what to ask. Use it to orient, then offer the suggestedQuestions it returns.',
      examplePrompt: 'Show me an overview of example.com',
   },
   {
      id: 'aeo_roi',
      toolName: 'aeo_roi',
      category: 'cross-pillar',
      title: 'The AI Visibility P&L: does AI search make me money',
      description: 'The flagship cross-pillar report no AEO tool can produce: it closes the loop from AI-referred traffic to conversions '
         + 'to revenue, per page. For a named goal it joins which AI engines referred real visitors to each page, which '
         + 'converted, and what each conversion is worth. Returns a per-page funnel (AI-referred sessions, conversions, AI versus organic '
         + 'conversion rate, revenue when the goal has a value) plus the money moves (pages where AI out-converts '
         + 'organic, pages AI sends traffic to that never convert). When a layer has no data it says so rather than fabricate a rate off a zero baseline.',
      whenToUse: 'Use to prove or disprove that AI visibility pays: the end-to-end return from AI-referred traffic through to revenue, per page, and the single '
         + 'highest-value AEO move. This is the join across AI referral traffic and conversion goals that no standalone AEO tool has.',
      examplePrompt: 'Is AI search making me money?',
   },
];

// ---------------------------------------------------------------------------
// Setup (references the install-guide library; does not duplicate its content).
// ---------------------------------------------------------------------------
const setup = {
   summary: 'Install s33k from source (clone, npm install, set the .env, npm run build, npm start) or run the bundled '
      + 'docker-compose stack (s33k + Postgres). Then connect your LLM one of two ways, both exposing the same '
      + 'tools: (1) LOCAL stdio, by adding the MCP server with your s33k API key as S33K_API_KEY and your instance URL '
      + 'as S33K_BASE_URL; or (2) HOSTED HTTP, with no local install, by adding the running server\'s /api/mcp endpoint '
      + 'as an HTTP MCP server with an Authorization: Bearer <api key> header (claude mcp add --transport http s33k '
      + '<base-url>/api/mcp --header "Authorization: Bearer <key>"). The single key is your APIKEY (the same value the '
      + 'MCP server uses). Full steps live in README.md, DEPLOY.md, and mcp/README.md in the repository.',
   connectClients: 'Per-client connect instructions. s33k is single-user and self-hosted, so the endpoint is YOUR OWN '
      + 'instance: <base-url>/api/mcp (for example http://localhost:3000/api/mcp, or your deployed URL). Every client uses '
      + 'the same single Bearer key, your APIKEY (the same value the MCP server reads). There is no OAuth and no signup. '
      + 'CLAUDE CODE (CLI): run `claude mcp add --transport http s33k <base-url>/api/mcp --header "Authorization: Bearer <key>"`. '
      + 'CURSOR: add to ~/.cursor/mcp.json (or project .cursor/mcp.json): { "mcpServers": { "s33k": { "url": "<base-url>/api/mcp", '
      + '"headers": { "Authorization": "Bearer <key>" } } } }. '
      + 'CODEX (CLI): run `codex mcp add s33k --url <base-url>/api/mcp --bearer-token-env-var S33K_API_KEY`, then export S33K_API_KEY=<key> '
      + 'in the shell that launches Codex (add it to ~/.zshrc to persist). '
      + 'CLAUDE DESKTOP: bridge the HTTP endpoint with mcp-remote in claude_desktop_config.json '
      + 'under mcpServers, e.g. { "mcpServers": { "s33k": { "command": "npx", "args": ["-y", "mcp-remote", '
      + '"<base-url>/api/mcp", "--header", "Authorization:Bearer <key>"] } } }. KNOWN GOTCHA: the Authorization header value must '
      + 'arrive as ONE argument. The space between "Bearer" and the key can get split into two args, which breaks auth, so pass the header '
      + 'as a single unsplit token (write it "Authorization:Bearer <key>" with no space, or otherwise keep "Bearer <key>" together as one value). '
      + 'ANY OTHER MCP CLIENT: point it at <base-url>/api/mcp and send the Authorization: Bearer <key> header. '
      + 'Same endpoint and same Bearer key for every client; only the config file or command differs.',
   fiveMinutesToValue: 'The bar is install-to-real-data in about five minutes. The fastest path is the onboard capability: '
      + 'give s33k one bare domain and it creates the domain, discovers keywords, queues live Google rank scrapes, '
      + 'provisions an analytics website, and hands back the tracking snippet. Rankings appear shortly after onboarding '
      + '(rankingsPending comes back true while the background scrape runs).',
   addTrackingCode: 'Analytics, autocapture engagement, and AI-referral signal only flow once the tracking script is on the '
      + 'site. After onboarding, call install_instructions for your platform to get the exact snippet and copy-paste steps '
      + '(raw HTML, Google Tag Manager, WordPress, Webflow, Shopify, Squarespace, Wix, Next.js/React).',
   connectSearchConsole: 'Google Search Console is an optional richer layer, not the first step. It gives real impression '
      + 'and click data (read via get_insight) beyond the keywords you track explicitly. It is connected after first value '
      + 'because the service-account flow is slower than the Serper-key rank path that onboarding leads with.',
   installGuidesSource: 'The exact tracking snippet and per-platform steps come from getInstallGuides(domain, websiteId) in '
      + 'utils/install-guides.ts, surfaced at runtime by the install_instructions capability (GET /api/install-instructions). '
      + 'That library is the single source for install copy; ask install_instructions for the live, domain-specific version.',
};

// ---------------------------------------------------------------------------
// Reasoning (honest "why", grounded in SECURITY.md).
// ---------------------------------------------------------------------------
const reasoning: ReasoningEntry[] = [
   {
      id: 'why_mcp_first',
      question: 'Why is s33k controlled from an LLM over MCP instead of a dashboard?',
      answer: 'Because the product is the unified control plane that joins SEO rank, analytics traffic, and AI visibility, '
         + 'and that join is most useful as an answer, not a chart. s33k does the joins and the rules-based prioritization '
         + 'on the server and hands the structured result to YOUR OWN LLM over MCP, which narrates it. A passive dashboard '
         + 'cannot answer "what happened, why, and what should I do" across all three pillars; an LLM with the joined data '
         + 'can. The whole product is controllable from MCP with no UI.',
   },
   {
      id: 'why_serper',
      question: 'Why does s33k use Serper for rankings instead of asking the user to configure a scraper?',
      answer: 'The 5-minutes-to-value bar. Serper is one API key held server-side: paste a domain, add keywords, see live '
         + 'Google rankings in about two minutes, with no scraper settings exposed to the user. s33k runs the SERP infra so '
         + 'onboarding is "give me your domain," not "configure a scraping backend."',
   },
   {
      id: 'why_cookieless_analytics',
      question: 'Why self-hosted cookieless analytics instead of a hosted analytics vendor?',
      answer: 'Two reasons: data ownership and privacy. Self-hosting your analytics means the analytics data lives in a database you '
         + 'own, not a third party. Cookieless, no-PII tracking (the autocapture script uses no cookies and no '
         + 'fingerprinting, and never reads typed values) means you can run it with zero privacy fear. It is '
         + 'the analytics substrate s33k builds its AI-native signals on top of.',
   },
   {
      id: 'why_no_llm_training',
      question: 'Why is "we do not train on your data" structurally true and not just a policy?',
      answer: 'Because s33k has no model-training pipeline, no LLM client, and no embedding or fine-tuning step anywhere in '
         + 'the codebase. The AI features (briefing, insights, ai_visibility) are rules-based: s33k runs transparent rules '
         + 'over your own data and hands the structured result to your own LLM for interpretation. Since s33k is open source '
         + 'and self-hostable, you can verify this by reading the code or owning the deployment.',
   },
   {
      id: 'why_self_hosted',
      question: 'Why does s33k use my own Serper key and my own database instead of a hosted backend?',
      answer: 'Because s33k is single-user and self-hosted: you supply your own Serper key for rank scrapes and your own '
         + 'database for storage, so the running cost is just your own infrastructure and there is no vendor holding your '
         + 'data or metering your usage. Keyword caps still exist as sane defaults (configurable in utils/limits.ts) so a '
         + 'runaway scrape does not surprise you with Serper cost, but they are yours to raise.',
   },
   {
      id: 'why_open_source',
      question: 'Why is s33k open source and self-hostable?',
      answer: 'The principle is "verify us, don\'t trust us." Open source means you can read every line of code that touches '
         + 'your data; self-hostable means you can run the whole thing on your own infrastructure with your own database so '
         + 'your data never leaves your control. It is the strongest form of a trust guarantee: not asserted, verifiable.',
   },
];

// ---------------------------------------------------------------------------
// Troubleshooting (common issues and fixes).
// ---------------------------------------------------------------------------
const troubleshooting: TroubleshootingEntry[] = [
   {
      id: 'rankings_pending',
      problem: 'I added keywords (or onboarded a domain) but the rankings show 0 or "not ranked".',
      resolution: 'Rank scrapes run in the background, so rankings appear shortly after, not instantly (onboarding returns '
         + 'rankingsPending: true while it works). Re-read with list_keywords a moment later. A position of 0 means the '
         + 'keyword has not scraped yet OR the site is not in the top 100 for that term (an opportunity, not an error). '
         + 'Use refresh_keywords to force a re-scrape.',
   },
   {
      id: 'empty_ai_funnel',
      problem: 'My AI visibility / AI referrals come back empty.',
      resolution: 'AEO measurement is first-party and new: s33k reports AI referrals it has actually recorded, '
         + 'and it only starts recording them once the tracking script is on the site and AI engines begin '
         + 'referring visitors. Empty early on is expected, not a bug: AI referral traffic to most sites builds slowly. '
         + 'When first-party data is thin, ai_visibility falls back to a deterministic AI-readiness audit so you still get a signal.',
   },
   {
      id: 'analytics_needs_script',
      problem: 'Traffic, engagement, scroll depth, or click data is all zeros.',
      resolution: 'Analytics and autocapture only flow once the tracking script is installed on the site. Call '
         + 'install_instructions for your platform, add the snippet, load any page once, then check again in a few minutes. '
         + 'Without the script s33k has no events to report.',
   },
   {
      id: 'invalid_api_key',
      problem: 'A tool or request is rejected with "Invalid API Key Provided." or "Not authorized".',
      resolution: 's33k is single-user: it accepts exactly one API key, the APIKEY you set in the environment (the MCP server '
         + 'uses the same value). Check that the Authorization: Bearer <key> header matches your APIKEY exactly. Browser use '
         + 'is authorized instead by the login session cookie from signing in at /login with USER_NAME / PASSWORD.',
   },
   {
      id: 'route_not_accessible',
      problem: 'A tool fails with "This Route cannot be accessed with API."',
      resolution: 'That capability is not exposed to API-key callers (only a small whitelist is). If it is a tool you expect '
         + 'to work, the route may be missing from the API-key whitelist (utils/allowedApiRoutes.ts). The analytics ingest '
         + 'route (collect) is intentionally not key-callable.',
   },
   {
      id: 'search_console_not_connected',
      problem: 'get_insight returns "Google Search Console is not Integrated".',
      resolution: 'get_insight needs Google Search Console connected for that domain. It is an optional level-2 layer, not '
         + 'part of the fast onboarding path. Connect Search Console in s33k for the domain, then get_insight returns real '
         + 'impression and click data.',
   },
];

// ---------------------------------------------------------------------------
// Trust (references the single securityFacts source; does not duplicate it).
// ---------------------------------------------------------------------------
const trust = {
   summary: 'Run s33k with zero security fear. s33k cannot train on your data (no model-training pipeline exists), it is a '
      + 'single-user tool so there is no cross-account boundary to breach, connected credentials are encrypted at rest (the '
      + 'analytics substrate is plaintext by necessity, the honest residual), tracking is cookieless with no PII, and you can '
      + 'export everything on demand. Every claim is verifiable because s33k is open source and self-hostable. The full, '
      + 'source-cited facts come from utils/securityFacts.ts (also served by the security_facts capability).',
   facts: securityFacts,
};

// ---------------------------------------------------------------------------
// Pricing / limits / privacy (high level).
// ---------------------------------------------------------------------------
const pricingAndLimits = {
   model: 's33k is open source and self-hosted: run it yourself on your own infrastructure and database, free. You supply '
      + 'your own Serper key and host, so your only cost is your infrastructure and the SERP scrapes you run.',
   keywordTracking: 'Keyword tracking is bounded by per-domain and per-request caps (configurable; defaults 200 '
      + 'per domain and 50 per request, see utils/limits.ts) so a runaway scrape does not surprise you with Serper cost. '
      + 'Onboarding adds up to 20 discovered keywords per domain automatically. Raise the caps in utils/limits.ts if you want more.',
   access: 's33k is single-user: one admin login (USER_NAME / PASSWORD) for the browser UI and one API key (the APIKEY, '
      + 'which the MCP server also uses) for the REST API and MCP. Anyone with the URL and that key can act as you, so '
      + 'protect them accordingly.',
   privacy: 'Tracking is cookieless and collects no PII: no cookies, no fingerprinting, the session id lives in '
      + 'sessionStorage and rotates daily, typed values are never read, and the server drops anything PII-shaped before '
      + 'storing it. s33k never trains on your data and never sends it to a model.',
};

const knowledge: KnowledgeBase = {
   capabilities,
   setup,
   reasoning,
   troubleshooting,
   trust,
   pricingAndLimits,
};

/** The topics a help query can be scoped to. */
export type HelpTopic = KnowledgeBase['capabilities'][number]['category']
   | 'setup' | 'reasoning' | 'troubleshooting' | 'trust' | 'pricing';

/**
 * Search the knowledge base for entries relevant to a free-text query, optionally scoped to a
 * topic. Returns a structured slice of the knowledge base: the matching capabilities plus the
 * setup, reasoning, troubleshooting, trust, and pricing context that matched. Pure and
 * dependency-free so GET /api/help can call it cheaply; never throws and never returns an empty
 * shape (it falls back to the full capability catalog when nothing matches, so the LLM always
 * has something to work with).
 * @param {string} q - The user's free-text question.
 * @param {string} [topic] - Optional category/section to scope the search to.
 * @returns The matching knowledge slice.
 */
export const searchKnowledge = (q: string, topic?: string) => {
   const query = String(q || '').toLowerCase().trim();
   const terms = query.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
   const wantTopic = String(topic || '').toLowerCase().trim();

   const matchesText = (...parts: string[]): number => {
      if (terms.length === 0) { return 0; }
      const hay = parts.join(' ').toLowerCase();
      return terms.reduce((score, term) => (hay.includes(term) ? score + 1 : score), 0);
   };

   const isCategory = (['seo', 'aeo', 'analytics', 'cross-pillar', 'onboarding', 'account', 'security', 'sharing'] as const)
      .some((c) => c === wantTopic);

   // Capabilities: filter by topic when a category topic is given, then rank by query overlap.
   // With no query terms (the listable-resource case) return the full scoped catalog, not a
   // truncated slice, so the capabilities resource is a complete doc. With a query, rank by
   // overlap and return the top matches.
   const scopedCaps = isCategory ? capabilities.filter((c) => c.category === wantTopic) : capabilities;
   let matchedCapabilities: CapabilityEntry[];
   if (terms.length === 0) {
      matchedCapabilities = scopedCaps;
   } else {
      const rankedCaps = scopedCaps
         .map((c) => ({ entry: c, score: matchesText(c.toolName, c.title, c.description, c.whenToUse, c.examplePrompt) }))
         .sort((a, b) => b.score - a.score);
      const anyCapMatch = rankedCaps.some((c) => c.score > 0);
      matchedCapabilities = (anyCapMatch ? rankedCaps.filter((c) => c.score > 0) : rankedCaps)
         .slice(0, 8)
         .map((c) => c.entry);
   }

   // A category topic (seo/aeo/...) suppresses the prose sections; a section topic or a
   // free-text query surfaces the sections that match. With no topic and no query, return
   // everything so the caller always has a useful slice.
   const matchedReasoning = isCategory
      ? []
      : reasoning.filter((r) => (terms.length === 0 ? (!wantTopic || wantTopic === 'reasoning') : matchesText(r.question, r.answer) > 0));
   const matchedTroubleshooting = isCategory
      ? []
      : troubleshooting.filter((t) => (terms.length === 0
         ? (!wantTopic || wantTopic === 'troubleshooting')
         : matchesText(t.problem, t.resolution) > 0));

   const wantsSetup = wantTopic === 'setup' || wantTopic === 'onboarding'
      || (!wantTopic && terms.length === 0)
      || /install|setup|track|snippet|onboard|connect|deploy/.test(query);
   const wantsTrust = wantTopic === 'trust' || wantTopic === 'security'
      || (!wantTopic && terms.length === 0)
      || /safe|secure|privacy|private|trust|train|encrypt|gdpr|data/.test(query);
   const wantsPricing = wantTopic === 'pricing'
      || (!wantTopic && terms.length === 0)
      || /price|pricing|cost|plan|limit|quota|free|paid|seat/.test(query);

   return {
      query: q,
      topic: topic || null,
      capabilities: matchedCapabilities,
      reasoning: matchedReasoning,
      troubleshooting: matchedTroubleshooting,
      setup: wantsSetup ? setup : null,
      trust: wantsTrust ? trust : null,
      pricingAndLimits: wantsPricing ? pricingAndLimits : null,
   };
};

/** The result of cross-checking a feature request against the capability index. */
export type CapabilityMatch = {
   /** True when the request text strongly matches a capability s33k already ships. */
   matched: boolean,
   /** The best-matching capability when matched is true, else null. */
   capability: CapabilityEntry | null,
   /** Raw overlap score of the best match (0 when nothing overlapped). */
   score: number,
};

// The single significant-term tokenizer used by both search and cross-check, so "is this
// already a capability?" is answered the same way "what capability answers this?" is. Drops
// very short tokens and a small stoplist of feature-request filler so the overlap signal is
// dominated by meaningful words (the verb and the noun the user actually wants).
const STOPWORDS = new Set([
   'the', 'and', 'for', 'with', 'that', 'this', 'have', 'has', 'can', 'could', 'would', 'should',
   'want', 'need', 'like', 'add', 'support', 'feature', 'please', 'able', 'ability', 's33k', 'tool',
   'from', 'into', 'about', 'when', 'what', 'how', 'does', 'will', 'are', 'you', 'your', 'our', 'all',
   'get', 'see', 'show', 'give', 'make', 'use', 'using', 'data', 'page', 'pages', 'site',
]);

const significantTerms = (text: string): string[] => String(text || '')
   .toLowerCase()
   .split(/[^a-z0-9]+/)
   .filter((t) => t.length > 2 && !STOPWORDS.has(t));

// The meta / self-support tool (help) is NOT a product feature a user would ask for, so the
// cross-check never maps a feature request onto it.
const META_TOOL_IDS = new Set(['help']);

/**
 * Cross-check a free-text feature request against the capability index, the server-side safety
 * net behind request_feature. It answers one question: does s33k ALREADY ship something that
 * does this? If a capability overlaps the request strongly enough, return it so the caller can
 * push back ("this may already be supported via X") instead of storing a duplicate. Pure, never
 * throws. This is the single source for the "does it exist?" check, so the help tool, the
 * coverage test, and the feature-request gate all reason over the same catalog.
 *
 * Matching is deliberately conservative on BOTH ends: it requires at least two overlapping
 * significant terms (so a single incidental word like "keyword" cannot trigger a false match)
 * AND a clear lead over the runner-up (so an ambiguous request is treated as new, not silently
 * mapped to a capability), because a false "already exists" wrongly blocks a real request, which
 * is worse here than letting a borderline one through to a human.
 * @param {string} request - The user's feature-request text.
 * @returns {CapabilityMatch} Whether it matches an existing capability, and which one.
 */
// The matchable (non-meta) capabilities and their significant-term haystacks, computed once.
// significantTerms is pure and the catalog is a module constant, so this is safe to memoize.
const matchableCapabilities = capabilities.filter((c) => !META_TOOL_IDS.has(c.id));
const capabilityHaystacks: Set<string>[] = matchableCapabilities.map(
   (c) => new Set(significantTerms([c.toolName, c.title, c.description, c.whenToUse, c.examplePrompt].join(' '))),
);

// Document frequency of every term across the matchable haystacks. A term in FEW capability docs
// is distinctive (it points at a specific tool); a term in many is generic filler. We use this only
// as a TIE-BREAK so a raw-count tie resolves to the capability whose matched terms are rarer, i.e.
// the genuinely more specific tool. Example: "how far do visitors scroll on my pages" ties
// scroll_depth and a generic analytics report on raw count, and the rarer term (scroll) picks
// scroll_depth. This NEVER changes the matched/novel boundary (that still rests on raw count below).
const documentFrequency = ((): Map<string, number> => {
   const df = new Map<string, number>();
   for (const hay of capabilityHaystacks) {
      for (const term of hay) { df.set(term, (df.get(term) || 0) + 1); }
   }
   return df;
})();

// Inverse-document-frequency weight of one term: rarer terms weigh more. Smoothed so a term that
// is unseen (df 0) still gets a positive, finite weight and the function never divides by zero.
const idfWeight = (term: string): number => {
   const total = capabilityHaystacks.length;
   const df = documentFrequency.get(term) || 0;
   return Math.log((total + 1) / (df + 1)) + 1;
};

export const crossCheckCapability = (request: string): CapabilityMatch => {
   const terms = significantTerms(request);
   if (terms.length === 0) {
      return { matched: false, capability: null, score: 0 };
   }
   const unique = Array.from(new Set(terms));
   const ranked = matchableCapabilities
      .map((c, i) => {
         const haySet = capabilityHaystacks[i];
         // score = raw count of overlapping significant terms (the gate metric, unchanged).
         // weight = idf-summed overlap (the tie-break metric only): rarer overlaps weigh more.
         let score = 0;
         let weight = 0;
         for (const term of unique) {
            if (haySet.has(term)) { score += 1; weight += idfWeight(term); }
         }
         return { entry: c, score, weight };
      })
      // Primary sort by raw overlap count (preserves the matched gate). Break ties by idf weight so
      // an equal-count tie selects the more DISTINCTIVE capability, not whichever happened to be
      // first in the catalog. The tie-break changes only WHICH tool is named, never matched-ness.
      .sort((a, b) => (b.score - a.score) || (b.weight - a.weight));

   const best = ranked[0];
   const runnerUp = ranked[1] ? ranked[1].score : 0;
   // Strong match = at least two meaningful overlapping terms AND a clear lead over the next
   // capability. Otherwise the request is treated as genuinely new and allowed through to store.
   const matched = best.score >= 2 && best.score > runnerUp;
   return { matched, capability: matched ? best.entry : null, score: best.score };
};

export default knowledge;
