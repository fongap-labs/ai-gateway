// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OAuth HTTP routes for Tier 2 subscription onboarding.
//
//   GET /oauth/start?provider=<name>&node=<node-id>
//     Requires a gateway access key. Redirects to the provider authorize URL.
//   GET /oauth/callback/<provider>?code=...&state=...
//     Automatic callback for PKCE clients that accept arbitrary redirect URIs.
//   GET /oauth/paste?state=...
//   POST /oauth/paste  (form: state=...&code=...)
//     Manual code-paste flow for providers whose OAuth client does not allow
//     arbitrary redirect URIs (e.g., Google Gemini CLI).

import { getOAuthProvider, isManualPasteProvider, resolveRedirectUri } from './provider-configs.ts';
import type { OAuthProviderConfig } from './provider-configs.ts';
import { saveFlowState, loadFlowState, deleteFlowState, storeSubscriptionToken, purgeExpiredFlowStates, OAUTH_FLOW_TTL_MS } from './token-store.ts';
import { hasTokenKey } from './crypto.ts';
import { authorize } from '../request/auth.ts';
import { corsHeaders } from '../protocol/http.ts';
import { getLogger } from '../observability/logger.ts';
import type { GatewayEnv } from '../types/runtime.ts';

const HTML_AMP = String.fromCharCode(38);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, HTML_AMP + 'amp;')
    .replace(/</g, HTML_AMP + 'lt;')
    .replace(/>/g, HTML_AMP + 'gt;')
    .replace(/"/g, HTML_AMP + 'quot;');
}

function htmlPage(status: number, bodyHtml: string): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ai-gateway oauth</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#111}`
    + `h1{font-size:1.2rem}code{background:#f4f4f4;padding:0 0.3rem;border-radius:4px}`
    + `form{margin:1rem 0}input[type=text]{width:100%;padding:0.5rem;margin:0.5rem 0;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}`
    + `button{padding:0.5rem 1rem;background:#0052cc;color:#fff;border:none;border-radius:4px;cursor:pointer}</style></head>`
    + `<body>${bodyHtml}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function htmlResponse(status: number, title: string, detail: string): Response {
  return htmlPage(status, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`);
}

function jsonResponse(request: Request, env: GatewayEnv, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(corsHeaders(request, env) || {}) },
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input) as BufferSource);
  return base64url(new Uint8Array(digest));
}

function publicBaseUrl(env: GatewayEnv): string | null {
  const raw = typeof env?.AIG_PUBLIC_URL === 'string' ? (env.AIG_PUBLIC_URL as string).trim() : '';
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export type OAuthRouteContext = {
  tier2Nodes: ReadonlyArray<{ id: string, provider: string, auth?: string }>,
};

function lookupNode(ctx: OAuthRouteContext, provider: string, nodeId: string): { found: boolean, providerMatches: boolean } {
  const node = ctx.tier2Nodes.find((c) => c.id === nodeId);
  if (!node) return { found: false, providerMatches: false };
  return { found: true, providerMatches: node.provider === provider && node.auth === 'oauth' };
}

type TokenExchangePayload = { access_token?: unknown, refresh_token?: unknown, expires_in?: unknown, account_id?: unknown };

async function exchangeCodeForTokens(
  providerConfig: OAuthProviderConfig, code: string, redirectUri: string, codeVerifier: string,
): Promise<{ ok: true, payload: TokenExchangePayload } | { ok: false }> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: providerConfig.clientId, code_verifier: codeVerifier,
  };
  if (providerConfig.clientSecret) params.client_secret = providerConfig.clientSecret;
  try {
    const response = await fetch(providerConfig.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) return { ok: false };
    return { ok: true, payload: await response.json() as TokenExchangePayload };
  } catch { return { ok: false }; }
}

function resolveExpiry(payload: TokenExchangePayload): { expiresInSec: number, refreshToken: string | null } {
  const expiresInSec = typeof payload.expires_in === 'number' ? payload.expires_in
    : (typeof payload.expires_in === 'string' && /^\d+$/.test(payload.expires_in) ? Number(payload.expires_in) : 3600);
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : null;
  return { expiresInSec, refreshToken };
}

