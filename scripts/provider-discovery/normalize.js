// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import {
  PROTOCOLS,
  SURFACES_BY_PROTOCOL,
  CAPABILITY_ENTRY_FIELDS,
  isProtocol,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
  isSupportTriState,
  isEvidence,
  EVIDENCE_LEVELS,
} from './catalog-schema.js';
import { isSafeDiscoveryUrl } from './ssrf-guard.js';


export function canonicalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return { value: null, warning: null };
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, warning: null };
  try {
    const u = new URL(trimmed);
    if (u.username || u.password) {
      return { value: null, warning: 'base_url contained credential-like userinfo; value dropped' };
    }
    if (u.protocol !== 'https:') {
      return { value: null, warning: 'base_url must use https:// (Discovery refuses http)' };
    }
    const guard = isSafeDiscoveryUrl(trimmed);
    if (!guard.safe) {
      return { value: null, warning: `base_url SSRF guard: ${guard.reason}; value dropped` };
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return { value: u.toString(), warning: null };
  } catch {
    return { value: null, warning: 'base_url is not a valid URL; value dropped' };
  }
}

const SENSITIVE_TOKEN_HINT = /(bearer|sk-|ghp_|akia|ghu_|ghs_|xox[abp]-|AIza)/i;
function stripCredentialLikeUrl(raw) {
  if (typeof raw !== 'string') return { value: null, suspect: false };
  if (SENSITIVE_TOKEN_HINT.test(raw)) return { value: null, suspect: true };
  return { value: raw, suspect: false };
}


export function normalizeCapabilityEntry(protocol, entry) {
  const warnings = [];
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    for (const key of Object.keys(entry)) {
      if (!CAPABILITY_ENTRY_FIELDS.includes(key)) {
        warnings.push(`unknown field "${key}" dropped`);
      }
    }
  }
  const safe = stripCredentialLikeUrl(entry?.base_url ?? null);
  if (safe.suspect) {
    warnings.push(`base_url contained credential-like text; value dropped`);
  }
  const canon = canonicalizeBaseUrl(safe.value);
  if (canon.warning) warnings.push(canon.warning);
  const baseUrl = canon.value;

  let supported = SUPPORT_NULL;
  if (isSupportTriState(entry?.supported)) supported = entry.supported;
  else if (entry?.supported !== undefined && entry?.supported !== null) {
    warnings.push(`supported value coerced to null (expected true/false/null)`);
  }

  const known = SURFACES_BY_PROTOCOL[protocol] || [];
  const seen = new Set();
  const surfaces = [];
  if (Array.isArray(entry?.surfaces)) {
    for (const s of entry.surfaces) {
      if (typeof s !== 'string') continue;
      const v = s.trim();
      if (!v) continue;
      if (!known.includes(v)) {
        warnings.push(`unknown surface "${v}" for protocol "${protocol}" dropped`);
        continue;
      }
      if (!seen.has(v)) {
        seen.add(v);
        surfaces.push(v);
      }
    }
  }
  surfaces.sort();

  let surfacesOut = surfaces;
  if (supported === SUPPORT_FALSE || supported === SUPPORT_NULL) {
    if (surfaces.length > 0) {
      warnings.push(`surfaces cleared because supported is ${supported === SUPPORT_FALSE ? 'false' : 'null'}`);
      surfacesOut = [];
    }
  }

  let evidence = 'unknown';
  if (isEvidence(entry?.evidence)) evidence = entry.evidence;
  else if (entry?.evidence !== undefined) {
    warnings.push(`evidence value coerced to "unknown"`);
  }

  return {
    entry: {
      supported,
      base_url: baseUrl,
      surfaces: surfacesOut,
      evidence,
    },
    warnings,
  };
}


export function normalizeProvider(providerName, rawProvider) {
  const warnings = [];
  const out = {};
  if (!rawProvider || typeof rawProvider !== 'object' || Array.isArray(rawProvider)) {
    warnings.push(`provider "${providerName}" is not an object; skipped`);
    return { provider: null, warnings };
  }
  for (const protocol of Object.keys(rawProvider)) {
    if (!isProtocol(protocol)) {
      warnings.push(`provider "${providerName}": unknown protocol "${protocol}" dropped`);
      continue;
    }
    const { entry, warnings: entryWarnings } = normalizeCapabilityEntry(
      protocol,
      rawProvider[protocol],
    );
    for (const w of entryWarnings) warnings.push(`provider "${providerName}" protocol "${protocol}": ${w}`);
    out[protocol] = entry;
  }
  return { provider: out, warnings };
}


export function normalizeCatalog(catalog) {
  const warnings = [];
  const providersIn = catalog?.providers;
  const providersOut = {};
  if (!providersIn || typeof providersIn !== 'object' || Array.isArray(providersIn)) {
    warnings.push('providers is not an object; normalized catalog has no providers');
    return {
      catalog: {
        schema_version: '1.1',
        providers: {},
      },
      warnings,
    };
  }
  const names = Object.keys(providersIn).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const { provider, warnings: provWarnings } = normalizeProvider(name, providersIn[name]);
    for (const w of provWarnings) warnings.push(w);
    if (provider) providersOut[name] = provider;
  }
  return {
    catalog: {
      schema_version: '1.1',
      providers: providersOut,
    },
    warnings,
  };
}


export function normalizeRuntimeView(nodes) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : 'unknown';
    const protocol = typeof raw.protocol === 'string' ? raw.protocol.trim().toLowerCase() : '';
    if (!isProtocol(protocol)) continue;
    const known = SURFACES_BY_PROTOCOL[protocol] || [];
    const surfaceSet = new Set();
    if (Array.isArray(raw.surfaces)) {
      for (const s of raw.surfaces) {
        if (typeof s !== 'string') continue;
        const v = s.trim();
        if (known.includes(v)) surfaceSet.add(v);
      }
    }
    const surfaces = [...surfaceSet].sort();
    let baseUrl = null;
    if (typeof raw.base_url === 'string') {
      const trimmed = raw.base_url.trim();
      if (trimmed && !SENSITIVE_TOKEN_HINT.test(trimmed)) {
        try {
          const u = new URL(trimmed);
          if (!u.username && !u.password && u.protocol === 'https:') {
            const guard = isSafeDiscoveryUrl(trimmed);
            if (guard.safe) baseUrl = u.toString();
          }
        } catch {   }
      }
    }
    out.push({ id, provider, protocol, surfaces, base_url: baseUrl });
  }
  out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.protocol !== b.protocol) return a.protocol < b.protocol ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

export { PROTOCOLS, SURFACES_BY_PROTOCOL, EVIDENCE_LEVELS };
