import { readEnv } from '../config-core/env.ts';
import { UPSTREAM_PROCESSING_ERROR, upstreamProcessingError } from '../contracts/upstream-processing.ts';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function corsHeaders(request: Request, env: Record<string, unknown>): Record<string, string> {
  const allowedOrigin = readEnv(env, 'AIG_CORS_ORIGIN');
  if (!allowedOrigin) return { ...SECURITY_HEADERS };
  const origin = normalizeAllowedOrigin(allowedOrigin);
  if (origin === null) return { ...SECURITY_HEADERS };
  const requested = String(request.headers.get('Access-Control-Request-Headers') || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const allowedRequestHeaders = new Set([
    'authorization',
    'x-api-key',
    'content-type',
    'accept',
    'idempotency-key',
    'anthropic-version',
    'anthropic-beta',
    'x-session-id',
    'x-gateway-deadline-ms',
  ]);
  const accepted = requested.filter((v) => allowedRequestHeaders.has(v));
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': accepted.length > 0 ? accepted.join(', ') : 'Authorization,X-Api-Key,Content-Type,Accept',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers':
      'X-Request-Id,Request-Id,Retry-After,X-Should-Retry,X-Gateway-Error-Code,X-Gateway-Retryable,X-Gateway-Budget-Exhausted,X-Gateway-Attempts,X-Gateway-Dispatches,X-Gateway-Hedges,X-Gateway-Failure-Kinds',
    ...SECURITY_HEADERS,
  };
  if (origin !== '*') headers.Vary = 'Origin';
  return headers;
}

function normalizeAllowedOrigin(value: string): string | null {
  if (value === '*') return '*';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function jsonError(
  request: Request,
  env: Record<string, unknown>,
  status: number,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
      ...(extraHeaders || {}),
    },
  });
}

export function htmlResponse(
  content: BodyInit,
  init?: { status?: number; headers?: Record<string, string>; nonce?: string; allowSelfForm?: boolean },
): Response {
  const nonce = init?.nonce ?? base64url(crypto.getRandomValues(new Uint8Array(16)));
  const formAction = init?.allowSelfForm ? "'self'" : "'none'";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`;
  return new Response(content, {
    status: init?.status ?? 200,
    headers: {
      ...init?.headers,
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'no-store',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildTargetUrl(baseUrl: string, upstreamPath: string): string {
  const base = new URL(baseUrl);
  let path = upstreamPath || '/';
  const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
  if ((basePath === '/v1' || basePath.endsWith('/v1')) && /^\/v1(?:\/|$)/i.test(path)) {
    path = path.replace(/^\/v1/i, '') || '/';
  }
  base.pathname = joinPath(base.pathname, path);
  base.search = '';
  return base.toString();
}

function joinPath(left: string | undefined, right: string | undefined): string {
  const a = String(left || '').replace(/\/+$/, '');
  const b = String(right || '').replace(/^\/+/, '');
  return `/${[a.replace(/^\/+/, ''), b].filter(Boolean).join('/')}`;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds limit.');
    this.name = 'BodyTooLargeError';
  }
}

export class BodyAdmissionBudgetError extends Error {
  constructor() {
    super('Gateway is busy with other large requests; retry shortly.');
    this.name = 'BodyAdmissionBudgetError';
  }
}

export async function readBodyTextWithLimit(request: Request, maxBytes: number, observeBytes?: (actualBytes: number) => boolean): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    if (observeBytes && !observeBytes(total)) {
      await reader.cancel().catch(() => {});
      throw new BodyAdmissionBudgetError();
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function readBodyTextBounded(
  response: Response,
  maxBytes: number = 4096,
  deadlineMs?: number | null,
): Promise<{ text: string; isTruncated: boolean }> {
  try {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) return { text: '[streaming body skipped]', isTruncated: false };
    const reader = response.body?.getReader();
    if (!reader) return { text: '', isTruncated: false };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let isTruncated = false;
    const deadline = deadlineMs && deadlineMs > 0 ? deadlineMs : null;
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      if (deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await reader.cancel().catch(() => {});
          return { text: '', isTruncated: false };
        }
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutP = new Promise<null>((resolve) => {
          timerId = setTimeout(() => resolve(null), remaining);
        });
        try {
          const raced = await Promise.race([
            reader.read().then((v) => ({ ok: true as const, value: v })),
            timeoutP.then(() => ({ ok: false as const })),
          ]);
          if (!raced.ok) {
            await reader.cancel().catch(() => {});
            return { text: '', isTruncated: false };
          }
          result = raced.value;
        } finally {
          clearTimeout(timerId);
        }
      } else {
        result = await reader.read();
      }
      if (result.done) break;
      const remaining = maxBytes - total;
      const slice = result.value.byteLength > remaining ? result.value.subarray(0, remaining) : result.value;
      chunks.push(slice);
      total += slice.byteLength;
      if (slice.byteLength < result.value.byteLength) {
        isTruncated = true;
        break;
      }
    }
    await reader.cancel().catch(() => {});
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(combined), isTruncated };
  } catch {
    return { text: '', isTruncated: false };
  }
}

export async function safeReadErrorBody(response: Response, maxBytes: number = 4096, deadlineMs?: number | null): Promise<string> {
  return (await readBodyTextBounded(response, maxBytes, deadlineMs)).text;
}

export const MAX_BUFFERED_REPLY_BYTES = 2 * 1024 * 1024;

export async function readBufferedReplyText(response: Response, deadlineMs?: number | null): Promise<string> {
  const { text, isTruncated } = await readBodyTextBounded(response, MAX_BUFFERED_REPLY_BYTES, deadlineMs);
  if (isTruncated) {
    throw upstreamProcessingError(
      UPSTREAM_PROCESSING_ERROR.TOO_LARGE,
      'Upstream reply exceeded the gateway buffered-response limit. Use stream:true.',
    );
  }
  return text;
}

export function trimDiagnostic(text: unknown, limit: number = 600): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

export function shouldNotRetryHeaders(status: number, isRetryable: boolean = false): Record<string, string> {
  if (status === 429 || status === 503 || isRetryable) return {};
  return { 'x-should-retry': 'false' };
}
