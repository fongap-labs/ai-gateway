#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
const ok = (label) => { passed++; console.log(`ok - ${label}`); };

const DOCS = [
  'README.md', 'README.zh-CN.md', 'SECURITY.md', 'scripts/README.md',
  'docs/architecture/overview.md',
  'docs/architecture/protocol-model.md',
  'docs/architecture/routing-model.md',
  'docs/architecture/reliability-model.md',
  'docs/architecture/repository-layout.md',
  'docs/architecture/module-boundary-audit.md',
  'docs/architecture/calendar-heatmap.md',
  'docs/operations/configuration.md',
  'docs/operations/deployment.md',
  'docs/operations/public-model-status.md',
  'docs/operations/troubleshooting.md',
];

const PROTOCOL_FACT_FILES = [
  'README.md', 'README.zh-CN.md',
  'docs/architecture/protocol-model.md',
  'docs/architecture/routing-model.md',
  'docs/operations/configuration.md',
  '.dev.vars.example', 'config/worker-vars.example.json',
];
for (const file of PROTOCOL_FACT_FILES) {
  const text = read(file);
  assert.doesNotMatch(text, /Responses\s*(?:→|->)\s*Anthropic/i, `${file}: Responses must remain Native Only`);
  assert.doesNotMatch(text, /three-way|三向/i, `${file}: no three-way protocol fallback`);
  assert.doesNotMatch(text, /"openai:responses"\s*:\s*\["anthropic:messages"\]/, `${file}: invalid Responses fallback`);
  ok(`${file} protocol contract`);
}

for (const file of ['.dev.vars.example', 'config/worker-vars.example.json']) {
  const text = read(file);
  assert.match(text, /anthropic:messages[\s\S]{0,180}openai:chat_completions/);
  assert.match(text, /openai:chat_completions[\s\S]{0,180}anthropic:messages/);
  ok(`${file} bidirectional Chat/Messages fallback`);
}

const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'base_url', 'priority', 'models']);
const workerVars = JSON.parse(read('config/worker-vars.example.json'));
for (const [key, nodes] of Object.entries(workerVars)) {
  if (!/^TIER[123]_NODES_\d{2}$/.test(key)) continue;
  assert.ok(Array.isArray(nodes), `${key} example must be an array`);
  for (const node of nodes) {
    const unknown = Object.keys(node).filter((field) => !ALLOWED_NODE_FIELDS.has(field));
    assert.deepEqual(unknown, [], `${key}: example node contains retired/unknown fields: ${unknown.join(', ')}`);
    for (const required of ['id', 'provider', 'base_url', 'models']) {
      assert.ok(Object.hasOwn(node, required), `${key}: example node missing ${required}`);
    }
  }
}
ok('worker vars node examples match the current account-level schema');

const devVarsText = read('.dev.vars.example');
assert.doesNotMatch(devVarsText, /"protocol"\s*:/, '.dev.vars.example must not put protocol in node JSON');
assert.doesNotMatch(devVarsText, /"surfaces"\s*:/, '.dev.vars.example must not put surfaces in node JSON');
assert.match(devVarsText, /Required per node:\s*id, provider, base_url, models/i);
ok('.dev.vars.example node examples match the current account-level schema');

const ACCESS_FACT_FILES = [
  'README.md', 'README.zh-CN.md', 'SECURITY.md',
  'docs/operations/configuration.md', 'docs/operations/deployment.md',
  '.dev.vars.example', 'config/access-keys.example.json',
];
const GROUP_KEY = /AIG_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT|<GROUP>|\{AIR,PRO,MAX,ULTRA,AGENT\})/;
const GROUP_MODELS = /AIG_ACCESS_MODELS_(?:AIR|PRO|MAX|ULTRA|AGENT|<GROUP>|\{AIR,PRO,MAX,ULTRA,AGENT\})/;
for (const file of ACCESS_FACT_FILES) {
  const text = read(file);
  assert.match(text, GROUP_KEY, `${file}: grouped access key required`);
  assert.match(text, GROUP_MODELS, `${file}: grouped model allowlist required`);
  ok(`${file} grouped access model`);
}

