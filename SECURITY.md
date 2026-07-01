# s33k Security and Trust

s33k is an open, self-hosted, MCP-controllable SEO + AEO + analytics suite. It is a single-user tool: you run your own copy, you are the only account, and your data lives in your own database. This document is the honest, specific answer to one question: can you run s33k without security fear? The answer rests on a simple principle.

**Verify us, don't trust us.** Every claim below points at the exact code, test, or config that proves it. s33k is open source, so you can read all of it, and you self-host it, so the data never leaves your own infrastructure.

You can also ask your own LLM "is this safe? does it train on my data?" and get these same answers back as structured facts: the `security_facts` MCP tool returns this document's guarantees in machine-readable form.

---

## 1. We do not train on your data (this is structurally true)

s33k has **no model-training pipeline anywhere in the codebase**. There is no LLM client, no embedding step, no fine-tuning job, and no code path that sends your data to any model trainer. This is not a policy promise that could quietly change. It is a structural fact about what the code can and cannot do.

The AI features (the daily briefing, the cross-pillar insights, the AI-visibility funnel) are **rules-based**. They run small, transparent, commented rules over your own data on the server and return a structured, narration-ready bundle. The interpretation ("tell me what this means and what to do") happens in **your own LLM**, over MCP. s33k only ever hands your LLM structured data that it computed from your own database. It never asks an external model anything about your data, and it never sends your data to a model to be trained on.

Where to verify:

- `pages/api/briefing.ts`: top-of-file trust marker plus the long header comment:
  "This route is RULES-BASED. It does NOT call any LLM."
- `pages/api/insights.ts`: same trust marker and "RULES-BASED. It does NOT call any
  LLM" header.
- `pages/api/ai-visibility.ts`: trust marker; the view is built only from
  first-party AI referral traffic plus a deterministic on-page audit.
  "It NEVER queries an LLM."
- `mcp/src/index.ts`: the `briefing`, `insights`, and `ai_visibility` tool
  descriptions all state the s33k server does not call an LLM.

The distinction that matters: this is not "we don't train today." It is "we have no infrastructure to train, and your data never leaves the server for any model."

---

## 2. Single-user by design

s33k is one user and one instance. There are no other accounts, no signup, no invites, no shared tenancy: you own the whole deployment, so there is no cross-account boundary to breach. Access is a single admin login plus a single API key (the `APIKEY`), which is the same key the MCP server authenticates with. Anyone with the URL and that key can act as you, so protect them accordingly (see section 6).

Because there is only one owner, all of your data belongs to you and s33k reads it freely to do its job (compute rank trends, sessions, and cross-pillar joins). The strongest guarantee here is the deployment model itself: you host it, so the data is yours end to end.

Where to verify: `utils/resolveAccount.ts` and `utils/authorize.ts` (the single-admin resolution and the API-route guard), and the fact that there is no signup, invite, or account-management route in `pages/api/`.

---

## 3. Encryption at rest (connected credentials are encrypted; the honest residual)

