// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Whitelist-only evidence from the existing real Gateway acceptance checks.
// Never persist credentials, headers, prompts, raw replies or image payloads.

const SHA_RE = /^[0-9a-f]{40}$/;
const BUILD_RE = /^[0-9a-f]{7,40}$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function validExpectedSha(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}

function safeToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : null;
}

function nonnegativeInt(value, max = 1_000_000) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const stringValue = String(value);
  if (!/^\d+$/.test(stringValue)) return null;
  const numberValue = Number(stringValue);
  return Number.isSafeInteger(numberValue) && numberValue <= max ? numberValue : null;
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseCheckEvidence(line) {
  const raw = parseLine(line);
  if (!raw || raw.result !== 'PASS' || !/^[a-z][a-z0-9-]{0,64}$/.test(raw.check ?? '')) return null;
  return {
    check: raw.check,
    result: 'PASS',
    http_status: nonnegativeInt(raw.status, 599),
    duration_ms: nonnegativeInt(raw.duration_ms, 3_600_000),
    request_id: safeToken(raw.request_id),
    attempts: nonnegativeInt(raw.attempts, 10_000),
    dispatches: nonnegativeInt(raw.dispatches, 10_000),
    gateway_code: safeToken(raw.gateway_code),
    failover: raw.failover === 'true' ? true : raw.failover === 'false' ? false : null,
  };
}

export function parseFailureEvidence(line) {
  const raw = parseLine(line);
  if (!raw || raw.result !== 'FAIL' || typeof raw.message !== 'string') return null;
  // Extract only a check label, HTTP status and simple gateway code. The
  // upstream message itself must never be kept in an acceptance report.
  const match = /^([a-z][a-z0-9-]{0,64}): HTTP (\d{3}), gateway_code=([A-Za-z0-9._:-]{1,128})/.exec(raw.message);
  if (match) {
    return {
      stage: 'request',
      category: 'http_error',
      check: match[1],
      http_status: nonnegativeInt(match[2], 599),
      gateway_code: safeToken(match[3]),
    };
  }
  const label = /^([a-z][a-z0-9-]{0,64}):/.exec(raw.message);
  return { stage: 'request', category: 'assertion_or_transport', check: label?.[1] ?? null, http_status: null, gateway_code: null };
}

export function createAcceptanceReport({
  origin,
  expectedSha,
  readiness,
  startedAt,
  completedAt,
  checks,
  exitCode,
  failure,
  plannedImageCalls,
}) {
  const observedSha = typeof readiness?.build === 'string' && BUILD_RE.test(readiness.build) ? readiness.build : null;
  const versionVerified = validExpectedSha(expectedSha) && observedSha === expectedSha;
  const ready = readiness?.ready === true;
  const degraded = readiness?.degraded === true;
  const pass = exitCode === 0 && !failure && versionVerified && ready && !degraded;
  return {
    schema_version: 1,
    kind: 'ai-gateway-live-acceptance',
    started_at: startedAt,
    completed_at: completedAt,
    gateway_origin: origin,
    version: { expected_sha: expectedSha, observed_sha: observedSha, verified: versionVerified },
    readiness: { ready, degraded, status: safeToken(readiness?.status), http_status: nonnegativeInt(readiness?.httpStatus, 599) },
    result: pass ? 'PASS' : 'FAIL',
    checks,
    summary: {
      passed: checks.filter((check) => check.result === 'PASS').length,
      failed: checks.filter((check) => check.result === 'FAIL').length,
      planned_image_calls: plannedImageCalls,
      // A failed client request may still have consumed upstream image quota.
      actual_billed_image_calls: null,
    },
    failure: pass ? null : (failure ?? { stage: 'request', category: 'nonzero_exit', check: null }),
  };
}
