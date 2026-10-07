// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AES-GCM token encryption for Tier 2 subscription credentials.
//
// The AIG_TOKEN_ENCRYPTION_KEY Worker secret holds a base64-encoded 256-bit
// raw key. Tokens are never stored in D1 as plaintext: an account-level D1
// read without the Worker secret must not yield usable upstream tokens.
// A missing or malformed key fails closed - the OAuth store refuses to write
// or resolve tokens rather than degrading to plaintext storage.

const KEY_BYTES = 32;
const IV_BYTES = 12;
// Ciphertext written with additional authenticated data starts with this marker. Earlier rows have
// no marker and are decrypted without AAD; they are rewritten with it the next time they are saved.
const V2_PREFIX = 'v2.';

// Binds a ciphertext to the row it belongs to, so copying the encrypted columns of one node onto
// another node (or swapping the access and refresh columns) fails authentication.
export type SecretContext = { nodeId: string; provider: string; field: 'access' | 'refresh' };

function additionalData(context: SecretContext): BufferSource {
  return new TextEncoder().encode(`aig-token-v2|${context.nodeId}|${context.provider}|${context.field}`) as BufferSource;
}

export type EncryptedSecret = {
  ciphertextB64: string;
  ivB64: string;
};

let cachedKeyMaterial: string | undefined;
let cachedKeyPromise: Promise<CryptoKey | null> | undefined;

function importKey(rawMaterial: string): Promise<CryptoKey | null> {
  try {
    const decoded = atob(rawMaterial);
    if (decoded.length !== KEY_BYTES) return Promise.resolve(null);
    const bytes = new Uint8Array(KEY_BYTES);
    for (let i = 0; i < KEY_BYTES; i++) bytes[i] = decoded.charCodeAt(i);
    return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch {
    return Promise.resolve(null);
  }
}

// Resolve the AES-GCM key for this isolate. Returns null when the secret is
// missing or malformed (fail-closed: callers refuse plaintext storage).
export async function loadTokenKey(env: Record<string, unknown>): Promise<CryptoKey | null> {
  const raw = typeof env?.AIG_TOKEN_ENCRYPTION_KEY === 'string' ? (env.AIG_TOKEN_ENCRYPTION_KEY as string).trim() : '';
  if (cachedKeyMaterial === raw && cachedKeyPromise) return cachedKeyPromise;
  cachedKeyMaterial = raw;
  if (!raw) {
    cachedKeyPromise = Promise.resolve(null);
    return cachedKeyPromise;
  }
  cachedKeyPromise = importKey(raw);
  return cachedKeyPromise;
}

export async function encryptSecret(env: Record<string, unknown>, plaintext: string, context?: SecretContext): Promise<EncryptedSecret | null> {
  const key = await loadTokenKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  try {
    const algorithm: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource, ...(context ? { additionalData: additionalData(context) } : {}) };
    const ciphertext = await crypto.subtle.encrypt(algorithm, key, encoded as BufferSource);
    const cipherBytes = new Uint8Array(ciphertext);
    let cipherB64 = '';
    for (const byte of cipherBytes) cipherB64 += String.fromCharCode(byte);
    let ivRaw = '';
    for (const byte of iv) ivRaw += String.fromCharCode(byte);
    return { ciphertextB64: (context ? V2_PREFIX : '') + btoa(cipherB64), ivB64: btoa(ivRaw) };
  } catch {
    return null;
  }
}

export async function decryptSecret(env: Record<string, unknown>, secret: EncryptedSecret, context?: SecretContext): Promise<string | null> {
  const key = await loadTokenKey(env);
  if (!key) return null;
  const isV2 = secret.ciphertextB64.startsWith(V2_PREFIX);
  // A bound ciphertext cannot be opened without saying which row it should belong to.
  if (isV2 && !context) return null;
  try {
    const cipherBytes = atob(isV2 ? secret.ciphertextB64.slice(V2_PREFIX.length) : secret.ciphertextB64);
    const cipher = new Uint8Array(cipherBytes.length);
    for (let i = 0; i < cipherBytes.length; i++) cipher[i] = cipherBytes.charCodeAt(i);
    const ivBytes = atob(secret.ivB64);
    if (ivBytes.length !== IV_BYTES) return null;
    const iv = new Uint8Array(IV_BYTES);
    for (let i = 0; i < IV_BYTES; i++) iv[i] = ivBytes.charCodeAt(i);
    const algorithm: AesGcmParams = {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      ...(isV2 && context ? { additionalData: additionalData(context) } : {}),
    };
    const plaintext = await crypto.subtle.decrypt(algorithm, key, cipher as BufferSource);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export function hasTokenKey(env: Record<string, unknown>): boolean {
  return typeof env?.AIG_TOKEN_ENCRYPTION_KEY === 'string' && !!(env.AIG_TOKEN_ENCRYPTION_KEY as string).trim();
}

export function __resetTokenKeyCacheForTests(): void {
  cachedKeyMaterial = undefined;
  cachedKeyPromise = undefined;
}
