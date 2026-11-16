#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
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

node scripts/private-center-config.mjs preflight
node scripts/persistent-deployment.mjs preflight
node scripts/persistent-deployment.mjs prepare \
  --wrangler "$RUNNER_TEMP/wrangler.github.json" \
  --summary "$RUNNER_TEMP/deployment-summary.txt"

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

read_gateway_secret_names
node scripts/persistent-deployment.mjs check-secret-source \
  --file "$RUNNER_TEMP/worker-secrets.json" --wrangler "$RUNNER_TEMP/wrangler.github.json"

sync_runtime_secrets preflight

node scripts/deployment-recovery.mjs snapshot "$recovery_evidence"

for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  center_update_attempted+=("$center")
  node scripts/cloudflare-wrangler.mjs deploy \
    --message "action-worker:center:$center:$DEPLOY_SOURCE_SHA" \
    --config "$config"
done

sync_runtime_secrets reconcile

for center in ai-inference-center ai-perception-center ai-generation-center; do
  config="$RUNNER_TEMP/private-center-$center.json"
  manifest="$RUNNER_TEMP/private-center-$center-manifest.json"
  inventory="$RUNNER_TEMP/private-center-$center-inventory.json"
  node scripts/cloudflare-wrangler.mjs secret list \
    --format json --config "$config" > "$inventory"
  node scripts/private-center-config.mjs verify-inventory \
    --worker "$center" --inventory "$inventory" --manifest "$manifest"
done

read_gateway_secret_names
node scripts/persistent-deployment.mjs prepare-publish \
  --file "$RUNNER_TEMP/worker-secrets.json" --wrangler "$RUNNER_TEMP/wrangler.github.json"

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

node scripts/deployment-recovery.mjs verify-published "$recovery_evidence"

if [[ -f "$RUNNER_TEMP/deployment-summary.txt" ]]; then
  {
    echo "## AI Gateway deployment"
    echo
    cat "$RUNNER_TEMP/deployment-summary.txt"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "AI Gateway deployment completed: $DEPLOYED_SHA"
