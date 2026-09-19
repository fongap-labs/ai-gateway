#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import { renderReadmeStatusSvg, readmeStatusSvgResponse } from '../src/dashboard/readme-status.ts';
import { preflight } from '../src/request/preflight.ts';

const svg = renderReadmeStatusSvg({
  today: 35_240_000,
  h24: 36_360_000,
  d7: 747_000_000,
  cumulative: 2_516_000_000,
  input: 2_507_000_000,
  output: 9_150_000,
  cacheHitRatio: 0.526,
  observedAt: '2026-09-18T09:00:00.000Z',
  available: true,
});

assert.match(svg, /AI Gateway/);
assert.doesNotMatch(svg, /Smart AI Gateway/);
assert.match(svg, />LIVE<\/text>/);
assert.match(svg, /35\.2M/);
assert.match(svg, /36\.4M/);
assert.match(svg, /747M/);
assert.match(svg, /2\.52B/);
assert.match(svg, /CACHE HIT/);
assert.match(svg, /52\.6%/);
assert.match(svg, />INPUT<\/text>/);
assert.match(svg, /2\.51B/);
assert.match(svg, />OUTPUT<\/text>/);
assert.match(svg, /9\.15M/);
assert.match(svg, /<g transform="translate\(28 207\)">/);
assert.match(svg, /<g transform="translate\(460 207\)">/);
assert.match(svg, /<g transform="translate\(892 207\)">/);
assert.match(svg, /<circle cx="-21" cy="-4" r="4" fill="#0f5d53"\/>/);
assert.match(svg, /<text x="-9" y="0" class="metric-label">INPUT<\/text>/);
assert.match(svg, /class="metric-value" text-anchor="middle">2\.51B<\/text>/);
assert.match(svg, /<circle cx="-55" cy="-4" r="4" fill="#7cb4a5"\/>/);
assert.match(svg, /class="metric-label" text-anchor="end">OUTPUT<\/text>/);
assert.match(svg, /class="metric-value" text-anchor="end">9\.15M<\/text>/);
assert.doesNotMatch(svg, /CACHE READ|缓存读取/i);
assert.doesNotMatch(svg, /provider.*key/i);
assert.match(svg, /Maintainer instance/);
assert.match(svg, /Observed 2026-09-18 09:00:00 UTC/);
assert.match(svg, /width="920" height="278"/);
assert.equal((svg.match(/width="212" height="100"/g) || []).length, 4);
for (const x of ['18', '242', '466', '690']) {
  assert.match(svg, new RegExp(`<g transform="translate\\(${x} 54\\)">`));
}

const degraded = await readmeStatusSvgResponse({}, Date.parse('2026-09-18T09:00:00Z'));
assert.equal(degraded.status, 200);
assert.match(degraded.headers.get('content-type') || '', /^image\/svg\+xml/);
assert.match(degraded.headers.get('cache-control') || '', /max-age=60/);
const degradedSvg = await degraded.text();
assert.match(degradedSvg, /UNAVAILABLE/);
assert.match(degradedSvg, /Live data temporarily unavailable/);
assert.equal((degradedSvg.match(/class="value">—<\/text>/g) || []).length, 4);
assert.match(degradedSvg, /class="metric-value">—<\/text>/);

const publicRoute = await preflight(
  new Request('https://gateway.example/readme-status.svg', { headers: { accept: 'image/svg+xml' } }),
  {},
  {},
);
assert.equal(publicRoute.ok, false);
assert.equal(publicRoute.response.status, 200);
assert.match(publicRoute.response.headers.get('content-type') || '', /^image\/svg\+xml/);

console.log('readme-status-test passed');
