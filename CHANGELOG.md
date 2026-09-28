# Changelog

## [Unreleased]

- test: run the product test suites from the central Action Worker test pack (`tests/packs/ai-gateway`) instead of a local `tests/` directory so a pull request cannot weaken its own tests.

- fix: bump the Gemini CLI user agent from v0.14.0 to v0.60.0 so Code Assist upstreams accept requests that identify as the current CLI release.

- feat: edge idempotent caching for zero-temperature inference — the Cloudflare Cache API intercepts requests with temperature=0 or x-gateway-cache: true, serving HIT responses with x-gateway-cache-status: HIT in ~50ms and zero upstream cost; MISS responses carry x-gateway-cache-status: MISS. Cache key is SHA-256 of canonicalized route/model/body. TTL controlled by AIG_EDGE_CACHE_TTL_SEC (default 4h, 0 disables). [Phase 3]

- feat: reasoning alignment for DeepSeek-R1 and Claude Extended Thinking — DeepSeek's reasoning_content and Anthropic's thinking/thinking_delta blocks are now converted bidirectionally: O→A streaming emits native Anthropic thinking blocks; A→O streaming/non-streaming emits OpenAI-standard reasoning_content; non-stream converters preserve chains. The conversion-aware first-event guard predicates now commit on reasoning/thinking deltas, eliminating false first-event timeouts during long thinking phases. [Phase 2]

- feat: hedging strong abort (TTFT-based) — when a hedged node produces its first real output (streaming) or complete response (non-streaming), the losing node's underlying fetch is immediately aborted with reason "Hedge lost". The AbortError is isolated at every phase (headers, first-event guard, post-headers object assembly) and classified as the neutral cancelled_after_peer_commit, preventing pollution of node health scoring and retry flow. [Phase 1]

- feat: browser-friendly OAuth onboarding — /oauth/start accepts the gateway access key as a ?key= query parameter (in addition to the Authorization header) so an operator can start subscription onboarding from a browser address bar, which cannot set custom headers. API request routes never consume query credentials; the fallback is scoped to OAuth onboarding only. Installers (install.sh / install.ps1) now generate AIG_TOKEN_ENCRYPTION_KEY automatically (node crypto, cross-platform) and collect AIG_PUBLIC_URL, so a fresh deployment can onboard Claude/Codex/Gemini subscriptions without manual secret generation. Configuration docs gain a Tier 2 quick example (node JSON, onboarding URL, available Gemini upstream models), and .dev.vars.example / config/worker-vars.example.json ship copyable subscription node examples.

- feat: complete Tier 2 Google Gemini (Code Assist) subscription support — the built-in google subscription adapter now dispatches through the Cloud Code Assist backend (cloudcode-pa.googleapis.com/v1internal generateContent/streamGenerateContent) instead of failing closed. A new proprietary-wire conversion module (src/subscription/google-wire.ts) converts OpenAI Chat Completions to/from the Code Assist envelope (messages→contents, system→systemInstruction, tools/tool_calls/functionResponse, generationConfig, image inlineData) for both streaming and non-streaming responses, fail-closed for unsupported request shapes. The SubscriptionAdapter contract gains an optional `wire` declaration (streamToNative/objectToNative) and an optional `upstreamUrl` override on prepared requests; the dispatch layer wraps OK upstream responses into the node's native protocol shape before the success layer, so success/stream/object handlers stay unchanged. Provider adapters gain an optional `subscriptionEndpoint` so Tier 2 auth:"oauth" nodes may omit base_url (google/anthropic/openai all resolve from the registry). Quota hints interpret gRPC RetryInfo retryDelay and Retry-After on 429. The three mainstream subscription providers (Claude/Codex/Gemini) are now fully supported end to end.

- fix: align runtime CORS and log-level reads with the documented AIG_CORS_ORIGIN and AIG_LOG_LEVEL variables so operator configuration works as documented.

- refactor: standardize the routing strategy contract — the request tier loop resolves node selection through one RoutingStrategy dispatcher (routingStrategyFor) instead of branching on the algorithm by tier; Tier 1 maps to p2c_ttft (P2C + passive TTFT + affinity + heat + quota gate, unchanged) and Tier 2/3 to priority_lru (current health/latency selection, unchanged). Future strategies (cost/quality/learned) are the extension point but are deliberately not implemented without a concrete need.

- refactor: unify runtime state reads behind a RuntimeStateStore contract — the Tier 1 adaptive runtime and the Tier 2/3 node state keep separate implementations; a new neutral read contract (EndpointState / AccountState / ModelState) projects both backends so upper layers resolve state through runtimeStateStoreFor(node) instead of importing backend internals. Projections are honest (a field a backend does not track is null, never fabricated); claims, releases, outcome recording, and quota settlement stay in the backend modules and dispatch funnels. Isolate-local best-effort; no Redis, Durable Objects, or cross-isolate coordination.

- feat: add the Tier 1 quota lease lifecycle — provider-reported quota windows (OpenAI/Anthropic rate-limit headers, subscription window-reset hints) now feed the isolate-local quota state: a reported near-limit tail demotes the account in the P2C score before a 429 arrives, an exhausted window gates admission through a reservation counter so concurrent requests cannot all pass against a reported tail, and settlement subtracts actual token usage. Unknown quota stays a no-op pass-through (no fabricated hard limits; the adaptive-429/cooldown path is untouched and pinned by its tests). Claims extend the existing release-token lifecycle: abort/pre-dispatch/hedge-loss releases restore reservations, settle/release are idempotent, and window expiry auto-restores the account to unknown until the next report.