async function completeTokenExchange(env: GatewayEnv, providerConfig: OAuthProviderConfig, providerName: string, code: string, redirectUri: string, codeVerifier: string, nodeId: string): Promise<Response> {
  const logger = getLogger(env);
  const exchanged = await exchangeCodeForTokens(providerConfig, code, redirectUri, codeVerifier);
  if (!exchanged.ok || typeof exchanged.payload.access_token !== 'string' || !exchanged.payload.access_token) {
    logger.error(`oauth token exchange failed for node=${nodeId}`);
    return htmlResponse(502, 'Token exchange failed', 'Restart onboarding from /oauth/start.');
  }
  const { expiresInSec, refreshToken } = resolveExpiry(exchanged.payload);
  const accountId = typeof exchanged.payload.account_id === 'string' && exchanged.payload.account_id.trim()
    ? exchanged.payload.account_id.trim() : null;
  const stored = await storeSubscriptionToken(env, {
    nodeId, provider: providerName,
    accessToken: exchanged.payload.access_token, refreshToken,
    accountId,
    expiresAt: Date.now() + expiresInSec * 1000,
  });
  if (!stored) {
    logger.error(`oauth token persist failed for node=${nodeId}`);
    return htmlResponse(503, 'Token storage failed', 'Check AIG_TOKEN_ENCRYPTION_KEY and D1, then retry.');
  }
  logger.info(`oauth subscription token stored node=${nodeId} provider=${providerName}`);
  return htmlResponse(200, 'Subscription linked', `Node ${escapeHtml(nodeId)} is now authorized.`);
}

// ---- GET /oauth/start -------------------------------------------------------

async function handleOAuthStart(request: Request, env: GatewayEnv, ctx: OAuthRouteContext, url: URL): Promise<Response> {
  const logger = getLogger(env);
  if (!hasTokenKey(env)) return jsonResponse(request, env, 503, { error: { message: 'AIG_TOKEN_ENCRYPTION_KEY is not configured.', type: 'gateway_oauth_disabled' } });
  const authResult = await authorize(request, env);
  if (!authResult.authorized) return jsonResponse(request, env, 401, { error: { message: 'Gateway access key required.', type: 'gateway_oauth_unauthorized' } });
  const provider = (url.searchParams.get('provider') || '').trim().toLowerCase();
  const nodeId = (url.searchParams.get('node') || '').trim();
  if (!provider || !nodeId) return jsonResponse(request, env, 400, { error: { message: 'Missing provider or node parameter.', type: 'gateway_oauth_bad_request' } });
  const providerConfig = getOAuthProvider(env, provider);
  if (!providerConfig) return jsonResponse(request, env, 404, { error: { message: `Unknown provider "${provider}".`, type: 'gateway_oauth_unknown_provider' } });
  const nodeLookup = lookupNode(ctx, provider, nodeId);
  if (!nodeLookup.found) return jsonResponse(request, env, 404, { error: { message: `Node "${nodeId}" not found.`, type: 'gateway_oauth_unknown_node' } });
  if (!nodeLookup.providerMatches) return jsonResponse(request, env, 400, { error: { message: `Node "${nodeId}" is not a Tier 2 auth:"oauth" node for provider "${provider}".`, type: 'gateway_oauth_node_mismatch' } });
  const base = publicBaseUrl(env);
  const redirectUri = resolveRedirectUri(providerConfig, base || '', provider);
  if (!redirectUri) return jsonResponse(request, env, 503, { error: { message: 'Cannot derive redirect URI (AIG_PUBLIC_URL missing).', type: 'gateway_oauth_disabled' } });

  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const saved = await saveFlowState(env, { state, provider, node_id: nodeId, code_verifier: codeVerifier, created_at: Date.now() });
  if (!saved) { logger.error('oauth flow state persist failed'); return jsonResponse(request, env, 503, { error: { message: 'Flow state storage unavailable.', type: 'gateway_oauth_store_unavailable' } }); }
  void purgeExpiredFlowStates(env);

  const authorizeUrl = new URL(providerConfig.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', providerConfig.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('scope', providerConfig.scope);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  if (isManualPasteProvider(providerConfig)) {
    const pasteUrl = base ? `${base}/oauth/paste?state=${encodeURIComponent(state)}` : '/oauth/paste';
    return htmlPage(200,
      `<meta http-equiv="refresh" content="0; url=${escapeHtml(authorizeUrl.toString())}">`
      + `<h1>Redirecting to authorization...</h1>`
      + `<p>After authorizing, copy the code and paste it at <a href="${escapeHtml(pasteUrl)}">${escapeHtml(pasteUrl)}</a>.</p>`
      + `<p>Not redirected? <a href="${escapeHtml(authorizeUrl.toString())}">Click here</a>.</p>`);
  }
  return new Response(null, { status: 302, headers: { location: authorizeUrl.toString(), 'cache-control': 'no-store' } });
}

// ---- GET /oauth/callback/<provider> (automatic) ----------------------------

