# Roadmap

What s33k is focused on, what is queued behind it, and what it deliberately will not do. This file is direction, not a promise of dates. If you want to work on something here, open an issue first so we can agree on shape before you build.

## Current focus

1. **The analyst layer.** The rules-based briefing (`briefing`, `daily_brief`, `alerts`, `insights`) is the product's front door, and it should notice more than it does: content decay (a page whose traffic slides for weeks while its rank holds), anomaly spikes, and SERP context on rank alerts (who moved above you) so your LLM can explain a change, not just report it.
2. **A stranger's first hour.** Screenshots in the README, honest cost math, and a troubleshooting doc, so someone who finds the repo can decide fast and install without getting stuck.

## Queued behind that

- **Backlinks, the cheap way.** A monthly referring-domains count per domain built from the Common Crawl domain-level web graph (a fixed-cost index, no crawler, no per-user spend), with honest labeling about Common Crawl's partial coverage. Page-level detail is out of scope until the count proves useful.
- **Alerts since a timestamp.** An `alerts` parameter so your LLM can poll "what changed since yesterday" cheaply, which makes proactive notification workflows possible without email setup.
- **A clean migration baseline.** The migration chain still carries tables from a retired multi-tenant era; a fresh install should create only the schema s33k actually uses.
- **Retention tooling.** Events are kept forever today. A documented retention policy and an optional cleanup command.

## Not planned

- **Multi-tenant accounts, signup, or billing.** s33k is single-user and self-hosted on purpose. That constraint is what keeps the security model simple and the data yours.
- **Server-side LLM calls.** The AI features stay rules-based and your own LLM does the narration. This is a verified trust property (see `SECURITY.md`), not a temporary gap.
- **A bigger dashboard.** The MCP surface is the product. The web UI stays a thin companion for setup and glancing, not a destination.

## Good first issues

Issues labeled `good-first-issue` on the [issue tracker](https://github.com/benjaminard/s33k/issues) are scoped to be doable without deep repo knowledge. `CONTRIBUTING.md` has the build gates; `CLAUDE.md` has the hard-won gotchas.
