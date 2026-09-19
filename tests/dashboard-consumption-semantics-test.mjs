#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadUpstreamDaily } from '../src/observability/token-usage-store.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

{
  const now = Date.parse('2026-09-10T12:00:00+08:00');
  const d1 = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('token_usage_daily')) {
                return { results: [{
                  day: '2026-09-01',
                  upstream_total_tokens: 1_000,
                  requests: 7,
                  upstream_attempts: 99,
                  upstream_usage_reports: 5,
                  upstream_usage_missing: 2,
                }] };
              }
              return { results: [{
                hour: '2026-09-10T04:00:00.000Z',
                upstream_total_tokens: 2_000,
                requests: 8,
                upstream_attempts: 88,
                upstream_usage_reports: 6,
                upstream_usage_missing: 2,
              }] };
            },
          };
        },
      };
    },
  };

  const series = await loadUpstreamDaily({ TOKEN_STATS_DB: d1 }, '2026-09-01', now);
  assert.ok(series instanceof Map);
  assert.equal(series.get('2026-09-01')?.total, 1_000, 'historical Token total stays on physical upstream consumption');
  assert.equal(series.get('2026-09-01')?.requests, 7, 'historical request count uses delivered responses, not upstream attempts');
  assert.equal(series.get('2026-09-10')?.total, 2_000, 'recent Token total stays on physical upstream consumption');
  assert.equal(series.get('2026-09-10')?.requests, 8, 'recent request count uses delivered responses, not upstream attempts');
}

{
  const source = fs.readFileSync(join(root, 'src', 'dashboard', 'pages.ts'), 'utf8');
  assert.ok(source.includes("viewBox='0 0 48 48'"),
    'favicon uses a compact square canvas for the AI Gateway mark');
  assert.ok(!source.includes('<text'), 'favicon must not depend on a font glyph');
  assert.ok(source.includes("stroke='%230f5d53'") && source.includes("d='M7 37L24 5L41 37Q33 40 24 31Q15 40 7 37Z'"),
    'favicon uses the original teal palette and one uninterrupted triangle-convergence mark');
  assert.ok(!source.includes('M17.5 20H30.5'),
    'logo does not rely on an A crossbar');
  assert.ok(!source.includes("preserveAspectRatio='none'"), 'favicon must not stretch the logo');
  assert.ok(source.includes('One endpoint. Built for upstream change.'),
    'brand slogan stays in the compact header instead of a hero block');
  assert.ok(!source.includes('一个入口，应对所有变化'),
    'the old marketing hero copy is removed from the public dashboard');
  assert.ok(source.includes('href="https://i.135468.xyz/"') && source.includes('>Fongap Labs</a>'),
    'footer brand link points to i.135468.xyz');
}

console.log('dashboard consumption semantics tests passed.');
