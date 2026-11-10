#!/usr/bin/env bash
set -Eeuo pipefail
# Runtime provider/application secrets are persistent Cloudflare Worker Secrets.
# This code-deploy path only reads their names and never uploads or deletes values.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
# A central successful job is recorded as a successful production deployment.
# Disabled deployments must not silently return success and generate an audit.
case "${AIG_IS_DEPLOY_ENABLED:-true}" in
  true) ;;
  false)
    echo "ERROR: AI Gateway deployment is disabled; no production deployment occurred." >&2
    exit 77
    ;;
  *)
    echo "ERROR: AIG_IS_DEPLOY_ENABLED must be true or false." >&2
    exit 64
    ;;
esac

[[ "${DEPLOY_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ERROR: DEPLOY_SOURCE_SHA must be a full commit SHA" >&2
  exit 64
}
recovery_evidence="$RUNNER_TEMP/gateway-recovery-$DEPLOY_SOURCE_SHA.json"

cleanup() {
  rm -f \
    "${RUNNER_TEMP:-/tmp}/wrangler.github.json" \
    "${RUNNER_TEMP:-/tmp}/worker-secrets.json" \
    "${RUNNER_TEMP:-/tmp}/deployment-summary.txt" \
    "${RUNNER_TEMP:-/tmp}/private-center-"*.json \
    "$recovery_evidence" "$recovery_evidence.next" 2>/dev/null || true
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

# Fail closed before any production Gateway mutation unless both private
# Worker names and their required Secret shards are already present in Cloudflare.
# This does not bootstrap centers or infer Secret values from GitHub.
for center in ai-inference-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  manifest="$RUNNER_TEMP/private-center-$center-manifest.json"
  inventory="$RUNNER_TEMP/private-center-$center-inventory.json"
  node scripts/private-center-config.mjs prepare \
    --worker "$center" --output "$config" --manifest "$manifest"
  node scripts/cloudflare-wrangler.mjs secret list \
    --format json --config "$config" > "$inventory"
  node scripts/private-center-config.mjs verify-inventory \
    --worker "$center" --inventory "$inventory" --manifest "$manifest"
done

# Wrangler returns names and types only; no secret values are downloaded.
node scripts/cloudflare-wrangler.mjs secret list \
  --format json \
  --config "$RUNNER_TEMP/wrangler.github.json" \
  > "$RUNNER_TEMP/worker-secrets.json"
node scripts/persistent-deployment.mjs verify-secrets \
  --file "$RUNNER_TEMP/worker-secrets.json" \
  --wrangler "$RUNNER_TEMP/wrangler.github.json"

# Confirm a healthy production version and preserve its exact Cloudflare UUID
# before a new version or D1 migration can mutate remote state.
node scripts/deployment-recovery.mjs snapshot "$recovery_evidence"

# Attach the exact source SHA to Cloudflare's deployment metadata. The recovery
# guard refuses to claim an unrelated/concurrent deploy as this job's publish.
# Cloudflare preserves existing Worker Secrets across code-only deployments.
node scripts/cloudflare-wrangler.mjs deploy \
  --message "action-worker:deploy:$DEPLOY_SOURCE_SHA" \
  --config "$RUNNER_TEMP/wrangler.github.json"
node scripts/deployment-recovery.mjs capture-published "$recovery_evidence"

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
  echo "Post-deploy health check failed; checking exact rollback eligibility." >&2
  # Never default to Wrangler's unpinned previous-version selection, and never
  # overwrite a concurrent production deployment. Both decisions use live API.
  if ! rollback_version="$(node scripts/deployment-recovery.mjs rollback-target "$recovery_evidence")"; then
    echo "ERROR: Rollback refused: production no longer matches this deployment." >&2
    exit 77
  fi
  if ! node scripts/cloudflare-wrangler.mjs rollback "$rollback_version" \
    --message "action-worker:rollback:$DEPLOY_SOURCE_SHA" \
    --config "$RUNNER_TEMP/wrangler.github.json"; then
    echo "ERROR: Targeted rollback was not confirmed by Cloudflare." >&2
    exit 77
  fi
  if ! node scripts/deployment-recovery.mjs verify-restored "$recovery_evidence"; then
    echo "ERROR: Restored version or public health is not verified." >&2
    exit 77
  fi
  echo "Previous immutable Gateway version and public health restored; new deployment failed." >&2
  exit 1
fi

# No success audit if another actor replaced this version during health probes.
node scripts/deployment-recovery.mjs verify-published "$recovery_evidence"

if [[ -f "$RUNNER_TEMP/deployment-summary.txt" ]]; then
  {
    echo "## AI Gateway deployment"
    echo
    cat "$RUNNER_TEMP/deployment-summary.txt"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "AI Gateway deployment completed: $DEPLOYED_SHA"
