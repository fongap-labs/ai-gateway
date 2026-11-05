#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "${DEPLOY_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Private inference deployment requires a verified full commit SHA." >&2
  exit 64
}
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" ]] || {
  echo "Protected deployment runner directory is missing." >&2
  exit 77
}

config="$RUNNER_TEMP/inference-center.wrangler.json"
secrets="$RUNNER_TEMP/inference-center.secrets.json"
cleanup() {
  rm -f -- "$config" "$secrets"
}
trap cleanup EXIT

npm ci
npm run validate:deploy
npm run check:inference
node scripts/inference-center-deployment.mjs prepare --config "$config" --secrets "$secrets"
node scripts/cloudflare-wrangler.mjs deploy --secrets-file "$secrets" -c "$config"
echo "Private inference center deployed from $DEPLOY_SOURCE_SHA; gateway traffic unchanged."
