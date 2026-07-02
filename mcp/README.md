# s33k MCP server

This is the MCP (Model Context Protocol) control layer for s33k. It lets an LLM client such as Claude Code or Cursor operate s33k entirely over a single connection: track keywords and read live Google rankings, detect AI visibility from referral data, read owned analytics, and pull the cross-pillar briefing and scoreboard.

The server is a thin wrapper over the s33k REST API. It authenticates with the s33k Bearer API key, so it runs fully headless with no login cookie.

There are two ways to connect, and they expose the EXACT same tools (the registrations are shared in `src/tools.ts`):

- **Local (stdio).** Run the compiled `dist/index.js` as a stdio child of your MCP client. This is the usual way a self-hoster runs s33k. Uses `S33K_API_KEY` from the environment. See [Register it in Claude Code](#register-it-in-claude-code).
- **Hosted (HTTP).** Connect to your running s33k server's `/api/mcp` endpoint with one URL plus your Bearer key. NO local install. Handy when your MCP client and your s33k instance run on different machines. See [Connect over the hosted HTTP endpoint](#connect-over-the-hosted-http-endpoint).

## Tools

The server registers 73 tools and 5 knowledge resources, grouped by pillar. s33k is single-user: there is one flat tool surface and one API key, no per-tool access tiers. The authoritative source is `src/tools.ts` (the shared `registerS33kTools`, used by both transports); the per-tool descriptions live in `utils/knowledge.ts` in the root repo. Most read tools take `domain` and an optional `period` (e.g. `30d`); the per-tool specifics are below.

### Getting started

| Tool | What it does |
|---|---|
| `start_here` | **Call this first.** The guided entry point: give it a domain (or no domain to pick one) and it returns your setup state, the single most important thing to do now, and where to look next, including which pages AI search lands on (`entry_pages`). If you do not know where to start, start here. |

### Cross-pillar

| Tool | What it does |
|---|---|
| `briefing` | One proactive daily standup for a domain: a headline, sections, and the top three actions across every pillar. Best first call of the day. |
| `insights` | Cross-pillar analyst. Joins rank, traffic, AI referrals, and engagement into rules-based findings and prioritized recommendations. |
| `alerts` | The "what changed and what to do" standup. Compares this period to the prior one and surfaces rank moves (with SERP context: who sits directly above you), traffic swings, content decay (a page losing traffic while its rank held: refresh it), and new AI engines, plus the top priority. Pass `since=<ISO timestamp>` to poll "what changed since yesterday" cheaply. |
| `executive_summary` | The leadership one-glance report: headline numbers, top and top-converting channel, an SEO snapshot, AI visibility, a health line, and the single next action. |
| `weekly_digest` | A week-in-review bundle: traffic, top entry pages, sessions per channel, AI-search sessions, and the keywords that moved most in rank. |
| `page_scoreboard` | Joins per-page traffic with tracked keywords and rank. Flags content-gap pages and keywords whose target page got no traffic. |
| `entry_pages` | Answers "which pages did AI search land on": analyzes the ENTRY (landing) pages where sessions start, joining each page's first-touch source split (including AI) to its tracked rank. |
| `entry_page_report` | The entry-page acquisition lens: first-touch sessions per landing page by source channel, joined to the keywords/rank each page holds. |
| `content_performance_report` | Ranks pages by pageviews, joining entries, optional goal conversions, and tracked keywords/rank per page. |
| `conversion_attribution` | Attributes a goal's conversions and revenue by source (AI vs organic vs direct) and by tracked keyword, and names the money moves. |
| `portfolio_summary` | Summarizes every domain on the account in one call: rank distribution, quick-win count, and human plus AI-referral sessions per site. |

### SEO

| Tool | What it does | Arguments |
|---|---|---|
| `discover_pages` | Crawls a domain (sitemap first, then homepage links) and returns up to 25 pages for keyword-to-page mapping. | `domain` |
| `list_keywords` | Lists a domain's keywords with current rank, ranking URL, target page, and recent rank history. | `domain` |
| `add_keyword` | Adds a keyword to track. Queues a background SERP scrape. | `keyword`, `domain`, `country` (default `US`), `device` (`desktop` or `mobile`, default `desktop`), `target_page` (optional) |
| `update_keyword` | Updates keywords by ID: set target page and/or toggle sticky. | `ids`, `target_page` and/or `sticky` |
| `delete_keyword` | Permanently deletes one or more keywords by ID. | `ids` |
| `refresh_keywords` | Triggers a fresh SERP scrape for specific keyword IDs or a whole domain. | `ids` (array of numbers) OR `domain` |
| `striking_distance` | Returns near-miss keywords ranking just off page one (positions 4 to 30), the cheapest SEO wins, each with its position delta. | `domain`, `min`/`max` (optional) |
| `seo_report` | A prebuilt one-call SEO snapshot: rank distribution, striking-distance quick wins, biggest movers, and keywords grouped by target page. | `domain` |
| `site_audit` | Crawls a domain and returns a prioritized on-page / technical issue list (titles, metas, H1s, duplicates, thin content), each with a severity. | `domain` |
| `cannibalization_detection` | Finds keyword cannibalization where two of your own pages compete for the same term and split the equity. | `domain` |
| `content_gap` | Crawls a named competitor and your site and returns the topics the competitor covers that you do not. | `domain`, `competitor` |
| `competitor_visibility` | Reads the stored SERP for every tracked keyword and tallies competitor share of voice, plus who outranks you per keyword. | `domain` |
| `get_insight` | Reads Google Search Console insight (top pages, keywords, countries, stats). Requires GSC connected; the easiest connect path is `mint_key_drop` with secret `gsc_service_account`. | `domain` |

### AEO

| Tool | What it does | Arguments |
|---|---|---|
| `ai_referrals` | Reports which AI engines send real visitors (per-engine visitors, page views, AI share of referred traffic). | `domain`, `period` (optional) |
| `ai_visibility` | Per-page and per-engine view of AI referrals, flagging not-cited pages, with an AI-readiness audit fallback when referral data is thin. | `domain`, `period` (optional) |
| `aeo_report` | A prebuilt one-call AEO snapshot: AI referrals per engine plus a per-engine summary. | `domain`, `period` (optional) |

### Analytics

| Tool | What it does | Arguments |
|---|---|---|
| `traffic_summary` | Site-wide totals: pageviews, visitors, visits, bounce rate, average duration, pages per visit. | `domain`, `period` (optional) |
| `human_traffic` | Estimates likely-human vs likely-bot traffic via a bounce/duration heuristic with a known-human referrer floor. An estimate, not an exact count. | `domain`, `period` (optional) |
| `human_analytics` | Human-only analytics from s33k's own first-party pageviews (datacenter bots excluded by IP), with exit and bounce rate a plain pageview summary cannot produce. | `domain`, `period` (optional), `includeBots` (optional) |
| `channel_report` | Maps every session to a clean marketing channel (Organic Search, AI Search, Referral, Direct) with sessions and share, plus conversions per channel with a goal. | `domain`, `period` (optional), `goalId` (optional) |
| `campaign_report` | Groups every session by UTM campaign (with utm_source / utm_medium splits) and reports sessions and share, plus conversions per campaign with a goal. | `domain`, `period` (optional), `goalId` (optional) |
| `live_view` | A polled real-time snapshot of who is on the site now: active visitors, pages being viewed, source and country splits, and recent events. | `domain`, `windowMinutes` (optional, default 5) |
| `funnel_analysis` | An ordered, multi-step funnel from first-party sessions with per-step drop-off. | `domain`, `steps`, `period` (optional) |
| `period_compare` | This period vs the immediately-preceding equal-length period, side by side, with delta and percent change per metric. | `domain`, `period` (optional), `goalId` (optional) |
| `traffic_breakdown` | Breaks traffic down by a dimension. Analytics is first-party from the beacon, which collects country and device only; the other dimensions (region, city, browser, os, language, screen) are accepted but return empty rows. | `domain`, `dimension`, `period` (optional) |
| `traffic_timeseries` | Daily (or unit-grouped) time series of pageviews and visitors. | `domain`, `period` (optional), `unit` (optional) |
| `top_events` | Custom/tracked events with their fire counts. | `domain`, `period` (optional) |
| `engagement` | Session-quality engagement tiers (bounced / browsed / engaged) with counts, percentages, and averages. | `domain`, `period` (optional) |
| `top_clicks` | The most-clicked elements from s33k autocapture, by visible text and stable selector. Never any typed value. | `domain`, `period` (optional) |
| `form_submissions` | Which forms get submitted, how often, and from which pages, from autocapture. Records the form id/name only, never field values. | `domain`, `period` (optional) |
| `scroll_depth` | How far visitors scroll per page plus a site-wide depth histogram, from autocapture. | `domain`, `period` (optional) |
| `page_engagement` | Active engagement (dwell) time per page from autocapture, paused when the tab is hidden or the visitor is idle. | `domain`, `period` (optional) |
| `web_vitals` | Real-user Core Web Vitals (LCP, CLS, INP, FID, FCP, TTFB) at p75 scored against Google's field thresholds, with the slowest pages. | `domain`, `period` (optional) |
| `conversions_by_source` | Attributes conversions (autocaptured form submits by default) to the first-touch source, with an approximate rate per source. | `domain`, `period` (optional), `eventType` (optional) |

### Conversion goals and segments

| Tool | What it does | Arguments |
|---|---|---|
| `create_goal` | Defines a named conversion goal: a destination page reached (`page_reached`) or an autocaptured event fired (`event`). | `domain`, `name`, `kind`, `matchValue`, `value` (optional) |
| `list_goals` | Lists the named conversion goals defined for a domain and their match rules. | `domain` |
| `delete_goal` | Deletes a named conversion goal by its id. | `domain`, `goalId` |
| `goal_analytics` | Conversion rate and counts for a goal, filterable and groupable by source/landing page/device/country/engagement, with revenue when the goal has a value. | `domain`, `goalId`, `period` (optional), filter/groupBy (optional) |
| `suggest_goals` | Proposes ready-to-create goals by spotting a site's likely conversions (thank-you, demo, contact, signup pages). | `domain` |
| `segment_save` | Saves a named, reusable filter set built from the composable analytics filters. | `domain`, `name`, filters |
| `segment_list` | Lists the named segments defined for a domain and the filters each stores. | `domain` |
| `segment_delete` | Deletes a named segment by its id. | `domain`, `id` |
| `segment_analytics` | Applies a saved segment by name (or id) and returns the human-analytics-style traffic summary with its filters applied. | `domain`, `segment` (name or id), `period` (optional) |

### Domains and onboarding

| Tool | What it does | Arguments |
|---|---|---|
| `list_domains` | Lists all domains tracked in s33k. | none |
| `create_domain` | Adds one or more domains to track (bare hostnames, no protocol). A write, so it needs a full-account key; read-only share keys are rejected at the API. | `domains` |
| `onboard` | The one-call cold start: creates the domain, discovers and adds keywords with scrapes queued, provisions analytics, and returns the snippet plus guides. A write, so it needs a full-account key. | `domain` |
| `setup_status` | Reports a domain's setup progress as a checklist with the single next step and the exact tool to call, plus the modules block (Analytics, AI referrals, SEO, Search Console). | `domain` |
| `mint_key_drop` | Mints a single-use, signed curl one-liner so a secret reaches the server from the user's own terminal, never the chat. `serper` enables SEO rank tracking (paste the key on stdin); `gsc_service_account` connects Google Search Console from a downloaded service-account JSON file (`--data-binary @service-account.json`) and the response carries the Google-side setup steps. | `secret` (optional, `serper` or `gsc_service_account`) |
| `install_instructions` | Returns the tracking snippet and per-platform install steps (WordPress, Webflow, Shopify, GTM, Next.js, raw HTML, and more). | `domain`, `platform` (optional) |

### Account, trust, and self-support

| Tool | What it does | Arguments |
|---|---|---|
| `security_facts` | Returns s33k's complete, source-cited trust facts: no model training, single-user, encryption at rest, cookieless/no-PII. | none |
| `export_data` | Downloads everything s33k holds about you as one JSON bundle. Never includes a secret. | none |
| `help` | Answers any question about s33k from its single authoritative product-knowledge layer. Reads no account data and never queries an LLM. | `question`, `topic` (optional) |

### Knowledge resources

Five read-only MCP resources expose the same product-knowledge layer the `help` tool reads, so a client can pull a whole doc into context with `resources/read`: `knowledge://capabilities`, `knowledge://setup`, `knowledge://reasoning`, `knowledge://troubleshooting`, and `knowledge://trust`.

## Trust property

s33k makes no server-side LLM calls. The AI features (`briefing`, `insights`, `ai_visibility`, `alerts`, `entry_pages`, and the prebuilt reports) are rules-based: the server computes structured findings over your own data and hands them to your own LLM to narrate. There is no model-training path, tracking is cookieless with no PII, and s33k is self-hostable so you can verify all of it. See `SECURITY.md`, or ask via the `security_facts` tool.

## Requirements

- Node 20 (the s33k repo pins Node 20 via `.nvmrc`; native deps are built for it). The MCP SDK requires Node 18 or newer, so Node 20 is fine.
- A running s33k instance. By default the server talks to `http://localhost:3000`. Set `S33K_BASE_URL` to match how you run s33k (for example `http://localhost:3000` for the local Quickstart, or `http://localhost:8080` for the docker-compose stack).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `S33K_API_KEY` | yes | none | The value of `APIKEY` in the s33k root `.env` file. |
| `S33K_BASE_URL` | no | `http://localhost:3000` | The base URL of the running s33k instance. Trailing slashes are trimmed. |

The Bearer API key path is whitelisted in s33k's `utils/allowedApiRoutes.ts` for the routes these tools use. Any new authed route a tool calls must be added to that whitelist, or the call is rejected with "This Route cannot be accessed with API."

## Install and build

Run from the `mcp/` directory. Make sure Node 20 is active first.

```bash
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20
cd mcp
npm ci
npm run build
```

This compiles `src/index.ts` to `dist/index.js`.

## Register it in Claude Code

The compiled entry point is `mcp/dist/index.js`. Register it with `claude mcp add`, passing the env vars with `-e`:

```bash
claude mcp add s33k \
  -e S33K_API_KEY=YOUR_S33K_API_KEY \
  -e S33K_BASE_URL=http://localhost:3000 \
  -- node "$(pwd)/dist/index.js"
```

Or add this block to a Claude Code MCP JSON config (for example `.mcp.json` at the repo root, or your user `~/.claude.json` under `mcpServers`). Use the absolute path to the built file:

```json
{
  "mcpServers": {
    "s33k": {
      "command": "node",
      "args": ["/absolute/path/to/s33k/mcp/dist/index.js"],
      "env": {
        "S33K_API_KEY": "YOUR_S33K_API_KEY",
        "S33K_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

After registering, restart Claude Code (or reload MCP servers) and the s33k tools become available. Confirm with `claude mcp list`.

## Connect over the hosted HTTP endpoint

Your running s33k server exposes the SAME tools over a remote Streamable HTTP MCP endpoint at `/api/mcp`. You connect with one URL plus your Bearer key and NO local install. This is handy when your MCP client and your s33k instance are on different machines.

The key crux: every tool call the hosted endpoint makes carries ONLY the connecting client's Bearer key. The s33k API's `authorize()` then enforces that key per connection. A request with no Bearer key is rejected with 401.

Replace `https://your-s33k-host` below with the URL of your own s33k instance.

**Claude Code:**

```bash
claude mcp add --transport http s33k https://your-s33k-host/api/mcp \
  --header "Authorization: Bearer YOUR_S33K_API_KEY"
```

**Claude Code MCP JSON config** (`.mcp.json` or `~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "s33k": {
      "type": "http",
      "url": "https://your-s33k-host/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_S33K_API_KEY" }
    }
  }
}
```

**Claude.ai connectors / Cursor:** add a custom MCP (HTTP) connector with the URL `https://your-s33k-host/api/mcp` and an `Authorization: Bearer YOUR_S33K_API_KEY` header. Any MCP client that speaks Streamable HTTP works the same way.

**Claude Desktop:** Claude Desktop cannot point at a remote HTTP MCP URL directly, so bridge it with `mcp-remote`. Edit the Desktop config file (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "s33k": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-s33k-host/api/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer YOUR_S33K_API_KEY" }
    }
  }
}
```

Put the key in the `AUTH` env var exactly as shown (`Bearer YOUR_S33K_API_KEY`), not inline in the `--header` argument. `mcp-remote` splits a header argument on its first space, which would break `Bearer <key>`; routing the value through `${AUTH}` keeps it intact. After saving, fully quit and reopen Claude Desktop (a window reload is not enough), then look for s33k under the connectors / tools menu. To run s33k locally instead of the hosted endpoint, drop the stdio `node .../mcp/dist/index.js` block from "Register it in Claude Code" above into this same Desktop config file.

The endpoint runs stateless: a fresh MCP server, transport, and key-bound fetch are built per request and torn down when the response finishes, so no key or session state is ever shared across connections.

## Run it directly (manual check)

The stdio server waits for a client, so running it by hand will print a startup line to stderr and then block:

```bash
S33K_API_KEY=... S33K_BASE_URL=http://localhost:3000 node dist/index.js
```

A clean boot prints `s33k-mcp connected (base URL: ...). 73 tools and 5 resources registered.` to stderr. Press Ctrl-C to stop.

## End-to-end smoke test

`smoke-test.mjs` spawns the BUILT server (`dist/index.js`) as a stdio child, drives it with the official MCP client SDK (real `initialize` handshake), and exercises the tools against a live s33k instance. It asserts the registered tool count and that every tool it drives returns a successful, non-empty result.

What it covers:

- **Read tools** run read-only against a real domain on your instance: the first domain on the account, or `SMOKE_READ_DOMAIN` if set.
- **Mutating tools** (`create_domain`, `add_keyword`, `update_keyword`, `delete_keyword`) run ONLY against a throwaway domain `s33k-smoke-test.example`, never the real data.
- It is **idempotent and re-runnable**: it deletes the throwaway domain before and after the mutation block via an authenticated `DELETE /api/domains` call (whitelisted for the API key in `utils/verifyUser.ts`), so a second run does not fail on a duplicate-domain error.
- `get_insight` is treated as PASS when Google Search Console is not connected (the tool responded correctly); to exercise its success path, connect GSC for the domain first.

Configuration is read from the runner's environment and never hardcoded:

| Variable | Required | Default | Description |
|---|---|---|---|
| `APIKEY` | yes | none | The s33k global API key. Export it from the root `.env` before running. |
| `S33K_BASE_URL` | no | `http://localhost:3005` | The live s33k API base URL the spawned server should target. |
| `SMOKE_READ_DOMAIN` | no | first domain on the account | The domain the read tools run against. Set it to pin a specific domain. |

Build first, then run (Node 20 via nvm). The runner exports the key from the root `.env`:

```bash
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20
npm run build
set -a; . ../.env; set +a    # exports APIKEY (and any S33K_BASE_URL override)
npm run smoke                # or: node smoke-test.mjs
```

Exit code is 0 when every assertion passes, non-zero otherwise. A clean run prints a `Summary: N/N assertions passed.` line with all assertions passing.

## Notes

- All protocol traffic is on stdout. Diagnostic lines (startup, fatal errors) are written to stderr so they do not corrupt the MCP stream.
- Tool errors (for example a missing domain or an unconfigured scraper) are returned as MCP tool error results, not thrown, so the LLM can read and react to them.
