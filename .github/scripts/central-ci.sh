#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
if [ -z "$TARGET_ROOT" ] || [ ! -d "$TARGET_ROOT" ]; then
  echo "central-ci: target root is required" >&2
  exit 64
fi

cd "$TARGET_ROOT"

npm ci
npm run validate:merge
npm run check:deploy

if [ "${CENTRAL_CI_PR_NUMBER:-0}" = "0" ]; then
  npm run validate:deploy
fi
