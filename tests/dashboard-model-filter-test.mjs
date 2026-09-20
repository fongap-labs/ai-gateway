#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import {
  filterDashboardModelStatus,
  publicModelStatus,
  renderModels,
} from '../src/dashboard/model-status-view.ts';
import {
  buildHeatmap,
  selectDashboardModelUsageRows,
  usageSection,
} from '../src/dashboard/usage-view.ts';
import { quickStartSection } from '../src/dashboard/quick-start-view.ts';
import { KEY_GROUPS } from '../src/config/access-keys.ts';
import { THEME_CSS } from '../src/dashboard/theme.ts';
import { collectVarsFromEnv } from '../scripts/github-deployment-config.mjs';

const entry = (id, status = 'available') => ({
  id,
  status,
  display_order: 100,
  group: id.startsWith('Code-') ? 'code' : 'general',
});

const envelope = {
  observed_at: '2026-09-12T00:00:00.000Z',
  models: [entry('Air'), entry('Max'), entry('Code-Pro'), entry('Code-Ultra')],
};

{
  const out = filterDashboardModelStatus(envelope, undefined);
  assert.deepEqual(out.models.map((m) => m.id), ['Air', 'Max', 'Code-Pro', 'Code-Ultra'],
    'unset variable keeps the full public catalog');
}

{
  const html = renderModels(envelope, new Map()).html;
  assert.ok(html.includes('通用模型'), 'general model group keeps its Chinese label');
  assert.ok(html.includes('编程模型'), 'code-prefixed models are presented as 编程模型');
  assert.ok(!html.includes('Code 模型'), 'mixed-language Code 模型 label is removed');
  assert.ok(html.includes('服务状态 · TTFT (24h)'), 'TTFT scope is shown once in the status-panel note');
  assert.ok(html.includes('<span>Samples</span>'), 'sample column header is shortened to Samples');
  assert.ok(!html.includes('Samples (24h)'), '24h is not repeated in the Samples column header');
}

{
  const out = filterDashboardModelStatus(envelope, '  code-pro, MAX,missing,code-pro, Code-Ultra  ');
  assert.deepEqual(out.models.map((m) => m.id), ['Code-Pro', 'Max', 'Code-Ultra'],
    'matching is case-insensitive, unknown names are ignored, duplicates are removed and configured order wins');
  assert.equal(out.observed_at, envelope.observed_at, 'status observation timestamp is preserved');
}

{
  const out = filterDashboardModelStatus(envelope, 'missing-one,missing-two');
  assert.deepEqual(out.models, [], 'a non-empty allowlist never fabricates unknown model rows');
}

{
  const out = filterDashboardModelStatus(envelope, ' , , ');
  assert.deepEqual(out.models.map((m) => m.id), ['Air', 'Max', 'Code-Pro', 'Code-Ultra'],
    'whitespace/empty CSV is treated as unset');
}

{
  const nodes = [{
    id: 'status-filter-node',
    provider: 'mock',
    tier: 'tier-1',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    base_url: 'https://status-filter.example.com/v1',
    credential: 'unused-in-status-test',
    priority: 10,
    models: {
      'Code-Ultra': 'up-ultra',
      'Code-Max': 'up-max',
      'Code-Pro': 'up-pro',
    },
  }];
  const out = publicModelStatus(nodes, { DASHBOARD_MODELS: 'code-pro,Code-Ultra' }, new Set(), 1_700_000_000_000);
  assert.deepEqual(out.models.map((m) => m.id), ['Code-Pro', 'Code-Ultra'],
    'dashboard wrapper applies the text variable after public status is computed');
}

{
  const vars = collectVarsFromEnv({ DASHBOARD_MODELS: 'Code-Ultra,Code-Max,Code-Pro' });
  assert.equal(vars.vars.DASHBOARD_MODELS, 'Code-Ultra,Code-Max,Code-Pro',
    'GitHub deployment bridge admits DASHBOARD_MODELS as a plain Worker text variable');
}

{
  const officialNames = new Map([
    ['code-pro', 'Code-Pro'],
    ['code-max', 'Code-Max'],
    ['code-ultra', 'Code-Ultra'],
    ['general-pro', 'General-Pro'],
  ]);
  const rows = [
    { model: 'code-pro', total: 325, requests: 30 },
    { model: 'code-max', total: 320, requests: 29 },
    { model: 'code-ultra', total: 60, requests: 8 },
    { model: 'general-pro', total: 52, requests: 7 },
    { model: 'glm-5.2', total: 51, requests: 6 },
    { model: 'legacy-provider-model', total: 7, requests: 1 },
  ];
  const out = selectDashboardModelUsageRows(
    rows,
    'General-Pro,Code-Ultra,Code-Max,Code-Pro',
    officialNames,
  );
  assert.deepEqual(out.map((r) => r.model), ['Code-Pro', 'Code-Max', 'Code-Ultra', '其他'],
    'usage ranks eligible DASHBOARD_MODELS by Token total and exposes only the top three');
  assert.deepEqual(out[3], { model: '其他', total: 110, requests: 14 },
    'rank 4+ and every model outside DASHBOARD_MODELS are merged into 其他');
}

