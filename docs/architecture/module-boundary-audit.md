# Module boundary and duplication audit

Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390` (2026-09-16).

This audit reviews runtime modules by ownership, dependency direction, state ownership, control flow and repeated behavior. It is not a line-count exercise: duplication is removed only when one shared owner makes the contract clearer.

## Current status

All material P1/P2 ownership findings from the baseline audit are resolved without changing routing policy, cooldown values, stream commit semantics, accounting semantics, error semantics or public API behavior.

Resolved changes:

- Tier 1 score construction moved to `src/scheduler/tier1-scoring.ts`.
- Provider-model 429 heat consolidated in `src/reliability/tier1-heat.ts`.
- `src/reliability/tier1-state.ts` now owns Tier 1 mutable reliability state rather than ranking policy.
- Success finalization split into `success.ts`, `success-stream.ts` and `success-object.ts`.
- Cross-layer upstream-processing failures moved from transport to the neutral `src/types/upstream-processing.ts` contract.
- Generic and Tier 1 automatic cooldown jitter now share `src/reliability/cooldown-jitter.ts`.

The remaining repeated code called out below is intentional and should not be abstracted without new evidence.

## Module result

| Module | Duplication | Boundary | Decision |
| --- | --- | --- | --- |
| `config` | Low/moderate parse/cache scaffolding | Good | Keep validators independent; no generic parser framework. |
| `providers` | Low | Good | One adapter per provider family; the registry is the single provider → wire/OAuth/subscription/quirk authority. |
| `scheduler` | Low | Good | Own ranking policy; do not move reliability state here. |
| `reliability` | Low/moderate | Good | State, heat, classification and shared cooldown arithmetic have explicit owners. |
| `request` | Moderate | Good after success split | Keep `success.ts` thin; protocol-specific branches stay visible. |
| `transport` | Low | Good | Keep wire/path predicates here. |
| `protocol` | Low/moderate | Good | Keep protocol semantics explicit. |
| `conversion` | Moderate internal repetition | Good | Keep explicit Chat ↔ Messages conversion; no universal IR. |
| `stream` | Moderate mechanical repetition | Good | OpenAI/Anthropic state machines remain separate. |
| `observability` | Moderate intentional query/write parallelism | Good | Preserve delivered vs physical-upstream accounting as separate concepts. |
| `runtime` | Low | Good | Read-only projections only. |
| `dashboard` | Low/moderate rendering repetition | Good | Presentation must not depend back on execution-state modules. |
| `ratelimit` | Low | Good | Keep isolated. |
| `types` | Low | Good | Neutral cross-layer contracts only; not a utility drawer. |

## Resolved findings

### Tier 1 ownership

The implemented ownership is:

```text
reliability/tier1-state.ts   mutable account/model state
reliability/tier1-heat.ts    provider-model heat + hedge pressure
scheduler/tier1-scoring.ts   score constants + score calculation
scheduler/tier1-scheduler.ts eligibility + affinity + P2C + claim
```

This was an ownership correction only. Existing P2C behavior, TTFT weighting, affinity, quota and heat factors were preserved.

### Success finalization

The former `request/attempt/success.ts` hotspot was mechanically split into:

```text
attempt/success.ts           thin dispatcher + shared contract
attempt/success-stream.ts    first-event guard + stream lifecycle
attempt/success-object.ts    object assembly + object finalization
```

The dispatch predicate and protocol-specific behavior remain explicit. Embedded-error and post-header branches are not forced into a generic result engine.

### Upstream-processing failures

`src/types/upstream-processing.ts` now owns the cross-layer failure vocabulary. Stream/protocol code produces typed processing failures and `reliability/classify.ts` decides reliability effects. The retired `src/transport/processing-error.ts` path is removed rather than retained as a shim.

### Automatic cooldown jitter

Generic node reliability and Tier 1 previously duplicated the same ±10% arithmetic. `src/reliability/cooldown-jitter.ts` now owns that pure calculation; both state machines decide independently when jitter applies.

### Provider adapter consolidation

Provider knowledge previously spread across `src/config/provider-profile.ts` (wire switch), `src/config/provider-quirks.ts` (stream usage), `src/oauth/provider-configs.ts` (OAuth defaults), and `src/subscription/index.ts` (adapter table) is now declared once per provider in `src/providers/` and resolved through `src/providers/registry.ts`. The subscription adapter implementations stay in `src/subscription/` and are composed into provider adapters; the OAuth parse/merge machinery stays in `src/oauth/provider-configs.ts` and consumes adapter-declared defaults. The retired switch and quirks modules are removed rather than retained as shims.

Important semantics remain unchanged:

- only automatically computed cooldowns/backoffs use jitter;
- explicit provider `Retry-After` remains exact and unjittered;
- the jitter range remains ±10%;
- Tier 1 429 duration remains owned by `adaptive-429.ts`.

## Intentional duplication

### Delivered vs physical-upstream queries

`token-usage-store/queries.ts` and `token-usage-store/upstream-queries.ts` intentionally look similar because they answer different accounting questions:

- delivered columns describe successful request evidence and TTFT;
- `upstream_*` columns describe physical retry/fallback/hedge consumption.

Do not merge them into a generic query builder unless a concrete drift problem or third accounting view justifies it.

### Protocol stream assemblers

OpenAI and Anthropic assemblers share reader/scanner mechanics but have different terminal events, EOF rules and semantic state. Keep them explicit unless a third implementation proves a stable common abstraction.

### Configuration parsers

`models.ts`, `policies.ts` and `protocol-fallbacks.ts` share parse/cache/diagnostic patterns but have different schemas and failure contracts. A generic parser would currently obscure validation.

### Conversion paths

`SUPPORTED_CONVERSIONS` and fallback policy may currently contain the same directions but represent capability and policy respectively. They are allowed to diverge and remain separate.

## Guardrails

`tests/module-boundary-contract-test.mjs` pins the stable dependency directions and the resolved ownership decisions:

- scheduler owns Tier 1 scoring;
- reliability owns Tier 1 heat/state;
- both reliability state machines consume the shared cooldown-jitter primitive;
- success dispatch/stream/object responsibilities stay split;
- reliability consumes the neutral upstream-processing contract and does not depend on transport for failure vocabulary;
- provider knowledge resolves through one registry (`src/providers/registry.ts`); the retired provider-profile/provider-quirks modules stay removed, subscription stays composition-only, and scheduler/reliability/transport never import the provider registry;
- persistent observability stays independent from routing execution;
- dashboard presentation cannot depend back on scheduler/reliability/transport execution state.

`tests/cooldown-jitter-test.mjs` separately pins the shared ±10% arithmetic at lower, neutral and upper random samples.

Future refactors should prefer clean replacement over compatibility layers and should not create new abstractions merely to reduce line count.
