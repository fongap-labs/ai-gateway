#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${AW_SOURCE_DIR:?AW_SOURCE_DIR is required}"
STATE_ROOT="${AW_TASK_STATE_DIR:?AW_TASK_STATE_DIR is required}"
PREVIOUS_DIR="${STATE_ROOT}/previous"
CURRENT_DIR="${STATE_ROOT}/current"

cd "${ROOT}"
npm ci

node_count=0
credential_count=0
while IFS='=' read -r name value; do
  case "${name}" in
    AIG_TIER*_NODES_*)
      [[ -n "${value}" ]] && node_count=$((node_count + 1))
      ;;
    AIG_TIER*_CREDENTIALS_*)
      [[ -n "${value}" ]] && credential_count=$((credential_count + 1))
      ;;
  esac
done < <(env)

{
  echo "## Model Discovery readiness"
  echo
  echo "- Configured node shards: ${node_count}"
  echo "- Configured credential shards: ${credential_count}"
} >> "${GITHUB_STEP_SUMMARY}"

if [[ "${node_count}" -eq 0 || "${credential_count}" -eq 0 ]]; then
  echo "- Central execution ready: false" >> "${GITHUB_STEP_SUMMARY}"
  echo "Model Discovery skipped because no usable provider configuration is available."
  exit 0
fi

echo "- Central execution ready: true" >> "${GITHUB_STEP_SUMMARY}"

mkdir -p "${PREVIOUS_DIR}" "${CURRENT_DIR}"
previous_file="${PREVIOUS_DIR}/current-models.json"
if [[ ! -f "${previous_file}" ]]; then
  printf '%s
' '{"schema_version":1,"generated_at":null,"nodes":[]}' > "${PREVIOUS_DIR}/current-models.json"
fi

node scripts/provider-discovery.mjs live   --previous "${PREVIOUS_DIR}/current-models.json"   --out-dir "${CURRENT_DIR}"

if [[ -f "${CURRENT_DIR}/changes.md" ]]; then
  cat "${CURRENT_DIR}/changes.md" >> "${GITHUB_STEP_SUMMARY}"
fi
