// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Explicit Chat image tool bridge. Never infer billable image generation from
// arbitrary conversational text. The client must select the declared function
// and an authorized internal image model.
import { hasImageInput } from '../../packages/contracts/image-input.ts';
import { validateImageGenerationRequest } from '../../packages/contracts/image-request.ts';
import type { GatewayEnv } from '../../packages/contracts/runtime.ts';
import { loadModelsConfig } from '../../src/config/models.ts';
import { corsHeaders, readBodyTextBounded } from '../../src/protocol/http.ts';
import { extractOpenAITextContent, synthesizeSseFromCompletion } from '../../src/protocol/openai.ts';
import type { AuthResult } from '../../src/types/request.ts';
import { authorizeModel, resolveClientModel } from './policy/model-authz.ts';
import { gatewayError } from './response/errors.ts';

const IMAGE_TOOL_NAME = 'generate_image';
const MAX_IMAGE_TOOL_REPLY = 8 * 1024 * 1024;

export function isExplicitImageToolCall(body: Record<string, unknown>): boolean {
  const choice = body.tool_choice;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return false;
  const functionChoice = (choice as Record<string, unknown>).function;
  return (
    (choice as Record<string, unknown>).type === 'function' &&
    !!functionChoice &&
    typeof functionChoice === 'object' &&
    (functionChoice as Record<string, unknown>).name === IMAGE_TOOL_NAME
  );
}

export async function runExplicitImageTool({
  request,
  env,
  body,
  auth,
  knownModels,
  requestedModel,
  requestId,
  execute,
}: {
  request: Request;
  env: GatewayEnv;
  body: Record<string, unknown>;
  auth: AuthResult;
  knownModels: ReadonlySet<string>;
  requestedModel: string;
  requestId: string;
  execute: (subrequest: Request) => Promise<Response>;
}): Promise<Response> {
  const fail = (status: number, message: string, code: string) =>
    gatewayError(request, env, 'openai_chat', status, message, requestId, undefined, undefined, code);

  // Protect paid tools even when a normal chat key can call the text model.
  if (auth.mode !== 'grouped' || !auth.authorized || auth.group !== 'AGENT') {
    return fail(403, 'Image generation requires the authorized AGENT tool key.', 'gateway_image_tool_unauthorized');
  }
  const tools = body.tools;
  if (
    !Array.isArray(tools) ||
    !tools.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const fn = (entry as Record<string, unknown>).function;
      return (
        (entry as Record<string, unknown>).type === 'function' &&
        !!fn &&
        typeof fn === 'object' &&
        (fn as Record<string, unknown>).name === IMAGE_TOOL_NAME
      );
    })
  ) {
    return fail(400, 'Declare generate_image in tools before selecting it.', 'gateway_image_tool_undeclared');
  }
  if (hasImageInput(body)) {
    return fail(400, 'Image editing is not supported by generate_image.', 'gateway_image_tool_edit_unsupported');
  }
  const metadata = body.metadata;
  const options = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  if (typeof options.aig_image_model !== 'string' || !options.aig_image_model.trim()) {
    return fail(400, 'metadata.aig_image_model must name a configured image model.', 'gateway_image_tool_model_required');
  }
  const imageModel = resolveClientModel(options.aig_image_model, knownModels);
  const imageConfig = loadModelsConfig(env)[imageModel];
  if (
    authorizeModel(imageModel, knownModels, auth).allowed !== true ||
    imageConfig?.policy.visibility !== 'internal' ||
    !imageConfig.catalog.modalities?.input.includes('text') ||
    !imageConfig.catalog.modalities.output.includes('image')
  ) {
    return fail(403, 'The image tool model is not authorized.', 'gateway_image_tool_model_unauthorized');
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((entry) => entry && typeof entry === 'object' && entry.role === 'user');
  const prompt = lastUser ? extractOpenAITextContent(lastUser.content).trim() : '';
  const imageBody = { model: imageModel, prompt, size: options.aig_image_size ?? '1024x1024', n: 1, response_format: 'b64_json' };
  const validationError = validateImageGenerationRequest(imageBody);
  if (validationError) return fail(400, validationError, 'gateway_image_tool_invalid_request');

  const headers = new Headers({ 'content-type': 'application/json' });
  for (const name of ['authorization', 'x-api-key', 'x-gateway-deadline-ms']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let response: Response;
  try {
    response = await execute(
      new Request(new URL('/v1/images/generations', request.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(imageBody),
        signal: request.signal,
      }),
    );
  } catch {
    return fail(502, 'Image tool result is unknown and must not be retried automatically.', 'gateway_image_tool_outcome_unknown');
  }
  // A generation attempt is potentially billable. Never replay it after an
  // unknown outcome, even if a transient upstream status was returned.
  if (!response.ok) {
    return fail(502, 'Image generation failed; automatic replay disabled.', 'gateway_image_tool_failed');
  }
  const result = await readBodyTextBounded(response, MAX_IMAGE_TOOL_REPLY);
  if (result.isTruncated || !result.text) {
    return fail(502, 'Image tool reply is missing or too large.', 'gateway_image_tool_reply_invalid');
  }
  let image: unknown;
  try {
    const json = JSON.parse(result.text) as { data?: Array<{ b64_json?: unknown }> };
    image = json.data?.[0]?.b64_json;
  } catch {
    // A malformed reply is terminal: do not start another paid generation.
  }
  if (typeof image !== 'string' || !image || image.length > MAX_IMAGE_TOOL_REPLY) {
    return fail(502, 'Image tool returned no valid image.', 'gateway_image_tool_reply_invalid');
  }
  // Explicit Chat integration uses Markdown data URI. Clients must opt into
  // rendering it; ordinary Chat requests and tool invocation remain distinct.
  const content = `![Generated image](data:image/png;base64,${image})`;
  const completion = {
    id: `chatcmpl-image-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
  if (body.stream === true) {
    return synthesizeSseFromCompletion(completion, env, request, { 'x-gateway-image-tool': 'true', 'cache-control': 'no-store' });
  }
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-gateway-image-tool': 'true',
      'x-request-id': requestId,
      ...corsHeaders(request, env),
    },
  });
}
