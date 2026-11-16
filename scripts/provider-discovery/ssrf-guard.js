import { lookup as defaultDnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';


const LOOPBACK_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function isLoopbackHostname(host) {
  const h = String(host || '').toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function isLinkLocalIpv4(host) {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateIpv4(host) {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function isLinkLocalIpv6(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|]$/g, '');
  return h.startsWith('fe80:') || h === '::' || h.startsWith('fc') || h.startsWith('fd');
}

function mappedIpv4FromIpv6(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|]$/g, '');
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  return match ? match[1] : null;
}

export function isDangerousHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|]$/g, '');
  if (!h) return true;
  const mappedIpv4 = mappedIpv4FromIpv6(h);
  if (mappedIpv4 && isDangerousHost(mappedIpv4)) return true;
  if (isLoopbackHostname(h)) return true;
  if (isLinkLocalIpv4(h)) return true;
  if (isPrivateIpv4(h)) return true;
  if (isLinkLocalIpv6(h)) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  if (h === '0.0.0.0' || h === '::') return true;
  return false;
}

export function isSafeDiscoveryUrl(raw, allowPrivate = false) {
  if (typeof raw !== 'string') return { safe: false, reason: 'not a string' };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { safe: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'https:') return { safe: false, reason: 'must use https' };
  if (u.username || u.password) return { safe: false, reason: 'userinfo forbidden' };
  const host = u.hostname;
  if (!host) return { safe: false, reason: 'missing host' };
  if (!allowPrivate && isDangerousHost(host)) {
    return { safe: false, reason: `blocked host "${host}" (loopback/link-local/private/metadata)` };
  }
  return { safe: true, reason: null };
}


export const DISCOVERY_LIMITS = Object.freeze({
  connectTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  maxResponseBytes: 5 * 1024 * 1024,  
  maxModelCount: 1_000,
  maxRedirects: 3,
});

async function lookupAllWithTimeout(host, lookupImpl) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(lookupImpl(host, { all: true, verbatim: true })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), DISCOVERY_LIMITS.connectTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function isSafeDiscoveryTarget(raw, allowPrivate = false, lookupImpl = defaultDnsLookup) {
  const basic = isSafeDiscoveryUrl(raw, allowPrivate);
  if (!basic.safe || allowPrivate) return basic;

  const host = new URL(raw).hostname.replace(/^\[|]$/g, '');
  if (isIP(host)) return basic;

  let records;
  try {
    records = await lookupAllWithTimeout(host, lookupImpl);
  } catch (error) {
    return { safe: false, reason: `DNS resolution failed for "${host}": ${String(error?.message || error)}` };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { safe: false, reason: `DNS resolution returned no addresses for "${host}"` };
  }

  for (const record of records) {
    const address = typeof record === 'string' ? record : record?.address;
    if (typeof address !== 'string' || isIP(address) === 0) {
      return { safe: false, reason: `DNS resolution returned an invalid address for "${host}"` };
    }
    if (isDangerousHost(address)) {
      return { safe: false, reason: `DNS for "${host}" resolved to blocked address "${address}"` };
    }
  }
  return basic;
}

export function redirectTargetIsSafe(locationHeader, allowPrivate = false) {
  if (typeof locationHeader !== 'string' || !locationHeader.trim()) return false;
  return isSafeDiscoveryUrl(locationHeader, allowPrivate).safe;
}

export async function readBoundedResponseText(response, maxBytes = DISCOVERY_LIMITS.maxResponseBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    return text;
  }
  let received = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { reader.cancel(); } catch {   }
      throw new Error(`response exceeds ${maxBytes} bytes (received ${received})`);
    }
    chunks.push(value);
  }
  const total = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(total);
}

export function enforceMaxModelCount(models, max = DISCOVERY_LIMITS.maxModelCount) {
  if (!Array.isArray(models)) return models;
  if (models.length > max) {
    throw new Error(`provider returned ${models.length} models (max ${max})`);
  }
  return models;
}
