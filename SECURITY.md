# Security Policy

## Supported versions

Only the current `main` branch and the latest published release are actively maintained. Older releases may not receive security fixes.

## Reporting a vulnerability

Do not disclose exploitable details in a public Issue. Use the repository's **Security → Report a vulnerability** flow to create a private GitHub Security Advisory.

Never include:

- API tokens or gateway access-key values;
- full authorization headers;
- private upstream URLs;
- user prompts, request bodies, or personal data;
- live exploit details in a public thread.

If private advisories are unavailable, open a public Issue containing only a request for a private reporting channel.

## Deployment responsibilities

- Store configured `AIG_ACCESS_KEY_AIR`, `AIG_ACCESS_KEY_PRO`, `AIG_ACCESS_KEY_MAX`, `AIG_ACCESS_KEY_ULTRA`, `AIG_ACCESS_KEY_AGENT` values and all `AIG_TIER{1,2,3}_CREDENTIALS_*` shards as Cloudflare Secrets. Store the corresponding `AIG_ACCESS_MODELS_AIR`, `AIG_ACCESS_MODELS_PRO`, `AIG_ACCESS_MODELS_MAX`, `AIG_ACCESS_MODELS_ULTRA`, `AIG_ACCESS_MODELS_AGENT` values and node configs (`AIG_TIER{1,2,3}_NODES_*`) as non-secret variables. Node credentials bind by **Tier + node id**; `01..10` are shard numbers only, and Config/Secret shard suffixes do not need to match;
- never commit `.dev.vars`, `.env`, `secrets*.json`, or `wrangler.user.jsonc`; production custom domains belong in `wrangler.user.jsonc` (gitignored), see `wrangler.user.jsonc.example`;
- never pass credentials through URL query parameters;
- keep `/health` and `/metrics` protected;
- revoke and rotate exposed or suspected credentials immediately;
- review Worker logs before sharing them publicly.

## Gateway-enforced protections

- Timing-safe gateway auth (Bearer / `x-api-key`);
- strict upstream header allowlist — client credentials, cookies, forwarded and CF-private headers are never relayed;
- HTTPS-only upstreams by default; `redirect: 'manual'` so redirects never carry credentials;
- bounded request/response reads;
- CORS disabled unless `AIG_CORS_ORIGIN` is set explicitly;
- credentials are excluded from every response, diagnostic endpoint, and log line.

## Rate limiting boundary

The gateway's built-in RPM limiter (`src/ratelimit/key-rpm.ts`) is **isolate-local**:
it enforces a per-group cap within a single Cloudflare Workers isolate. Under
horizontal scaling (multiple isolates), a distributed client can exceed the
nominal RPM by a factor equal to the number of active isolates.

For strict account-wide limits, operators should layer one of:
- **Cloudflare WAF Rate Limiting** (recommended; global, edge-enforced)
- **Durable Object counter** (custom coordination, adds latency)

The limiter is **group-scoped**, not per-key: all access keys in the same
`AIG_ACCESS_KEY_<GROUP>` share the RPM cap. This is by design to avoid
per-key state explosion; see `src/ratelimit/key-rpm.ts` for details.

## Google OAuth client constants

The Google OAuth `client_id` and `client_secret` in `src/providers/google.ts`
are sourced from the Gemini CLI's public OAuth client (Apache-2.0 licensed,
see https://github.com/google-gemini/gemini-cli). These are public constants
designed for installed applications and are **not** considered secret. The
OAuth onboarding flow uses these only for the Tier 2 Gemini Code Assist
subscription; no client-supplied credentials reach the upstream provider.

## Subscription proxying and provider terms

Tier 2 subscription nodes (`auth: "oauth"`) call the Claude, Codex and Gemini
subscription endpoints with the identity of the vendors' own command-line
clients: the adapters send first-party client headers and user agents (for
example `claude-cli`, `codex-tui` and `GeminiCLI`) and, for Gemini, the public
Gemini CLI OAuth client. Those vendors' terms may not allow a subscription to
be used through a third-party proxy, and a vendor may rate-limit, suspend or
ban an account that is. Enabling subscription nodes is the operator's own
decision and risk; review the current terms of each provider first.

Set `AIG_ENABLE_SUBSCRIPTION=false` to remove the feature: no Tier 2 `oauth` node
is loaded and every `/oauth/*` route answers 404. The default is `true`, which
keeps the current behavior.

## OAuth start credential handling

The `/oauth/start` endpoint requires a gateway access key for operator
authentication. Credentials are accepted only via `Authorization: Bearer` or
`x-api-key` headers, or via an HTML paste form that submits the key in the
request body (never in URL query parameters). Query-string credentials
(`?key=...`) are no longer accepted to prevent credential leakage in logs,
browser history, and screenshots.
