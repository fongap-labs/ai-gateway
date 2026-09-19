# Public Model Status

The status shown on the public dashboard is a **read-only service projection**. It is not the same thing as isolate-local scheduling state and must never become a routing input.

## Two different concepts

### Runtime Availability

`src/runtime/availability.ts` summarizes what the current Worker isolate knows about candidate availability: Tier 1 observation/cooldown state and Tier 2/3 reliability state.

Scheduler and reliability logic may use this runtime state.

### Public Model Status

`src/runtime/model-status.ts` combines current runtime availability with persisted recent-success evidence so the public page does not incorrectly label every model as unobserved after an isolate restart.

The direction is one-way:

```text
Runtime state + D1 observability
            ↓
Public Model Status
            ↓
Dashboard HTML
```

Public Model Status never feeds Scheduler, Reliability, Transport, Protocol, Conversion, Hedge, Cooldown, or Failover.

## Dashboard display allowlist

`DASHBOARD_MODELS` is an optional non-secret Worker **text variable** that controls which logical models appear individually in the public dashboard.

Example:

```text
DASHBOARD_MODELS=Code-Ultra,Code-Max,Code-Pro,Ultra,Max,Pro,Air
```

Rules:

- unset or empty → show the full public model catalog;
- configured → show only matching public models in **模型状态**;
- matching is case-insensitive and trims whitespace;
- official logical-model casing is preserved in the UI;
- unknown names are ignored and never create fake rows;
- duplicates are removed;
- the configured CSV order becomes the model-status display order.

This variable is presentation-only. It does **not** change `/v1/models`, model registration, access-key allowlists, routing, model-family fallback, health decisions, D1 collection, or aggregate Token/request totals. In the **模型使用** panel it controls which logical models are eligible to appear as named rows; non-allowlisted usage is folded into `其他` rather than removed from totals. Existing `MODELS_CONFIG` visibility rules are applied first, so this allowlist cannot re-expose a model already hidden by registry configuration.

## Status states

The current public surface has five states:

| State | UI label | Meaning |
| --- | --- | --- |
| `available` | 服务可用 | At least one current path is available, or a fresh/unobserved isolate is backed by success evidence within 24 hours |
| `fluctuating` | 服务波动 | All current candidates are explicitly unavailable, but the model has success evidence within 24 hours |
| `no_recent` | 无新记录 | No current available path and no success within 24 hours, but success exists inside the 7-day retained history |
| `no_record` | 暂无记录 | The model is configured/public but the retained statistics window contains no success evidence |
| `down` | 服务故障 | No serving candidate exists, or all serving candidates are explicitly unavailable with no recent success evidence |

A cold isolate with no local Tier 1 TTFT sample must not be transformed into a false global outage claim when persisted recent success proves the model has been serving.

## Success evidence

The persisted evidence path reuses token-usage storage under `src/observability/token-usage-store.ts` and its submodules. The model-status projection queries per-model **successful delivered request** evidence from the existing D1 aggregation rather than creating a second health database.

Two windows are used:

- recent evidence: 24 hours;
- historical evidence: the 7-day retained per-model window.

A per-model row with `requests > 0` means at least one real request was successfully delivered in that bucket. Upstream retry/fallback/hedge attempts do not create public success evidence by themselves.

## TTFT display

The dashboard also displays model-level TTFT aggregates for the same recent 24-hour window:

- `P50` requires at least 5 successful TTFT samples;
- `P95` requires at least 20 successful TTFT samples;
- `samples` is `successful_ttft_count`, i.e. successful delivered requests with a recorded TTFT sample.

TTFT is presented as bucket bounds rather than fabricated exact values. The open-ended final bucket is rendered as `≥10s`.

These aggregates are presentation/observability data only. They do not feed candidate scoring from D1 and do not replace Tier 1's isolate-local passive TTFT used by the scheduler.

## D1 failure behavior

Public status is fail-open as a presentation feature:

- no D1 binding → continue with runtime evidence;
- D1 read failure → continue without persisted evidence;
- empty recent-evidence result → do not invent success;
- TTFT query failure → keep model rows/status and render missing TTFT values;
- presentation failure must not break the request-routing hot path.

A D1 problem must not automatically mark every model as available or unavailable.

## Privacy boundary

The public projection may expose only model-level, aggregated service facts needed by the dashboard: logical model id, public status, bucketed P50/P95, sample count, and aggregate usage views.

It must not expose:

- node ids;
- provider/tier/protocol/surface internals;
- upstream base URLs or credentials;
- cooldown/failure-reason internals;
- per-node/account TTFT or scheduler state;
- request bodies or user data.

The public status contract exists for service presentation, not operator debugging.

## Performance boundary

Recent model evidence and TTFT aggregates are loaded as shared dashboard query/cache inputs rather than one database query per node/model. Public status stays outside the scheduler hot path.

## Source files

- `src/runtime/availability.ts` — isolate-local availability projection.
- `src/runtime/model-status.ts` — public five-state decision logic.
- `src/dashboard/model-status-view.ts` — dashboard allowlist, P50/P95/samples rendering.
- `src/observability/token-usage-store.ts` and `src/observability/token-usage-store/` — persisted success/TTFT/usage access.
- dashboard modules — presentation only.

Any future status signal that is intended to affect routing must be designed as a separate reliability feature rather than quietly reusing this public projection.
