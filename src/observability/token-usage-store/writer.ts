import { getLimits } from '../../config/timeouts.ts';
import type { GatewayEnv } from '../../types/runtime.ts';
import { normalizeUsageReport } from '../token-usage.ts';
import { bufferPersist } from './buffer.ts';
import type { UsagePayload } from './statements.ts';

function shouldSampleModel(env: GatewayEnv): boolean {
  const pct = getLimits(env).tokenD1SamplePct;
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return Math.random() * 100 < pct;
}

export function tokenUsagePayload(usage: unknown): UsagePayload {
  const report = normalizeUsageReport(usage);
  if (report) {
    const normalized = report.usage;
    return {
      input: normalized.input,
      output: normalized.output,
      cacheCreation: normalized.cacheCreation,
      cacheRead: normalized.cacheRead,
      effectiveInput: normalized.effectiveInput,
      observedCacheRead: report.observedCacheRead,
      observedCacheInput: report.observedCacheInput,
      cacheReadReports: report.hasCacheRead ? 1 : 0,
      total: normalized.total,
      requests: 1,
      reports: 1,
      missing: 0,
    };
  }
  return {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    effectiveInput: 0,
    observedCacheRead: 0,
    observedCacheInput: 0,
    cacheReadReports: 0,
    total: 0,
    requests: 1,
    reports: 0,
    missing: 1,
  };
}

export function persistTokenUsage(
  env: GatewayEnv,
  usage: unknown,
  now: number = Date.now(),
  model: string | null = null,
  ttftMs: number | null = null,
): Promise<void> {
  return bufferPersist(env, 'delivered', {
    now,
    model,
    usage: tokenUsagePayload(usage),
    ttftMs,
    exactGlobal: true,
    includeModel: model !== null && shouldSampleModel(env),
  });
}

export function persistUpstreamAttemptUsage(env: GatewayEnv, usage: unknown, now: number = Date.now(), model: string | null = null): Promise<void> {
  return bufferPersist(env, 'upstream', {
    now,
    model,
    usage: tokenUsagePayload(usage),
    exactGlobal: true,
    includeModel: model !== null && shouldSampleModel(env),
  });
}
