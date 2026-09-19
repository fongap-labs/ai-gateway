// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { getCachedDashboardStats } from './usage-view.ts';
import type { GatewayEnv } from '../types/runtime.ts';

type LiveStatusData = {
  today: number,
  h24: number,
  d7: number,
  cumulative: number,
  input: number,
  output: number,
  cacheHitRatio: number | null,
  observedAt: string,
  available: boolean,
};

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [base, suffix] of units) {
    if (value >= base) {
      const scaled = value / base;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${Number(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.trunc(value));
}

function compactPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  return `${Math.min(100, value * 100).toFixed(1)}%`;
}

export function renderReadmeStatusSvg(data: LiveStatusData): string {
  const values = data.available
    ? [data.today, data.h24, data.d7, data.cumulative].map(compactTokens)
    : ['—', '—', '—', '—'];
  const labels = ['TODAY', '24 HOURS', '7 DAYS', 'ALL TIME'];
  const status = data.available ? 'LIVE' : 'UNAVAILABLE';
  const statusColor = data.available ? '#0f5d53' : '#777777';
  const cacheHit = data.available ? compactPercent(data.cacheHitRatio) : '—';
  const input = data.available ? compactTokens(data.input) : '—';
  const output = data.available ? compactTokens(data.output) : '—';
  const observed = data.available && data.observedAt
    ? `Observed ${data.observedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`
    : 'Live data temporarily unavailable';

  const cards = values.map((value, index) => {
    const x = 18 + index * 224;
    return `<g transform="translate(${x} 54)">
      <rect x="0" y="0" width="212" height="100" rx="14" fill="#ffffff" stroke="#e7e9e5"/>
      <text x="20" y="29" class="label">${labels[index]}</text>
      <text x="20" y="73" class="value">${value}</text>
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="278" viewBox="0 0 920 278" role="img" aria-labelledby="title desc">
  <title id="title">AI Gateway live production usage</title>
  <desc id="desc">Near-live production token usage from the maintainer deployment.</desc>
  <style>
    text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .title{font-size:19px;font-weight:700;fill:#17211f;letter-spacing:.2px}
    .label{font-size:11px;font-weight:600;letter-spacing:.8px;fill:#8b928f}
    .value{font-size:30px;font-weight:650;fill:#17211f}
    .metric-label{font-size:11px;font-weight:600;letter-spacing:.7px;fill:#8b928f}
    .metric-value{font-size:22px;font-weight:650;fill:#17211f}
    .foot{font-size:11px;fill:#7a817f}
    .status{font-size:11px;font-weight:700;letter-spacing:.8px}
  </style>
  <rect x="0.5" y="0.5" width="919" height="277" rx="18" fill="#f8f7f3" stroke="#e7e9e5"/>
  <text x="24" y="32" class="title">AI Gateway</text>
  <circle cx="842" cy="27" r="4" fill="${statusColor}"/>
  <text x="896" y="27" class="status" fill="${statusColor}" text-anchor="end" dominant-baseline="middle">${status}</text>
  ${cards}
  <rect x="28" y="176" width="864" height="6" rx="3" fill="#0f5d53"/>
  <g transform="translate(28 207)">
    <text x="0" y="0" class="metric-label">CACHE HIT</text>
    <text x="0" y="30" class="metric-value">${cacheHit}</text>
  </g>
  <g transform="translate(460 207)">
    <circle cx="-21" cy="-4" r="4" fill="#0f5d53"/>
    <text x="-9" y="0" class="metric-label">INPUT</text>
    <text x="0" y="30" class="metric-value" text-anchor="middle">${input}</text>
  </g>
  <g transform="translate(892 207)">
    <circle cx="-55" cy="-4" r="4" fill="#7cb4a5"/>
    <text x="0" y="0" class="metric-label" text-anchor="end">OUTPUT</text>
    <text x="0" y="30" class="metric-value" text-anchor="end">${output}</text>
  </g>
  <text x="28" y="260" class="foot" dominant-baseline="middle">Maintainer instance</text>
  <text x="892" y="260" class="foot" text-anchor="end" dominant-baseline="middle">${observed}</text>
</svg>`;
}

export async function readmeStatusSvgResponse(env: GatewayEnv, now: number = Date.now()): Promise<Response> {
  let data: LiveStatusData = {
    today: 0,
    h24: 0,
    d7: 0,
    cumulative: 0,
    input: 0,
    output: 0,
    cacheHitRatio: null,
    observedAt: '',
    available: false,
  };

  try {
    const stats = await getCachedDashboardStats(env, now);
    const summary = stats.summary;
    if (summary && summary.available === true) {
      data = {
        today: summary.today.total,
        h24: summary.h24.total,
        d7: summary.d7.total,
        cumulative: summary.cumulative.total,
        input: summary.cumulative.input,
        output: summary.cumulative.output,
        cacheHitRatio: summary.cumulative.cacheHitRatio,
        observedAt: stats.observedAt,
        available: true,
      };
    }
  } catch {
    // Keep the README image renderable when D1 is temporarily unavailable.
  }

  return new Response(renderReadmeStatusSvg(data), {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
