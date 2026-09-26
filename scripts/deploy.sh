#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${AIG_IS_DEPLOY_ENABLED:-true}" == "false" ]]; then
  echo "AI Gateway deployment is disabled by AIG_IS_DEPLOY_ENABLED=false."
  exit 0
fi

[[ "${DEPLOY_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ERROR: DEPLOY_SOURCE_SHA must be a full commit SHA" >&2
  exit 64
}

cleanup() {
  rm -f     "${RUNNER_TEMP:-/tmp}/wrangler.github.json"     "${RUNNER_TEMP:-/tmp}/gateway-secrets.json"     "${RUNNER_TEMP:-/tmp}/deployment-summary.txt" 2>/dev/null || true
}
trap cleanup EXIT

export DEPLOYED_SHA="$DEPLOY_SOURCE_SHA"
export AIG_BUILD_SHA="$DEPLOY_SOURCE_SHA"

npm ci
npm run validate:deploy
npm run check:deploy
node scripts/github-deployment-config.mjs preflight
node scripts/github-deployment-config.mjs prepare --from-env   --wrangler "$RUNNER_TEMP/wrangler.github.json"   --secrets "$RUNNER_TEMP/gateway-secrets.json"   --summary "$RUNNER_TEMP/deployment-summary.txt"

if [[ -n "${AIG_USAGE_D1_ID:-}" ]]; then
  npx --yes wrangler@4.114.0 d1 migrations apply ai-gateway-stats     --remote     -c "$RUNNER_TEMP/wrangler.github.json"
fi

npx --yes wrangler@4.114.0 deploy   --secrets-file "$RUNNER_TEMP/gateway-secrets.json"   -c "$RUNNER_TEMP/wrangler.github.json"

health_ok=false
for attempt in 1 2 3; do
  if node scripts/github-deployment-config.mjs health-check       --from-env       --expected-build "$DEPLOYED_SHA"; then
    health_ok=true
    break
  fi
  if [[ "$attempt" -lt 3 ]]; then
    echo "Post-deploy health check attempt ${attempt}/3 failed; retrying in 5s."
    sleep 5
  fi
done

if [[ "$health_ok" != "true" ]]; then
  echo "Post-deploy health check failed; rolling back previous Worker version." >&2
  npx --yes wrangler@4.114.0 rollback -c "$RUNNER_TEMP/wrangler.github.json"
  node scripts/github-deployment-config.mjs health-check --from-env || true
  exit 1
fi

if [[ -f "$RUNNER_TEMP/deployment-summary.txt" ]]; then
  {
    echo "## AI Gateway deployment"
    echo
    cat "$RUNNER_TEMP/deployment-summary.txt"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "AI Gateway deployment completed: $DEPLOYED_SHA"