async function handleOAuthCallback(env: GatewayEnv, url: URL, pathProvider: string): Promise<Response> {
  void purgeExpiredFlowStates(env);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (url.searchParams.get('error')) return htmlResponse(400, 'Authorization failed', `Provider error: ${escapeHtml(url.searchParams.get('error') || '')}`);
  if (!code || !state) return htmlResponse(400, 'Invalid callback', 'Missing code or state.');
  const flow = await loadFlowState(env, state);
  await deleteFlowState(env, state);
  if (!flow) return htmlResponse(400, 'Unknown state', 'Restart onboarding from /oauth/start.');
  if (flow.provider !== pathProvider) return htmlResponse(400, 'Provider mismatch', 'Restart onboarding.');
  if (Date.now() - flow.created_at > OAUTH_FLOW_TTL_MS) return htmlResponse(400, 'Expired', 'Restart onboarding from /oauth/start.');
  const providerConfig = getOAuthProvider(env, flow.provider);
  if (!providerConfig) return htmlResponse(503, 'Provider gone', 'The provider is no longer configured.');
  const redirectUri = resolveRedirectUri(providerConfig, publicBaseUrl(env) || '', flow.provider);
  if (!redirectUri) return htmlResponse(503, 'Misconfigured', 'Cannot reconstruct redirect URI.');
  return completeTokenExchange(env, providerConfig, flow.provider, code, redirectUri, flow.code_verifier, flow.node_id);
}

// ---- GET+POST /oauth/paste (manual code-paste for Google etc.) ------------

async function handleOAuthPasteGet(env: GatewayEnv, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') || '';
  if (!state) return htmlResponse(400, 'Missing state', 'Open the paste URL from the /oauth/start page.');
  const flow = await loadFlowState(env, state);
  if (!flow) return htmlResponse(400, 'Unknown state', 'This paste link is invalid or expired. Restart from /oauth/start.');
  if (Date.now() - flow.created_at > OAUTH_FLOW_TTL_MS) { await deleteFlowState(env, state); return htmlResponse(400, 'Expired', 'Restart onboarding from /oauth/start.'); }
  return htmlPage(200,
    `<h1>Paste authorization code</h1>`
    + `<p>Provider: <code>${escapeHtml(flow.provider)}</code> | Node: <code>${escapeHtml(flow.node_id)}</code></p>`
    + `<form method="POST" action="/oauth/paste">`
    + `<input type="hidden" name="state" value="${escapeHtml(state)}">`
    + `<input type="text" name="code" placeholder="Paste the code from the provider here" autofocus>`
    + `<button type="submit">Complete authorization</button></form>`);
}

async function handleOAuthPastePost(env: GatewayEnv, request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') || '';
  let state = '', code = '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(await request.text());
    state = form.get('state') || '';
    code = form.get('code') || '';
  } else {
    return htmlResponse(400, 'Bad request', 'Expected form-urlencoded body.');
  }
  if (!state || !code) return htmlResponse(400, 'Missing data', 'Both state and code are required.');
  const flow = await loadFlowState(env, state);
  await deleteFlowState(env, state);
  if (!flow) return htmlResponse(400, 'Unknown state', 'This paste link is invalid or already used. Restart from /oauth/start.');
  if (Date.now() - flow.created_at > OAUTH_FLOW_TTL_MS) return htmlResponse(400, 'Expired', 'Restart onboarding from /oauth/start.');
  const providerConfig = getOAuthProvider(env, flow.provider);
  if (!providerConfig) return htmlResponse(503, 'Provider gone', 'The provider is no longer configured.');
  const redirectUri = providerConfig.manualRedirectUrl || resolveRedirectUri(providerConfig, publicBaseUrl(env) || '', flow.provider);
  if (!redirectUri) return htmlResponse(503, 'Misconfigured', 'Cannot reconstruct redirect URI.');
  return completeTokenExchange(env, providerConfig, flow.provider, code.trim(), redirectUri, flow.code_verifier, flow.node_id);
}

// ---- Route dispatcher -------------------------------------------------------

export async function handleOAuthRoute(request: Request, env: GatewayEnv, ctx: OAuthRouteContext, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  if (pathname === '/oauth/start') return handleOAuthStart(request, env, ctx, url);
  const callbackMatch = /^\/oauth\/callback\/([a-z0-9][a-z0-9-]{0,63})$/.exec(pathname);
  if (callbackMatch?.[1]) return handleOAuthCallback(env, url, callbackMatch[1]);
  if (pathname === '/oauth/paste') {
    return request.method === 'POST'
      ? handleOAuthPastePost(env, request)
      : handleOAuthPasteGet(env, url);
  }
  return jsonResponse(request, env, 404, { error: { message: 'OAuth route not found. Use /oauth/start, /oauth/callback/<provider>, or /oauth/paste.', type: 'gateway_oauth_not_found' } });
}
