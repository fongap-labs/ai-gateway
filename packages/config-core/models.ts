import { readEnv } from './env.ts';

const CAPABILITY_KEYS = ['tools', 'reasoning', 'vision', 'stream', 'ocr'];
const ALLOWED_ENTRY_FIELDS = new Set([
  'policy',
  'fallback',
  'fallback_mode',
  'fallback_attempt_caps',
  'capabilities',
  'reasoning_efforts',
  'modalities',
  'visibility',
  'display_order',
  'group',
  'ui_visible',
]);
const MODALITY_TOKENS = new Set(['text', 'image', 'audio', 'video']);
const VALID_VISIBILITY = new Set(['public', 'internal']);
const DEFAULT_VISIBILITY = 'public';
const DEFAULT_DISPLAY_ORDER = 100;
const DEFAULT_GROUP = 'general';
const DEFAULT_UI_VISIBLE = true;

export type ModelCatalogFacts = {
  capabilities?: Record<string, boolean>;
  reasoning_efforts?: string[];
  modalities?: { input: string[]; output: string[] };
};

export type ModelRuntimePolicy = {
  policy?: string;
  fallback?: string[];
  fallback_mode?: 'one_way' | 'recheck';
  fallback_attempt_caps?: number[];
  visibility: string;
  ui_visible: boolean;
  display_order: number;
  group: string;
};

export type ModelEntry = {
  catalog: ModelCatalogFacts;
  policy: ModelRuntimePolicy;
};

let cachedEnv: Record<string, unknown> | undefined;
let cached: { models: Record<string, ModelEntry>; errors: string[] } | undefined;

export function loadModelsConfig(env: Record<string, unknown>): Record<string, ModelEntry> {
  return analyzeModels(env).models;
}

export function getModelsConfigDiagnostics(env: Record<string, unknown>): string[] {
  return analyzeModels(env).errors;
}