- refactor: separate model catalog facts from runtime policy — the parsed AIG_MODELS_CONFIG entry and the Model Registry entry now expose distinct `catalog` (capabilities, reasoning efforts, modalities) and `policy` (failover policy binding, visibility, UI grouping) objects instead of one flat record; the operator-facing flat schema is unchanged and all resolved defaults, tier policy inference, family fallback, visibility filtering, and projections behave identically. Adding a model or a new model family stays configuration-only (pinned end to end by a new catalog/policy contract test).

- refactor: unify provider knowledge behind the provider adapter registry (src/providers) — each provider declares its wire contract, stream-usage quirk, built-in OAuth onboarding defaults, and subscription semantics in one module; the registry is the single provider → wire/subscription/OAuth authority and unknown providers resolve to the generic OpenAI-compatible adapter, so adding a plain OpenAI-compatible provider stays configuration-only. The retired provider-profile switch, provider-quirks module, and subscription adapter table are removed; the subscription adapter implementations and the AIG_OAUTH_PROVIDERS parse/merge machinery are unchanged and now compose through the registry. Routing, scheduling, reliability, and transport behavior are unchanged.

- feat: subscription model discovery and node abstraction — isSubscriptionNode becomes the single binding between "subscription entitlement" and its credential form (dispatch never checks node.auth directly); codex and claude adapters gain a discoverModels pass that runs best-effort at onboarding completion, surfaces the reachable upstream model count on the success page, and persists the ids as operator diagnostics (the static node models mapping stays the routing authority). Migration 0013 adds the discovered_models column.

- feat: provider adapters own subscription quota-window hints — codex and claude adapters interpret entitlement reset markers (window-reset epoch headers, resets_in_seconds bodies, anthropic ratelimit reset headers) as cooldown hints that can only extend the 429 rate-limit cooldown (capped at 6h); recovery stays the existing cooldown-expiry, single half-open probe, auto-restore circuit. API-key nodes never consume subscription hints.

- refactor: introduce the subscription adapter layer (src/subscription) — provider-specific subscription request shaping (Codex originator/account/instructions, Claude OAuth betas/client shape, Google fail-closed refusal) moves out of dispatch.ts into per-provider adapters behind a minimal prepare() contract; the adapter registry becomes the single dispatchability authority and the redundant `dispatch_ready` provider flag is removed. Scheduler, reliability, tier boundaries, and the OAuth credential lifecycle are unchanged.

- feat: apply the mainstream reverse-proxy shape to Claude OAuth subscription dispatch — merge the required beta flags (claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, fine-grained-tool-streaming-2025-05-14) into the client-supplied anthropic-beta list and send x-app plus a first-party claude-cli user agent; plain API-key nodes are untouched. CCH billing-block signing remains unimplemented (CLIProxyAPI-only extra layer).

- ci: cancel centralized PR work when a pull request is closed.

- feat: complete the Codex subscription request protocol — first-party `Originator: codex-tui` header and `instructions` field normalization (empty string when absent) on the Responses surface for OpenAI subscription dispatches; plain API-key nodes remain untouched.

- feat: harden subscription entitlement dispatch — isolate-level refresh singleflight plus cross-isolate compare-and-swap on a persisted refresh_version so token rotation keeps exactly one authoritative refresh token; persist the provider account id and send it as `chatgpt-account-id` for OpenAI subscription dispatches; fail-close runtime dispatch for providers without a verified subscription backend (built-in `google` default, override via `dispatch_ready`).

- fix: bind runtime build identity to the validated AI Gateway source SHA instead of the Action Worker runner SHA.

- feat: add Tier 2 subscription OAuth adapters with Tier 2-only `auth:"oauth"` nodes, PKCE onboarding, AES-GCM token storage, dispatch-time refresh, built-in provider defaults, and fail-closed deployment configuration.

- refactor: dispatch production deploy through Action Worker and remove repository-local deployment credentials, orchestration, and gate logic.

- refactor: move pull-request CI to Action Worker while retaining main and scheduled validation until deployment is centralized.

- ci: add a lightweight GitHub Actions merge gate for centralized Action Worker evidence.

- ci: add a trusted project entrypoint for Action Worker centralized CI.

- refactor: derive model fallback families from the final capability tier so new prefixed Pro/Max/Ultra families require no code changes.

- fix: preserve logical-model compatibility during family fallback so prefixed aliases such as `Audit-Ultra` can fail over to `Audit-Max` and `Audit-Pro` without crossing model families.

- fix: infer built-in request policies from the tier suffix of prefixed logical model names such as `Audit-Ultra` and `Editor-Air`.

- fix: configure the Cloudflare custom domain with a valid host-only route pattern.


- fix: align built-in model policies with fallback topology: Air gets a bounded four-model pass, reasoning models get the full six-attempt family plan with 60s phase timeouts and a 180s request budget, while access-key allowlists remain fail-closed.

- refactor: align merge CI with Action Worker using ci-evidence and centralized PR Governance.

- fix: drive dashboard quick-start access groups and public endpoint from runtime configuration instead of front-end constants.

- fix: rotate to another upstream after a node-local HTTP 400 rejection instead of terminating the whole request.

- fix: update the Fongap Labs dashboard link to https://labs.fongap.com.

- fix: default deployment to enabled and derive repository identity from GitHub context.
- refactor [breaking, migration]: hard cut gateway access, deployment, node-shard, credential-shard, binding, timeout, cooldown, and Boolean configuration names; derive Action Worker dispatch target from GITHUB_REPOSITORY_OWNER.