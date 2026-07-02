# Roadmap

What s33k is focused on, what is queued behind it, and what it deliberately will not do. This file is direction, not a promise of dates. If you want to work on something here, open an issue first so we can agree on shape before you build.

## Current focus

1. **The analyst layer.** The rules-based briefing (`briefing`, `daily_brief`, `alerts`, `insights`) is the product's front door, and it should notice more than it does: content decay (a page whose traffic slides for weeks while its rank holds), anomaly spikes, and SERP context on rank alerts (who moved above you) so your LLM can explain a change, not just report it.
2. **A stranger's first hour.** Honest cost math, a realistic MCP-conversation example in the README, and a troubleshooting doc, so someone who finds the repo can decide fast and install without getting stuck.

## Queued behind that

The concrete queue lives on the [issue tracker](https://github.com/benjaminard/s33k/issues); each item there is written to be picked up cold. Highlights:

- **A browser upload page for file-shaped secrets** ([#16](https://github.com/benjaminard/s33k/issues/16)). The key-drop curl is right for pasted keys and rough for files; a one-time token-gated page with a file picker (the `/setup` pattern) collapses the terminal friction into one click.
- **Honest rank alerts under sparse scrape history** ([#17](https://github.com/benjaminard/s33k/issues/17)). Distinguish newly-ranked from newly-scraped, and always alert on a drop off the top 100.
- **Batch keyword add** ([#18](https://github.com/benjaminard/s33k/issues/18)) and **context-aware alert recommendations** ([#19](https://github.com/benjaminard/s33k/issues/19)), both labeled good first issue, alongside [#20](https://github.com/benjaminard/s33k/issues/20), [#21](https://github.com/benjaminard/s33k/issues/21), and [#22](https://github.com/benjaminard/s33k/issues/22).
- **Backlinks, the cheap way.** A monthly referring-domains count per domain built from the Common Crawl domain-level web graph (a fixed-cost index, no crawler, no per-user spend), with honest labeling about Common Crawl's partial coverage. Page-level detail is out of scope until the count proves useful.

Shipped from the previous queue (July 2026): `alerts?since=` polling, the clean single-user migration baseline, and the documented retention policy (see `BACKUP.md`).

## Not planned

- **Multi-tenant accounts, signup, or billing.** s33k is single-user and self-hosted on purpose. That constraint is what keeps the security model simple and the data yours.
- **Server-side LLM calls.** The AI features stay rules-based and your own LLM does the narration. This is a verified trust property (see `SECURITY.md`), not a temporary gap.
- **A dashboard, period.** The MCP surface is the product, so the web UI was deleted outright: the only browser surface left is the one-time, token-gated setup page, and everything else is conversation with your own LLM.

## Good first issues

Issues labeled `good-first-issue` on the [issue tracker](https://github.com/benjaminard/s33k/issues) are scoped to be doable without deep repo knowledge. `CONTRIBUTING.md` has the build gates; `CLAUDE.md` has the hard-won gotchas.
