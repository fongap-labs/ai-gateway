// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

export const TIER_ORDER: readonly [1, 2, 3] = [1, 2, 3];

export type DetectedRoute =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'anthropic_count_tokens'
  | 'health'
  | 'metrics'
  | 'models'
  | 'other';

export function normalizePath(pathname: string | undefined): string {
  const raw = String(pathname || '/');
  // 1) Normalize: collapse redundant slashes, decode, drop query strings, lowercase.
  let normalized = raw;
  try {
    // Parse against a dummy host to extract the pathname, which also resolves
    // doubled slashes, percent-encoded separators, and query strings.
    const url = new URL(raw, 'http://x');
    normalized = url.pathname;
  } catch {
    // Non-standard input (for example a bare path without a host) falls back to the raw value.
    normalized = raw;
  }
  // 2) Strip trailing slashes and lowercase.
  normalized = normalized.replace(/\/+$/, '').toLowerCase();
  // 3) Fold the doubled /v1/v1/ prefix emitted by the Anthropic SDK.
  if (normalized.startsWith('/v1/v1/')) {
    normalized = normalized.replace(/^\/v1\/v1\//, '/v1/');
  }
  return normalized || '/';
}

export function detectRoute(method: string, pathname: string): DetectedRoute {
  const verb = String(method).toUpperCase();
  if (verb === 'GET') {
    if (pathname === '/health') return 'health';
    if (pathname === '/metrics') return 'metrics';
    if (pathname === '/v1/models' || pathname === '/models') return 'models';
    return 'other';
  }
  if (verb !== 'POST') return 'other';
  if (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens') return 'anthropic_count_tokens';
  if (pathname === '/v1/messages' || pathname === '/messages') return 'anthropic_messages';
  if (pathname === '/v1/responses' || pathname === '/responses') return 'openai_responses';
  if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') return 'openai_chat';
  return 'other';
}

export function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') || '').includes('text/html');
}
