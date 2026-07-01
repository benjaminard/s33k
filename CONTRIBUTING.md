# Contributing to s33k

Thanks for your interest. s33k is a single-user, self-hosted, open-source tool, and contributions are welcome: bug fixes, new MCP tools, docs, or new SEO / analytics / AI-referral ideas.

## Development setup

s33k pins Node 20 (see `.nvmrc`).

```bash
git clone https://github.com/benjaminard/s33k.git
cd s33k
nvm use 20
npm ci
cp .env.example .env   # set USER_NAME and PASSWORD, generate SECRET and APIKEY (openssl rand -hex 34 / -hex 24)
npm run dev            # http://localhost:3000, on a local SQLite database
```

Or run the whole stack in Docker: `./scripts/setup-env.sh && docker compose up -d --build`.

## Before you open a pull request

Run these from the repo root and make sure they all pass:

```bash
npm run lint             # must be clean
npx jest --ci            # all suites green
cd mcp && npm run build  # the MCP server compiles
```

House rules:

- No em dashes anywhere, in prose, code, or comments. Use `.` `,` `:` `·` or `/`.
- Match the surrounding style, and keep each change focused.
- If you add an MCP tool in `mcp/src/tools.ts`, add its knowledge entry in `utils/knowledge.ts` and add it to the smoke test's `EXPECTED_TOOLS`, or the build fails. A jest guard keeps the registered tools and the knowledge layer in lockstep on purpose.
- Comment the why and the non-obvious, not the what.

## How to submit

Fork the repo, work on a branch, and open a pull request against `main` with a clear description of what changed and why. For anything large, open an issue first so we can talk it through before you build.

## Architecture

[`CLAUDE.md`](CLAUDE.md) is the contributor door-sign: runtime and commands, the database seam (Postgres in production, SQLite locally), the hard-won deploy notes, and the design invariants (single-user, first-party analytics, no server-side LLM calls). Read it before a non-trivial change.

## License

By contributing, you agree that your contributions are licensed under the MIT License. See [`LICENSE`](LICENSE).
