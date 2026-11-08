// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Operations-owned scheduled entrypoint. The Gateway application only owns
// public request handling; this handler may later be deployed independently.
import type { GatewayEnv } from '../packages/contracts/runtime.ts';
import { runUsageMaintenance } from './maintenance/usage.ts';

export async function scheduled(_controller: unknown, env: GatewayEnv): Promise<void> {
  await runUsageMaintenance(env);
}

export default { scheduled };
