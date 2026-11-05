#!/usr/bin/env bash
set -Eeuo pipefail
# Runtime provider/application secrets are persistent Cloudflare Worker Secrets.
# This code-deploy path only reads their names and never uploads or deletes values.
umask 077

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
  rm -f \
    "${RUNNER_TEMP:-/tmp}/wrangler.github.json" \
    "${RUNNER_TEMP:-/tmp}/worker-secrets.json" \
    "${RUNNER_TEMP:-/tmp}/deployment-summary.txt" 2>/dev/null || true
}
trap cleanup EXIT

export DEPLOYED_SHA="$DEPLOY_SOURCE_SHA"
export AIG_BUILD_SHA="$DEPLOY_SOURCE_SHA"

npm ci
npm run validate:deploy
npm run check:deploy

node scripts/persistent-deployment.mjs preflight
node scripts/persistent-deployment.mjs prepare \
  --wrangler "$RUNNER_TEMP/wrangler.github.json" \
  --summary "$RUNNER_TEMP/deployment-summary.txt"

# Wrangler returns names and types only; no secret values are downloaded.
node scripts/cloudflare-wrangler.mjs secret list \
  --format json \
  --config "$RUNNER_TEMP/wrangler.github.json" \
  > "$RUNNER_TEMP/worker-secrets.json"
node scripts/persistent-deployment.mjs verify-secrets \
  --file "$RUNNER_TEMP/worker-secrets.json" \
  --wrangler "$RUNNER_TEMP/wrangler.github.json"

# No --secrets-file: Cloudflare preserves existing Worker Secrets across code deployments.
node scripts/cloudflare-wrangler.mjs deploy \
  --config "$RUNNER_TEMP/wrangler.github.json"

health_ok=false
for attempt in 1 2 3; do
  if node scripts/persistent-deployment.mjs health-check --expected-build "$DEPLOYED_SHA"; then
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
  node scripts/cloudflare-wrangler.mjs rollback --config "$RUNNER_TEMP/wrangler.github.json"
  node scripts/persistent-deployment.mjs health-check || true
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
