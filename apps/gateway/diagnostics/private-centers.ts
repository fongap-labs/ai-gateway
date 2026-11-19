import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { resolveBuildSha } from '../../../src/observability/diagnostic-endpoints.ts';
import { corsHeaders } from '../../../src/protocol/http.ts';

type Status = 'ok' | 'missing-binding' | 'missing-key' | 'unauthorized' | 'unexpected-response' | 'auth-not-enforced' | 'transport-error' | 'timeout';
type PrivateBinding = { fetch(request: Request): Promise<Response> };
const PROBE_TIMEOUT_MS = 2500;
const MAX_PROBE_BODY_BYTES = 8192;
const SPECS = [
  {
    name: 'inference',
    binding: 'AIG_INFERENCE_SERVICE',
    secret: 'AIG_INFERENCE_AUTH_KEY',
    header: 'x-aig-inference-auth',
    path: '/internal/health',
    method: 'GET',
    success: 200,
  },
  {
    name: 'perception',
    binding: 'AIG_PERCEPTION_SERVICE',
    secret: 'AIG_PERCEPTION_AUTH_KEY',
    header: 'x-aig-perception-auth',
    path: '/internal/execute',
    method: 'POST',
    success: 400,
  },
  {
    name: 'generation',
    binding: 'AIG_GENERATION_SERVICE',
    secret: 'AIG_GENERATION_AUTH_KEY',
    header: 'x-aig-generation-auth',
    path: '/internal/health',
    method: 'GET',
    success: 200,
  },
] as const;

function isBinding(value: unknown): value is PrivateBinding {
  return value !== null && typeof value === 'object' && 'fetch' in value && typeof value.fetch === 'function';
}

function withSignalTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Private-center probe timed out'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

async function readProbeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROBE_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await withSignalTimeout(reader.read(), signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_PROBE_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (signal.aborted) void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out pending read can keep the reader locked until cancellation settles.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isExpectedPositive(body: unknown, name: string): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const data = body as Record<string, unknown>;
  if (name !== 'perception') return data.status === 'ok' && data.center === name;
  const error = data.error;
  return (
    error !== null && typeof error === 'object' && !Array.isArray(error) && (error as Record<string, unknown>).code === 'center_contract_invalid'
  );
}

async function checkCenter(env: GatewayEnv, spec: (typeof SPECS)[number]): Promise<Status> {
  const binding = env[spec.binding];
  if (!isBinding(binding)) return 'missing-binding';
  const secret = env[spec.secret];
  if (typeof secret !== 'string' || secret.length < 32) return 'missing-key';
  const url = `https://${spec.name}.internal${spec.path}`;
  let signal: AbortSignal | undefined;
  const makeRequest = (credential: string, requestSignal: AbortSignal) =>
    new Request(url, {
      method: spec.method,
      headers: { [spec.header]: credential },
      signal: requestSignal,
    });
  try {
    signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const authorized = await withSignalTimeout(binding.fetch(makeRequest(secret, signal)), signal);
    if (authorized.status === 403) return 'unauthorized';
    if (authorized.status !== spec.success) return 'unexpected-response';
    const body = await readProbeJson(authorized, signal);
    if (!isExpectedPositive(body, spec.name)) return 'unexpected-response';
    signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const rejected = await withSignalTimeout(binding.fetch(makeRequest('invalid', signal)), signal);
    if (rejected.status !== 403) return 'auth-not-enforced';
    return 'ok';
  } catch {
    return signal?.aborted ? 'timeout' : 'transport-error';
  }
}

export async function privateCenterProbeResponse(request: Request, env: GatewayEnv, requestId: string): Promise<Response> {
  const statuses = await Promise.all(SPECS.map(async (spec) => [spec.name, await checkCenter(env, spec)] as const));
  const centers = Object.fromEntries(statuses);
  const ready = statuses.every(([, status]) => status === 'ok');
  return new Response(
    JSON.stringify({
      build: resolveBuildSha(env),
      ready,
      status: ready ? 'ok' : 'degraded',
      centers,
    }),
    {
      status: ready ? 200 : 503,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
        ...corsHeaders(request, env),
      },
    },
  );
}
