// SPDX-License-Identifier: MIT
// Compatibility export for central contract tests. The private preflight
// transport is owned by Gateway; never reintroduce a second implementation.
export { checkInferenceConversion } from '../../apps/gateway/transport/inference-preflight-client.ts';
