// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


export const PROTOCOLS = Object.freeze(['openai', 'anthropic']);

export const SURFACES_BY_PROTOCOL = Object.freeze({
  openai: Object.freeze(['chat_completions', 'responses']),
  anthropic: Object.freeze(['messages', 'count_tokens']),
});

export const RUNTIME_NODE_SURFACES = Object.freeze([
  'chat_completions',
  'responses',
  'messages',
]);

export const EVIDENCE_LEVELS = Object.freeze([
  'configured',
  'official',
  'verified',
  'unknown',
]);

export const SUPPORT_TRUE = true;
export const SUPPORT_FALSE = false;
export const SUPPORT_NULL = null;


export const CAPABILITY_ENTRY_FIELDS = Object.freeze(['supported', 'base_url', 'surfaces', 'evidence']);

export const CATALOG_SCHEMA_VERSION = '1.1';


export function isProtocol(value) {
  return typeof value === 'string' && PROTOCOLS.includes(value);
}

export function isSurfaceFor(protocol, surface) {
  if (!isProtocol(protocol)) return false;
  const list = SURFACES_BY_PROTOCOL[protocol];
  return list.includes(surface);
}

export function isEvidence(value) {
  return typeof value === 'string' && EVIDENCE_LEVELS.includes(value);
}

export function isSupportTriState(value) {
  return value === SUPPORT_TRUE || value === SUPPORT_FALSE || value === SUPPORT_NULL;
}


export function validateCapabilityEntry(protocol, entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`entry is not an object`];
  }
  for (const key of Object.keys(entry)) {
    if (!CAPABILITY_ENTRY_FIELDS.includes(key)) {
      errors.push(`unknown field "${key}"`);
    }
  }
  if (!isSupportTriState(entry.supported)) {
    errors.push(`supported must be true, false, or null`);
  }
  if (entry.base_url !== null && typeof entry.base_url !== 'string') {
    errors.push(`base_url must be a string or null`);
  }
  if (typeof entry.base_url === 'string' && entry.base_url.length === 0) {
    errors.push(`base_url must not be an empty string (use null instead)`);
  }
  if (!Array.isArray(entry.surfaces)) {
    errors.push(`surfaces must be an array`);
  } else {
    if (entry.supported === SUPPORT_FALSE && entry.surfaces.length > 0) {
      errors.push(`surfaces must be [] when supported is false`);
    }
    if (entry.supported === SUPPORT_NULL && entry.surfaces.length > 0) {
      errors.push(`surfaces must be [] when supported is null`);
    }
    const known = SURFACES_BY_PROTOCOL[protocol] || [];
    for (const surface of entry.surfaces) {
      if (typeof surface !== 'string') {
        errors.push(`surfaces entries must be strings`);
        break;
      }
      if (!known.includes(surface)) {
        errors.push(`surface "${surface}" is not valid for protocol "${protocol}" (allowed: ${known.join(', ')})`);
      }
    }
  }
  if (!isEvidence(entry.evidence)) {
    errors.push(`evidence must be one of ${EVIDENCE_LEVELS.join(', ')}`);
  }
  return errors;
}

export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { ok: false, errors: ['catalog is not an object'] };
  }
  if (catalog.schema_version !== CATALOG_SCHEMA_VERSION) {
    errors.push(`schema_version must be "${CATALOG_SCHEMA_VERSION}"`);
  }
  if (!catalog.providers || typeof catalog.providers !== 'object' || Array.isArray(catalog.providers)) {
    errors.push('providers must be an object keyed by provider name');
    return { ok: errors.length === 0, errors };
  }
  for (const [providerName, providerEntry] of Object.entries(catalog.providers)) {
    if (!providerName.trim()) {
      errors.push('provider name must be a non-empty string');
      continue;
    }
    if (!providerEntry || typeof providerEntry !== 'object' || Array.isArray(providerEntry)) {
      errors.push(`provider "${providerName}" must be an object keyed by protocol`);
      continue;
    }
    for (const protocol of Object.keys(providerEntry)) {
      if (!isProtocol(protocol)) {
        errors.push(`provider "${providerName}": unknown protocol "${protocol}" (allowed: ${PROTOCOLS.join(', ')})`);
        continue;
      }
      const entry = providerEntry[protocol];
      const entryErrors = validateCapabilityEntry(protocol, entry);
      for (const e of entryErrors) errors.push(`provider "${providerName}" protocol "${protocol}": ${e}`);
    }
  }
  return { ok: errors.length === 0, errors };
}


export function loadCatalogFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse catalog JSON at ${filePath}: ${e.message}`);
  }
  const { ok, errors } = validateCatalog(parsed);
  return { catalog: parsed, loadWarnings: ok ? [] : errors, valid: ok };
}


const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = here;
