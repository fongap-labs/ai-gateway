// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OAuth provider configuration (Tier 2 subscription entitlements).
//
// Built-in defaults: the three mainstream international subscription
// providers (Anthropic Claude, OpenAI Codex, Google Gemini) ship with
// public OAuth constants extracted from their respective open-source CLIs.
// These values are public knowledge - not secrets - and are embedded so
// the operator can onboard subscriptions without manual configuration.
//
// Override: AIG_OAUTH_PROVIDERS (JSON Variable) may override any built-in
// provider or add new ones. User entries replace defaults at the provider
// level (not field-by-field). Unset AIG_OAUTH_PROVIDERS leaves the defaults
// in effect.
//
// Provider entry shape:
//   {
//     "authorize_url":       "...",     // required, https
//     "token_url":           "...",     // required, https
//     "client_id":           "...",     // required
//     "scope":               "...",     // required, space-separated
//     "client_secret":       "...",     // optional, confidential clients (Google)
//     "manual_redirect_url": "...",     // optional, provider-hosted redirect for
//                                       //   manual-code-paste flow (Google's
//                                       //   codeassist.google.com/authcode)
//     "upstream_headers":    { ... }    // optional, extra headers for upstream
//                                       //   calls made with the resolved token
//   }

export type OAuthUpstreamHeaders = Readonly<Record<string, string>>;

export type OAuthProviderConfig = {
  authorizeUrl: string,
  tokenUrl: string,
  clientId: string,
  scope: string,
  clientSecret?: string,
  /** When set, the authorize redirect goes to this URL (not the gateway
   *  callback) and the operator must paste the code at /oauth/paste.
   *  This is required for providers whose OAuth client does not allow
   *  arbitrary redirect URIs (e.g., Google). */
  manualRedirectUrl?: string,
  /** Whether dispatch through this provider's subscription entitlement is
   *  verified and allowed. False means OAuth onboarding works but runtime
   *  dispatch fails closed until a subscription adapter is verified.
   *  Absent means true (dispatchable). */
  dispatchReady?: boolean,
  upstreamHeaders: OAuthUpstreamHeaders,
};

export type OAuthProvidersConfig = Record<string, OAuthProviderConfig>;

// ---- Built-in defaults (public values from open-source CLI source code) ----

const DEFAULT_PROVIDERS: OAuthProvidersConfig = Object.freeze({
  anthropic: Object.freeze({
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    upstreamHeaders: Object.freeze({}),
  }),
  openai: Object.freeze({
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scope: 'openid email profile offline_access',
    upstreamHeaders: Object.freeze({}),
  }),
  // Google onboarding is supported, but no verified Gemini/Code Assist
  // subscription backend (endpoint + request shape + entitlement headers)
  // exists behind the OpenAI-compatible Chat profile, so dispatch fails
  // closed. Flip dispatch_ready via AIG_OAUTH_PROVIDERS only after a
  // subscription adapter has been verified against the real backend.
  google: Object.freeze({
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: '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',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
    manualRedirectUrl: 'https://codeassist.google.com/authcode',
    dispatchReady: false,
    upstreamHeaders: Object.freeze({}),
  }),
});

// ---- Parsing and merge ------------------------------------------------------

let cachedRaw: string | undefined;
let cachedParsed: OAuthProvidersConfig | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHttpUrl(value: unknown, field: string, provider: string, diagnostics: string[]): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" is missing "${field}"`);
    return null;
  }
  const url = value.trim();
  if (!/^https:\/\//.test(url)) {
    diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" field "${field}" must be an https URL`);
    return null;
  }
  return url;
}