The credentials you connect (Google Search Console keys, Google Ads keys, the SERP scraper key, SMTP password) are encrypted at rest with [`cryptr`](https://www.npmjs.com/package/cryptr) (AES-256) keyed by the app `SECRET` environment variable. They are decrypted only in memory, only to make the API call they belong to, and are never logged, never returned by the export endpoint, and never sent to a model.

Your API key is stored as a SHA-256 hash, never as the clear key. The full key is your `APIKEY` env value.

Where to verify:

- `pages/api/domains.ts` and `pages/api/settings.ts`: `cryptr.encrypt(...)` on write
  for `client_email`, `private_key`, `scaping_api` (scraper key), `smtp_password`, and
  the `adwords_*` credentials.
- `utils/searchConsole.ts` and `utils/adwords.ts`: encryption-at-rest markers and
  `cryptr.decrypt(...)` on read, in memory only.

**The honest residual (what is NOT encrypted, and why).** Your analytics substrate, the autocapture events (`S33kEvent`), the tracked keywords and their full rank history (`Keyword`), the domain names (`Domain`), and the AI-crawler hits (`CrawlerHit`), is stored in PLAINTEXT in the database. This is not an oversight: s33k computes analytics over this data on the server (counts, sessions, rank trends, cross-pillar joins), so it cannot be zero-knowledge or end-to-end encrypted, the server has to read it to do its job. What is encrypted at rest is exactly the set that does NOT need to be computed over: your connected third-party credentials. This is precisely why self-hosting (section 5) is the strongest guarantee: when you own the deployment and the database, that residual access is yours alone.

---

## 4. Your data is yours (export it, or delete it, on demand)

Ownership you can exercise, not just claim:

- **Export everything.** `GET /api/export` (MCP tool `export_data`) returns one JSON bundle with all of your data: domains, keywords with full rank history, and autocapture events. It **never** includes a secret: Search Console / Google Ads credentials are reported only as configured-or-not.
- **Delete it yourself.** Because you own the database, deleting your data is direct: drop the rows, drop the database, or tear down the instance. There is no vendor holding your data hostage.

Where to verify: `pages/api/export.ts`, and the `export_data` tool in `mcp/src/index.ts`.

---

## 5. Open source and self-hosted (verify us, don't trust us)

s33k is open source. You can read every line of the code that touches your data, and you run the whole thing on your own infrastructure with your own database, so your data never leaves your control. Self-hosting is the strongest possible form of "verify, don't trust": the guarantees in this document are things you can confirm by reading the code and by owning the deployment end to end.

---

## 6. Cookieless, no-PII tracking

The s33k autocapture script (`public/s33k.js`) and its ingest endpoint (`pages/api/collect.ts`) are built to capture the **event, never the person**.

- **No cookies, no fingerprinting.** The session id lives in `sessionStorage` only and
  is a daily-rotating value: it cannot identify a person and cannot be joined across
  days or across tabs.
- **No typed content, ever.** The client never reads the value of an `input`,
  `textarea`, `select`, `[contenteditable]`, or any password field. It records THAT a
  form was submitted (its id/name), never the field values. Captured text is trimmed
  and length-capped; inputs are explicitly excluded.
- **Defense in depth on the server.** `pages/api/collect.ts` sanitizes every event and
  drops anything PII-shaped (an email, a card number, a value smuggled into a label)
  before it is stored. The ingest also enforces domain allow-listing, bot filtering,
  and rate limiting.

Where to verify: `public/s33k.js` (the PRIVACY header and the capture helpers), `pages/api/collect.ts`, and `utils/event-sanitize.ts`.

---

## 7. Sub-processors

s33k is first-party by design: analytics is collected by its own beacon into its own database, so there is no third-party analytics sub-processor. When you self-host, the hosting and the database are yours. The only outbound calls s33k makes on your behalf are:

| Sub-processor | Role | Notes |
|---|---|---|
| Serper | SERP data for keyword rank tracking | The SERP query runs server-side on your own Serper key (`scrapers/services/serper.ts`); the key is encrypted at rest. |
| Google (optional) | Search Console / Google Ads data, if you connect it | Only if you configure it. Credentials are encrypted at rest and used server-side only. |

No data is sent to any LLM provider as a sub-processor, because s33k makes no LLM calls. The analysis happens in **your** LLM, which is your client and your choice, not a sub-processor of s33k.

---

## 8. The proof index

| Guarantee | Proven by |
|---|---|
| No model training / no LLM call | `pages/api/briefing.ts`, `insights.ts`, `ai-visibility.ts` trust markers; `mcp/src/index.ts` tool descriptions |
| Single-user, single-key access | `utils/resolveAccount.ts`, `utils/authorize.ts`, the absence of any signup/invite/account route |
| Encryption at rest (connected credentials) | `pages/api/domains.ts`, `pages/api/settings.ts`, `utils/searchConsole.ts`, `utils/adwords.ts` |
| Data export | `pages/api/export.ts`, MCP `export_data` |
| Cookieless / no-PII tracking | `public/s33k.js`, `pages/api/collect.ts`, `utils/event-sanitize.ts` |
| Open source / self-hosted | the repository itself |

Ask your LLM the `security_facts` MCP tool for any of these and it will answer with the fact and where to verify it.
