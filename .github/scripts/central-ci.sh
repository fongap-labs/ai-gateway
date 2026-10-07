#!/usr/bin/env bash
# Central execution contract: invoked by fongap-labs/action-worker.
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
if [ -z "$TARGET_ROOT" ] || [ ! -d "$TARGET_ROOT" ]; then
  echo "central-ci: target root is required" >&2
  exit 64
fi
if [ -z "${CENTRAL_CI_AW_ROOT:-}" ] || [ ! -f "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" ]; then
  echo "central-ci: CENTRAL_CI_AW_ROOT must point to the action-worker checkout" >&2
  exit 64
fi

cd "$TARGET_ROOT"

npm ci
# Standard tools run here with fixed arguments, so a pull request cannot weaken them by editing the
# "lint" or "typecheck" scripts in package.json. Their configuration files and the repository-owned
# checks below are still part of the change under review.
npx --no-install biome check .
npx --no-install tsc --noEmit
npm run validate:merge
# Test suites are owned by action-worker (tests/packs/ai-gateway) and run against this checkout.
node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" ai-gateway "$TARGET_ROOT" all
npm run check:deploy

if [ "${CENTRAL_CI_PR_NUMBER:-0}" = "0" ]; then
  npm run validate:deploy
fi
