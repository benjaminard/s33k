## What changed

(1-2 sentences.)

## Why

(Link the issue, or one sentence of context.)

## Checklist

- [ ] `npm run lint` passes
- [ ] `npx jest --ci` passes (not `npm run test`, that is watch mode)
- [ ] `npm run build` prints "Compiled successfully"
- [ ] `cd mcp && npm run build` passes
- [ ] New MCP tool? Knowledge entry added to `utils/knowledge.ts` and the smoke test's `EXPECTED_TOOLS` updated (the build enforces both)
- [ ] New authed API route? Whitelisted in `utils/allowedApiRoutes.ts` (keep that file dependency-free)
- [ ] No em dashes anywhere (grep for the U+2014 character; count must be zero)

## How was this tested

(Local instance? Curl? Which jest suites cover it?)
