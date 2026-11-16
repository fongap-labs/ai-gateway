// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

type AuthzShape = { authorized?: boolean; allowAll?: boolean; allowlist?: ReadonlySet<string> };

const CONTEXT_LENGTH_SUFFIX = /\[[0-9]+m\]$/;

export function clientModelCore(model: string): string {
  return model.replace(CONTEXT_LENGTH_SUFFIX, '').trim();
}

export function resolveClientModel(model: string, knownModels: ReadonlySet<string>): string {
  const core = clientModelCore(model);
  if (knownModels.has(core)) return core;
  const lower = core.toLowerCase();
  for (const entry of knownModels) {
    if (entry.toLowerCase() === lower) return entry;
  }
  return core;
}

function catalogHas(models: ReadonlySet<string>, value: string): boolean {
  const lower = value.toLowerCase();
  for (const model of models) {
    if (model.toLowerCase() === lower) return true;
  }
  return false;
}

export function filterVisibleModels(knownModels: ReadonlySet<string>, authz: AuthzShape): string[] {
  if (!knownModels || knownModels.size === 0) return [];
  if (!authz?.authorized) return [];
  if (authz.allowAll) return [...knownModels].sort();
  if (!authz.allowlist || authz.allowlist.size === 0) return [];
  const allowlist = authz.allowlist;
  return [...knownModels].filter((m) => catalogHas(allowlist, m)).sort();
}

export function authorizeModel(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
  authz: AuthzShape,
): { allowed: true } | { allowed: false; status: 401 | 403 | 404 } {
  if (!authz?.authorized) return { allowed: false, status: 401 };
  if (!knownModels || knownModels.size === 0) return { allowed: false, status: 404 };
  if (authz.allowAll) {
    return catalogHas(knownModels, requestedModel) ? { allowed: true } : { allowed: false, status: 404 };
  }
  const inAllowlist = authz.allowlist ? catalogHas(authz.allowlist, requestedModel) : false;
  if (!inAllowlist) {
    return { allowed: false, status: 403 };
  }
  if (!catalogHas(knownModels, requestedModel)) {
    return { allowed: false, status: 404 };
  }
  return { allowed: true };
}
