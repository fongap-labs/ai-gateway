import gateway from '../apps/gateway/index.ts';
import operations from '../operations/index.ts';

export default {
  fetch: gateway.fetch,
  scheduled: operations.scheduled,
};
