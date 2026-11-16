import type { GatewayEnv } from '../packages/contracts/runtime.ts';
import { runUsageMaintenance } from './maintenance/usage.ts';

export async function scheduled(_controller: unknown, env: GatewayEnv): Promise<void> {
  await runUsageMaintenance(env);
}

export default { scheduled };
