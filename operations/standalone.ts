import type { GatewayEnv } from '../packages/contracts/runtime.ts';
import { scheduled as runScheduledMaintenance } from './index.ts';

export async function scheduled(controller: unknown, env: GatewayEnv): Promise<void> {
  if (!env.TOKEN_STATS_DB || typeof env.TOKEN_STATS_DB.prepare !== 'function') {
    throw new Error('Operations Worker requires private TOKEN_STATS_DB D1 binding.');
  }
  await runScheduledMaintenance(controller, env);
}

export default { scheduled };
