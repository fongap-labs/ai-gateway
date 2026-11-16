import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { loadAccessKeysConfig } from '../../../src/config/access-keys.ts';
import type { AuthResult } from '../../../src/types/request.ts';

export type { AuthResult };

function sha256Digest(text: unknown): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
}

const MAX_CACHED_SECRET_DIGESTS = 32;
const secretDigests = new Map<string, Promise<Uint8Array>>();

function secretDigest(secret: string): Promise<Uint8Array> {
  let digest = secretDigests.get(secret);
  if (!digest) {
    if (secretDigests.size >= MAX_CACHED_SECRET_DIGESTS) secretDigests.clear();
    digest = sha256Digest(secret).then((buffer) => new Uint8Array(buffer));
    secretDigests.set(secret, digest);
  }
  return digest;
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return result === 0;
}

function parseBearer(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  const token = raw.slice(7).trim();
  return token || '';
}

export function presentedCredentials(request: Request): string[] {
  const bearer = parseBearer(request.headers.get('authorization'));
  const xApiKey = String(request.headers.get('x-api-key') || '').trim();
  const presented: string[] = [];
  if (bearer) presented.push(bearer);
  if (xApiKey) presented.push(xApiKey);
  return presented;
}

export async function authorize(request: Request, env: GatewayEnv): Promise<AuthResult> {
  return authorizeCredentials(presentedCredentials(request), env);
}

export async function authorizeCredentials(credentials: readonly string[], env: GatewayEnv): Promise<AuthResult> {
  const presented = credentials.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (presented.length === 0) return { authorized: false, mode: 'none' };

  const access = loadAccessKeysConfig(env);
  if (access.keys.length === 0) return { authorized: false, mode: 'none' };

  const candidateDigests = await Promise.all(presented.map((c) => sha256Digest(c)));
  for (const key of access.keys) {
    if (!key.secret) continue;
    const expected = await secretDigest(key.secret);
    for (const candidate of candidateDigests) {
      if (constantTimeEquals(new Uint8Array(candidate), expected)) {
        return {
          authorized: true,
          mode: 'grouped',
          group: key.group,
          allowAll: key.allowAll,
          allowlist: key.allowAll ? undefined : new Set(key.allowlist),
        };
      }
    }
  }

  return { authorized: false, mode: 'grouped' };
}