function analyzeModels(env: Record<string, unknown>): { models: Record<string, ModelEntry>; errors: string[] } {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'AIG_MODELS_CONFIG');
  const errors: string[] = [];
  const models: Record<string, ModelEntry> = {};
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`AIG_MODELS_CONFIG invalid JSON (${msg}); fields ignored`);
      cached = { models, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('AIG_MODELS_CONFIG must be a JSON object { model: { policy, capabilities, reasoning_efforts } }');
    } else {
      for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
        if (!name.trim()) {
          errors.push('AIG_MODELS_CONFIG: empty model name (keys must be non-empty strings)');
          continue;
        }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`AIG_MODELS_CONFIG: "${name}" must be an object`);
          continue;
        }
        const cfg = config as Record<string, unknown>;
        for (const field of Object.keys(cfg)) {
          if (field === 'vision_delegate') continue;
          if (!ALLOWED_ENTRY_FIELDS.has(field)) {
            errors.push(`AIG_MODELS_CONFIG: "${name}" has unknown field "${field}" (allowed: ${[...ALLOWED_ENTRY_FIELDS].join(', ')})`);
          }
        }
        const policy: ModelRuntimePolicy = {
          visibility: DEFAULT_VISIBILITY,
          ui_visible: DEFAULT_UI_VISIBLE,
          display_order: DEFAULT_DISPLAY_ORDER,
          group: DEFAULT_GROUP,
        };
        if (cfg.policy !== undefined) {
          if (typeof cfg.policy === 'string' && cfg.policy.trim()) {
            policy.policy = cfg.policy.trim();
          } else {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": policy must be a non-empty string`);
          }
        }
        const declaredFallback = cfg.fallback;
        if (declaredFallback !== undefined) {
          if (!Array.isArray(declaredFallback) || !declaredFallback.every((target) => typeof target === 'string' && !!target.trim())) {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": fallback must be an array of non-empty model names`);
          } else {
            const names = (declaredFallback as string[]).map((target) => target.trim());
            const normalized = names.map((target) => target.toLowerCase());
            if (normalized.includes(name.trim().toLowerCase())) {
              errors.push(`AIG_MODELS_CONFIG: model "${name}": fallback cannot contain the requested model`);
            }
            if (new Set(normalized).size !== normalized.length) {
              errors.push(`AIG_MODELS_CONFIG: model "${name}": fallback contains duplicate model names`);
            }
            policy.fallback = names;
          }
        }
        const fallbackMode = cfg.fallback_mode;
        if (fallbackMode !== undefined) {
          if (fallbackMode === 'one_way' || fallbackMode === 'recheck') {
            policy.fallback_mode = fallbackMode;
          } else {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": fallback_mode must be "one_way" or "recheck"`);
          }
        }
        const fallbackCaps = cfg.fallback_attempt_caps;
        if (fallbackCaps !== undefined) {
          if (
            !Array.isArray(fallbackCaps) ||
            !fallbackCaps.every((cap) => typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 1) ||
            !Array.isArray(declaredFallback) ||
            fallbackCaps.length !== declaredFallback.length + 1
          ) {
            errors.push(
              `AIG_MODELS_CONFIG: model "${name}": fallback_attempt_caps must contain one positive integer for requested model and each fallback`,
            );
          } else {
            policy.fallback_attempt_caps = [...fallbackCaps] as number[];
          }
        }
        if ((fallbackMode !== undefined || fallbackCaps !== undefined) && !Array.isArray(declaredFallback)) {
          errors.push(`AIG_MODELS_CONFIG: model "${name}": fallback must be declared when configuring fallback behavior`);
        }
        const vis = cfg.visibility;
        if (vis !== undefined) {
          if (typeof vis !== 'string' || !VALID_VISIBILITY.has(vis)) {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": visibility must be "public" or "internal"`);
          } else {
            policy.visibility = vis;
          }
        }
        const order = cfg.display_order;
        if (order !== undefined) {
          if (typeof order !== 'number' || !Number.isFinite(order) || order < 0) {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": display_order must be a non-negative finite number`);
          } else {
            policy.display_order = order;
          }
        }
        const grp = cfg.group;
        if (grp !== undefined) {
          if (typeof grp !== 'string' || !grp.trim()) {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": group must be a non-empty string`);
          } else {
            policy.group = grp.trim();
          }
        }
        const uiv = cfg.ui_visible;
        if (uiv !== undefined) {
          if (typeof uiv !== 'boolean') {
            errors.push(`AIG_MODELS_CONFIG: model "${name}": ui_visible must be a boolean`);
          } else {
            policy.ui_visible = uiv;
          }
        }
        const catalog: ModelCatalogFacts = {};
        const caps = cfg.capabilities;
        if (caps !== undefined) {
          if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
            errors.push(`AIG_MODELS_CONFIG: "${name}" capabilities must be an object`);
          } else {
            const capRec = caps as Record<string, unknown>;
            let hasValidCapability = false;
            for (const [key, val] of Object.entries(capRec)) {
              if (!CAPABILITY_KEYS.includes(key)) {
                errors.push(
                  `AIG_MODELS_CONFIG: "${name}" capabilities.${key} is not a supported capability (allowed: ${CAPABILITY_KEYS.join(', ')})`,
                );
              } else if (typeof val !== 'boolean') {
                errors.push(`AIG_MODELS_CONFIG: "${name}" capabilities.${key} must be a boolean`);
              } else {
                hasValidCapability = true;
              }
            }
            if (hasValidCapability) {
              catalog.capabilities = Object.fromEntries(
                Object.entries(capRec).filter(([k, v]) => CAPABILITY_KEYS.includes(k) && typeof v === 'boolean'),
              ) as Record<string, boolean>;
            }
          }
        }
        const efforts = cfg.reasoning_efforts;
        if (efforts !== undefined) {
          if (!Array.isArray(efforts) || !efforts.every((e) => typeof e === 'string' && e.trim())) {
            errors.push(`AIG_MODELS_CONFIG: "${name}" reasoning_efforts must be an array of non-empty strings`);
          } else {
            catalog.reasoning_efforts = efforts.map((e) => e.trim());
          }
        }
        const mods = cfg.modalities;
        if (mods !== undefined) {
          if (!mods || typeof mods !== 'object' || Array.isArray(mods)) {
            errors.push(`AIG_MODELS_CONFIG: "${name}" modalities must be an object { input, output }`);
          } else {
            const modRec = mods as Record<string, unknown>;
            const sides: { input: string[]; output: string[] } = { input: [], output: [] };
            let isValidModality = true;
            for (const side of ['input', 'output'] as const) {
              const list = modRec[side];
              if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && MODALITY_TOKENS.has(t.trim()))) {
                errors.push(
                  `AIG_MODELS_CONFIG: "${name}" modalities.${side} must be an array over the closed vocabulary [${[...MODALITY_TOKENS].join(', ')}]`,
                );
                isValidModality = false;
              } else {
                sides[side] = [...new Set(list.map((t) => t.trim()))];
              }
            }
            if (isValidModality) catalog.modalities = { input: sides.input, output: sides.output };
          }
        }
        if (catalog.reasoning_efforts?.length && catalog.capabilities?.reasoning === false) {
          errors.push(`AIG_MODELS_CONFIG: model "${name}": reasoning_efforts conflicts with capabilities.reasoning=false`);
        }
        if (catalog.capabilities?.ocr === true && catalog.capabilities?.vision === false) {
          errors.push(`AIG_MODELS_CONFIG: model "${name}": capabilities.ocr=true conflicts with capabilities.vision=false`);
        }
        if (catalog.capabilities?.vision === true && catalog.modalities && !catalog.modalities.input.includes('image')) {
          errors.push(
            `AIG_MODELS_CONFIG: model "${name}": capabilities.vision=true requires modalities.input to include "image" when modalities is declared`,
          );
        }
        models[name.trim()] = { catalog, policy };
      }
    }
  }
  const known = new Set(Object.keys(models).map((name) => name.toLowerCase()));
  for (const [name, entry] of Object.entries(models)) {
    for (const target of entry.policy.fallback ?? []) {
      if (!known.has(target.toLowerCase())) {
        errors.push(`AIG_MODELS_CONFIG: model "${name}": fallback target "${target}" is not declared`);
      }
    }
  }
  cached = { models, errors };
  return cached;
}
