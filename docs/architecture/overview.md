# Architecture overview

ai-gateway is a Cloudflare Workers AI API gateway for a household, an individual operator, or a small trusted team. It makes a pool of heterogeneous AI capacity behave like one predictable endpoint without hiding protocol boundaries or inventing global guarantees the runtime does not have.

The product boundary is governed by [Product policy](../governance/product-policy.md). It is intentionally not a public SaaS gateway, enterprise API-management platform, billing system, reseller platform, or general multi-tenant control plane.

## Design goals

The long-term design order is:

1. keep Tier 1 free-token capacity stable, efficient, safe, and continuously usable;
2. preserve protocol correctness and security;
3. keep operation simple for a household or small trusted team;
4. maximize useful free capacity without hiding retry/fallback amplification;
5. keep Tier 2 ready for membership/subscription entitlements;
6. keep Tier 3 as protected paid-API fallback capacity;
7. add extensibility only for a concrete current use case.

A runtime feature should improve at least one of these properties without materially damaging the others:

- request success and recovery behavior;
- free-capacity utilization;
- tail-latency control;
- protocol compatibility;
- operational predictability;
- security;
- Worker hot-path cost.

The project prefers bounded, local mechanisms over global coordination unless production evidence shows local shaping is insufficient. It also prefers deleting superseded mechanisms over carrying old/new implementations in parallel.

## Tier roles

Tier roles are permanent architecture boundaries, not generic priority labels.

| Tier | Long-term role | Design priority |
| --- | --- | --- |
| **Tier 1** | Free or effectively free token capacity across providers/accounts | Primary daily traffic; resilience, load spreading, 429 recovery, low cost, continuous availability |
| **Tier 2** | Membership/subscription entitlement capacity | Reserved for future subscription-entitlement adapters; not a second generic API-key pool |
| **Tier 3** | Paid API capacity | Protected final fallback; predictable and bounded use |

Tier 1 therefore receives most reliability engineering. Tier 2 and Tier 3 must stay simpler and must not accumulate Tier 1-specific adaptive machinery without a demonstrated need.

## Request flow

```text
Client
  ↓
Authentication + route/body validation
  ↓
Request orchestration
  ↓
Logical-model pass
  ↓
Native protocol/surface candidate pool
  ↓
Tier 1 → Tier 2 → Tier 3
  ↓
Optional Chat Completions ↔ Anthropic Messages fallback for the same model
  ↓
If the logical-model pool is exhausted: bounded compatible-model fallback
  ↓
At most one re-check round for recovered compatible pools
  ↓
Protocol-specific response / stream
```

OpenAI Chat Completions and Anthropic Messages are Native First. Only after the native pool is exhausted may the configured cross-protocol fallback run. OpenAI Responses is Native Only for protocol conversion.

Logical-model fallback is a separate outer orchestration layer. The closed families are `Code-Max ↔ Code-Pro → Code-Ultra`, `Max ↔ Pro → Ultra`, and one-way `Air → Pro → Max → Ultra`. Compatible families are evaluated for at most two rounds; all passes share the original attempt, dispatch, hedge, and wall-clock budgets. `max_attempts` remains the request-wide hard ceiling and is never enlarged by family fallback.

## Module ownership

```text
Model Registry     logical model policy and declared capabilities
Node config         provider name, base URL, logical→upstream model mapping,
                    optional Tier 2/3 priority, credential binding,
                    optional Tier 2-only `auth:"oauth"` subscription marker
Provider Profile    provider → protocol + routable surfaces
Request             native/protocol/model-family fallback orchestration and shared budgets
Scheduler           which eligible node should receive the next attempt
Reliability         whether a node/account/model is currently usable and how failures change state
Transport           how to call the selected upstream endpoint
Protocol            client request validation and protocol-specific errors
Conversion          supported Chat ↔ Messages semantic bridge
Stream              first-event guards, SSE lifecycle, commit boundary
OAuth               Tier 2 subscription credentials: provider registry (AIG_OAUTH_PROVIDERS),
                    PKCE onboarding routes, AES-GCM token store, dispatch-time resolution
Subscription        provider-specific subscription request shaping: adapter registry,
                    codex/claude/google adapters (headers, body normalization,
                    dispatch refusal for unverified entitlement backends)
Observability       logs, metrics, D1/token usage, diagnostics
Runtime             runtime availability and public read-only projections
Dashboard           presentation only
```

