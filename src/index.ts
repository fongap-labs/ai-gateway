// SPDX-License-Identifier: MIT
// Cloudflare-compatible composition root. Independent Gateway and Operations
// applications own their handlers; this file only preserves the deployed
// composition until their build and deployment units are independently selected.
import gateway from '../apps/gateway/index.ts';
import operations from '../operations/index.ts';

export default {
  fetch: gateway.fetch,
  scheduled: operations.scheduled,
};
