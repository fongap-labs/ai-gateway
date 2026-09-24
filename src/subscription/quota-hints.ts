// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Quota-window reset hint extraction for subscription upstreams.
//
// Subscription entitlement backends announce their quota windows in
// provider-specific places (absolute epoch timestamps, relative seconds,
// ISO strings in error bodies). These are HINTS, never truth: the caller
// caps the resulting cooldown and keeps its own recovery model (cooldown
// expiry -> probe -> restore). Each adapter declares the marker names it
// trusts for its provider instead of guessing every provider's shape here.

/** Maximum hint-derived wait: quota windows are typically minutes to
 *  hours; anything larger is treated as suspect data, not a window. */
export const QUOTA_HINT_MAX_MS = 6 * 60 * 60 * 1000;

function parseEpochSecondsOrMs(raw: string): number | null {
  if (!/^\d{9,16}$/.test(raw)) return null;
  const value = Number(raw);
  // Epoch seconds vs milliseconds disambiguated by magnitude.
  return value > 1e12 ? value : value * 1000;
}

function parseIsoTimestamp(raw: string): number | null {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse one marker value into a wall-clock reset time, or null. */
function parseResetValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return parseEpochSecondsOrMs(trimmed) ?? parseIsoTimestamp(trimmed);
}

/** Absolute reset markers: header names whose VALUE is the reset
 *  instant (epoch seconds / ms / ISO). */
export function hintFromResetHeaders(headers: Headers, names: readonly string[], now: number): number | null {
  let best: number | null = null;
  for (const name of names) {
    const raw = headers.get(name);
    if (!raw) continue;
    const at = parseResetValue(raw);
    if (at !== null && at > now && (best === null || at > best)) best = at;
  }
  return best;
}

/** Relative-seconds markers: header names whose VALUE is seconds until
 *  the window resets (e.g. x-ratelimit-*-reset on Anthropic-shaped
 *  upstreams carry remaining seconds). */
export function hintFromSecondsHeaders(headers: Headers, names: readonly string[]): number | null {
  let best: number | null = null;
  for (const name of names) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= QUOTA_HINT_MAX_MS) {
      const ms = seconds * 1000;
      if (best === null || ms > best) best = ms;
    }
  }
  return best;
}

/** Body JSON fields carrying seconds-until-reset (e.g. resets_in_seconds
 *  on Anthropic quota errors) or absolute reset instants. */
export function hintFromResetBody(body: string, fields: readonly string[]): number | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  let best: number | null = null;
  for (const field of fields) {
    const raw = record[field];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const at = typeof raw === 'number'
      ? (raw > 1e12 ? raw : raw * 1000) // epoch seconds or ms
      : parseResetValue(String(raw));
    if (at !== null && (best === null || at > best)) best = at;
  }
  return best;
}

/** Collapse the per-marker results into one capped hint (ms until reset
 *  relative to now), or null when nothing usable was found. */
export function capHint(resetAt: number | null, relativeMs: number | null, now: number): number | null {
  const candidates: number[] = [];
  if (resetAt !== null) {
    const ms = resetAt - now;
    if (ms > 0 && ms <= QUOTA_HINT_MAX_MS) candidates.push(ms);
  }
  if (relativeMs !== null && relativeMs > 0) candidates.push(relativeMs);
  if (candidates.length === 0) return null;
  return Math.min(Math.max(...candidates), QUOTA_HINT_MAX_MS);
}
