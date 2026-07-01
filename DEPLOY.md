# Self-hosting s33k

s33k is a single-user, self-hosted SEO + AEO + analytics suite you control from your own LLM over MCP. This is the short guide to running your own copy. Everything runs in one container (the app plus its scrape/notify cron). There is no billing, no multi-tenant, and no external analytics service to stand up: s33k collects its own page analytics through a first-party beacon and stores everything in its own database.

You need three things:

1. A place to run a Node container or a Node 20 process.
2. A database. Postgres in production, or a local SQLite file for a quick single-machine setup.
3. A [Serper](https://serper.dev) API key for keyword rank checks (pay-as-you-go, about $1 per 1000 lookups). Bring your own.

---

## 1. Generate your secrets

Run these locally and keep the output. You paste them into your environment.

```bash
# APIKEY: the Bearer token the REST API and the MCP server authenticate with.
openssl rand -hex 24

# SECRET: encrypts stored keys (Serper, SMTP, GSC) and signs your login session.
openssl rand -hex 34

# PASSWORD: your admin login password. Use a password-manager value, or:
openssl rand -base64 24
```

Pick a `USER_NAME` too (the login username, e.g. `admin`). The username is not the secret, the password is.

s33k refuses to boot in production if `APIKEY`, `SECRET`, or `PASSWORD` are unset, left as a `REGENERATE_ME...` placeholder, or set to the public SerpBear demo values. You cannot accidentally ship the demo credentials.

---

## 2. Configure your environment

Copy the template and fill it in. `.env.example` documents every variable.

```bash
cp .env.example .env
```

The minimum you must set:

```bash
# --- Auth (REQUIRED) ---------------------------------------------------------
USER_NAME=admin
PASSWORD=your-strong-password
SECRET=your-openssl-rand-hex-34
APIKEY=your-openssl-rand-hex-24
SESSION_DURATION=24

# --- Public URL (REQUIRED) ---------------------------------------------------
# The URL you reach s33k at, with the scheme and no trailing slash.
NEXT_PUBLIC_APP_URL=http://localhost:3000

# --- Database ----------------------------------------------------------------
# Set DATABASE_URL for Postgres (recommended for anything persistent).
# Leave it unset to use a local SQLite file at DATABASE_PATH instead.
DATABASE_URL=postgres://user:pass@host:5432/s33k
# DATABASE_PATH=./data/database.sqlite

# --- SERP scraper (bring your own key) ---------------------------------------
SCRAPER_TYPE=serper
SERPER_API_KEY=your-serper-key
```

Notes:

- `NODE_ENV=production` is baked into the container image; you do not set it.
- If `DATABASE_URL` is set, s33k uses Postgres. If it is unset, s33k uses a SQLite file at `DATABASE_PATH` (default `./data/database.sqlite`). Pick one.
- The Serper key can also be pasted in the Settings UI, where it is stored encrypted in the database. A UI-entered key always wins over the env value. `SCAPING_API` is accepted as an alias for `SERPER_API_KEY`.
- Analytics is first-party. There is no external analytics service to configure. The `public/s33k.js` beacon posts page events to your own `/api/collect` endpoint and s33k computes everything from its own `s33k_event` table.

Optional blocks (all safe to leave blank):

```bash
# --- Rank-change email digest (optional) -------------------------------------
# Off by default. Set NOTIFICATION_INTERVAL to turn it on. SMTP is configured
# in the Settings UI (server, port, username, password, from address).
NOTIFICATION_INTERVAL=never

# --- Scrape cadence (optional) -----------------------------------------------
# Weekly by default (the main cost lever for Serper spend).
SCRAPE_INTERVAL=weekly

# --- Google Search Console (optional, richer keyword data) -------------------
# One-click OAuth connect. Leave blank to skip; the connect button then shows
# a friendly "not configured" message instead of crashing.
GSC_OAUTH_CLIENT_ID=
GSC_OAUTH_CLIENT_SECRET=
```

---

## 3. Run it

### Option A: Docker (recommended)

Build the image from this repo's `Dockerfile` and run it. The container runs migrations on boot, then starts the server plus the scrape/notify cron.

```bash
# Build once.
docker build -t s33k .

# Run it. --env-file loads the .env you filled in above.
# Mount ./data only if you are using the SQLite path (DATABASE_PATH); with
# DATABASE_URL your Postgres holds the state and no volume is needed.
docker run -d --name s33k \
  --env-file .env \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  s33k
```

s33k is now at `http://localhost:3000`. Log in with your `USER_NAME` and `PASSWORD`.

### Option B: Local Node 20 (no Docker)

s33k needs Node 20 (the `jsonwebtoken` dependency crashes on newer Node).

```bash
npm ci
npm run build
# Run migrations against your database (Postgres or the SQLite file).
npx sequelize-cli db:migrate
# Start the server and the cron.
npx concurrently "node .next/standalone/server.js" "node cron.js"
```

For local development instead of a production build, `npm run dev` serves the app with hot reload.

---

## 4. Point your site at the analytics beacon

To collect page analytics (traffic, sources, AI referrals, entry pages), add the beacon to the site you want to track. Serve `public/s33k.js` from your s33k instance and drop this one line into your site's `<head>`:

```html
<script defer src="https://your-s33k-host/s33k.js" data-domain="yourdomain.com"></script>
```

The beacon is cookieless and captures no personal data (see `SECURITY.md`). It posts events to `/api/collect` on your s33k instance. If you only care about keyword rank tracking and AI-referral reporting from server logs, the beacon is optional, but it is what powers the traffic, engagement, and entry-page reports.

---

## 5. Seed your first domain and keywords

Once s33k is up and you can log in, add data over the REST API with your `APIKEY`.

```bash
export S33K_URL="http://localhost:3000"
export S33K_KEY="your-APIKEY-value"
```

Add the domain:

```bash
curl -s -X POST "$S33K_URL/api/domains" \
  -H "Authorization: Bearer $S33K_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domains":["yourdomain.com"]}'
```

Add keywords. `device` is `desktop` or `mobile`, `country` is a 2-letter code, `target_page` (optional) is the URL you want to rank for that keyword.

```bash
curl -s -X POST "$S33K_URL/api/keywords" \
  -H "Authorization: Bearer $S33K_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": [
      {"keyword":"your keyword","domain":"yourdomain.com","device":"desktop","country":"US","tags":"core","target_page":"https://yourdomain.com/"}
    ]
  }'
```

A 401 means the `APIKEY` is wrong. A 400 with "Domain is Required" means a keyword is missing its `domain` field.

Adding keywords does not scrape immediately (the cron scrapes on its schedule). To pull positions right now, list the keyword IDs and refresh them:

```bash
# List keywords (note the "ID" field on each).
curl -s "$S33K_URL/api/keywords?domain=yourdomain.com" \
  -H "Authorization: Bearer $S33K_KEY"

# Refresh by comma-separated IDs (replace 1,2,3 with the real IDs).
curl -s -X POST "$S33K_URL/api/refresh?id=1,2,3" \
  -H "Authorization: Bearer $S33K_KEY"
```

If a refresh returns no positions, the usual cause is a missing or wrong `SERPER_API_KEY`, or a Serper account out of credits.

---

## 6. Connect the MCP server

The MCP server lets your LLM drive s33k. Build it once, then register it. Make sure Node 20 is active first.

```bash
cd mcp
npm install
npm run build
cd ..
```

Register it with `claude mcp add`, pointing `S33K_API_KEY` at the `APIKEY` from your `.env` and `S33K_BASE_URL` at your running instance:

```bash
claude mcp add s33k \
  -e S33K_API_KEY="$(grep '^APIKEY=' .env | cut -d= -f2)" \
  -e S33K_BASE_URL=http://localhost:3000 \
  -- node "$(pwd)/mcp/dist/index.js"
```

Restart your LLM client, then try: "Give me the s33k briefing for yourdomain.com."

s33k exposes 72 MCP tools across the three pillars (SEO rank, analytics, AEO/AI-referrals) plus the cross-pillar joins. There is no admin surface and no billing: it is one user, one key.

---

## 7. Day-2 operations

- **Security.** s33k has a single admin login and a single API key, so anyone with the URL sees the login page. If your instance is not meant to be public, put it behind private networking, an IP allowlist, or an auth proxy. At minimum, do not share the URL. Rotate the key periodically: generate a fresh `openssl rand -hex 24`, update `APIKEY`, restart, and update `S33K_API_KEY` in any MCP client config.
- **Backups.** Your state is the database. With Postgres, take periodic `pg_dump` logical backups (and enable your provider's automated backups). With the SQLite path, back up the `./data` directory. `GET /api/export` (MCP tool `export_data`) also downloads everything s33k holds as one JSON bundle, credentials excluded.
- **Upgrades.** Pull the latest code, rebuild (`docker build` or `npm run build`), and restart. Migrations run on boot; your database persists across the restart.
- **Logs.** Watch the container or process logs. A `[SECURITY]` line means a credential is still a demo or placeholder value and the boot was refused.