{
  const now = Date.parse('2026-09-10T12:00:00+08:00');
  const daily = new Map([
    ['2026-09-10', { total: 106_000_000, requests: 876, reports: 800, missing: 76 }],
  ]);
  const { cells } = buildHeatmap(daily, now);
  const cell = cells.find((html) => html.includes('data-date="2026-09-10"'));
  assert.ok(cell, 'heatmap contains the target date');
  assert.match(cell, /876 次请求/, 'heatmap hover uses 次请求');
  assert.ok(!cell.includes('次上游调用'), 'heatmap hover no longer exposes 上游调用 wording');
}

{
  const now = Date.parse('2026-09-10T12:00:00+08:00');
  const stats = {
    summary: {
      available: true,
      today: { total: 1, requests: 1 },
      h24: { total: 1, requests: 1 },
      d7: { total: 1, requests: 1 },
      cumulative: { total: 1, requests: 1, reports: 1, missing: 0, input: 1, output: 0, cacheRead: 0, cacheHitRatio: null },
      coverage: 1,
    },
    daily: new Map(),
    modelUsage: { available: true, rows: [{ model: 'code-pro', total: 1, requests: 1 }] },
  };
  const html = await usageSection(
    { DASHBOARD_MODELS: 'Code-Pro' },
    now,
    stats,
    new Map([['code-pro', 'Code-Pro']]),
  );
  assert.match(html, /<div class="panel-title">模型使用 · 近 7 天<\/div>/, 'model usage heading carries its time window');
  assert.ok(!html.includes('模型使用 · 上游消耗'), 'old heading is removed');
  assert.match(THEME_CSS, /\.usage-detail-grid\{[^}]*grid-template-columns:/,
    'desktop usage analysis uses the new two-panel grid');
  assert.match(THEME_CSS, /@media\(max-width:1120px\)[\s\S]*?\.usage-detail-grid\{grid-template-columns:1fr\}/,
    'responsive layout stacks usage analysis panels before cards can overflow');
  assert.ok(!/section\{[^}]*border-top/.test(THEME_CSS),
    'card-based dashboard sections use whitespace instead of section divider lines');
  assert.match(THEME_CSS, /\.status-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/,
    'status cards use shrinkable grid tracks and cannot force the page wider');
  assert.ok(THEME_CSS.includes('--brand:#0f5d53') && THEME_CSS.includes('--heat-4:#0f5d53'),
    'dashboard restores the original low-saturation teal palette');
  assert.ok(!THEME_CSS.includes('.composition-layout{'),
    'composition no longer reserves an empty title column');
  assert.match(THEME_CSS, /\.composition-data\{[^}]*display:grid;gap:18px/,
    'track and all four cumulative metrics keep a deliberate gap below the composition track');
  assert.ok(!html.includes('累计 Token 构成'),
    'cumulative composition does not add a redundant visible heading');
  assert.match(THEME_CSS, /\.composition-metrics\.four-up\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/,
    'token composition uses four aligned metrics without a secondary chart');
  assert.ok(!THEME_CSS.includes('.cache-ring{'),
    'token composition no longer reserves visual weight for a cache ring');
  assert.match(THEME_CSS, /\.heatmap\{[^}]*grid-template-rows:repeat\(7,11px\)/,
    'desktop heatmap rows use the fine-tuned 11px height to align with model usage');
  assert.match(THEME_CSS, /\.model-ranking\{[^}]*gap:2px\}/,
    'model usage rows use a tighter vertical gap');
  assert.match(THEME_CSS, /\.model-rank-row\{[^}]*padding:6px 8px/,
    'model usage rows use compact vertical padding');
  assert.match(THEME_CSS, /\.model-panel \.panel-head\{margin-bottom:14px\}/,
    'model usage heading leaves less unused vertical space');
  assert.match(THEME_CSS, /@media\(max-width:760px\)[\s\S]*?\.heatmap\{grid-template-rows:repeat\(7,10px\)\}/,
    'mobile heatmap keeps the compact 10px row height');
  assert.match(THEME_CSS, /@media\(min-width:761px\) and \(max-height:900px\)[\s\S]*?\.stat\{min-height:88px/,
    'short desktop viewports compact the first fold so all four Token KPIs remain visible');
}

{
  const html = quickStartSection('https://gateway.example.com/v1');
  assert.ok(!html.includes('GATEWAY_KEY_AIR'), 'quick start must not imply AIR is the only usable key');
  assert.ok(html.includes('GATEWAY_API_KEY'), 'quick start uses a generic client-side gateway key variable');
  assert.ok(html.includes(KEY_GROUPS.join(' / ')), 'quick start key-group list comes from the shared key registry');
}

console.log('dashboard model filter tests passed.');
