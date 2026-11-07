// SPDX-License-Identifier: MIT
// Operational token statistics maintenance, intentionally separate from
// the gateway API execution entrypoint.
import { maintainUsageStats } from '../../src/observability/token-usage-store.ts';
import type { GatewayEnv } from '../../src/types/runtime.ts';

export async function runUsageMaintenance(env: GatewayEnv): Promise<void> {
  await maintainUsageStats(env);
}
