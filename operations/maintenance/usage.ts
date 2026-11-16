import type { GatewayEnv } from '../../packages/contracts/runtime.ts';
import { maintainUsageStats } from './retention.ts';

export async function runUsageMaintenance(env: GatewayEnv): Promise<void> {
  await maintainUsageStats(env);
}