const SHARD_FACT_FILES = [
  'README.md', 'README.zh-CN.md', 'SECURITY.md',
  'docs/architecture/routing-model.md',
  'docs/operations/configuration.md', 'docs/operations/deployment.md', '.dev.vars.example',
];
for (const file of SHARD_FACT_FILES) {
  const text = read(file);
  assert.match(text, /independent|independently|not by matching|无需.*对应|不按.*后缀|Tier\s*\+\s*node id/i,
    `${file}: must state independent Config/Secret shard binding`);
  assert.doesNotMatch(text, /(?:must|should|required to|需要|必须)[^\n]{0,80}(?:paired\s*1:1|matching\s+(?:config\s+)?shard|matching\s+suffix|一一对应|1:1\s*配对)/i,
    `${file}: must not instruct operators to pair Config/Secret suffixes`);
  ok(`${file} independent shard suffixes`);
}

const routing = read('docs/architecture/routing-model.md');
assert.match(routing, /Tier 1 has no independent attempt cap/i);
assert.match(routing, /Node `limits`[^\n]*not part of the account schema/i);
assert.match(routing, /`max_attempts` is the request-wide hard ceiling/i);
assert.match(routing, /There is exactly one cross-tier allocation model/i);
assert.match(routing, /There is no `budget_split`, weighted allocation, or alternate cross-tier budget mode/i);
assert.doesNotMatch(routing, /request priority/i, 'retired access-group request-priority scoring must stay absent');
assert.match(routing, /access groups only authorize logical models/i);
assert.doesNotMatch(routing, /historical config|migration-time runtime interpretation/i);
ok('routing docs use one current attempt-allocation and scoring contract');

const reliability = read('docs/architecture/reliability-model.md');
assert.doesNotMatch(reliability, /request priority/i, 'reliability docs must not restore retired request-priority scoring');
assert.match(reliability, /Gateway access groups authorize logical models but do not add a Tier 1 score factor/i);
ok('reliability docs match current Tier 1 score inputs');

const config = read('docs/operations/configuration.md');
assert.match(config, /Required fields:[\s\S]{0,160}id[\s\S]{0,80}provider[\s\S]{0,80}base_url[\s\S]{0,80}models/i,
  'configuration docs must show the small account-level node schema');
assert.match(config, /Provider wire profiles/i);
assert.match(config, /`protocol`, `surfaces`, `limits`[^\n]*rejected/i,
  'protocol/surfaces/limits must not return to per-node config');
