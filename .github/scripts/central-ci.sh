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

run_phase() {
  local phase="$1"
  shift
  local call_line="${BASH_LINENO[0]:-$LINENO}"
  if "$@"; then
    echo "central-ci: phase=$phase status=passed"
  else
    local code=$?
    echo "central-ci: phase=$phase status=failed exit=$code" >&2
    if [ -n "${CENTRAL_CI_FAILURE_FILE:-}" ]; then
      printf "%s:%s\\n" "$call_line" "$code" > "$CENTRAL_CI_FAILURE_FILE"
    fi
    exit "$code"
  fi
}

run_phase npm-ci npm ci
# Standard tools run here with fixed arguments, so a pull request cannot weaken them by editing the
# "lint" or "typecheck" scripts in package.json. Their configuration files and the repository-owned
# checks below are still part of the change under review.
run_phase biome npx --no-install biome check .
run_phase typecheck npx --no-install tsc --noEmit
run_phase validate-merge npm run validate:merge
# Test suites are owned by action-worker (tests/packs/ai-gateway) and run against this checkout.
run_phase test-pack node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" ai-gateway "$TARGET_ROOT" all
run_phase check-deploy npm run check:deploy

if [ "${CENTRAL_CI_PR_NUMBER:-0}" = "0" ]; then
  run_phase validate-deploy npm run validate:deploy
fi
