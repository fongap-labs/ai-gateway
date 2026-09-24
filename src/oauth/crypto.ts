// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AES-GCM token encryption for Tier 2 subscription credentials.
//
// The AIG_TOKEN_ENCRYPTION_KEY Worker secret holds a base64-encoded 256-bit
// raw key. Tokens are never stored in D1 as plaintext: an account-level D1
// read without the Worker secret must not yield usable upstream tokens.
// A missing or malformed key fails closed — the OAuth store refuses to write
// or resolve tokens rather than degrading to plaintext storage.

const KEY_BYTES = 32;
const IV_BYTES = 12;

export type EncryptedSecret = {
  ciphertextB64: string,
  ivB64: string,
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
  const raw = typeof env?.AIG_TOKEN_ENCRYPTION_KEY === 'string'
    ? (env.AIG_TOKEN_ENCRYPTION_KEY as string).trim() : '';
  if (cachedKeyMaterial === raw && cachedKeyPromise) return cachedKeyPromise;
  cachedKeyMaterial = raw;
  if (!raw) {
    cachedKeyPromise = Promise.resolve(null);
    return cachedKeyPromise;
  }
  cachedKeyPromise = importKey(raw);
  return cachedKeyPromise;
}

export async function encryptSecret(
  env: Record<string, unknown>,
  plaintext: string,
): Promise<EncryptedSecret | null> {
  const key = await loadTokenKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource }, key, encoded as BufferSource);
    const cipherBytes = new Uint8Array(ciphertext);
    let cipherB64 = '';
    for (const byte of cipherBytes) cipherB64 += String.fromCharCode(byte);
    let ivRaw = '';
    for (const byte of iv) ivRaw += String.fromCharCode(byte);
    return { ciphertextB64: btoa(cipherB64), ivB64: btoa(ivRaw) };
  } catch {
    return null;
  }
}

export async function decryptSecret(
  env: Record<string, unknown>,
  secret: EncryptedSecret,
): Promise<string | null> {
  const key = await loadTokenKey(env);
  if (!key) return null;
  try {
    const cipherBytes = atob(secret.ciphertextB64);
    const cipher = new Uint8Array(cipherBytes.length);
    for (let i = 0; i < cipherBytes.length; i++) cipher[i] = cipherBytes.charCodeAt(i);
    const ivBytes = atob(secret.ivB64);
    if (ivBytes.length !== IV_BYTES) return null;
    const iv = new Uint8Array(IV_BYTES);
    for (let i = 0; i < IV_BYTES; i++) iv[i] = ivBytes.charCodeAt(i);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource }, key, cipher as BufferSource);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export function hasTokenKey(env: Record<string, unknown>): boolean {
  return typeof env?.AIG_TOKEN_ENCRYPTION_KEY === 'string'
    && !!(env.AIG_TOKEN_ENCRYPTION_KEY as string).trim();
}

export function __resetTokenKeyCacheForTests(): void {
  cachedKeyMaterial = undefined;
  cachedKeyPromise = undefined;
}
