#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activateOperationsCron,
  classifyCronOwnership,
  createCloudflareCronClient,
  deactivateOperationsCron,
  MAINTENANCE_CRON,
  readCronSnapshot,
} from './operations-cron-control.mjs';

const cron = [MAINTENANCE_CRON];
const copied = (value) => structuredClone(value);
function localClient(initial) {
  const state = copied(initial);
  const writes = [];
  return {
    state,
    writes,
    async read(name) {
      return copied(state[name === 'ai-gateway' ? 'gateway' : 'operations']);
    },
    async writeOperations(next) {
      writes.push(copied(next));
      state.operations = copied(next);
    },
  };
}

assert.equal(classifyCronOwnership({ gateway: cron, operations: [] }), 'prepare');
assert.equal(classifyCronOwnership({ gateway: [], operations: [] }), 'detach');
assert.equal(classifyCronOwnership({ gateway: [], operations: cron }), 'activate');
assert.throws(() => classifyCronOwnership({ gateway: cron, operations: cron }), /overlapping/);
assert.throws(() => classifyCronOwnership({ gateway: ['* * * * *'], operations: [] }), /Unexpected/);
assert.throws(() => classifyCronOwnership({ gateway: [], operations: [MAINTENANCE_CRON, MAINTENANCE_CRON] }), /Invalid/);

const prepared = localClient({ gateway: cron, operations: [] });
assert.equal(await readCronSnapshot(prepared).then(classifyCronOwnership), 'prepare');
await assert.rejects(activateOperationsCron(prepared), /Gateway Cron must be detached/);
assert.equal(prepared.writes.length, 0);

const detached = localClient({ gateway: [], operations: [] });
assert.equal(await activateOperationsCron(detached), 'activated');
assert.deepEqual(detached.writes, [cron]);
assert.equal(classifyCronOwnership(detached.state), 'activate');
assert.equal(await activateOperationsCron(detached), 'already-active');
assert.deepEqual(detached.writes, [cron]);
assert.equal(await deactivateOperationsCron(detached), 'disabled');
assert.deepEqual(detached.writes, [cron, []]);
assert.equal(await deactivateOperationsCron(detached), 'already-disabled');

const duplicateOwner = localClient({ gateway: cron, operations: cron });
assert.equal(await deactivateOperationsCron(duplicateOwner), 'disabled');
assert.deepEqual(duplicateOwner.state, { gateway: cron, operations: [] });
const unknown = localClient({ gateway: ['* * * * *'], operations: cron });
await assert.rejects(deactivateOperationsCron(unknown), /unexpected Cron/);
assert.equal(unknown.writes.length, 0);

const race = localClient({ gateway: [], operations: [] });
const originalWrite = race.writeOperations;
race.writeOperations = async (schedules) => {
  await originalWrite(schedules);
  if (schedules.length === 1) race.state.gateway = copied(cron);
};
await assert.rejects(activateOperationsCron(race), /verify both live schedules/);
assert.deepEqual(race.writes, [cron, []]);
assert.deepEqual(race.state.operations, []);

const failedUpdate = localClient({ gateway: [], operations: [] });
failedUpdate.writeOperations = async () => {
  throw new Error('Cloudflare response contained a secret that must not leak');
};
await assert.rejects(activateOperationsCron(failedUpdate), /verify both live schedules/);

assert.throws(() => createCloudflareCronClient({ accountId: 'not-an-id', token: 'test-token-value' }), /credentials/);

const accountId = 'a'.repeat(32);
const token = 'integration-test-token-for-mock';
const calls = [];
const mockFetch = async (url, opts) => {
  calls.push({ url, method: opts.method, body: opts.body, auth: opts.headers.authorization });
  const schedule = opts.method === 'PUT' ? JSON.parse(opts.body).map((v) => v.cron) : [];
  return new Response(JSON.stringify({ success: true, result: { schedules: schedule.map((v) => ({ cron: v })) } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const api = createCloudflareCronClient({ accountId, token, fetchImpl: mockFetch });
assert.deepEqual(await api.read('ai-gateway'), []);
assert.deepEqual(await api.writeOperations(cron), cron);
assert.deepEqual(await api.writeOperations([]), []);
assert.equal(calls.length, 3);
assert.ok(calls.every((c) => c.url.includes(`/accounts/${accountId}/workers/scripts/`)));
assert.ok(calls.every((c) => c.auth === `Bearer ${token}`));
assert.deepEqual(JSON.parse(calls[1].body), [{ cron: MAINTENANCE_CRON }]);
await assert.rejects(api.writeOperations(['* * * * *']), /approved Operations schedule/);
await assert.rejects(api.read('other-worker'), /Unknown Worker/);

const invalidApi = createCloudflareCronClient({
  accountId,
  token,
  fetchImpl: async () => new Response(JSON.stringify({ success: false, result: { schedules: [] } }), { status: 200 }),
});
await assert.rejects(invalidApi.read('ai-gateway'), /response was invalid/);
const forbiddenApi = createCloudflareCronClient({
  accountId,
  token,
  fetchImpl: async () => new Response('sensitive response body', { status: 403 }),
});
await assert.rejects(forbiddenApi.read('ai-gateway'), /schedule read or update failed/);

const source = readFileSync(new URL('./operations-cron-control.mjs', import.meta.url), 'utf8');
assert.match(source, /AIG_OPERATIONS_CRON_APPROVED/);
assert.match(source, /assertReleaseTopology\(plan\)/);
assert.match(source, /DEPLOY_SOURCE_SHA/);
assert.match(source, /readCronSnapshot\(client\)/);
assert.match(source, /writeOperations\(\[\]\)/);

console.log('Operations Cron handoff contract passed: read-only inspection, guarded activation, emergency reversal and race recovery.');
