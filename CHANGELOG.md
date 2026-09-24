# Changelog

## [Unreleased]

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