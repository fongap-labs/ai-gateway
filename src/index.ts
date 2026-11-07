// SPDX-License-Identifier: MIT
// Backwards-compatible entrypoint: production Wrangler still points to src/index.ts.
// Runtime ownership now lives under apps/gateway.
export { default } from '../apps/gateway/index.ts';
