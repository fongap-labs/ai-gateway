# Changelog

## [Unreleased]

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