These boundaries are intentional. Transport does not select nodes. Scheduler and Reliability do not parse provider wire events. Model-family fallback does not replace node scheduling or reliability state; it only decides which compatible logical model is evaluated next after the current pool is exhausted. Provider profiles are the single owner of protocol/surface structure; account records cannot override them. OAuth owns subscription credential storage and resolution; the scheduler never reads the token store, and a resolution failure surfaces as a pre-dispatch auth rotation.

## Current invariants

- Account-level Node Config accepts `id`, `provider`, `base_url`, `models`, optional `priority`, and the Tier 2-only `auth:"oauth"` subscription marker; `protocol`, `surfaces`, and `limits` are rejected.
- `auth:"oauth"` is valid only on Tier 2 nodes; Tier 2 subscription nodes must not declare a static credential in `AIG_TIER{N}_CREDENTIALS_*` (one credential source per node).
- Provider Wire Profiles derive runtime protocol/surfaces: `anthropic` → Messages, `openai` → Chat + Responses, all other providers → OpenAI-compatible Chat.
- Native OpenAI Chat targets `/v1/chat/completions` upstream.
- Native OpenAI Responses targets `/v1/responses` upstream.
- Native Anthropic Messages targets `/v1/messages` upstream.
- The built-in conversion matrix is only OpenAI Chat Completions ↔ Anthropic Messages.
- OpenAI Responses does not enter cross-protocol conversion.
- `Code-Max` and `Code-Pro` are first-choice interchangeable coding aliases; `Code-Ultra` is the family-level higher fallback.
- `Max` and `Pro` are first-choice interchangeable general aliases; `Ultra` is the family-level higher fallback.
- Code aliases never fall back into non-Code aliases.
- `Air` may fall back upward to `Pro → Max → Ultra`; higher general aliases never fall back down to `Air`.
- Compatible model families get at most two evaluation rounds; there is no unbounded model loop.
- `max_attempts` is the request-wide hard ceiling; model-family fallback never enlarges it internally.
- A model-shaped 404 isolates the failing node/model mapping; an authorized compatible sibling may still be evaluated within the same request budget.
- Native retry, protocol fallback, and model-family fallback share the same logical-attempt and wall-clock failover budget.
- A hedge twin remains in the primary request's protocol and surface.
- Tier 1 uses Eligibility → soft Affinity → P2C with passive TTFT and bounded heat protection; access-key groups do not alter its score.
- Tier 2/3 remain separate from Tier 1 adaptive state.
- Tier 2 subscription (`auth:"oauth"`) credentials are resolved at dispatch time from the OAuth token store: isolate cache first, D1 only on cache miss or near expiry, refresh inside a 5-minute margin; resolution failures are pre-dispatch auth rotations with an isolate-local negative cache so a broken subscription does not hammer the provider's token endpoint.
- Refresh-token rotation safety: one in-flight resolution per node per isolate (singleflight), and refresh persists land only through a compare-and-swap on the persisted `refresh_version`; a losing writer reloads the winner's credential, so exactly one refresh token remains the persisted authority. Durable Objects are not introduced for this.
- Provider account identity (e.g., the OpenAI `account_id`) is persisted in plaintext beside the credential and applied as the `chatgpt-account-id` header for OpenAI-protocol subscription dispatches only; it never pollutes the RuntimeNode schema.
- Providers without a verified subscription backend (the built-in `google` default, whose adapter refuses) keep OAuth onboarding but fail runtime dispatch closed; they never fall into the generic OpenAI-compatible path pretending to be usable. The subscription adapter registry (`src/subscription/`) is the single dispatchability authority: an `auth:"oauth"` node whose provider has no adapter, or whose adapter refuses to shape the request, rotates pre-dispatch.
- Subscription access/refresh tokens are AES-GCM encrypted with the `AIG_TOKEN_ENCRYPTION_KEY` Worker secret; a missing key disables all subscription onboarding and resolution (fail-closed), and tokens are never stored in D1 as plaintext.
- OAuth onboarding (`/oauth/start`, `/oauth/callback/<provider>`, `/oauth/paste`) uses PKCE S256 with a single-use D1 flow state (10-minute TTL); `/oauth/start` requires a gateway access key and a matching Tier 2 node, and every callback/paste consumes its state row regardless of outcome.
- Built-in OAuth defaults for the three mainstream subscription providers (anthropic, openai, google) embed public constants from their open-source CLIs; `AIG_OAUTH_PROVIDERS` entries replace defaults per-provider (wholesale). Providers with a `manual_redirect_url` (Google) use the manual code-paste flow because their OAuth client does not allow arbitrary gateway redirect URIs.
- Short-lived scheduler/reliability state is isolate-local best-effort and disappears with the isolate.
- D1 Token totals track real physical upstream-reported usage, while public `次请求` uses successfully delivered request counts.
- D1 token usage and public model status are observability, not routing authority.
- `TIER1_AFFINITY` KV stores only hashed session affinity and does not make routing globally sticky.
- Provider Discovery is read-only advisory tooling.
- Public Model Status is a read-only five-state projection; dashboard P50/P95/samples are model-level aggregates and never feed Scheduler or Reliability.
- ai-gateway carries one current internal/configuration contract; superseded old-version paths are removed rather than kept behind compatibility shims.

