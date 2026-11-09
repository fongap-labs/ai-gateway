// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Dedicated Operations Worker entrypoint. Never export a public fetch route.
// Fail closed if maintenance storage was not bound during a controlled cutover.
import type { GatewayEnv } from '../packages/contracts/runtime.ts';
import { scheduled as runScheduledMaintenance } from './index.ts';

export async function scheduled(controller: unknown, env: GatewayEnv): Promise<void> {
  if (!env.TOKEN_STATS_DB || typeof env.TOKEN_STATS_DB.prepare !== 'function') {
    throw new Error('Operations Worker requires private TOKEN_STATS_DB D1 binding.');
  }
  await runScheduledMaintenance(controller, env);
}

export default { scheduled };
