#!/usr/bin/env bash
set -Eeuo pipefail
# The protected ai-gateway-ops Environment supplies private Provider shards and
# center authentication. Application access keys stay in Cloudflare.
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
      echo 'Cloudflare confirmed restoration of the previous Gateway version.' >&2
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

# Only the Secret synchronization subprocess needs Provider keys.
provider_secret_names=()
for name in "${!AIG_TIER1_CREDENTIALS_@}" "${!AIG_TIER2_CREDENTIALS_@}"; do
  if [[ "$name" =~ ^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$ ]]; then
    export -n "$name"
    provider_secret_names+=("$name")
  fi
done
sync_runtime_secrets() (
  if (( ${#provider_secret_names[@]} )); then
    export "${provider_secret_names[@]}"
  fi
  exec node scripts/sync-runtime-secrets.mjs "$@"
)

export DEPLOYED_SHA="$DEPLOY_SOURCE_SHA"
export AIG_BUILD_SHA="$DEPLOY_SOURCE_SHA"

npm ci
npm run validate:deploy
npm run check:deploy

# Verify ALL configured private centers before printing success or mutating Cloudflare.
# Missing custom policies and missing image/vision capacity are reported together.
node scripts/private-center-config.mjs preflight
node scripts/persistent-deployment.mjs preflight
node scripts/persistent-deployment.mjs prepare \
  --wrangler "$RUNNER_TEMP/wrangler.github.json" \
  --summary "$RUNNER_TEMP/deployment-summary.txt"

# The existing Action Worker source-script deployment is the ONE release entry.
# Build all private center manifests before mutating any Worker.
for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  manifest="$RUNNER_TEMP/private-center-$center-manifest.json"
  node scripts/private-center-config.mjs prepare \
    --worker "$center" --output "$config" --manifest "$manifest"
done

read_gateway_secret_names() {
  node scripts/cloudflare-wrangler.mjs secret list \
    --format json --config "$RUNNER_TEMP/wrangler.github.json" > "$RUNNER_TEMP/worker-secrets.json"
}

# Check the live Gateway's application Secret names before touching any Worker.
read_gateway_secret_names
node scripts/persistent-deployment.mjs check-secret-source \
  --file "$RUNNER_TEMP/worker-secrets.json" --wrangler "$RUNNER_TEMP/wrangler.github.json"

# Verify the protected environment covers every prepared private node before any write.
sync_runtime_secrets preflight

# Snapshot the live Gateway identity before the FIRST center mutation.
# The Cloudflare API gives us the rollback version ID for the current Worker.
# This guard does not make a multi-Worker rollout atomic; never report success
# if a later center Secret inventory or Gateway health check fails.
node scripts/deployment-recovery.mjs snapshot "$recovery_evidence"

# Prepare all three private centers under the same audited commit. No center
# has public routes or Workers.dev. Their credentials are applied below.
for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  center_update_attempted+=("$center")
  node scripts/cloudflare-wrangler.mjs deploy \
    --message "action-worker:center:$center:$DEPLOY_SOURCE_SHA" \
    --config "$config"
done

# Apply the Provider shards to their private Workers and mirror center auth
# to the Gateway bindings. Inspect all four Workers before changing any Secret.
sync_runtime_secrets reconcile

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

# Plan inheritance from the live Secret names after center authentication sync.
read_gateway_secret_names
node scripts/persistent-deployment.mjs prepare-publish \
  --file "$RUNNER_TEMP/worker-secrets.json" --wrangler "$RUNNER_TEMP/wrangler.github.json"

# The previous Gateway version was recorded before center publication.
# Attach the exact source SHA to Cloudflare's deployment metadata. The recovery
# guard refuses to claim an unrelated/concurrent deploy as this job's publish.
# Only retained Secret names are inherited by the new version.
gateway_update_attempted=true
node scripts/cloudflare-wrangler.mjs deploy \
  --message "action-worker:deploy:$DEPLOY_SOURCE_SHA" \
  --config "$RUNNER_TEMP/wrangler.github.json"
node scripts/deployment-recovery.mjs capture-published "$recovery_evidence"

health_ok=false
for attempt in 1 2 3; do
  if read_gateway_secret_names &&
    node scripts/persistent-deployment.mjs verify-secrets \
      --file "$RUNNER_TEMP/worker-secrets.json" --wrangler "$RUNNER_TEMP/wrangler.github.json" &&
    node scripts/persistent-deployment.mjs health-check --expected-build "$DEPLOYED_SHA"; then
    health_ok=true
    break
  fi
  if [[ "$attempt" -lt 3 ]]; then
    echo "Post-deploy verification attempt ${attempt}/3 failed; retrying in 5s."
    sleep 5
  fi
done

if [[ "$health_ok" != "true" ]]; then
  echo "Post-deploy Secret or readiness verification failed; checking exact rollback eligibility." >&2
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
    echo "ERROR: Cloudflare did not verify the restored Gateway version." >&2
    exit 77
  fi
  gateway_rollback_verified=true
  echo "Cloudflare restored the previous Gateway version. New deployment failed." >&2
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
