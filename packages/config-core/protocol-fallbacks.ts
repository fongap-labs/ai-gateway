// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Protocol, Surface } from '../contracts/protocol.ts';
import { readEnv } from './env.ts';

const PROTOCOL_SURFACES = new Map<string, Set<string>>([
  ['openai', new Set(['chat_completions', 'responses'])],
  ['anthropic', new Set(['messages'])],
]);

export const SUPPORTED_CONVERSIONS: Readonly<Record<string, string[]>> = Object.freeze({
  'anthropic:messages': ['openai:chat_completions', 'openai:responses'],
  'openai:chat_completions': ['anthropic:messages', 'openai:responses'],
  'openai:responses': ['anthropic:messages', 'openai:chat_completions'],
});

export const DEFAULT_FALLBACK_CHAIN: Readonly<Record<string, string[]>> = Object.freeze({
  'anthropic:messages': ['openai:chat_completions', 'openai:responses'],
  'openai:chat_completions': ['anthropic:messages', 'openai:responses'],
  'openai:responses': ['anthropic:messages', 'openai:chat_completions'],
});

const DISABLE_LITERAL = 'disable';

const ROUTE_PROTOCOL_SURFACE: Readonly<Record<string, string>> = Object.freeze({
  openai_chat: 'openai:chat_completions',
  openai_responses: 'openai:responses',
  anthropic_messages: 'anthropic:messages',
});

let cachedEnv: Record<string, unknown> | undefined;
let cached: { config: Record<string, string[]>; errors: string[] } | undefined;

export function loadProtocolFallbacks(env: Record<string, unknown>): Record<string, string[]> {
  return analyzeProtocolFallbacks(env).config;
}

export function getProtocolFallbacksDiagnostics(env: Record<string, unknown>): string[] {
  return analyzeProtocolFallbacks(env).errors;
}

function analyzeProtocolFallbacks(env: Record<string, unknown>): { config: Record<string, string[]>; errors: string[] } {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'AIG_PROTOCOL_FALLBACKS');
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const errors: string[] = [];
  const config: Record<string, string[]> = {};
  if (!trimmed) {
    cached = { config: { ...DEFAULT_FALLBACK_CHAIN }, errors };
    return cached;
  }
  if (trimmed.toLowerCase() === DISABLE_LITERAL) {
    cached = { config, errors };
    return cached;
  }
  {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`AIG_PROTOCOL_FALLBACKS invalid JSON (${msg}); fallbacks disabled`);
      cached = { config, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('AIG_PROTOCOL_FALLBACKS must be a JSON object { "protocol:surface": ["protocol:surface", ...] }');
    } else {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const parsedKey = parseSurfaceKey(key, errors, '');
        if (!parsedKey) continue;
        if (!Array.isArray(value)) {
          errors.push(`AIG_PROTOCOL_FALLBACKS: "${key}" must be a JSON array of "protocol:surface" strings`);
          continue;
        }
        if (value.length === 0) {
          config[parsedKey] = [];
          continue;
        }
        const targets: string[] = [];
        for (const entry of value) {
          const parsedEntry = parseSurfaceKey(String(entry), errors, key);
          if (parsedEntry) targets.push(parsedEntry);
        }
        if (targets.length > 0) {
          const allowed = SUPPORTED_CONVERSIONS[parsedKey];
          if (!allowed) {
            errors.push(
              `AIG_PROTOCOL_FALLBACKS: "${parsedKey}" is not a supported conversion source (supported: ${Object.keys(SUPPORTED_CONVERSIONS).join(', ')})`,
            );
          } else {
            for (const target of targets) {
              if (!allowed.includes(target)) {
                errors.push(`AIG_PROTOCOL_FALLBACKS: "${parsedKey}" -> "${target}" is not a supported conversion (allowed: ${allowed.join(', ')})`);
              }
            }
          }
          const validTargets = targets.filter((t) => allowed?.includes(t));
          if (validTargets.length > 0) config[parsedKey] = validTargets;
        }
      }
    }
  }
  cached = { config, errors };
  return cached;
}

function parseSurfaceKey(raw: string, errors: string[], parentKey: string): string | null {
  const prefix = parentKey ? `AIG_PROTOCOL_FALLBACKS: "${parentKey}" entry` : 'AIG_PROTOCOL_FALLBACKS key';
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push(`${prefix} must be a non-empty "protocol:surface" string`);
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  const idx = trimmed.indexOf(':');
  if (idx <= 0 || idx === trimmed.length - 1) {
    errors.push(`${prefix} "${raw}" must be in the form "protocol:surface" (e.g. "anthropic:messages")`);
    return null;
  }
  const protocol = trimmed.slice(0, idx);
  const surface = trimmed.slice(idx + 1);
  const allowed = PROTOCOL_SURFACES.get(protocol);
  if (!allowed) {
    errors.push(`${prefix} "${raw}" has unknown protocol "${protocol}" (allowed: openai, anthropic)`);
    return null;
  }
  if (!allowed.has(surface)) {
    errors.push(`${prefix} "${raw}" has unknown surface "${surface}" for protocol "${protocol}" (allowed: ${[...allowed].join(', ')})`);
    return null;
  }
  return trimmed;
}

export function getFallbackChain(route: string, env: Record<string, unknown>): Array<{ protocol: Protocol; surface: Surface }> {
  const key = ROUTE_PROTOCOL_SURFACE[route];
  if (!key) return [];
  const config = loadProtocolFallbacks(env);
  const chain = config[key];
  if (!chain || chain.length === 0) return [];
  return chain.map((entry) => {
    const idx = entry.indexOf(':');
    return {
      protocol: entry.slice(0, idx) as Protocol,
      surface: entry.slice(idx + 1) as Surface,
    };
  });
}
