# Configuration

Production configuration is delivered from GitHub Actions into Cloudflare Workers. Non-sensitive account configuration belongs in repository Variables; credentials belong in Secrets. The Cloudflare Dashboard is not the canonical day-to-day configuration source.

## Sources

| Source | Purpose |
| --- | --- |
| `AIG_TIER{1,2,3}_NODES_01..10` | Non-secret account/node definitions |
| `AIG_TIER{1,2,3}_CREDENTIALS_01..10` | Tier-scoped credentials keyed by node id |
| `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | Gateway access keys |
| `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | Per-group logical-model allowlists |
| `AIG_MODELS_CONFIG` | Optional logical-model metadata/capabilities |
| `AIG_POLICIES_CONFIG` | Attempt, hedge, timeout and Tier 1 admission policy |
| `AIG_DASHBOARD_MODELS` | Optional public-dashboard logical-model display allowlist |

`src/config/runtime-vars.ts` is the single source for runtime variable defaults and ranges.

## Access groups

The five independent groups are `AIR`, `PRO`, `MAX`, `ULTRA`, and `AGENT`. A configured group uses both:

```text
AIG_ACCESS_KEY_<GROUP>
AIG_ACCESS_MODELS_<GROUP>
```

Groups do not inherit from one another. An empty or missing model allowlist grants zero models for every group, including `AGENT`. The group name is an authorization boundary only; it does not assign Tier 1 scheduler priority.

## Node configuration

Node JSON describes an account/endpoint, not protocol implementation details.

Required fields:

```text
id
provider
base_url
models
```

Optional field:

```text
priority
```

Example:

```json
{
  "id": "nvidia-01",
  "provider": "nvidia",
  "base_url": "https://integrate.api.nvidia.com/v1",
  "priority": 10,
  "models": {
    "Code-Max": "upstream-code-model"
  }
}
```

