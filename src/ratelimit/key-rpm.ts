// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

type KeyStateEntry = {
  stamps: number[];
  cap: number;
};

type KeyAdmissionVerdict = { ok: true } | { ok: false; retryAfterSec: number };

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 5_000;

const keyState: Map<string, KeyStateEntry> = new Map();

function touchEntry<T>(entries: Map<string, T>, key: string, value: T): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size <= MAX_TRACKED_KEYS) return;
  const oldest = entries.keys().next();
  if (!oldest.done) entries.delete(oldest.value);
}

function pruneWindow(stamps: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < stamps.length && (stamps[drop] ?? Infinity) < cutoff) drop += 1;
  if (drop > 0) stamps.splice(0, drop);
}

export function admitKeyRequest(groupFingerprint: string, cap: number, now: number = Date.now()): KeyAdmissionVerdict {
  if (!cap || cap <= 0) return { ok: true };
  let entry = keyState.get(groupFingerprint);
  if (!entry) entry = { stamps: [], cap };
  touchEntry(keyState, groupFingerprint, entry);
  pruneWindow(entry.stamps, now);
  entry.cap = cap;
  if (entry.stamps.length >= cap) {
    const oldest = entry.stamps[0];
    if (oldest === undefined) return { ok: true };
    const retryAfterMs = Math.max(1, oldest + WINDOW_MS - now);
    return { ok: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  entry.stamps.push(now);
  return { ok: true };
}

type AuthFailureEntry = {
  stamps: number[];
};

const authFailureState: Map<string, AuthFailureEntry> = new Map();

export function admitAuthAttempt(fingerprint: string, cap: number, now: number = Date.now()): KeyAdmissionVerdict {
  if (!cap || cap <= 0) return { ok: true };
  const entry = authFailureState.get(fingerprint);
  if (!entry) return { ok: true };
  pruneWindow(entry.stamps, now);
  if (entry.stamps.length < cap) return { ok: true };
  const oldest = entry.stamps[0];
  if (oldest === undefined) return { ok: true };
  const retryAfterMs = Math.max(1, oldest + WINDOW_MS - now);
  return { ok: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
}

export function hasTrackedAuthFailures(): boolean {
  return authFailureState.size > 0;
}

export function recordAuthFailure(fingerprint: string, now: number = Date.now()): void {
  let entry = authFailureState.get(fingerprint);
  if (!entry) entry = { stamps: [] };
  touchEntry(authFailureState, fingerprint, entry);
  pruneWindow(entry.stamps, now);
  entry.stamps.push(now);
}

export function clearAuthFailures(fingerprint: string): void {
  authFailureState.delete(fingerprint);
}

export function getKeyRpmSnapshot(groupFingerprint: string, now: number = Date.now()): { used: number; cap: number } {
  const entry = keyState.get(groupFingerprint);
  if (!entry) return { used: 0, cap: 0 };
  pruneWindow(entry.stamps, now);
  return { used: entry.stamps.length, cap: entry.cap };
}

export function __resetKeyRpmForTests(): void {
  keyState.clear();
  authFailureState.clear();
}