## Configuration authority

- Runtime variable names/defaults: `src/config/runtime-vars.ts`.
- Node parsing and credential binding: `src/config/nodes.ts` and related config modules.
- Provider protocol/surface mapping: `src/config/provider-profile.ts`.
- Logical model policy/capabilities: `src/config/registry.ts`.
- Logical-model fallback policy: `src/request/model-fallback.ts` and its contract tests.
- Protocol fallback matrix: protocol fallback config/conversion modules and their contract tests.
- Failure taxonomy: `src/reliability/classify.ts`.
- OAuth provider registry (subscription endpoints/clients/scopes/headers): `src/oauth/provider-configs.ts` parsing `AIG_OAUTH_PROVIDERS`; token storage/refresh and onboarding routes: `src/oauth/`.
- Subscription token schema: `migrations/0011_subscription_tokens.sql` (owned by `src/oauth/token-store.ts`; observability never reads or writes these tables).

Architecture documentation summarizes these sources; it must be corrected when executable behavior changes.

## Stability phase

The current module ownership and routing/reliability architecture are frozen for the stability phase. Routine work should improve correctness, tests, operations, and measured production behavior without reorganizing directories or inventing parallel control planes.

- Reliability and scheduler state remain isolate-local best-effort by design.
- Durable Objects or a global scheduler are not added without production evidence that isolate-local shaping is causing material failures.
- Provider Wire Profiles remain wire-contract metadata, not a second per-model capability engine.
- Capability validation stays small and fail-closed only for obvious contradictions in declared logical-model metadata.
- Structural changes require a concrete production problem, evidence that existing boundaries cannot address it, and an explicit architecture review.

The primary production signals for this phase are real upstream 429s, fallback amplification, hedge amplification, D1 write volume, and TTFT distribution. These measurements should drive the next reliability change; directory reshuffling should not.

## Persistence boundaries

D1 and KV are deliberately outside the critical scheduling decision path where possible.

- `TIER1_AFFINITY` KV: short-lived session binding, 30-minute TTL.
- Token-usage D1: persisted physical upstream usage, successful-delivery evidence, recent public-status evidence, and model-level TTFT aggregates.
- Tier 1 TTFT, in-flight, cooldown, adaptive 429/heat, half-open state: isolate-local memory.
- Tier 2/3 health/circuit/concurrency state: isolate-local memory.

The gateway does not claim cross-PoP globally accurate concurrency or provider-account quota from these local states. Stronger coordination is not added merely because it is theoretically cleaner; it requires measured evidence that the household/small-team deployment model needs it.

See [Protocol model](protocol-model.md), [Routing model](routing-model.md), and [Reliability model](reliability-model.md) for the detailed contracts.
