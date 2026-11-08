// SPDX-License-Identifier: MIT
// Operational token statistics maintenance, intentionally separate from
// the gateway API execution entrypoint.
import type { GatewayEnv } from '../../packages/contracts/runtime.ts';
import { maintainUsageStats } from '../../src/observability/token-usage-store.ts';

export async function runUsageMaintenance(env: GatewayEnv): Promise<void> {
  await maintainUsageStats(env);
}
