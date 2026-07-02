# s33k: contributor guide for the next AI session

s33k (reads "seek") is an open, self-hosted, single-user, MCP-native SEO + AEO + Analytics suite.
One person self-hosts it and controls all of it from their own LLM over MCP. Forked from
`towfiqi/serpbear` (MIT).

The product is the unified MCP control plane that joins three pillars a marketer checks constantly:
SEO (per-page keyword rank in Google), Analytics (traffic + sources, served first-party from an
owned events table), and AEO/GEO (do AI engines cite and refer you). The join across all three, per
page, is the thing no other tool does.

This file is for the AI doing the work. Read it before you build. Add to it when you hit a
hard-won lesson, so the next session never relearns it. It is a contributor guide for an
open-source repo, not an internal ops doc.

---

## Runtime + commands (get this right first)

- **Node 20 via nvm, locally.** `jsonwebtoken` crashes on Node 25. Prefix node/npm in any shell
  line: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1;`
- **Tests:** `npx jest --ci` (one-shot). `npm run test` is WATCH mode, do not use it for verification.
- **Lint:** `npm run lint` must be clean. **Build:** `npm run build` must print "Compiled successfully".
- **MCP server:** `cd mcp && npm run build`, then probe over a real stdio handshake. The registered
  tool count and the smoke test's `EXPECTED_TOOLS` are kept in lockstep by a jest guard
  (`__tests__/utils/knowledge-coverage.test.ts`), so the count cannot silently rot. Smoke harness:
  `npm run smoke` from `mcp/`.
- **Two MCP transports, one tool set.** The tools live in `mcp/src/tools.ts` (`registerS33kTools`).
  `mcp/src/index.ts` is the thin stdio entry; `pages/api/mcp/[[...slug]].ts` is the hosted Streamable
  HTTP endpoint at `/api/mcp` (connect with a URL + Bearer key, no install). Both register the SAME
  tools, each binding its own per-connection key.
- **Do not touch a running dev server or `.env`.** `.env` is gitignored and must stay untracked.

---

## A. Hard-won deploy gotchas (the most valuable section, do not relearn these)

### Database: Postgres in prod, never SQLite on a mounted volume
- SQLite-on-a-mounted-volume threw `SQLITE_CANTOPEN` even running as root with an absolute path.
  The combination of the volume mount and the Next.js standalone runtime cwd is the cause. Stop
  trying to make SQLite-on-volume work. Use Postgres in prod, or plain-file SQLite locally.
- The app supports BOTH via `DATABASE_URL`: Postgres when `DATABASE_URL` is set, SQLite otherwise.
  The seam is `database/database.ts` (runtime Sequelize) and `database/config.js` (migrations CLI).
  Both branch on `process.env.DATABASE_URL`.
- `pg` and `@types/pg` are dependencies. The `CrawlerHit` model id is `ID` mapped to the `id`
  column. That mapping is a `@types/pg`-strictness fix, keep it.
- `DATABASE_PATH` is the absolute-path env for the SQLite branch (local). Irrelevant under Postgres.

### Deploying to your own host
- The Docker image is the deploy unit (`Dockerfile` + `docker-compose.yml` for a local Postgres).
  Any host that runs a container works. Whatever your host, the deploy uploads the working tree /
  image and runs it; make sure you are deploying the code you think you are, not a stale pinned
  commit.
- Migrations run on boot via `entrypoint.sh` (`sequelize-cli db:migrate`), which FAILS LOUD: a
  non-zero migrate exit triggers `exit 1`, so the container refuses to boot on a broken migration
  rather than starting against a missing/mismatched table.
- If your host mounts an app-data volume, it may be root-owned at runtime. The container runs as
  ROOT on purpose to sidestep that permission problem: the Dockerfile intentionally does NOT set
  `USER nextjs`. Leave it.

### Node + container
- Node 20 via nvm locally (see above). The Dockerfile uses `node:22-alpine`, which is fine.

### Migration chain squashed to the live schema; existing installs keep their dead tables
- The multi-tenant SaaS migrations (create/alter of `account`, `api_key`, `invite`, `waitlist`,
  `feature_request`, `audit_log`, `rate_limit`) were DELETED in the single-user squash (2026-07),
  so a fresh install creates only the live schema. The `domain` and `keyword` base tables still
  come from the on-boot `connection.sync()` (database/database.ts), not from a migration; the
  add-column migrations that touch them no-op on a fresh DB via their describeTable probe and the
  columns arrive with the sync. That was true before the squash too.
- Deleting a migration FILE is safe for existing installs: sequelize-cli/Umzug ignore SequelizeMeta
  rows that have no matching file. But NEVER ship a migration that assumes a deleted one ran: any
  remaining migration must keep its safeDescribeTable / column-presence / indexExists skip guards
  (the 016/030 pattern) for everything it touches.
- NEVER emit DROP TABLE (or any destructive SQL) against the dead tables. An install that predates
  the squash keeps them, and its meta rows keep the deleted names; both are harmless. If an
  operator wants them gone, that is a MANUAL, documented cleanup on their own DB
  (`DROP TABLE account, api_key, invite, waitlist, feature_request, audit_log, rate_limit`),
  never a migration, because migrations run unattended on every boot.

---

## B. Code patterns the next session must follow

### Every new MCP tool MUST get a knowledge entry (the build enforces it)
- Add a `CapabilityEntry` to `utils/knowledge.ts` for any new tool, or the knowledge-coverage jest
  test FAILS the build. This is the self-support durability guarantee: a user's own LLM must be able
  to answer any question about the tool, so the answers can never silently rot.
- Tools are registered in `mcp/src/tools.ts` (`registerS33kTools`), shared by the stdio entry
  (`mcp/src/index.ts`) and the hosted HTTP route (`pages/api/mcp`). The knowledge-coverage jest
  guard parses `tools.ts`, so any new tool there still needs a knowledge entry, and the smoke test's
  `EXPECTED_TOOLS` array must match the registered set exactly.
- Whitelist any new authed API route in `utils/allowedApiRoutes.ts`. Keep that file
  DEPENDENCY-FREE: no DB-model imports. Importing a model drags sequelize/uuid ESM into jest and
  breaks suites. That exact regression happened and was fixed. Do not reintroduce it.

### Model column names must match the migration EXACTLY (Postgres is case-sensitive)
- A new model used `field: 'id'` (lowercase) while its create-table migration keyed the column `ID`.
  On SQLite (case-insensitive) it worked; on Postgres `"id"` != `"ID"`, so every read of that model
  threw "column does not exist" and the route returned a generic 400. Rule: the model attribute's
  column name (the `field:` if set, else the attribute name) must byte-match the column the
  migration creates. Also register every new model in `database/database.ts`'s `models` array.
  The migrations themselves only swallow IDEMPOTENCY (already-applied) errors, never real ones.

### Import provider/util classes STATICALLY, never via runtime `require('./x').Named`
- A dynamic `const { FooProvider } = require('./foo')` resolved to `undefined` in the Next
  STANDALONE production bundle (`new FooProvider()` threw "is not a constructor"), even though
  the export map registered the full name. Next/webpack does not reliably expose a harmony (ESM)
  NAMED export through a runtime require in standalone output. Jest never caught it (jest runs
  source, not the bundle) and it only fired on the configured code path, so a local test looked
  green. Fix: `import { FooProvider } from './foo'` at module top. Static imports are rewritten
  correctly by webpack and are the durable form. To reproduce a bundle-only bug like this:
  `npm run build`, copy `data/database.sqlite` into `.next/standalone/data/`, run
  `node .next/standalone/server.js`, and curl the route.

### Search Console OAuth callbacks are public routes secured by a SIGNED state
- The optional "Connect Google Search Console" flow is two routes: `/api/searchconsole/connect`
  (GET, authed) returns a Google consent URL, and `/api/searchconsole/callback` (GET) is hit by
  GOOGLE's redirect with NO API key and NO cookie. The callback therefore SKIPS `authorize()` (the
  same pattern `pages/api/adwords.ts` uses for its GET-with-code callback) and is NOT in
  `allowedApiRoutes.ts`. Do not add it; whitelisting a route the callback bypasses would be
  cargo-culting.
- Security is re-established by a SIGNED state: `/connect` signs a compact state (HMAC-SHA256 of the
  domain + nonce + timestamp, keyed by the app SECRET) in `utils/searchConsoleOAuth.ts`.
  `/callback` re-verifies that signature (constant-time compare, 15-minute TTL) before trusting the
  domain. The state carries NO secret. The refresh token (the actual secret) is exchanged
  server-side and stored cryptr-encrypted on the Domain's `search_console` blob under
  `oauth_refresh_token`.
- The SC read path (`utils/searchConsole.ts`) prefers the OAuth refresh token (build an
  `OAuth2Client`, `setCredentials({ refresh_token })`) and falls back to the service-account JWT when
  there is none. Keep that fallback: it is the back-compat path for the env/service-account setup.
- The two OAuth env vars are `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET`; the redirect URI is
  `${NEXT_PUBLIC_APP_URL}/api/searchconsole/callback`. If they are unset, `/connect` returns a
  friendly "not configured" message, it does not crash. The whole feature is optional.

### First-run setup + key drop: secrets never transit the LLM (headless direction, phase 1)
- The headless direction: s33k is 100% MCP-driven; the hosted web UI is slated for deletion. Two
  surfaces make that possible, and both obey one constraint: a SECRET (the Serper key) must never
  pass through an LLM chat. Paths are browser-to-server or terminal-to-server only.
- **/setup (the installer)** is the one browser moment. While setup is incomplete, the first
  ensureSynced() success per process prints `[SETUP] Open <base>/setup?token=... to finish setup.`
  (Next 12 pages-router standalone has NO app-level boot hook: no instrumentation.ts, and
  next.config.js is serialized, not executed, in standalone output, so first-ensureSynced-caller is
  the earliest once-per-process app code. The line therefore prints on the first request the
  process serves, e.g. a healthcheck.) The token is >= 32 bytes, memory-only, regenerated each
  boot, constant-time-compared, and dead forever once setup completes. GET /setup and POST
  /api/setup are TOKEN-AUTHED PUBLIC routes (the GSC-callback pattern): NOT in allowedApiRoutes.
- **BACKFILL RULE (do not regress):** an instance with meaningful stored settings (scraper key,
  smtp, GSC/adwords creds, non-'none' scraper_type) or an env-configured scraper counts as setup
  COMPLETED even without the `setup_completed` flag, so every pre-existing install (including the
  production instance) never sees the setup page. See computeSetupCompleted in utils/setupState.ts.
- **Key drop (enable SEO later, from a conversation):** the `mint_key_drop` tool returns a signed
  (HMAC + 15 min TTL + single-use nonce, the searchConsoleOAuth state pattern) curl one-liner; the
  user pastes the key on STDIN in their own terminal, so it never touches chat or shell history.
  POST /api/key-drop/[nonce] is the signed-nonce public consume route (NOT in allowedApiRoutes;
  body parser disabled because curl --data-binary defaults to an urlencoded Content-Type that
  Next's parser would mangle). Consumed nonces persist in the settings blob (restart-durable).
- **Cross-bundle singleton gotcha:** the pages-router server build can duplicate a shared module
  per page/API bundle, so per-process state (the setup token, the key-drop replay guard) lives on
  `globalThis`, never in module-local variables.
- **Modular pillars:** SEO is an OPTIONAL module (enabled iff a scraper key + type resolve; see
  computeSeoConfigured). With SEO off, computeSetupState omits the track_keywords step, so a
  keyless instance with flowing analytics reads COMPLETE/healthy. setup_status and start_here
  carry a `modules` block naming Analytics / AI referrals / SEO status and the mint_key_drop
  enablement path.

### No server-side LLM, ever (a verified-true trust property)
- The AI features (`briefing`, `insights`, `ai_visibility`, `alerts`, `entry_pages`) are
  RULES-BASED. They return structured data for the USER's own LLM to narrate. s33k has no
  model-training pipeline and calls no model provider. This is documented in `SECURITY.md` and
  answerable live via the `security_facts` tool. Keep this structurally true: no LLM client, no
  model-provider SDK, no train/embed/fine-tune path.

### Settings + the failed-retry queue are POSTGRES-BACKED, not files
- `data/settings.json` is RETIRED. Instance settings live in ONE global Postgres row, the
  `setting` table (id = 1), via `utils/settingsStore.ts` (`getStoredSettings` / `writeStoredSettings`).
  Sensitive fields are cryptr-encrypted. On first read, the store does a ONE-TIME, race-safe
  (findOrCreate on id=1) import of an existing `data/settings.json` to preserve any UI-entered
  credentials, then the row is authoritative and the file is never read again. The readers
  (`pages/api/settings.ts`, `utils/searchConsole.ts`, `utils/adwords.ts` + `pages/api/adwords.ts`)
  all go through the store; no app path touches settings.json.
- `data/failed_queue.json` is RETIRED. The retry queue is DERIVED from `keyword.lastUpdateError`
  (refresh.ts sets it on a failed scrape, clears it to 'false' on success). `failedRetryWhere()` /
  `getFailedRetryKeywordIds()` in `utils/scraper.ts` are the query. The hourly retry is
  `POST /api/cron?mode=retry` (DB-backed, same Bearer auth + spend-brake as the full scrape).
  `clearfailed` resets lastUpdateError to 'false' instead of writing a file.
- `cron.js` is a THIN, FILE-FREE, ENV-CONFIGURED scheduler: it reads NO files. Cadences come from
  `SCRAPE_INTERVAL` (default weekly) and `NOTIFICATION_INTERVAL` (default never); the server owns all
  DB state and decides whether to actually scrape/notify. The hourly tick POSTs `/api/cron?mode=retry`.

### Conventions
- No em dashes (U+2014) ANYWHERE: prose, copy, code, labels, comments. Self-check: grep for the
  U+2014 character, count must be zero. Use `.` `,` `:` `·` or `/` instead.
- Max line 150 in code (`eslint max-len` fails the build otherwise). Prose in this file is exempt
  from the line cap but still no em dashes.
- Secrets come from `process.env` only, never hardcoded.
- `npx jest --ci` for one-shot test runs.

---

## C. Commenting + decision-capture standard

- **Comment the WHY and the non-obvious gotcha, not the what.** The code already says what it does.
- **Keep comments from going stale.** Only comment things unlikely to drift, or that are
  load-bearing. A stale comment is worse than none.
- **Intent lives in three places, each scoped to its reach:**
  - **Inline why-comments** · line-level, for the local gotcha.
  - **Commit messages** · why THIS change exists.
  - **This CLAUDE.md** · cross-cutting decisions and gotchas that span files.
- **When you hit a hard-won lesson, add it here** so it is never relearned. That is the whole point
  of this file.

---

## D. Hosted HTTP MCP endpoint (`pages/api/mcp`)

- **What it is.** An optional remote MCP endpoint at `/api/mcp` (Streamable HTTP, SDK
  `StreamableHTTPServerTransport`). A client connects with a URL + a Bearer key and NO local install:
  `claude mcp add --transport http s33k <base-url>/api/mcp --header "Authorization: Bearer <key>"`.
  It exposes the SAME tools as the stdio server via the shared `mcp/src/tools.ts`. The single key is
  `process.env.APIKEY`. If you prefer, self-host with the stdio server only and skip this route.
- **The route reads `Authorization: Bearer <key>`** off the incoming request and binds a per-request
  fetchImpl to THAT key. Every tool call therefore hits the real s33k REST API carrying only that
  key. No-Bearer is rejected 401 before any MCP server is built.
- **Stateless on purpose.** A fresh McpServer + transport + key-bound fetch are built PER REQUEST
  (`sessionIdGenerator: undefined`) and closed on `res.on('close')`.
- **The route is NOT in `allowedApiRoutes.ts`.** It does not call `authorize()` itself (it is the MCP
  transport, guarded by requiring a Bearer key); the checks happen when its tools call the real
  `/api/*` routes, which DO go through `authorize()`. Do not whitelist `/api/mcp` there.
- **The loopback base URL is HEADER-INDEPENDENT, always `http://127.0.0.1:${PORT}` (do not regress).**
  `resolveBaseUrl()` in this route takes NO request and never reads `x-forwarded-host`/`host`. An
  earlier version derived the base from request headers when `NEXT_PUBLIC_APP_URL` was unset; a forged
  `X-Forwarded-Host` would then redirect the loopback fetch (which carries the connecting client's
  Bearer key) to an attacker host = key exfiltration + SSRF. The API we proxy is always THIS local
  process, so there is never a reason to consult headers. Keep it header-free. (The separate
  `utils/baseUrl.ts` resolver keeps its header logic on purpose: it builds user-facing links, not a
  key-bearing loopback.)
- **Per-key rate brake.** The handler runs `rateLimit('mcp:'+bearer, { limit: 240, windowMs: 60000 })`
  AFTER the no-Bearer 401 (so anonymous floods take the cheaper rejection) and before building the
  server. 429 + Retry-After when exhausted.
- **Build-toolchain lesson (hard-won).** The hosted route pulls `zod` (via tools.ts) into the Next
  type-check. Root TypeScript 4.8.4 cannot PARSE zod 3.25's `const`-type-param `.d.cts` (a syntax
  error `skipLibCheck` does not suppress). Bumping to TS 5.9 type-checked but OOM'd the build at the
  4GB default heap. The durable fix shipped: pin root TS to ~5.4.5 (the same version the mcp
  workspace uses) AND set `NODE_OPTIONS=--max-old-space-size=8192` in the root `build` script.
  Do not bump root TS to 5.9+ casually; do not drop the heap bump. The mcp workspace keeps its own TS.
- **jest:** `modulePathIgnorePatterns: ['<rootDir>/.next/']` was added so the standalone build copy
  (`.next/standalone/mcp/package.json`) does not collide with `mcp/package.json` in jest-haste-map.
- **Importing the shared module into Next.** `pages/api/mcp` imports `../../../mcp/src/tools` even
  though root tsconfig EXCLUDES `mcp/`. exclude only drops files from the default include glob, not
  from import resolution, so webpack bundles it. The SDK `.js` ESM subpaths resolve via its `exports`
  `./*` wildcard; the eslint import resolver does not understand the wildcard, hence the two
  `eslint-disable import/extensions, import/no-unresolved` lines on the SDK imports. Keep them.

---

## Quick map

- `database/database.ts`, `database/config.js` · Postgres-or-SQLite selection via `DATABASE_URL`.
- `utils/authorize.ts` · the auth + API-route-whitelist seam.
- `utils/allowedApiRoutes.ts` · API-route whitelist (keep dependency-free).
- `utils/knowledge.ts` · single source of truth for tool docs; the coverage test gates it.
- `mcp/src/tools.ts` · the SHARED MCP tool + resource registration. `mcp/src/index.ts` is
  the stdio entry; `pages/api/mcp/[[...slug]].ts` is the hosted HTTP endpoint. Both call into tools.ts.
- `utils/firstparty-provider.ts` · the owned analytics provider over the `s33k_event` table.
- `SECURITY.md` · the verifiable trust facts (no-training, cookieless, export/delete-your-data).
