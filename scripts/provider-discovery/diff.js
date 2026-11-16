// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import {
  PROTOCOLS,
  SURFACES_BY_PROTOCOL,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
} from './catalog-schema.js';

function directionOf(before, after) {
  const toRank = (v) => (v === SUPPORT_TRUE ? 2 : v === SUPPORT_FALSE ? 0 : 1);
  const rb = toRank(before);
  const ra = toRank(after);
  if (ra > rb) return 'up';
  if (ra < rb) return 'down';
  return 'lateral';
}

function severityForTransition(kind, before, after) {
  if (kind === 'base_url_changed') return { severity: 'P3', direction: 'lateral' };

  const dir = directionOf(before, after);
  if (before === SUPPORT_TRUE && (after === SUPPORT_FALSE || after === SUPPORT_NULL)) {
    return { severity: 'P1', direction: 'down' };
  }
  if (before === SUPPORT_NULL && after === SUPPORT_TRUE) {
    return { severity: 'P2', direction: 'up' };
  }
  if (before === SUPPORT_FALSE && after === SUPPORT_TRUE) {
    return { severity: 'P2', direction: 'up' };
  }
  return { severity: 'P3', direction: dir };
}

function pkey(provider, protocol, surface) {
  return surface ? `${provider}|${protocol}|${surface}` : `${provider}|${protocol}`;
}

function compareCapabilityEntry(provider, protocol, before, after) {
  const out = [];
  if (!before && !after) return out;

  const bSup = before?.supported ?? SUPPORT_NULL;
  const aSup = after?.supported ?? SUPPORT_NULL;
  if (bSup !== aSup) {
    const { severity, direction } = severityForTransition('protocol_support_changed', bSup, aSup);
    out.push({
      provider,
      kind: 'protocol_support_changed',
      protocol,
      before: bSup,
      after: aSup,
      severity,
      direction,
    });
  }

  const bUrl = before?.base_url ?? null;
  const aUrl = after?.base_url ?? null;
  if (bUrl !== aUrl) {
    const { severity, direction } = severityForTransition('base_url_changed', null, null);
    out.push({
      provider,
      kind: 'base_url_changed',
      protocol,
      before: bUrl,
      after: aUrl,
      severity,
      direction,
    });
  }

  const bSurfaces = new Set(before?.surfaces ?? []);
  const aSurfaces = new Set(after?.surfaces ?? []);
  const known = SURFACES_BY_PROTOCOL[protocol] || [];
  for (const surface of known) {
    const wasListed = bSurfaces.has(surface);
    const isListed = aSurfaces.has(surface);
    if (wasListed === isListed) continue;
    const beforeState = wasListed ? SUPPORT_TRUE : SUPPORT_NULL;
    const afterState = isListed ? SUPPORT_TRUE : SUPPORT_NULL;
    const { severity, direction } = severityForTransition('surface_support_changed', beforeState, afterState);
    out.push({
      provider,
      kind: 'surface_support_changed',
      protocol,
      surface,
      before: wasListed ? 'supported' : 'unknown',
      after: isListed ? 'supported' : 'unknown',
      severity,
      direction,
    });
  }

  return out;
}

export function diffCatalogs(before, after) {
  const bProviders = before?.providers || {};
  const aProviders = after?.providers || {};
  const names = new Set([...Object.keys(bProviders), ...Object.keys(aProviders)]);
  const sortedNames = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const added = [];
  const removed = [];
  const changed = [];
  const unchangedProviders = [];

  for (const provider of sortedNames) {
    const bProv = bProviders[provider];
    const aProv = aProviders[provider];

    if (bProv && !aProv) {
      removed.push({ provider, kind: 'protocol_support_changed', protocol: '*', before: SUPPORT_TRUE, after: SUPPORT_NULL, severity: 'P1', direction: 'down' });
      continue;
    }
    if (!bProv && aProv) {
      added.push({ provider, kind: 'protocol_support_changed', protocol: '*', before: SUPPORT_NULL, after: SUPPORT_TRUE, severity: 'P2', direction: 'up' });
      continue;
    }

    let providerHadChange = false;
    const protocols = new Set([...Object.keys(bProv || {}), ...Object.keys(aProv || {})]);
    for (const protocol of protocols) {
      if (!PROTOCOLS.includes(protocol)) continue;
      const bEntry = bProv[protocol];
      const aEntry = aProv[protocol];
      const entryChanges = compareCapabilityEntry(provider, protocol, bEntry, aEntry);
      if (entryChanges.length > 0) {
        providerHadChange = true;
        changed.push(...entryChanges);
      }
    }
    if (!providerHadChange) unchangedProviders.push(provider);
  }

  const sortFn = (a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if ((a.protocol || '') !== (b.protocol || '')) return (a.protocol || '') < (b.protocol || '') ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const sa = a.surface || '';
    const sb = b.surface || '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return 0;
  };
  added.sort(sortFn);
  removed.sort(sortFn);
  changed.sort(sortFn);
  unchangedProviders.sort();

  return {
    added,
    removed,
    changed,
    unchanged_providers: unchangedProviders,
    summary: {
      added_count: added.length,
      removed_count: removed.length,
      changed_count: changed.length,
      unchanged_count: unchangedProviders.length,
    },
  };
}

export function summarizeBySeverity(diff) {
  const out = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const c of diff.changed) out[c.severity] = (out[c.severity] || 0) + 1;
  out.added = diff.added.length;
  out.removed = diff.removed.length;
  return out;
}

export function hasProtocolDowngrade(diff) {
  return diff.changed.some(
    (c) => c.kind === 'protocol_support_changed' && c.before === SUPPORT_TRUE && (c.after === SUPPORT_FALSE || c.after === SUPPORT_NULL),
  );
}

export { pkey };
