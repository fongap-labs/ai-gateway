// SPDX-License-Identifier: MIT
// Compatibility import while callers migrate to Gateway-owned private transport.
// The implementation lives in apps/gateway, never in the Inference Center.
export * from '../../apps/gateway/transport/inference-client-request.ts';
