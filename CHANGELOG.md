# Changelog

## Unreleased

Changes are grouped by operator impact. Implementation history and superseded tuning details remain in Git.

### Migration and configuration

- **Diagnostics access:** `/health` and `/metrics` require MAX or ULTRA access by default; configure `AIG_DIAGNOSTICS_GROUPS` before deployment if neither group is available. `*` permits all valid gateway keys.
- **OAuth administration:** `/oauth/start` is disabled unless `AIG_OAUTH_ADMIN_GROUPS` authorizes the caller. `AIG_IS_SUBSCRIPTION_ENABLED=false` disables subscription nodes and OAuth routes.
- **Credentials and cache:** Set `AIG_TOKEN_ENCRYPTION_KEY` to use encrypted OAuth credentials and credential-bound edge caching; missing encryption keys fail closed. Cache use is opt-in unless `AIG_EDGE_CACHE_AUTO=true` is configured.
- **Deployment settings:** Gateway, node, credential-shard, timeout and cooldown variables were consolidated under the current configuration contract. `AIG_DASHBOARD_PUBLIC` was retired; the public dashboard is controlled by `AIG_PUBLIC_DASHBOARD`.
- **Degraded deployments:** Excluded or malformed nodes are reported through `/health` and block deployment checks by default. Only set `AIG_ALLOW_DEGRADED=true` when reduced capacity is intentional.
- **Tier 1 quota cooldown:** Short-window 429s no longer escalate to long quota cooldown merely after repeated probes. Older excessive cooldowns may remain in KV until expiry; operators can clear `tier1-cooldowns:v1` in `TIER1_AFFINITY` once during migration.

### Security

- Limit protocol-conversion response buffering to 2 MiB, OAuth form bodies to 64 KiB and concurrent request-body reservations to 32 MiB per isolate; reject oversized payloads before reading when possible.
- Bind cached responses to credential fingerprints, request content and response mode; prevent cross-client reuse, avoid caching tool calls and incomplete streams, and return `private, no-store` to clients.
- Bind stored OAuth tokens to node, provider and field using AES-GCM authenticated data; consume OAuth state atomically and avoid exposing credentials in diagnostics or logs.
- Rate-limit failed authentication with `AIG_AUTH_ATTEMPT_RPM` (default 60/min, `0` disables it); preserve independent model authorization and restrict node details visible through `/health`.
- Use cryptographically secure randomness for routing and jitter; harden secret-file permissions, broaden secret scanning, address CodeQL findings and pin the external test pack to an immutable commit.
- Keep the public dashboard free of secret-bearing quick-start details; API endpoints still require gateway authorization.

### Routing and reliability

- Improve Tier 1 429 classification: separate short rate-limit windows from quota exhaustion, respect provider reset evidence, apply model-scoped cooldown where possible and permit key-wide cooldown only with stronger evidence.
- Cap built-in Tier 1 short-window cooldown at five minutes and long-quota cooldown at 30 minutes unless explicitly configured otherwise; use bounded half-open recovery and a single probe where enabled.
- Avoid turning an isolated 403 or HTTP 400 into a whole-pool outage; preserve key-wide 401 handling and restore transient retries within the shared attempt and time budget.
- Keep Tier 1 availability, quota leases, shared long cooldowns and session affinity consistent under concurrent requests; bound KV reads and avoid unnecessary writes.
- Prefer the requested model while it can accept work; otherwise select an eligible, less-loaded sibling within the same model family. Bound silent streaming sibling hops without exceeding the request budget.
- Add optional isolate-level admission, retry and hedge guards to prevent slow or failing upstreams from exhausting free-tier capacity; preserve explicitly configured per-tier ceilings.

### Protocols and streaming

- Support native OpenAI Chat Completions, Responses and Anthropic Messages with a common intermediate representation for cross-protocol fallback, while retaining native passthrough.
- Preserve reasoning, tools, documents, usage and completion semantics across supported conversions; reject unsupported native-only controls with explicit diagnostics.
- Improve Claude Code model aliases, Anthropic and Responses stream completion, tool-call assembly, malformed responses and path normalization.
- Add optional `AIG_CONVERSION_BUDGET` limits and error/truncation modes for conversion CPU, output and tool events, plus optional nonstream upstream dispatch.
- Add optional `AIG_STREAM_PASSTHROUGH` to reduce stream relay CPU; document its model-rewrite and usage-observation tradeoffs. Guard initial SSE buffering and cancel losing hedges promptly.
- Retain concurrency and quota reservations until streams finish or cancel; treat incomplete or malformed streams as unsuccessful rather than silently reporting success.

### Subscription, operations and observability

- Add Tier 2 OAuth adapters for Anthropic, OpenAI and Google, including token refresh coordination, quota hints, provider model discovery and Google Code Assist wire translation.
- Separate provider wire definitions from runtime routing policies; centralize provider adapters, scheduler strategy and state-reading contracts without changing Tier roles.
- Consolidate production CI, testing and deployment under Action Worker; enforce TypeScript, Biome, secret and documentation checks and retain commit-SHA deployment identity.
- Reduce hot-path CPU, duplicate stream parsing, redundant hashes, KV activity and excessive logs; expose optional free-tier cost, conversion, probe and admission controls.
- Batch D1 usage writes, preserve upstream-attempt accounting separately from successfully delivered requests and support explicit model-detail sampling; improve TTFT, cache and usage diagnostics.
- Remove the verbose dashboard upstream-accounting notice while keeping token data collection, correct stream/cache counters and public model-status evidence.
- Correct OAuth browser form CSP, Cloudflare custom-domain routing, deployment secret propagation, runtime environment parsing and dashboard navigation.