function parseProvider(provider: string, raw: unknown, diagnostics: string[]): OAuthProviderConfig | null {
  if (!isRecord(raw)) {
    diagnostics.push(`AIG_OAUTH_PROVIDERS: entry "${provider}" must be a JSON object`);
    return null;
  }
  const authorizeUrl = normalizeHttpUrl(raw.authorize_url, 'authorize_url', provider, diagnostics);
  const tokenUrl = normalizeHttpUrl(raw.token_url, 'token_url', provider, diagnostics);
  const clientId = typeof raw.client_id === 'string' && raw.client_id.trim()
    ? raw.client_id.trim() : null;
  const scope = typeof raw.scope === 'string' ? raw.scope.trim() : null;
  if (!clientId) diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" is missing "client_id"`);
  if (!scope) diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" is missing "scope"`);
  if (!authorizeUrl || !tokenUrl || !clientId || !scope) return null;

  const clientSecret = typeof raw.client_secret === 'string' && raw.client_secret.trim()
    ? raw.client_secret.trim() : undefined;

  let manualRedirectUrl: string | undefined;
  if (typeof raw.manual_redirect_url === 'string' && raw.manual_redirect_url.trim()) {
    const murl = raw.manual_redirect_url.trim();
    if (!/^https?:\/\//.test(murl)) {
      diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" field "manual_redirect_url" must be an http(s) URL`);
      return null;
    }
    manualRedirectUrl = murl;
  }

  const dispatchReady = raw.dispatch_ready === undefined ? true
    : (raw.dispatch_ready === true || raw.dispatch_ready === 'true');

  let upstreamHeaders: OAuthUpstreamHeaders = {};
  if (raw.upstream_headers !== undefined) {
    if (!isRecord(raw.upstream_headers)) {
      diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" field "upstream_headers" must be a JSON object of header name to value`);
      return null;
    }
    const headerEntries: [string, string][] = [];
    for (const [name, value] of Object.entries(raw.upstream_headers)) {
      if (typeof value !== 'string') {
        diagnostics.push(`AIG_OAUTH_PROVIDERS: provider "${provider}" upstream header "${name}" must be a string`);
        return null;
      }
      headerEntries.push([name.toLowerCase(), value]);
    }
    upstreamHeaders = Object.freeze(Object.fromEntries(headerEntries));
  }
  return Object.freeze({
    authorizeUrl, tokenUrl, clientId, scope,
    ...(clientSecret ? { clientSecret } : {}),
    ...(manualRedirectUrl ? { manualRedirectUrl } : {}),
    ...(!dispatchReady ? { dispatchReady: false } : {}),
    upstreamHeaders,
  });
}

// Load + merge: built-in defaults are always present; AIG_OAUTH_PROVIDERS
// entries override per-provider (wholesale replacement, not field merge).
// Never returns null - defaults are always available.
export function loadOAuthProviders(
  env: Record<string, unknown>,
  diagnosticsOut?: string[],
): OAuthProvidersConfig {
  const raw = typeof env?.AIG_OAUTH_PROVIDERS === 'string'
    ? (env.AIG_OAUTH_PROVIDERS as string).trim() : '';
  if (cachedRaw === raw && cachedParsed !== undefined) return cachedParsed;
  cachedRaw = raw;

  if (!raw) {
    cachedParsed = DEFAULT_PROVIDERS;
    return cachedParsed;
  }

  const diagnostics: string[] = [];
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch {
    diagnosticsOut?.push('AIG_OAUTH_PROVIDERS: value is not valid JSON; using built-in defaults only');
    cachedParsed = DEFAULT_PROVIDERS;
    return cachedParsed;
  }
  if (!isRecord(parsedUnknown)) {
    diagnosticsOut?.push('AIG_OAUTH_PROVIDERS: value must be a JSON object keyed by provider name; using built-in defaults only');
    cachedParsed = DEFAULT_PROVIDERS;
    return cachedParsed;
  }

  // Start with defaults; user entries replace per-provider.
  const config: Record<string, OAuthProviderConfig> = {};
  for (const [name, entry] of Object.entries(DEFAULT_PROVIDERS)) config[name] = entry;

  for (const [provider, entry] of Object.entries(parsedUnknown)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
      diagnostics.push(`AIG_OAUTH_PROVIDERS: invalid provider name "${provider}"`);
      continue;
    }
    const parsed = parseProvider(provider, entry, diagnostics);
    if (parsed) config[provider] = parsed;
  }

  if (diagnostics.length > 0) diagnosticsOut?.push(...diagnostics);
  cachedParsed = Object.freeze(config);
  return cachedParsed;
}

export function getOAuthProvider(
  env: Record<string, unknown>,
  provider: string,
): OAuthProviderConfig | null {
  const config = loadOAuthProviders(env);
  return config[provider] ?? null;
}

// Whether a provider's authorize flow redirects to a provider-hosted page
// (manual paste) instead of back to the gateway (automatic callback).
export function isManualPasteProvider(provider: OAuthProviderConfig): boolean {
  return !!provider.manualRedirectUrl;
}

// The redirect_uri to send to the authorize endpoint.
// For manual-paste providers: the provider-hosted URL from config.
// For automatic providers: the gateway callback URL derived from AIG_PUBLIC_URL.
export function resolveRedirectUri(
  provider: OAuthProviderConfig,
  publicBaseUrl: string,
  providerName: string,
): string | null {
  if (provider.manualRedirectUrl) return provider.manualRedirectUrl;
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl.replace(/\/+$/, '')}/oauth/callback/${providerName}`;
}

// Reset cached parse state (used by tests).
export function __resetOAuthProvidersCacheForTests(): void {
  cachedRaw = undefined;
  cachedParsed = undefined;
}