Rules:

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$` and is globally unique.
- `tier` is not a node field; the Variable prefix owns the tier.
- credentials never appear in node JSON.
- `provider`, `base_url`, and `models` are required.
- `base_url` must be absolute HTTPS unless insecure HTTP is explicitly enabled.
- `priority`, when present, is a non-negative integer JSON number. Tier 2/3 may use it; Tier 1 does not use static node priority as a P2C score.
- `models` is an object mapping logical model → upstream model. `{}` is only an intentional catalog-bounded wildcard.
- `protocol`, `surfaces`, `limits`, credential fields, and other unknown fields are rejected.

There is one current node shape. No alternate or compatibility schema is retained.

### Subscription nodes (`auth: "oauth"`, Tier 2 only)

Tier 2 nodes may declare `"auth": "oauth"` to mark a subscription-entitlement
node whose credential is an OAuth access token resolved at dispatch time from
the subscription token store instead of a static
`AIG_TIER{N}_CREDENTIALS_*` secret.

```json
{
  "id": "claude-sub-1",
  "provider": "anthropic",
  "auth": "oauth",
  "base_url": "https://api.anthropic.com",
  "models": { "Code-Max": "claude-sonnet-4-5" }
}
```

Rules:

- `auth: "oauth"` is valid only on Tier 2 nodes; Tier 1/3 nodes declaring it are configuration errors.
- Subscription nodes must not have a static credential in `AIG_TIER{N}_CREDENTIALS_*` — one credential source per node.
- Without `AIG_OAUTH_PROVIDERS` and `AIG_TOKEN_ENCRYPTION_KEY` configured, subscription nodes stay unusable (fail-closed) and receive no traffic.
- Onboarding: open `/oauth/start?provider=<name>&node=<node-id>` with a gateway access key; the browser completes the provider consent and returns to `/oauth/callback/<name>`.

## Provider wire profiles

Protocol and API surfaces are Provider capabilities and are defined once in `src/config/provider-profile.ts`:

- `provider: "anthropic"` → Anthropic protocol, `messages` surface.
- `provider: "openai"` → OpenAI protocol, `chat_completions` and `responses` surfaces.
- other providers → OpenAI-compatible `chat_completions` surface.

Runtime normalization adds those protocol/surface facts to `RuntimeNode`; account-level Node JSON does not override them.

If a Provider needs a different wire contract, change its Provider Profile. Do not repeat structural protocol/surface fields across every account.

OpenAI Responses remains Native Only. Chat/Messages protocol fallback remains bidirectional where conversion is safe:

```json
{
  "anthropic:messages": ["openai:chat_completions"],
  "openai:chat_completions": ["anthropic:messages"]
}
```

## Credential shards

Credential shards are JSON objects keyed by node id:

```json
{
  "nvidia-01": "credential-value",
  "nvidia-02": "credential-value"
}
```

Config and Secret shard suffixes are independent. Binding is by **Tier + node id**, not by matching shard suffix.

## Tier roles

Routing order is fixed:

```text
Tier 1 → Tier 2 → Tier 3
```

- Tier 1: free/effectively free capacity; primary reliability focus.
- Tier 2: subscription entitlement capacity. Static API-key nodes and `auth: "oauth"` subscription nodes share this tier; the tier stays free of Tier 1 adaptive machinery.
- Tier 3: paid API capacity; protected final fallback.

## Tier 2 subscriptions (OAuth)

Tier 2 subscription nodes link an operator-owned provider subscription
(Claude Pro/Max, ChatGPT/Codex, Google One AI Premium, or any
OAuth-authorized upstream) through the gateway's PKCE onboarding flow.

### Built-in provider defaults

The three mainstream international providers ship with **built-in defaults**
(public OAuth constants from their open-source CLIs) — no
`AIG_OAUTH_PROVIDERS` configuration is required to onboard them:

| Provider key | Subscription | Flow |
| --- | --- | --- |
| `anthropic` | Claude Pro/Max | Automatic (PKCE, redirect back to gateway) |
| `openai` | ChatGPT/Codex | Automatic (PKCE, redirect back to gateway) |
| `google` | Gemini (Google One) | Manual paste (Google OAuth client only allows its own redirect pages) |

To onboard with defaults, configure the Tier 2 node with the matching
provider name and run the onboarding flow below. To override a default or
add a new provider, set `AIG_OAUTH_PROVIDERS`.

### Variables and secrets

- `AIG_OAUTH_PROVIDERS` (plain Variable, JSON, optional) — per-provider OAuth
  registry. User entries **replace** built-in defaults at the provider level
  (wholesale, not field-by-field). Unset uses built-in defaults only:

```json
{
  "google": {
    "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_url": "https://oauth2.googleapis.com/token",
    "client_id": "<your own client id>",
    "client_secret": "<your own client secret>",
    "scope": "https://www.googleapis.com/auth/cloud-platform",
    "manual_redirect_url": null,
    "upstream_headers": {}
  }
}
```

  `client_secret` is for confidential OAuth clients (Google always requires
  one; Claude/Codex are public PKCE clients and do not). Setting
  `manual_redirect_url` selects the manual code-paste flow — omit it (or set
  your own gateway callback via the default) for the automatic redirect flow.

- `AIG_TOKEN_ENCRYPTION_KEY` (Secret) — base64-encoded 256-bit AES key.
  Generate with: `openssl rand -base64 32`. Without it, subscription
  onboarding and resolution are disabled (fail-closed).

- `AIG_PUBLIC_URL` (Variable, already required by the dashboard) — derives
  the OAuth redirect URI `/oauth/callback/<provider>`.

### Onboarding flow

**Claude / Codex (automatic)**:

1. Open `GET /oauth/start?provider=anthropic&node=<node-id>` (or
   `provider=openai`) with a gateway access key in the browser.
2. Approve the consent screen; the provider redirects back to
   `/oauth/callback/<provider>` and the gateway completes the exchange.

**Gemini (manual paste)**:

1. Open `GET /oauth/start?provider=google&node=<node-id>` with a gateway
   access key in the browser.
2. Approve the Google consent screen. Google redirects to its own
   `codeassist.google.com/authcode` page (its OAuth client does not allow
   arbitrary gateway callback URLs) which displays the authorization code.
3. Copy the code and paste it at the `/oauth/paste` link shown on the start
   page.
4. The gateway exchanges the code with PKCE and `client_secret`, stores
   the tokens, and confirms.

Flow states are single-use and expire after 10 minutes. Token refresh happens
automatically at dispatch time (5-minute expiry margin) with an isolate-local
cache and a 60-second negative cache on refresh failures.

## Runtime variables

Current numeric tunables are owned by `src/config/runtime-vars.ts`:

- `AIG_UPSTREAM_HEADER_TIMEOUT_MS`
- `AIG_FIRST_EVENT_TIMEOUT_MS`
- `AIG_STREAM_IDLE_TIMEOUT_MS`
- `AIG_RATE_LIMIT_COOLDOWN_MS`
- `AIG_AUTH_FAILURE_COOLDOWN_MS`
- `AIG_REQUEST_BODY_MAX_BYTES`
- `AIG_FAILOVER_BUDGET_MS`
- `AIG_HEDGE_DELAY_MS`
- `AIG_REQUEST_HEDGE_MAX`
- `AIG_ACCESS_KEY_RPM`

Other current variables include `AIG_CORS_ORIGIN`, `AIG_USAGE_INCLUDE_MODE`, `AIG_USAGE_EXCLUDE_PROVIDERS`, `AIG_ANTHROPIC_COUNT_MODE`, `AIG_LOG_LEVEL`, `AIG_PROTOCOL_FALLBACKS`, `AIG_SHOULD_EXPOSE_UPSTREAM`, `AIG_HAS_STREAM_GUARD`, `AIG_CAN_USE_HTTP`, `AIG_DASHBOARD_MODELS`, and `AIG_OAUTH_PROVIDERS` (see [Tier 2 subscriptions](#tier-2-subscriptions-oauth)).

## Dashboard model display

`AIG_DASHBOARD_MODELS` is a comma-separated presentation allowlist for logical models.

Example:

```text
AIG_DASHBOARD_MODELS=Code-Ultra,Code-Max,Code-Pro,Ultra,Max,Pro,Air
```

It does not change routing, authorization, `/v1/models`, fallback, D1 collection, or aggregate usage totals. It controls which public logical models are shown in the model-status area and which models are eligible to appear by name in the model-usage breakdown; non-allowlisted usage is aggregated into `其他`.

## Capacity and reliability

Tier 1 uses observed runtime facts rather than guessed Provider quotas:

- live in-flight work;
- actual rate-limit responses, including quota-shaped provider errors normalized by the failure classifier;
- bounded adaptive cooldown and `Retry-After`;
- provider-model heat;
- passive TTFT;
- soft session affinity, exploration, recovery/circuit state;
- optional explicit `AIG_POLICIES_CONFIG.max_in_flight` safety ceiling.

Access-key groups do not add a routing score factor. `AIG_ACCESS_KEY_RPM` protects gateway access keys; it is not a Provider quota model.

## Policies

Example:

```json
{
  "default": {
    "max_attempts": 5,
    "tier_attempts": null,
    "hedge": { "enabled": true, "tiers": ["tier1"] },
    "headers_timeout_ms": null,
    "first_event_timeout_ms": null,
    "failover_budget_ms": null,
    "max_in_flight": null
  }
}
```

`max_attempts` is the request-wide logical-attempt ceiling. Tier caps must fit inside it. `headers_timeout_ms`, `first_event_timeout_ms`, and `failover_budget_ms` optionally override the global request timing for one policy. Without an explicit model policy, `Air`/`Code-Air` use the built-in `fast` policy (`max_attempts=4`, 60s failover budget), exposing one pass across Air → Pro → Max → Ultra. `Pro`/`Max`/`Ultra` and their `Code-*` variants use `long-reasoning` (`max_attempts=6`, no hedge, 60s header timeout, 60s first-event timeout, 180s failover budget), matching the full 3/2/1 family fallback plan. Other models use `default`. An explicit `AIG_MODELS_CONFIG.<model>.policy` always wins. There is one cross-tier allocation model: hard Tier precedence. `budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema and are rejected as unknown fields.

