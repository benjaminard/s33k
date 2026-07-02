<p align="center">
  <img src="docs/s33k-logo.png" alt="s33k" width="160" />
</p>

# s33k

[![verify](https://github.com/benjaminard/s33k/actions/workflows/verify.yml/badge.svg)](https://github.com/benjaminard/s33k/actions/workflows/verify.yml)

s33k (reads "seek") is an open, self-hosted tool for one person to watch their own website, driven entirely from your own LLM over the Model Context Protocol (MCP). It joins the three things you check about a site into one place you control from Claude, Cursor, or any MCP client:

- **SEO.** Where every page ranks in Google for the keywords you track.
- **AI-search referrals (AEO).** Which AI engines (ChatGPT, Claude, Perplexity, Gemini, Copilot) actually send visitors to your site, measured from real referral traffic.
- **Analytics.** Page traffic, sources, engagement, scroll depth, clicks, and form submissions, collected by s33k's own cookieless beacon.

You run all of it by asking your LLM. There is no dashboard, period: the product is the MCP surface plus one single-use setup page. You connect s33k as an MCP server and ask questions like "how is my site doing?" or "which pages does AI search land on?" and your LLM calls the right tool. Everything runs on a stack you host, so your data stays on your own machine or server.

s33k is a single-user, self-hosted project. It is meant for one person tracking their own site (or a handful of sites). There is no signup, no billing, no multi-tenant accounts, and no web login: the single API key you generate at install time is the whole credential story.

## Credits

s33k is a fork of [`towfiqi/serpbear`](https://github.com/towfiqi/serpbear) (MIT).

- **From SerpBear:** the Google rank-tracking core (keywords, scheduled scrapes, the scraper integrations).
- **Added in s33k:** the MCP control plane, the cookieless analytics beacon, the AI-referral (AEO) layer, and the per-page scoreboard that ties traffic to rank.
- **Not in s33k:** multi-tenant accounts, signup, and billing. s33k is single-user on purpose.

Live Google rankings come from [Serper](https://serper.dev), a SERP API you bring your own key for. See [License](#license).

## The three pillars

1. **SEO.** Track keywords per site, each mapped to its target page, and scrape live Google rankings. Serper is the rank data source: you get your own key at [serper.dev](https://serper.dev), paste it in, and results arrive in about two minutes. Optionally connect Google Search Console for Google's own query, impression, and click data (see [Connect Google Search Console](#connect-google-search-console-optional)).
2. **AI-search referrals (AEO).** s33k detects which AI answer engines are sending you visitors by classifying your referral traffic. You see per-engine visitors and the AI share of referred traffic. No LLM is queried to do this: it reads only real first-party referral data.
3. **Analytics.** s33k ships its own cookieless, no-PII autocapture script. You paste one tag on your site and it records pageviews, first-touch source, clicks, form submits, scroll depth, and engagement time, with no per-element setup. All of it is stored in s33k's own database.

The product is the MCP control plane that joins all three. The per-page scoreboard ties each page's traffic to its live Google rank, and flags content gaps (pages that get traffic but have no tracked keyword) and dead keywords (target pages getting no traffic).

## What it looks like

There are no screenshots to show because there is no dashboard. s33k lives inside the chat you already use. A real session looks like this:

```text
You: How is my site doing?

Assistant: I pulled the s33k briefing for example.com. The short version: a good week.

  - Traffic: 412 visitors over the last 7 days, up 18% on the prior week. Top entry
    page is /pricing (organic search).
  - SEO: "project tracking tool" moved 11 -> 7. Two keywords sit in striking distance
    (positions 11 and 12); a small content push on /features could put both on page one.
  - AI search: ChatGPT and Perplexity sent 9 visitors, mostly landing on /docs/api.

  Top action: /pricing gets your most organic entrances but has no tracked keyword.
  Want me to add one?
```

And turning a pillar on is a conversation too:

```text
You: Enable SEO tracking.

Assistant: SEO needs a Serper key (serper.dev, free tier available) so s33k can read
  live Google rankings. A key should not be pasted into chat, so I minted a one-time
  drop link on your instance. Run this in your own terminal, paste the key, press
  Enter, then Ctrl-D:

    curl -sS -X POST https://your-s33k-host/api/key-drop/eyJz... --data-binary @-

  The key goes straight from your terminal to your s33k server: it never passes
  through this chat. The link is signed, single-use, and expires in 15 minutes.
  Tell me when it is done and I will kick off your first rank scrape.
```

## What it costs to run

s33k itself is free. The only per-use cost is the Serper key you bring for rank data, and it is small:

- Serper gives new accounts **2,500 free queries with no credit card**, and the entry paid tier works out to about **$1 per 1,000 searches** after that (check [serper.dev](https://serper.dev) for current pricing).
- One tracked keyword costs one query per scrape. At the default **weekly** cadence, 50 keywords is about 217 queries a month: the free credits alone last most of a year, and after that it rounds to pennies.
- Even an aggressive setup (100 keywords scraped **daily**) is about 3,000 queries a month, roughly $3.
- Analytics and AI-referral tracking cost nothing per event: the beacon writes to your own database, and hosting is whatever you already pay for the machine it runs on.

## What you can ask

Everything is driven from your LLM over MCP. A few examples of the higher-level questions the tools answer:

- **Cross-pillar briefing.** "Give me the s33k briefing for example.com." A daily standup: a headline, per-pillar sections, and the top things to do.
- **Where to start.** "I just connected s33k, where do I start?" A guided entry point that reads your setup state and names the single most important next step.
- **Per-page scoreboard.** "Show me the per-page scoreboard for example.com." Each page's traffic joined to its tracked keyword and live rank.
- **AI landing pages.** "Which pages does AI search land on for example.com?" First-touch source per landing page, including AI engines.
- **Rank quick wins.** "What are my striking distance keywords?" Keywords ranking just off page one, where a small push tends to win.
- **Conversion goals.** "Create a goal called Demo Booked when someone reaches /demo/thanks," then "what is my Demo Booked rate from organic search?"
- **Named conversion goals, UTM campaigns, and saved segments,** all over MCP.

## MCP tools

s33k exposes 73 MCP tools and 5 read-only knowledge resources, all sharing one authoritative registry at `mcp/src/tools.ts`. The main groups:

- **Cross-pillar (start here):** `start_here`, `briefing`, `insights`, `alerts`, `executive_summary`, `weekly_digest`, `page_scoreboard`, `entry_pages`, `entry_page_report`, `content_performance_report`, `conversion_attribution`, `portfolio_summary`.
- **SEO:** `list_keywords`, `add_keyword`, `update_keyword`, `delete_keyword`, `refresh_keywords`, `striking_distance`, `seo_report`, `site_audit`, `cannibalization_detection`, `content_gap`, `competitor_visibility`, `discover_pages`, `get_insight` (Google Search Console).
- **AI-search referrals (AEO):** `ai_referrals`, `ai_visibility`, `aeo_report`.
- **Analytics:** `traffic_summary`, `human_traffic`, `human_analytics`, `channel_report`, `campaign_report`, `live_view`, `funnel_analysis`, `period_compare`, `traffic_breakdown`, `traffic_timeseries`, `top_events`, `engagement`, plus the autocapture reads `top_clicks`, `form_submissions`, `scroll_depth`, `page_engagement`, `web_vitals`, `conversions_by_source`.
- **Conversion goals and segments:** `create_goal`, `list_goals`, `delete_goal`, `goal_analytics`, `suggest_goals`, `segment_save`, `segment_list`, `segment_delete`, `segment_analytics`.
- **Domains and onboarding:** `list_domains`, `create_domain`, `onboard`, `setup_status`, `install_instructions`.
- **Trust and self-support:** `security_facts`, `export_data`, `help`.

The five knowledge resources (`knowledge://capabilities`, `knowledge://setup`, `knowledge://reasoning`, `knowledge://troubleshooting`, `knowledge://trust`) expose the same product-knowledge layer the `help` tool reads, so a client can pull a whole doc into context. Full per-tool descriptions live in [`mcp/README.md`](mcp/README.md) and `utils/knowledge.ts`.

## Install

Two ways to run s33k. Docker is the fastest and is recommended. Either way you stand up the app, its database, and the MCP server on infrastructure you control. Analytics are collected by s33k's own beacon, so there is nothing else to install.

### Option A. Docker (recommended)

You need Docker and Docker Compose. From a terminal:

```bash
git clone https://github.com/benjaminard/s33k.git
cd s33k
./scripts/setup-env.sh        # writes .env with strong random secrets, prints your API key
docker compose up -d --build
docker compose logs s33k | grep SETUP
```

The last command prints a one-time `[SETUP]` link. Open it once in a browser: optionally paste your [Serper](https://serper.dev) key (or skip that and do it later over MCP), copy the MCP connect command it shows you, and you are done with the browser forever. Everything after that is conversation with your own LLM. The app and its Postgres come up together, the schema migrates on boot, and the beacon is ready to paste on your site. Save the API key the script printed, you will use it to connect your LLM below.

Prefer to set secrets yourself? Run `cp .env.example .env`, fill it in (`.env.example` documents every variable), then `docker compose up -d --build`.

**One-click cloud deploy.** To run s33k on a host instead of your laptop:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/benjaminard/s33k)

Render reads [`render.yaml`](render.yaml) from this repo and provisions the app plus a managed Postgres, generating `APIKEY` and `SECRET` for you. The one-time `[SETUP]` link prints in the service logs on first boot. **One step after the first deploy:** Render gives your service a public URL like `https://s33k-abc.onrender.com`. Go to the service's environment settings and set `NEXT_PUBLIC_APP_URL` to that exact URL, then let it redeploy. Until you do, the app refuses to boot (on purpose, so links are never built from forgeable request headers). A Railway one-click template can be published from your own Railway dashboard using the same env recipe; see [`DEPLOY.md`](DEPLOY.md).

### Option B. Run from source (Node 20)

```bash
git clone https://github.com/benjaminard/s33k.git
cd s33k
nvm use 20            # the repo pins Node 20 via .nvmrc (or: nvm install 20 && nvm use 20)
npm ci
cp .env.example .env  # then edit it (see below)
npm run dev
```

Edit `.env` before starting: generate `SECRET` with `openssl rand -hex 34` and `APIKEY` with `openssl rand -hex 24`, and add your own `SERPER_API_KEY` from [serper.dev](https://serper.dev) (or paste it later on the one-time setup page, or hand it over via the key-drop flow from your LLM). Leave `DATABASE_URL` unset to use a local SQLite file. s33k then runs at http://localhost:3000, creates its schema on first start, and prints its one-time `[SETUP]` link to the console. `.env.example` documents every variable inline.

## Add your domain and paste the beacon

Onboard your site in one step from your LLM ("Onboard example.com from scratch") once the MCP server is connected. s33k gives you one tracking snippet (the setup page shows it too). Paste that single `s33k.js` beacon tag on your site (in the `<head>`, or via your tag manager) and traffic, sources, clicks, form submits, scroll depth, and engagement start flowing in. The snippet is cookieless and captures no PII.

## Connect your LLM over MCP

This is how you actually use s33k: connect it as an MCP server to your AI client, then ask questions. For the local (stdio) path, build the MCP server once:

```bash
cd mcp && npm ci && npm run build && cd ..
```

s33k speaks MCP two ways, and you pick per client:

- **Local (stdio).** Simplest when s33k runs on the same machine as your client. Runs `node mcp/dist/index.js`, reads your key as `S33K_API_KEY` and the app URL as `S33K_BASE_URL`.
- **Remote (HTTP + Bearer).** For when s33k runs on a server. Point the client at `<BASE_URL>/api/mcp` with the header `Authorization: Bearer <APIKEY>`.

`<APIKEY>` is the `APIKEY` from your `.env` (the same value the setup script printed).

### Claude Code

Local (stdio):

```bash
claude mcp add s33k \
  -e S33K_API_KEY="$(grep '^APIKEY=' .env | cut -d= -f2)" \
  -e S33K_BASE_URL=http://localhost:3000 \
  -- node "$(pwd)/mcp/dist/index.js"
```

Remote (HTTP + Bearer), when s33k runs on a server:

```bash
claude mcp add --transport http s33k https://YOUR_S33K_URL/api/mcp \
  --header "Authorization: Bearer YOUR_APIKEY"
```

Restart the client, then try: "Give me the s33k briefing for example.com." Confirm with `claude mcp list`.

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Replace `/absolute/path/to/s33k` with your real repo path (run `pwd` in the s33k directory to get it). Local stdio:

```json
{
  "mcpServers": {
    "s33k": {
      "command": "node",
      "args": ["/absolute/path/to/s33k/mcp/dist/index.js"],
      "env": { "S33K_API_KEY": "YOUR_APIKEY", "S33K_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

Or remote HTTP (keep the key out of the file via an env var):

```json
{
  "mcpServers": {
    "s33k": {
      "url": "https://YOUR_S33K_URL/api/mcp",
      "headers": { "Authorization": "Bearer ${env:S33K_APIKEY}" }
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml`. Local stdio:

```toml
[mcp_servers.s33k]
command = "node"
args = ["/absolute/path/to/s33k/mcp/dist/index.js"]
[mcp_servers.s33k.env]
S33K_API_KEY = "YOUR_APIKEY"
S33K_BASE_URL = "http://localhost:3000"
```

Or remote HTTP:

```toml
[mcp_servers.s33k]
url = "https://YOUR_S33K_URL/api/mcp"
bearer_token_env_var = "S33K_APIKEY"
```

then `export S33K_APIKEY=YOUR_APIKEY` in the shell Codex runs in.

### Claude Desktop

Desktop's config takes stdio directly, which is the best path for a local instance. Config file: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "s33k": {
      "command": "node",
      "args": ["/absolute/path/to/s33k/mcp/dist/index.js"],
      "env": { "S33K_API_KEY": "YOUR_APIKEY", "S33K_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

To reach a remote HTTP instance, Desktop needs the `mcp-remote` bridge: set `"command": "npx"` and `"args": ["mcp-remote", "https://YOUR_S33K_URL/api/mcp", "--header", "Authorization: Bearer YOUR_APIKEY"]`.

### Advanced: web chat clients

**ChatGPT** can connect, but only if s33k is reachable at a **public HTTPS URL** (localhost will not work, because the request comes from OpenAI's servers). On a paid plan, turn on Developer mode in Settings, add a custom connector pointing at `https://YOUR_PUBLIC_S33K_URL/api/mcp`, and supply the Bearer key. Deploy s33k somewhere public first (see the cloud deploy button above).

**Claude Cowork / claude.ai custom connectors are not supported today:** their connector accepts OAuth 2.1 only, with no field for a static Bearer key, so s33k's single-key model cannot be entered. Use Claude Code or Claude Desktop instead.

Full per-tool details are in [`mcp/README.md`](mcp/README.md).

## Connect Google Search Console (optional)

Search Console adds Google's own query, impression, and click data to the `get_insight` tool. **It is optional and can be done any time (or never):** everything else in s33k works without it. Budget 10 to 15 unhurried minutes for the Google side.

Connecting it is a conversation. You ask your LLM to connect it, and it recites these steps (they also live inside s33k's own knowledge, so any MCP client can guide you without leaving the chat). The steps below match that guidance so you can also do it solo:

1. **Create a Google Cloud project.** Go to [console.cloud.google.com](https://console.cloud.google.com) and create or pick a project. A project is required: if Google prompts you to pick an organization first, select it, then create a project inside it. The project is just a container; any name works.
2. **Enable the Search Console API.** APIs and Services > Library > search for "Google Search Console API" > Enable.
3. **Create a service account.** Easiest path: APIs and Services > Credentials > Create credentials > "Help me choose", pick the Search Console API and **Application data** (that choice is what creates a service account). Name it anything. If it offers to grant the account a role on the project, **skip it**: no roles are needed, its permission comes from Search Console in step 6.
4. **Download the JSON key file.** This is a service-account key, **not an "API key"**: if a screen offers to create an API key, back out, that is a different credential and will not work. Go to Credentials > Service Accounts > click your account > **Keys** tab > Add Key > Create new key > **JSON** > Create. A `.json` file downloads. Note its name and location (Google names it something long; you can rename it).
5. **Send the file to s33k.** Ask your LLM to connect Search Console; it mints a one-time drop command. If your assistant has shell access (for example Claude Code), just let it run the command for you: the file goes terminal-to-server and its contents never enter the chat. To run it yourself, do so from the folder holding the file, with the `@filename` matching the file's real name:

   ```bash
   curl -sS -X POST https://your-s33k-host/api/key-drop/eyJz... --data-binary @service-account.json
   ```

   (macOS note: Terminal is often blocked from reading `~/Downloads` with "operation not permitted"; move the file to your home folder to avoid that.)
6. **Grant the service account access in Search Console.** s33k's response confirms the service account's email (a machine identity Google generated, unrelated to your personal email). Add that email as a user with **Full** permission on your property at [search.google.com/search-console](https://search.google.com/search-console) (Settings > Users and permissions). That grant is how Google authorizes the read; until you make it, the credential can see nothing. Then ask your LLM to run `get_insight`.

The credential is stored encrypted and no HTTP response ever returns it. The drop link for this file kind is single-use and lasts 60 minutes, enough time to finish the Google steps first.

**Prefer to configure it yourself?** Two other paths work and need no drop link: set the service-account `SEARCH_CONSOLE_CLIENT_EMAIL` / `SEARCH_CONSOLE_PRIVATE_KEY` env vars, or set `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET` / `NEXT_PUBLIC_APP_URL` and use the OAuth "Connect Google Search Console" consent flow. When none of these is configured, `get_insight` reports "not connected" rather than failing, so this is purely optional.

## Rank-change email (optional)

s33k can email you when tracked rankings move. SMTP settings (server, port, username, password, and the notification From/To addresses) are stored encrypted in the database; write them with one authenticated call to `/api/settings` (a curl with your `APIKEY` Bearer header, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for the exact command). Set the email cadence with the `NOTIFICATION_INTERVAL` env var (default `never`). Rank scrape cadence is set with `SCRAPE_INTERVAL`.

## Hosting it on a server

To run s33k somewhere your LLM and your team can reach it (a small VPS or server), run it on Postgres by setting `DATABASE_URL` to a `postgresql://...` connection string. s33k selects Postgres automatically when `DATABASE_URL` is set, and SQLite otherwise. On Postgres, apply the schema with `npm run db:migrate` (it runs against the `DATABASE_URL` Postgres instance using the production config). See [`DEPLOY.md`](DEPLOY.md) for the deploy recipe and [`CLAUDE.md`](CLAUDE.md) for the database seam and the hard-won deploy notes.

## Security and trust

s33k is cookieless, captures no PII, never trains on your data, and makes no server-side LLM calls. The AI features (`briefing`, `insights`, `ai_visibility`, `alerts`, `entry_pages`) are rules-based: they compute structured findings from your own data and hand them to your own LLM to narrate. You can export everything s33k holds as a single JSON bundle (`export_data`) for backup, and because you self-host, deleting your data is a local action: drop your SQLite file or Postgres database. Every trust claim points at the code or test that proves it. See [`SECURITY.md`](SECURITY.md), or ask your own LLM via the `security_facts` MCP tool.

## When something does not work

[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) covers the failures people actually hit on a first run: keywords that never rank, MCP tools returning 401, a silent analytics beacon, and a container that refuses to boot. Once MCP is connected, your own LLM can also self-diagnose via the `help` tool and the `knowledge://troubleshooting` resource.

## Repo orientation for contributors

[`CLAUDE.md`](CLAUDE.md) is the door-sign for anyone (human or AI) working in the repo: runtime and commands, the database seam (Postgres in prod, SQLite locally), the hard-won deploy gotchas, and the no-server-side-LLM invariant. [`ROADMAP.md`](ROADMAP.md) says where the product is headed and what it deliberately will not do.

## License

MIT, inherited from the SerpBear fork. See [`LICENSE`](LICENSE).
