#!/usr/bin/env bash
set -Eeuo pipefail
# Provider and application Secrets remain persistent in Cloudflare.
# The ONE ai-gateway-ops Environment supplies health and center-auth keys, which
# are synchronized to the four Workers in the existing source-script deploy.
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
center_update_attempted=()
gateway_update_attempted=false
gateway_rollback_verified=false

cleanup() {
  rm -f \
    "${RUNNER_TEMP:-/tmp}/wrangler.github.json" \
    "${RUNNER_TEMP:-/tmp}/worker-secrets.json" \
    "${RUNNER_TEMP:-/tmp}/deployment-summary.txt" \
    "${RUNNER_TEMP:-/tmp}/private-center-"*.json \
    "$recovery_evidence" "$recovery_evidence.next" 2>/dev/null || true
}
finish() {
  status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "${#center_update_attempted[@]}" -gt 0 ]]; then
    printf 'ERROR: partial multi-Worker release; private center update(s) attempted: %s.\n' "${center_update_attempted[*]}" >&2
    if [[ "$gateway_rollback_verified" == "true" ]]; then
      echo 'Gateway rollback identity was verified; public readiness was verified when the restored version supports it.' >&2
      echo 'Private centers may still be on the attempted source SHA.' >&2
    elif [[ "$gateway_update_attempted" == "true" ]]; then
      echo 'Gateway publication was attempted but no verified rollback is recorded; inspect exact Worker deployment identities before any retry or recovery.' >&2
    else
      echo 'Gateway publication was not attempted; existing Gateway configuration remains, while a bound center may already have changed.' >&2
    fi
    echo 'Do not claim an atomic rollback. Restore only an approved, compatible immutable SHA after checking each Worker identity through the protected release process.' >&2
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

export DEPLOYED_SHA="$DEPLOY_SOURCE_SHA"
export AIG_BUILD_SHA="$DEPLOY_SOURCE_SHA"

npm ci
npm run validate:deploy
npm run check:deploy

# Verify ALL configured private centers before printing success or mutating Cloudflare.
# Missing custom policies and missing image/vision capacity are reported together.
node scripts/private-center-config.mjs preflight
node scripts/persistent-deployment.mjs preflight
# Confirm the one protected Environment contains all authentication inputs
# before any production Worker or rollback-baseline mutation.
node scripts/sync-runtime-secrets.mjs preflight
node scripts/persistent-deployment.mjs prepare \
  --wrangler "$RUNNER_TEMP/wrangler.github.json" \
  --summary "$RUNNER_TEMP/deployment-summary.txt"

# The existing Action Worker source-script deployment is the ONE release entry.
# Build all private center manifests before mutating any Worker. Their Secret
# values remain managed exclusively by the protected ops channel.
for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  manifest="$RUNNER_TEMP/private-center-$center-manifest.json"
  node scripts/private-center-config.mjs prepare \
    --worker "$center" --output "$config" --manifest "$manifest"
done

# Snapshot the live Gateway identity before the FIRST center mutation.
# Use public readiness when the current version supports it; during the first
# readiness rollout, a tagged legacy version is identified through Cloudflare.
# This guard does not make a multi-Worker rollout atomic; never report success
# if a later center Secret inventory or Gateway health check fails.
node scripts/deployment-recovery.mjs snapshot "$recovery_evidence"

# Prepare all three private centers automatically under the SAME audited commit and
# credential environment. No center has public routes or Workers.dev.
# A first-time bootstrap may stop below for missing Cloudflare Secrets: it must
# never enable Gateway Service Bindings until the owner has provisioned them.
for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  center_update_attempted+=("$center")
  node scripts/cloudflare-wrangler.mjs deploy \
    --message "action-worker:center:$center:$DEPLOY_SOURCE_SHA" \
    --config "$config"
done

# Use the SAME protected ops Secret value for each private center and its
# Gateway Service Binding. This is an idempotent named-secret reconciliation,
# not an extra deploy workflow or another GitHub Environment.
# All four live Workers are inspected before any Secret is changed.
node scripts/sync-runtime-secrets.mjs reconcile

# Read only Secret names for each center, then fail closed BEFORE switching
# the public Gateway if either internal auth or provider shard is missing.
for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  manifest="$RUNNER_TEMP/private-center-$center-manifest.json"
  inventory="$RUNNER_TEMP/private-center-$center-inventory.json"
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

# The previous healthy Gateway identity was recorded before center publication.
# Attach the exact source SHA to Cloudflare's deployment metadata. The recovery
# guard refuses to claim an unrelated/concurrent deploy as this job's publish.
# Cloudflare preserves existing Worker Secrets across code-only deployments.
gateway_update_attempted=true
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
  gateway_rollback_verified=true
  echo "Previous Gateway version restored; public readiness was verified when supported. New deployment failed." >&2
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
