#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Deployment-only native Cloudflare tracing. Missing input preserves the
// existing logs-only configuration. No runtime Worker variable or new Secret.
export function applyNativeTraceSampling(observability, raw, exportDestination = '') {
  const destination = exportDestination ?? '';
  if (destination !== '' && (typeof destination !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(destination))) {
    throw new Error('AIG_TRACE_EXPORT_DESTINATION must name one configured Cloudflare OTel destination.');
  }
  if (raw === undefined || raw === null || raw === '') {
    if (destination) throw new Error('AIG_TRACE_EXPORT_DESTINATION requires an explicit positive AIG_TRACE_HEAD_SAMPLE_RATE.');
    return observability;
  }
  if (typeof raw !== 'string') throw new Error('AIG_TRACE_HEAD_SAMPLE_RATE must be a decimal between 0 and 1.');
  const value = raw.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    throw new Error('AIG_TRACE_HEAD_SAMPLE_RATE must be a decimal between 0 and 1.');
  }
  const rate = Number(value);
  if (destination && rate === 0) throw new Error('AIG_TRACE_EXPORT_DESTINATION requires positive sampling.');
  return {
    ...observability,
    traces:
      rate === 0
        ? { enabled: false }
        : { enabled: true, head_sampling_rate: rate, ...(destination ? { destinations: [destination] } : {}) },
  };
}