assert.match(config, /provider:\s*"anthropic"[\s\S]{0,100}messages/i);
assert.match(config, /provider:\s*"openai"[\s\S]{0,120}responses/i);
assert.match(config, /`budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema/i);
assert.doesNotMatch(config, /protocol` is required|surfaces` is required|budget_split"\s*:/i);
assert.match(config, /public `次请求` counts successfully delivered requests/i);
ok('configuration docs match provider-owned wire and dashboard accounting contracts');

const publicStatus = read('docs/operations/public-model-status.md');
for (const state of ['available', 'fluctuating', 'no_recent', 'no_record', 'down']) {
  assert.match(publicStatus, new RegExp('`' + state + '`'), `public status docs must include ${state}`);
}
assert.match(publicStatus, /P50[^\n]*at least 5/i);
assert.match(publicStatus, /P95[^\n]*at least 20/i);
assert.match(publicStatus, /successful_ttft_count/i);
assert.doesNotMatch(publicStatus, /must not expose:[\s\S]{0,200}- TTFT values/i,
  'model-level TTFT aggregates are now an intentional public dashboard surface');
ok('public model status docs match five-state and TTFT dashboard surface');

const troubleshooting = read('docs/operations/troubleshooting.md');
assert.doesNotMatch(troubleshooting, /\/version\b/);
assert.match(troubleshooting, /There is no node `limits\.rpm`, `rpm_mode`/i,
  'retired node RPM fields may only appear as an explicit negative statement');
assert.doesNotMatch(troubleshooting, /(?:check|inspect|configure|set)[^\n]{0,100}(?:limits\.rpm|rpm_mode)/i,
  'troubleshooting must not instruct operators to use retired node RPM fields');
assert.match(troubleshooting, /provider:\s*"openai"/i);
assert.match(troubleshooting, /Access-key groups[^\n]*do not assign Tier 1 scheduler priority/i);
ok('troubleshooting docs contain no retired operational instructions');

const toolingReadme = read('scripts/README.md');
assert.doesNotMatch(toolingReadme, /version:sync|Version synchronization|version-check\.mjs/i,
  'tooling docs must not restore retired project-version automation');
ok('tooling docs contain no retired version automation');

const moduleAudit = read('docs/architecture/module-boundary-audit.md');
assert.match(moduleAudit, /Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390`/);
assert.match(moduleAudit, /All material P1\/P2 ownership findings[\s\S]{0,120}resolved/i);
assert.match(moduleAudit, /Tier 1 ownership/i);
assert.match(moduleAudit, /request\/attempt\/success\.ts/i);
assert.match(moduleAudit, /Automatic cooldown jitter/i);
assert.match(moduleAudit, /no universal IR/i);
ok('module boundary audit pins baseline, resolved ownership, and anti-over-abstraction guardrails');

const calendar = read('docs/architecture/calendar-heatmap.md');
assert.match(calendar, /`total` is physical upstream Token consumption/i);
assert.match(calendar, /`requests` is \*\*successfully delivered requests\*\*/i);
assert.doesNotMatch(calendar, /`scripts\/calendar-heatmap|`scripts\/token-usage-test/,
  'calendar docs must point to tests/, not retired scripts/ test locations');
ok('calendar docs match usage semantics and current test layout');

for (const file of DOCS) {
  const text = read(file);
  assert.doesNotMatch(text, /RESPONSES_REASONING_MODE|ANTHROPIC_REASONING_REQUEST_MODE/, `${file}: removed knobs must stay absent`);
  assert.doesNotMatch(text, /max_attempts[^\n]{0,80}\bphysical\b/i, `${file}: max_attempts is logical`);
  assert.doesNotMatch(text, /CHANGELOG\.md|version-policy\.md|\/version\b/i, `${file}: project release/version surface must stay absent`);
  ok(`${file} has no retired contract surface`);
}

const deployYml = read('.github/workflows/deploy.yml');
const { RUNTIME_VAR_NAMES, RUNTIME_TUNABLES } = await import('../src/config/runtime-vars.ts');
assert.match(deployYml, /run-ai-gateway-deploy/);
assert.match(deployYml, /AW_DISPATCH_TOKEN/);
assert.match(deployYml, /source_repository/);
assert.match(deployYml, /source_sha/);
for (const name of RUNTIME_VAR_NAMES) {
  assert.equal(deployYml.includes(`${name}:`), false, `business deploy bridge must not inject ${name}`);
}
ok(`deploy.yml keeps all ${RUNTIME_VAR_NAMES.length} runtime variables in the central deploy owner`);

const devVars = read('.dev.vars.example');
assert.match(devVars, /Defaults live in src\/config\/runtime-vars\.ts/i,
  '.dev.vars.example must point operators to runtime-vars.ts for defaults');
for (const tunable of RUNTIME_TUNABLES) {
  assert.ok(devVars.includes(tunable.name), `.dev.vars.example must mention ${tunable.name}`);
}
ok('.dev.vars.example references every current tunable and keeps defaults single-sourced');

assert.match(routing, /Tier 1:[^\n]*Eligibility → Affinity → P2C/i);
assert.doesNotMatch(routing, /Same tier \+ same priority = LRU rotation/i);
ok('Tier 1 docs remain Affinity → P2C');

console.log(`\ndocs contract tests passed (${passed}).`);
