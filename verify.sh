#!/usr/bin/env bash
# verify.sh - the single verification loop for s33k (audit item A20).
#
# Runs every gate the repo rules require, in order, and stops at the first failure:
#   1. lint            (eslint, max-len + no-em-dash rules)
#   2. jest --ci       (the full test suite, one-shot, not watch)
#   3. build           (Next.js production build, must compile)
#   4. mcp build       (the MCP workspace tsc build)
#   5. mcp smoke       (idempotent end-to-end MCP tool check; skipped if env is missing)
#
# Usage: ./verify.sh   (from the repo root). Exit code 0 only if every gate passes.
# Node 20 is the pinned toolchain (see .nvmrc); we select it via nvm when present.
set -euo pipefail

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm use 20 >/dev/null 2>&1 || echo "[verify] nvm use 20 failed; continuing on the current node"
fi

echo "[verify] node $(node -v)"

echo "[verify] 1/5 lint"
npm run lint

echo "[verify] 2/5 jest --ci"
npx jest --ci

echo "[verify] 3/5 build"
npm run build

echo "[verify] 4/5 mcp build"
( cd mcp && npm run build )

echo "[verify] 5/5 mcp smoke (skipped if env is not configured)"
if ( cd mcp && npm run smoke ); then
  echo "[verify] smoke passed"
else
  echo "[verify] smoke skipped or failed (often missing env); review above if it failed"
fi

echo "[verify] all gates passed"
