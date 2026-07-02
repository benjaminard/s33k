# Troubleshooting

The failures people actually hit on a first run, with the fastest path out of each. Work top to bottom inside a section: each check rules out one layer. s33k is headless: everything below is your LLM (over MCP), a curl with your `APIKEY`, or the server logs. There is no web UI to click around in.

## I lost the setup link

The one-time `[SETUP]` URL is printed to the server log on boot, and only while setup is incomplete. If you closed the tab or lost the log line, just restart the container (`docker compose restart s33k`): the token regenerates and the `[SETUP]` line reprints. Once setup completes, the page 404s forever by design; from then on, every change happens over MCP or the authed API.

## Keywords show no rank (or stay at "not in top 100" forever)

1. **Check the Serper key.** Ask your LLM to run `setup_status` for the domain (it reports whether the SEO pillar has a key), or confirm `SERPER_API_KEY` is in your `.env`. Test the key itself at the [serper.dev](https://serper.dev) console: if it fails there, it fails here.
2. **Check the scraper type.** `SCRAPER_TYPE` must be `serper` (the default in `.env.example`, Docker, and Render installs). If you upgraded from an older install, confirm it is set: a blank scraper type means nothing ever scrapes.
3. **Check Serper credits.** New accounts get 2,500 free queries. When they run out, scrapes fail quietly from s33k's point of view. Your remaining balance is on the serper.dev dashboard.
4. **Trigger a scrape by hand** instead of waiting for the cron: ask your LLM to run `refresh_keywords` for the domain, or curl it directly: `curl -s -X POST "http://localhost:3000/api/refresh?domain=example.com" -H "Authorization: Bearer YOUR_APIKEY"`. Results normally land within about two minutes.
5. **Read the logs.** `docker compose logs -f s33k` (Docker) or your host's log view. A failing scrape logs the scraper error; a keyword with a real error is retried hourly by the retry cron.

## MCP tools return 401 Unauthorized

1. **The key must match.** `S33K_API_KEY` (stdio) or the `Authorization: Bearer ...` header (HTTP) must equal the `APIKEY` value in the server's `.env`. Copy-paste it fresh: a trailing space or shell-quoting artifact is the usual culprit.
2. **The base URL must reach the app.** Test it outside MCP first: `curl -s http://localhost:3000/api/domains -H "Authorization: Bearer YOUR_APIKEY"` should return JSON, not an error. (A bare `curl http://localhost:3000/` returns the JSON identity response; that only proves the server is up, not that your key works.)
3. **Rebuild the MCP server after upgrades.** For the stdio path: `cd mcp && npm ci && npm run build`. A stale `mcp/dist` from before an upgrade can fail in confusing ways.
4. **Restart the client.** Claude Code, Cursor, and Claude Desktop all read MCP config at startup. After changing config, restart, then confirm the server is listed (`claude mcp list` in Claude Code).

## The analytics beacon sends nothing

1. **Confirm the script is served.** `curl -s https://YOUR_S33K_HOST/s33k.js | head -1` should return JavaScript. If it does not, the app is not reachable at that host.
2. **Confirm the tag is on your site** with the right attributes: `<script defer src="https://YOUR_S33K_HOST/s33k.js" data-domain="example.com"></script>`, where `data-domain` exactly matches the domain you added in s33k (no `www.` mismatch).
3. **Check the browser console** on your site. A blocked or failing request to `/api/collect` shows up there. Note: the beacon honors Do Not Track and is skipped by some strict ad-blockers; test in a normal browser profile.
4. **Check the domain exists in s33k.** Ask your LLM to run `list_domains`. Events for a domain s33k does not know are dropped.
5. **Give it a minute, then ask.** Events are visible via `live_view` or `traffic_summary` almost immediately. If `live_view` shows your own test visit, collection works and you are done.

## The container will not boot

1. **Read the first `[SECURITY]` line in the logs.** s33k refuses to start (on purpose) when `APIKEY` or `SECRET` are missing or demo-default, or `NEXT_PUBLIC_APP_URL` is unset. The message names the exact variable to fix.
2. **A failed migration also stops the boot** (also on purpose, so the app never runs against a broken schema). The log shows which migration failed; re-running after fixing the database connection is safe, migrations are idempotent.
3. **Postgres not ready yet.** On the first `docker compose up`, the app can race the database for a few seconds and restart. If it still loops after a minute, check `DATABASE_URL`.

## Changing settings without a UI (SMTP, scraper key, and friends)

Instance settings live encrypted in the database and are read and written through `GET`/`PUT /api/settings` with your `APIKEY`. The PUT replaces the stored blob, so read first, merge your change, and send the whole object back:

```bash
# 1. Read the current settings.
curl -s http://localhost:3000/api/settings \
  -H "Authorization: Bearer YOUR_APIKEY"

# 2. Send back the full settings object with your changes merged in
#    (this example enables the rank-change email over SMTP).
curl -s -X PUT http://localhost:3000/api/settings \
  -H "Authorization: Bearer YOUR_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{"settings": { ...the object from step 1, plus...
        "notification_interval": "weekly",
        "notification_email": "you@example.com",
        "smtp_server": "smtp.example.com", "smtp_port": "587",
        "smtp_username": "you", "smtp_password": "your-smtp-password" }}'
```

The Serper key specifically has a nicer path: ask your LLM to mint a key-drop link (the `mint_key_drop` flow) and paste the key in your own terminal, so it never enters the chat.

## Connecting Google Search Console gets stuck

The full walkthrough is in the README's "Connect Google Search Console" section. The traps people actually hit, and the fix for each:

- **"I only see an organization, not a project."** A service account cannot live at the org level. Pick the organization, then create a project inside it. Any name works; it is just a container.
- **The credential screen offers to make an "API key."** Back out. That is a different Google credential and s33k will reject it. You want a service account's **JSON key file**: Credentials > Service Accounts > your account > Keys tab > Add Key > Create new key > JSON.
- **The `curl` says "operation not permitted" or "no matches found" on macOS.** macOS blocks Terminal from reading `~/Downloads` by default, which also makes shell globs like `*.json` match nothing there. Move the JSON to your home folder (`~`) and run the command from there, or let a shell-capable assistant (for example Claude Code) run it for you.
- **The drop command says the file was not found.** The `@filename` in the command must match the file's real name. Finder hides extensions, so a file shown as `service-account.json` may really be `service-account.json.txt`; run `ls -la` to see the true name, or rename the file to exactly `service-account.json`.
- **The drop link "expired."** File drop links last 60 minutes. If the Google steps took longer, ask your LLM to mint a fresh one.
- **`get_insight` still says "not connected" after the drop.** The drop only stores the credential; Google authorizes nothing until you add the service account's email as a **Full** user on your property at [search.google.com/search-console](https://search.google.com/search-console) (Settings > Users and permissions). Do that, then retry `get_insight`.
- **`get_insight` errors with a permission or property message.** The email must be granted on the exact property s33k tracks (for example the `www.` host vs the bare domain), and Search Console data lags 2 to 3 days, so a brand-new property may have little to return yet.

## Where to ask

Open a [GitHub issue](https://github.com/benjaminard/s33k/issues) with the log lines around the failure. Your own LLM can also answer product questions directly from the `help` tool and the `knowledge://troubleshooting` resource once MCP is connected.
