// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import {
  RUNTIME_NODE_SURFACES,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
} from './catalog-schema.js';
import { SURFACES_BY_PROTOCOL } from './normalize.js';

function checkNodeAgainstCatalog(node, catalog) {
  const warnings = [];
  const providerEntry = catalog?.providers?.[node.provider];
  const capabilityEntry = providerEntry?.[node.protocol];

  if (!providerEntry) {
    warnings.push({
      kind: 'runtime_provider_not_in_catalog',
      severity: 'P3',
      node_id: node.id,
      provider: node.provider,
      detail: `Runtime node "${node.id}" references provider "${node.provider}" which has no entry in the Catalog`,
    });
    return warnings;
  }

  if (!capabilityEntry) {
    warnings.push({
      kind: 'runtime_protocol_not_in_catalog',
      severity: 'P1',
      node_id: node.id,
      provider: node.provider,
      protocol: node.protocol,
      detail: `Runtime node "${node.id}" declares protocol "${node.protocol}" but the Catalog has no "${node.protocol}" entry for provider "${node.provider}"`,
    });
    return warnings;
  }

  const supported = capabilityEntry.supported;
  const confirmedUnsupportedSurfaces = new Set(
    Array.isArray(capabilityEntry.surfaces)
      ? capabilityEntry.surfaces.filter((s) => supported === SUPPORT_TRUE)  
      : [],
  );

  for (const surface of node.surfaces) {
    if (!RUNTIME_NODE_SURFACES.includes(surface)) continue;
    if (
      supported === SUPPORT_TRUE
      && Array.isArray(capabilityEntry.surfaces)
      && capabilityEntry.surfaces.length > 0
      && !capabilityEntry.surfaces.includes(surface)
    ) {
      warnings.push({
        kind: 'runtime_surface_mismatch',
        severity: 'P1',
        node_id: node.id,
        provider: node.provider,
        protocol: node.protocol,
        surface,
        detail: `Runtime node "${node.id}" declares surface "${surface}" but Catalog for provider "${node.provider}" lists surfaces [${capabilityEntry.surfaces.join(', ')}] under protocol "${node.protocol}"`,
      });
    }
    if (supported === SUPPORT_FALSE) {
      warnings.push({
        kind: 'runtime_protocol_unsupported',
        severity: 'P0',
        node_id: node.id,
        provider: node.provider,
        protocol: node.protocol,
        detail: `Runtime node "${node.id}" is configured for protocol "${node.protocol}" but Catalog marks provider "${node.provider}" as not supporting that protocol`,
      });
    }
  }

  const catalogBaseUrl = capabilityEntry.base_url;
  const runtimeBaseUrl = node.base_url;
  if (
    catalogBaseUrl
    && runtimeBaseUrl
    && catalogBaseUrl !== runtimeBaseUrl
  ) {
    warnings.push({
      kind: 'runtime_base_url_differs',
      severity: 'P3',
      node_id: node.id,
      provider: node.provider,
      protocol: node.protocol,
      configured_base_url: runtimeBaseUrl,
      discovered_base_url: catalogBaseUrl,
      detail: `Runtime node "${node.id}" base_url differs from Catalog entry for provider "${node.provider}" (${node.protocol})`,
    });
  }

  return warnings;
}

export function checkRuntimeAgainstCatalog(runtimeView, catalog) {
  const out = [];
  if (!Array.isArray(runtimeView)) return out;
  for (const node of runtimeView) {
    const ws = checkNodeAgainstCatalog(node, catalog);
    for (const w of ws) out.push(w);
  }
  out.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const da = order[a.severity] ?? 9;
    const db = order[b.severity] ?? 9;
    if (da !== db) return da - db;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    return (a.node_id || '') < (b.node_id || '') ? -1 : 1;
  });
  return out;
}

export function summarizeWarnings(warnings) {
  const out = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const w of warnings) {
    if (out[w.severity] !== undefined) out[w.severity] += 1;
  }
  return out;
}

export function aggregateCatalogCapabilities(catalog) {
  const out = {
    openai_chat_supported: 0,
    openai_responses_supported: 0,
    anthropic_messages_supported: 0,
    anthropic_count_tokens_supported: 0,
    providers_total: 0,
    providers_with_openai_supported: 0,
    providers_with_anthropic_supported: 0,
  };
  const providers = catalog?.providers || {};
  for (const [, p] of Object.entries(providers)) {
    out.providers_total += 1;
    const o = p?.openai;
    const a = p?.anthropic;
    if (o?.supported === SUPPORT_TRUE) {
      out.providers_with_openai_supported += 1;
      const set = new Set(o.surfaces || []);
      if (set.has('chat_completions')) out.openai_chat_supported += 1;
      if (set.has('responses')) out.openai_responses_supported += 1;
    }
    if (a?.supported === SUPPORT_TRUE) {
      out.providers_with_anthropic_supported += 1;
      const set = new Set(a.surfaces || []);
      if (set.has('messages')) out.anthropic_messages_supported += 1;
      if (set.has('count_tokens')) out.anthropic_count_tokens_supported += 1;
    }
  }
  return out;
}
