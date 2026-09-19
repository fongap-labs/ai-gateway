# Troubleshooting

Start with evidence from the failing boundary: configuration validation, CI job/step, authenticated `/health` build identity, sanitized gateway logs, and aggregated failure diagnostics. Do not rotate or rewrite unrelated configuration until the failing layer is identified.

## Configuration failures

### Gateway is `unconfigured`

Check that:

- at least one `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` Secret is configured;
- its matching `GATEWAY_ACCESS_MODELS_<GROUP>` Variable is present and non-empty;
- at least one `TIER{1,2,3}_NODES_CONFIG_XX` Variable exists;
- usable nodes have credentials in a `TIER{1,2,3}_NODES_SECRETS_XX` Secret for the same tier.

A group key with an empty model allowlist intentionally grants zero models.

### `No TIER{1,2,3}_NODES_CONFIG_XX Variable is configured`

Add at least one valid tier config shard containing a JSON array of nodes. The suffix is only a shard number.

The current account-level Node schema is:

```text
required: id, provider, base_url, models
optional: priority
```

`protocol`, `surfaces`, `limits`, credentials, and unknown fields are rejected. Protocol and routable surfaces come from `src/config/provider-profile.ts`.

### Missing node credential

Credentials bind by Tier + node id. They do not need to be in a Secret shard with the same suffix as the Config shard.

Example:

```text
TIER1_NODES_CONFIG_03 contains node "nvidia-01"
TIER1_NODES_SECRETS_01 may contain {"nvidia-01":"..."}
```

If the tier differs, the credential is invalid for that node.

### `MODELS_CONFIG` / `POLICIES_CONFIG` invalid

These auxiliary configs are validated fail-fast. Check malformed JSON, unknown fields, invalid values, and model→policy references to policy names that do not exist.

Use:

```bash
npm run config:check
npm run validate:merge
```

## Deployment failures

### Preflight fails

Use the exact missing Variable/Secret named by the job. Do not add unrelated placeholders merely to make preflight continue.

### D1 migration fails

The Worker is not deployed after a required migration failure. Inspect the migration error first; do not bypass migration ordering.

### Worker deploy succeeds but verification fails

The workflow attempts Worker rollback. Check the `Verify deployed gateway`, rollback, and rollback-verification steps separately.

Authenticated `/health` exposes the deployed commit SHA as `build`; production verification compares that value with the commit selected by the Deploy workflow.

If rollback verification also fails, the previous Worker may not be healthy or external configuration/upstream state may have changed. Stop automatic retries and inspect the deployed build/configuration evidence.

### Docs-only change did not deploy

This is expected when the triggering `main` commit changes only Markdown files and/or `docs/**`. The deploy gate intentionally skips Worker deployment for documentation-only changes.

## Runtime HTTP failures

### 400 / other client-class 4xx

The current failure taxonomy treats terminal request-invalid 4xx as `client` and stops the logical request. The gateway does not claim provider-specific 400 compatibility classification and automatic rotation for every such error.

Check:

- whether the selected upstream actually supports the request field;
- whether the request reached a native or converted fallback path;
- structured-output/tool fields and provider wire compatibility;
- sanitized upstream error text where available.

Do not assume a 400 means the key itself is unhealthy.

### 429 Too Many Requests

Tier 1 learns from real upstream rate-limit evidence rather than configured node RPM guesses.

Check:

- `Retry-After` if the provider sends it;
- whether the affected credential is in key-local adaptive cooldown/recovery;
- whether several independent keys for the same `(provider, upstream model)` are producing provider-model heat;
- current isolate-local in-flight pressure;
- whether multiple Worker isolates/PoPs are sharing the same upstream account/key;
- optional policy `max_in_flight` only when you deliberately configured a known per-account local safety ceiling.

Tier 1 cooldown is scoped to the affected provider/key slot; it does not intentionally disable the whole Provider or logical model. Provider-model heat is a bounded ranking signal, not a global cooldown.

There is no node `limits.rpm`, `rpm_mode`, or guessed Provider-global concurrency contract in the current schema.

### 502 Bad Gateway

Use failure diagnostics to identify whether the dominant issue is:

- `server`
- `network`
- `headers_timeout`
- `first_event_timeout`
- `stream_interrupted`
- `model_missing`
- `endpoint_not_found`
- conversion failure / unsupported fallback semantics

A converted fallback still returns the original client's error envelope.

### 503 Service Unavailable

Common causes:

