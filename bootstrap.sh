#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="${1:-}"
BOOTSTRAP_REF="${2:-}"
REQUEST_ID="${3:-}"

fail() {
  echo "[ai-gateway-task] FAIL  $*" >&2
  exit 1
}

[[ "${PROJECT}" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "invalid project"
[[ "${BOOTSTRAP_REF}" =~ ^[0-9a-f]{40}$ ]] || fail "invalid bootstrap ref"
[[ -n "${AW_SOURCE_DIR:-}" && -d "${AW_SOURCE_DIR}" ]] || fail "AW_SOURCE_DIR is unavailable"

resolved_sha="$(git -C "${AW_SOURCE_DIR}" rev-parse HEAD)"
[[ "${resolved_sha}" == "${BOOTSTRAP_REF}" ]] || fail "task source SHA mismatch"

task_file="${AW_SOURCE_DIR}/projects/${PROJECT}/task.json"
[[ -f "${task_file}" ]] || fail "task contract not found: projects/${PROJECT}/task.json"

entrypoint="$(jq -er '.entrypoint | strings | select(length > 0)' "${task_file}")"   || fail "task entrypoint is required"

[[ "${entrypoint}" =~ ^projects/[A-Za-z0-9_.-]+/[A-Za-z0-9._/-]+$ ]]   || fail "task entrypoint is invalid"
[[ "${entrypoint}" != *".."* ]] || fail "task entrypoint may not traverse directories"
[[ "${entrypoint}" == "projects/${PROJECT}/"* ]] || fail "task entrypoint must stay inside the selected project"

script="${AW_SOURCE_DIR}/${entrypoint}"
[[ -f "${script}" ]] || fail "task entrypoint not found: ${entrypoint}"

echo "[ai-gateway-task] project=${PROJECT} request=${REQUEST_ID:-unknown} ref=${BOOTSTRAP_REF}"
exec bash "${script}"
