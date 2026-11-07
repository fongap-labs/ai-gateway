// SPDX-License-Identifier: MIT
// Stable compatibility import while Gateway owns authorization preflight.

export type { PreflightOk, PreflightResult, PreflightTerminal } from '../../apps/gateway/preflight.ts';
export { getRouteProtocolSurface, preflight } from '../../apps/gateway/preflight.ts';
