# Subscription model

Tier 2 carries membership/subscription entitlement capacity: operator-owned Claude, Codex, and Gemini subscriptions onboarded through OAuth (PKCE) and dispatched as `auth: "oauth"` nodes. A subscription node's credential is an OAuth access token resolved at dispatch time from the subscription token store, not a static API key. Tier 2 is **not** a second generic API-key pool; Tier 1 and Tier 3 already cover free and paid API-key capacity.

This document is the stable contract for the subscription **adapter** — the per-provider request-semantics extension point. The adapter owns how one subscription entitlement family must be called. It never decides which node to call (scheduler), how failures change node state (reliability), or how a response is classified (`classify.ts`). Generality lives in the **unified access way** (one adapter contract, composed through the provider registry), not in forcing every provider's subscription semantics into one engine.

## Scope and pipeline position

A `SubscriptionAdapter` is composed into a `ProviderAdapter` through `src/providers/registry.ts` and bound to a node by the `auth: "oauth"` marker. The provider registry is the single dispatchability authority: an `auth: "oauth"` node whose provider has no subscription adapter, or whose adapter refuses to shape a request, rotates pre-dispatch and never falls into the generic OpenAI-compatible path pretending to be usable.

Dispatch pipeline position for one subscription attempt:

```text
OAuth resolver (credential) -> adapter (request shape) -> transport (wire)
                                                 |
                          (when adapter declares `wire`)
                          dispatch wraps the OK upstream response into the
                          node's native protocol shape before the success layer
```

