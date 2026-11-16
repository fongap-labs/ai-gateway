import { getProviderProfile } from '../contracts/provider-profiles.ts';
import type { RuntimeNode } from '../contracts/runtime-node.ts';
import { loadModelsConfig } from './models.ts';
import { getFallbackChain } from './protocol-fallbacks.ts';
import { modelRegistryEntry } from './registry.ts';

type VisionRoutingContext = {
  env: Record<string, unknown>;
  requestedModel: string;
  knownModels: ReadonlySet<string>;
  allowedModels: ReadonlySet<string>;
  nodes: ReadonlyArray<RuntimeNode>;
};

export type VisionDelegateResolution =
  | { kind: 'ready'; model: string }
  | { kind: 'unauthorized' | 'unavailable' | 'none' };

function canonicalModel(names: ReadonlySet<string>, name: string): string | undefined {
  return [...names].find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

export function perceptionBindingReady(env: Record<string, unknown>): boolean {
  const binding = env.AIG_PERCEPTION_SERVICE as { fetch?: unknown } | undefined;
  const key = env.AIG_PERCEPTION_AUTH_KEY;
  return !!binding && typeof binding.fetch === 'function' && typeof key === 'string' && key.length >= 32;
}

export function hasVisionNode(nodes: ReadonlyArray<RuntimeNode>, model: string, env: Record<string, unknown>): boolean {
  const fallbacks = getFallbackChain('openai_chat', env);
  return nodes.some((node) => {
    if (!getProviderProfile(node.provider).imageInput || typeof node.models[model] !== 'string' || !node.models[model].trim()) return false;
    if (node.protocol === 'openai' && node.surfaces.includes('chat_completions')) return true;
    return fallbacks.some(({ protocol, surface }) => node.protocol === protocol && node.surfaces.includes(surface));
  });
}

export function resolveVisionDelegate({
  env,
  requestedModel,
  knownModels,
  allowedModels,
  nodes,
}: VisionRoutingContext): VisionDelegateResolution {
  if (modelRegistryEntry(env, requestedModel).catalog.capabilities.vision === true) return { kind: 'none' };
  const explicit = loadModelsConfig(env)[requestedModel]?.policy.vision_delegate;
  if (explicit) {
    const model = canonicalModel(knownModels, explicit);
    if (!model || !canonicalModel(allowedModels, model)) return { kind: 'unauthorized' };
    if (modelRegistryEntry(env, model).catalog.capabilities.vision !== true || !hasVisionNode(nodes, model, env)) {
      return { kind: 'unavailable' };
    }
    return { kind: 'ready', model };
  }

  const candidates = [...knownModels]
    .filter((model) => model.toLowerCase() !== requestedModel.toLowerCase())
    .filter((model) => canonicalModel(allowedModels, model))
    .filter((model) => {
      const registry = modelRegistryEntry(env, model);
      return registry.catalog.capabilities.vision === true && registry.policy.visibility !== 'internal' && hasVisionNode(nodes, model, env);
    })
    .sort(
      (a, b) =>
        modelRegistryEntry(env, a).policy.display_order - modelRegistryEntry(env, b).policy.display_order ||
        a.localeCompare(b),
    );
  return candidates.length > 0 ? { kind: 'ready', model: candidates[0] } : { kind: 'none' };
}

export function gatewayCanAcceptVision(context: VisionRoutingContext): boolean {
  if (!perceptionBindingReady(context.env)) return false;
  if (modelRegistryEntry(context.env, context.requestedModel).catalog.capabilities.vision === true) {
    return hasVisionNode(context.nodes, context.requestedModel, context.env);
  }
  return resolveVisionDelegate(context).kind === 'ready';
}