- gateway configuration is invalid/unconfigured;
- all matching protocol/surface/model candidates are temporarily unavailable;
- the request-wide logical-attempt plan is exhausted after retryable failures;
- an explicit local `max_in_flight` ceiling is occupied for the relevant Tier 1 policy;
- no authorized compatible family fallback remains inside the same request budget.

Use authenticated `/health` and sanitized runtime diagnostics. A retryable family-exhaustion 503 does not prove that every account in the deployment was tested or globally unavailable.

### 504 Gateway Timeout

The request-wide `FAILOVER_BUDGET_MS` was exhausted or no safe attempt remained within the wall-clock budget. Inspect upstream headers/first-event latency, attempted failure domains, and fallback/hedge activity before increasing the budget.

## Model problems

### Model not listed or unavailable

Check the logical model name against node `models` mappings and optional `MODELS_CONFIG`. Provider-facing model ids may differ from the gateway's logical model aliases.

A model-shaped upstream 404 uses a short upstream-model-specific cooldown; it should not permanently poison the logical alias after remapping.

### Claude Code / Anthropic Messages fallback problem

A native Anthropic route requires a node whose `provider` resolves to the Anthropic Provider Wire Profile. If native candidates are exhausted and fallback is enabled, the request may convert to OpenAI Chat.

The conversion bridge is intentionally not full Anthropic semantic emulation. Features such as thinking history/control, context-management controls, provider-native tools, and some tool hints may be degraded or rejected. Debug conversion diagnostics expose fixed categories without request content.

### OpenAI Responses problem

OpenAI Responses is Native Only. Under the current Provider Wire Profiles, native `/v1/responses` routing is available only to nodes using `provider: "openai"`.

Confirm:

- the Node Config uses `provider: "openai"`;
- `base_url` points to the intended OpenAI endpoint;
- the logical model mapping resolves to a model supported by `/v1/responses`;
- credentials are bound to that node in the same tier.

Do not add per-node `protocol` or `surfaces` fields; those are rejected by the current Node schema. If another Provider needs native Responses support, its Provider Wire Profile must be changed explicitly.

### Structured output fallback

The conversion strategy is conservative:

- positive native capability evidence can use native JSON Schema;
- synthetic Tool mode additionally needs a response-side unwrap adapter;
- unknown target capability uses Prompt emulation.

The current generic runtime fallback path therefore defaults unknown targets to Prompt rather than forcing an unsupported `response_format`.

## Tier 1 routing diagnosis

A fast key is not guaranteed to receive most traffic. Tier 1 deliberately balances passive TTFT with live pressure and failure evidence.

If a previously preferred affinity key receives less traffic, check whether:

- its current in-flight pressure is elevated;
- provider-model rate-limit heat is penalizing the cohort;
- its affinity advantage has weakened as pressure/heat rose;
- it is in cooldown/recovery/half-open state;
- an explicit local `max_in_flight` ceiling is occupied;
- hedge spare-capacity gating excluded it from optional twin work.

Access-key groups (`AIR/PRO/MAX/ULTRA/AGENT`) authorize models; they do not assign Tier 1 scheduler priority.

## Dashboard / usage diagnosis

The public dashboard intentionally uses different counters for different questions:

- Token totals: real physical upstream Token usage, including retry/fallback/hedge work when the upstream reports usage;
- public `次请求`: successfully delivered requests, so internal retry/fallback/hedge attempts do not inflate the count;
- model-usage tooltips: physical upstream calls for the model-usage breakdown;
- model-status `samples`: successful delivered requests with a recorded TTFT sample in the recent window.

Do not divide aggregate physical Token usage by upstream-attempt count and compare that result directly with public successful-request or TTFT-sample counts; they answer different questions.

## Streaming problems

### Headers timeout

No upstream response headers arrived before `UPSTREAM_HEADERS_TIMEOUT_MS`. Check network/provider responsiveness.

### First-event timeout

Headers arrived but no meaningful protocol-specific output appeared before the active attempt deadline. `FIRST_EVENT_TIMEOUT_MS` is bounded by the same request/attempt wall-clock budget; lifecycle-only SSE events do not necessarily commit the response.

### Stream interruption

A stream can commit successfully and later truncate. After commit, the gateway does not transparently replay the request to another provider because duplicate partial output would be unsafe.

## Safe evidence collection

Never include live credentials, full authorization headers, private upstream URLs, prompts/request bodies, or user data in an Issue or public log sample. See [SECURITY.md](../../SECURITY.md).