Credential storage and resolution are owned by `src/oauth/` (AES-GCM token store, PKCE onboarding routes, dispatch-time resolution, isolate singleflight + compare-and-swap refresh). The adapter contract only consumes a `ResolvedSubscriptionCredential`; it never reads the token store, and a credential resolution failure surfaces as a pre-dispatch auth rotation. See [Configuration - Tier 2 subscriptions](../operations/configuration.md#tier-2-subscriptions-oauth) for onboarding and the OAuth layers.

## The adapter contract

Defined in `src/subscription/types.ts`. An adapter is a plain object; all methods are optional except `prepare`.

```ts
type SubscriptionAdapter = {
  prepare(ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null;
  quotaResetHint?(failure: SubscriptionFailureView, now: number): number | null;
  discoverModels?(credential: ResolvedSubscriptionCredential, env: Record<string, unknown>): Promise<readonly string[] | null>;
  wire?: SubscriptionWire;
};
```

| Method | Returns | When null / absent |
| --- | --- | --- |
| `prepare` | Headers + optional replacement body + optional `upstreamUrl` override | `null` rotates the node pre-dispatch (fail-closed) |
| `quotaResetHint` | Milliseconds to extend a 429 cooldown, or `null` | `null` leaves the generic failure classification untouched |
| `discoverModels` | Best-effort reachable upstream model ids, or `null` | `null` means discovery unsupported; static node `models` remains the routing authority |
| `wire` | A proprietary-wire converter | Absent for backends that reuse the node's native protocol wire |

`prepare` receives a read-only `SubscriptionDispatchContext` (`node`, `credential`, `request`, `body` after model substitution, effective `surface`). It returns a `SubscriptionPreparedRequest`:

```ts
type SubscriptionPreparedRequest = {
  headers: Readonly<Record<string, string>>; // applied last, on top of protocol/transport headers
  body: Record<string, unknown> | null;       // replacement body, or null to keep the dispatch body
  upstreamUrl: string | null;                 // replaces the dispatch target URL wholesale, or null
};
```

`upstreamUrl` is for subscription backends whose wire path is not expressible through `resolveUpstreamPath(protocol, surface)` (e.g. Google Code Assist's `v1internal:generateContent` and `v1internal:streamGenerateContent?alt=sse`). Backends that reuse the node's native protocol path leave it `null`.

`prepare` must not mutate the dispatch `body`; it returns a modified copy when it rewrites (e.g. Codex normalizes a missing `instructions` field on the Responses surface). Client identity material is never forwarded: the transport's header allowlist still applies to everything the adapter returns.

## Dispatchability rules (fail-closed)

Dispatchability is the provider registry's decision, never the node's. The contract is fail-closed at every gate:

- A provider with **no** `subscription` adapter keeps OAuth onboarding working but fails runtime dispatch closed; it never falls into the generic OpenAI-compatible path.
- `prepare` returning `null` rotates the node pre-dispatch, so an unshapeable request never goes upstream half-shaped.
- For a `wire` adapter, `objectToNative` returning `null` (no meaningful output) rotates as an empty response.
- `isSubscriptionNode(node)` (`src/subscription/index.ts`) describes **intent**, not servability: an `auth: "oauth"` node for a provider with no adapter still enters the subscription path and fails closed pre-dispatch. Keeping unservable subscription nodes on that path is what guarantees they never send a half-shaped request upstream. `dispatch.ts` consults this predicate instead of `node.auth` directly so the equation never hardcodes again in the request path.

A future credential form would change only this predicate (and the resolver it hands off to), never dispatch, scheduling, or the adapter contract.

## quotaResetHint semantics

Subscription entitlement backends announce quota windows in provider-specific places: absolute epoch reset headers, remaining-seconds headers, `resets_in_seconds` body fields, or gRPC `RetryInfo.retryDelay`. These are **hints, never truth**.

- `quotaResetHint` is consulted only on a 429-class failure and returns milliseconds to wait.
- A hint may only **extend** the 429 cooldown, never shorten it; the result is capped at `QUOTA_HINT_MAX_MS` (6 hours — anything larger is suspect data, not a window).
- Recovery stays the shared model every node already uses: cooldown expiry → single half-open probe → auto-restore. **No subscription-specific reliability state machine exists.**
- Each adapter declares only the marker names it trusts for its provider; shared parsers live in `src/subscription/quota-hints.ts`:

| Helper | Input | Reads |
| --- | --- | --- |
| `hintFromResetHeaders` | headers + names | absolute epoch-seconds/ms/ISO reset instants |
| `hintFromSecondsHeaders` | headers + names | relative seconds-until-reset |
| `hintFromResetBody` | body + fields | JSON fields carrying seconds or absolute reset |
| `hintFromRetryAfterHeader` | headers | standard `Retry-After` (seconds or HTTP-date) |
| `hintFromRetryDelayBody` | body | gRPC `RetryInfo.retryDelay` (`"42s"`) |
| `capHint` | reset-at + relative-ms | collapses candidates into one capped hint |

## Proprietary wire (optional)

Some subscription backends speak their own request/response shape instead of the node's native protocol. When a `SubscriptionAdapter` declares `wire`, the dispatch layer converts the OK upstream response into the node's native protocol shape **before** the success layer sees it, so every existing success/stream/object handler keeps one consistent contract.

```ts
type SubscriptionWire = {
  streamToNative(body: ReadableStream<Uint8Array> | null | undefined, options: { messageId: string, model: string }): ReadableStream<Uint8Array>;
  objectToNative(data: unknown): Record<string, unknown> | null;
};
```

Rules:

- **Streaming is converted lazily.** `streamToNative` must pipe upstream chunks through in real time, translate event types as they arrive, and emit the native terminal marker (e.g. OpenAI `data: [DONE]`) exactly once when the upstream stream ends. It must **not** buffer the full response before emitting, so the first-event guard can still rotate before meaningful output is committed.
- **Non-streaming objects are converted eagerly** in the dispatch layer.
- **Conversion is fail-closed.** `objectToNative` returns `null` when the response carries no meaningful output, and the dispatch layer rotates that as an empty response.
- The proprietary wire is **subscription-owned**: it lives inside `src/subscription/` and never enters the gateway's general transport or conversion layers. The two native protocol families (OpenAI / Anthropic) stay unchanged. This is a subscription-owned proprietary wire, not a third protocol family.

## Built-in adapters

The three mainstream subscription providers ship built-in OAuth defaults (public constants from their open-source CLIs) and built-in subscription adapters in `src/subscription/`.

| Provider | `prepare` shape | Quota markers | `wire` | `discoverModels` |
| --- | --- | --- | --- | --- |
| `anthropic` (Claude Pro/Max) | merge required OAuth beta flags (`claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`) + `x-app: cli` + claude-cli user agent | `anthropic-ratelimit-*-reset` headers, `resets_in_seconds`/`reset_at`/`resets_at` body | absent (native Anthropic Messages wire) | Anthropic `/v1/models` catalog |
| `openai` (ChatGPT/Codex) | `Originator: codex-tui` + `chatgpt-account-id` + `instructions` normalization on the Responses surface | `x-codex-*-window-reset` / `x-ratelimit-reset-*` headers, `resets_in_seconds` body | absent (native OpenAI Chat/Responses wire) | OpenAI `/v1/models` catalog |
| `google` (Gemini / Code Assist) | convert OpenAI Chat to the Code Assist envelope, set `upstreamUrl` to `v1internal:generateContent` / `v1internal:streamGenerateContent?alt=sse` | `Retry-After` header + gRPC `RetryInfo.retryDelay` body | present (`google-wire.ts`: Chat ↔ Code Assist envelope, both directions, streaming + object) | unsupported (no verified model-list endpoint) |

CCH billing-block signing (CLIProxyAPI's extra-paranoid layer) is not part of the mainstream Anthropic shape and is not implemented.

## Adding a subscription adapter

The extension recipe is intentionally small. A new provider with its own wire contract, OAuth onboarding, or subscription backend needs:

1. One adapter module in `src/subscription/<provider>.ts` implementing `SubscriptionAdapter`. Decide native wire (omit `wire`) or proprietary wire (implement `SubscriptionWire` in a sibling `<provider>-wire.ts`).
2. One provider adapter in `src/providers/<provider>.ts` declaring `wire` (protocol + surfaces), `streamUsage`, optional `oauth` onboarding defaults, optional `subscriptionEndpoint`, and `subscription: <adapter>`.
3. One line in the `PROVIDER_REGISTRY` in `src/providers/registry.ts`.
4. Contract tests under `tests/`.

Adding a plain OpenAI-compatible provider needs no source change at all — the generic OpenAI adapter is the registry fallback. The adapter contract is the only subscription extension point; the scheduler, reliability, transport, and conversion layers stay provider-agnostic and are not branched on provider names.

## Responsibility boundaries

| Layer | Responsibility |
| --- | --- |
| Provider registry | Single dispatchability authority; composes subscription adapters into provider adapters |
| Subscription adapter | Provider-specific request semantics for one entitlement family; never scheduling, reliability, or classification |
| OAuth (`src/oauth/`) | Credential storage, PKCE onboarding, dispatch-time resolution, refresh singleflight + compare-and-swap |
| Dispatch | Calls `prepare`, applies the prepared headers/body/URL, wraps `wire` responses into native protocol shape |
| Reliability | Cooldown and recovery; `quotaResetHint` only extends a 429 cooldown, capped |
| Transport | Upstream HTTP after a node is selected; never request-shape conversion |
| Conversion (`src/conversion/`) | Only the Chat ↔ Messages bridge; subscription proprietary wires stay in `src/subscription/` |

## Invariants

- `auth: "oauth"` is valid only on Tier 2 nodes; a subscription node must not also declare a static credential in `AIG_TIER{N}_CREDENTIALS_*` (one credential source per node).
- `base_url` is optional for Tier 2 `auth: "oauth"` nodes whose provider adapter declares a built-in `subscriptionEndpoint`; the config layer resolves it from the provider registry.
- A provider without a `subscription` adapter keeps OAuth onboarding but fails runtime dispatch closed; it never falls into the generic OpenAI-compatible path.
- `prepare` returning `null` is a pre-dispatch rotation; an unshapeable request never goes upstream half-shaped.
- `quotaResetHint` is advisory only: it may extend a 429 cooldown (capped at 6 hours) and never shortens it; recovery is the shared cooldown → probe → restore circuit. No subscription-specific reliability state machine exists.
- A proprietary `wire` is owned inside `src/subscription/`; the two native protocol families and the general transport/conversion layers stay unchanged.
- Streaming wire conversion is lazy (no buffering before emit); non-streaming conversion is eager; both are fail-closed.
- Subscription tokens are AES-GCM encrypted with `AIG_TOKEN_ENCRYPTION_KEY`; a missing key disables all subscription onboarding and resolution (fail-closed); tokens are never stored in D1 as plaintext.
- Provider account identity (e.g. the OpenAI `account_id`) is persisted in plaintext beside the credential and applied only to that provider's subscription dispatch headers; it never pollutes the `RuntimeNode` schema.
- One current adapter contract exists; superseded paths are removed, not kept behind compatibility shims.

See [Protocol model](protocol-model.md), [Routing model](routing-model.md), and [Reliability model](reliability-model.md) for the surrounding contracts.
