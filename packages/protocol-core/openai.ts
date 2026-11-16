import { markSyntheticClientStreamHeaders } from '../transport/client-lifecycle.ts';
import { corsHeaders } from '../transport/http.ts';

export function validateOpenAIChatRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (!b.model || typeof b.model !== 'string' || !b.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(b.messages)) return 'messages is required and must be an array.';
  return null;
}

export function extractOpenAITextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') out += part;
    else if (part?.type === 'text' || part?.type === 'output_text') out += part.text || '';
  }
  return out;
}

export function isOpenAIStreamingResponse(response: Response): boolean {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

export function withUsageStreamOptions(body: Record<string, unknown>): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const existing = body.stream_options && typeof body.stream_options === 'object' && !Array.isArray(body.stream_options) ? body.stream_options : {};
  const streamOptions: Record<string, unknown> = { ...existing };
  if (streamOptions.include_usage === undefined) streamOptions.include_usage = true;
  return { ...body, stream_options: streamOptions };
}

export function synthesizeSseFromCompletion(
  data: Record<string, unknown> | null | undefined,
  env: Record<string, unknown>,
  request: Request,
  extraHeaders?: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const base = {
    id: data?.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: data?.created || Math.floor(Date.now() / 1000),
    model: data?.model,
  };
  const stream = new ReadableStream({
    start(controller) {
      const emit = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      for (const choice of choices) {
        const msg = choice.message || {};
        const delta: Record<string, unknown> = { role: msg.role || 'assistant' };
        if (msg.content) delta.content = msg.content;
        if (msg.reasoning_content) delta.reasoning_content = msg.reasoning_content;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) delta.tool_calls = msg.tool_calls;
        emit({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] });
      }
      for (const choice of choices) {
        const finish = { index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason || 'stop' };
        emit({ ...base, choices: [finish], ...(data?.usage ? { usage: data.usage } : {}) });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: markSyntheticClientStreamHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...(extraHeaders || {}),
      ...corsHeaders(request, env),
    }),
  });
}