## Request timing

`AIG_FAILOVER_BUDGET_MS` is the global wall-clock budget for a request unless the resolved model policy supplies `failover_budget_ms`. `AIG_UPSTREAM_HEADER_TIMEOUT_MS` and `AIG_FIRST_EVENT_TIMEOUT_MS` remain the global phase defaults, while a model policy may override them with `headers_timeout_ms` and `first_event_timeout_ms`. Native tiers, protocol fallback, model-family fallback and bounded re-checks do not reset the resolved budget. A physical dispatch shares one absolute attempt deadline across headers, first meaningful output, body assembly and bounded diagnostic reads. A hedge twin inherits that deadline.

## Usage accounting

Dashboard usage intentionally separates public service volume from physical upstream work:

- Token totals use real upstream-reported physical Token consumption, including retry/fallback/hedge attempts when usage is reported;
- public `次请求` counts successfully delivered requests and therefore does not inflate from internal retries, fallback, or hedge twins;
- the model-usage breakdown may show physical upstream-call counts in its tooltips;
- TTFT `samples` counts successful delivered requests with a TTFT sample in the recent window;
- missing upstream usage is recorded as missing and is never estimated.

D1 usage and public status are observability inputs only; historical aggregates do not feed routing decisions.

## Deployment identity

Deployment identity is the Git commit SHA injected as `GITHUB_SHA` and exposed by authenticated `/health` as `build`. Named releases, when wanted, are created manually by a human as Git tags / GitHub Releases.

## Local validation

```bash
npm run config:check
npm run validate:merge
```
