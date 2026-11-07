// SPDX-License-Identifier: MIT
// Cloudflare-compatible composition root. Gateway owns requests;
// operations owns scheduled usage maintenance, outside the Gateway app.
import gateway from '../apps/gateway/index.ts';
import { runUsageMaintenance } from '../operations/maintenance/usage.ts';
import type { GatewayEnv } from './types/runtime.ts';

export default {
  fetch: gateway.fetch,
  async scheduled(_controller: unknown, env: GatewayEnv): Promise<void> {
    await runUsageMaintenance(env);
  },
};
