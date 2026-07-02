# Troubleshooting

The failures people actually hit on a first run, with the fastest path out of each. Work top to bottom inside a section: each check rules out one layer.

## Keywords show no rank (or stay at "not in top 100" forever)

1. **Check the Serper key.** In the web UI, open Settings and confirm the Serper API key is set (or `SERPER_API_KEY` is in your `.env`). Test the key itself at the [serper.dev](https://serper.dev) console: if it fails there, it fails here.
2. **Check the scraper type.** `SCRAPER_TYPE` must be `serper` (the default in `.env.example`, Docker, and Render installs). If you upgraded from an older install, confirm it is set: a blank scraper type means nothing ever scrapes.
3. **Check Serper credits.** New accounts get 2,500 free queries. When they run out, scrapes fail quietly from s33k's point of view. Your remaining balance is on the serper.dev dashboard.
4. **Trigger a scrape by hand** instead of waiting for the cron: ask your LLM to run `refresh_keywords` for the domain, or click refresh in the web UI. Results normally land within about two minutes.
5. **Read the logs.** `docker compose logs -f s33k` (Docker) or your host's log view. A failing scrape logs the scraper error; a keyword with a real error is retried hourly by the retry cron.

## MCP tools return 401 Unauthorized

1. **The key must match.** `S33K_API_KEY` (stdio) or the `Authorization: Bearer ...` header (HTTP) must equal the `APIKEY` value in the server's `.env`. Copy-paste it fresh: a trailing space or shell-quoting artifact is the usual culprit.
2. **The base URL must reach the app.** Test it outside MCP first: `curl -s http://localhost:3000/api/domains -H "Authorization: Bearer YOUR_APIKEY"` should return JSON, not an HTML login page or a connection error. If s33k runs on a server, use its public URL and confirm HTTPS.
3. **Rebuild the MCP server after upgrades.** For the stdio path: `cd mcp && npm ci && npm run build`. A stale `mcp/dist` from before an upgrade can fail in confusing ways.
4. **Restart the client.** Claude Code, Cursor, and Claude Desktop all read MCP config at startup. After changing config, restart, then confirm the server is listed (`claude mcp list` in Claude Code).

## The analytics beacon sends nothing

1. **Confirm the script is served.** `curl -s https://YOUR_S33K_HOST/s33k.js | head -1` should return JavaScript. If it does not, the app is not reachable at that host.
2. **Confirm the tag is on your site** with the right attributes: `<script defer src="https://YOUR_S33K_HOST/s33k.js" data-domain="example.com"></script>`, where `data-domain` exactly matches the domain you added in s33k (no `www.` mismatch).
3. **Check the browser console** on your site. A blocked or failing request to `/api/collect` shows up there. Note: the beacon honors Do Not Track and is skipped by some strict ad-blockers; test in a normal browser profile.
4. **Check the domain exists in s33k.** Ask your LLM to run `list_domains`. Events for a domain s33k does not know are dropped.
5. **Give it a minute, then ask.** Events are visible via `live_view` or `traffic_summary` almost immediately. If `live_view` shows your own test visit, collection works and you are done.

## The container will not boot

1. **Read the first `[SECURITY]` line in the logs.** s33k refuses to start (on purpose) when credentials are missing, demo-default, or `NEXT_PUBLIC_APP_URL` is unset. The message names the exact variable to fix.
2. **A failed migration also stops the boot** (also on purpose, so the app never runs against a broken schema). The log shows which migration failed; re-running after fixing the database connection is safe, migrations are idempotent.
3. **Postgres not ready yet.** On the first `docker compose up`, the app can race the database for a few seconds and restart. If it still loops after a minute, check `DATABASE_URL`.

## Where to ask

Open a [GitHub issue](https://github.com/benjaminard/s33k/issues) with the log lines around the failure. Your own LLM can also answer product questions directly from the `help` tool and the `knowledge://troubleshooting` resource once MCP is connected.
