# Agent Guide

This repository inherits Fongap Labs shared governance from [fongap-labs/action-worker](https://github.com/fongap-labs/action-worker/tree/main/docs).

## Required reading

1. `CLAUDE.md`
2. Action Worker `docs/SHARED_GOVERNANCE.md`
3. Action Worker `docs/NAMING_CONVENTIONS.md`
4. Action Worker `docs/CHANGELOG_CONVENTIONS.md`
5. Action Worker `docs/DEVELOPMENT_GUIDE.md`
6. The project-specific documents below

## Project authority

- `docs/governance/product-policy.md`
- `docs/architecture/overview.md`
- `docs/architecture/routing-model.md`
- `docs/architecture/reliability-model.md`
- `docs/architecture/protocol-model.md`
- `docs/governance/quality-policy.md`
- `docs/governance/dependency-policy.md`

## Project-specific rules

- Keep one current runtime/configuration contract; do not add compatibility shims for retired behavior.
- Provider/model fallback stays inside the gateway reliability/routing model.
- Preserve protocol, streaming, scheduler, cooldown and token-accounting contracts unless the project docs are deliberately changed.

## Precedence

```text
Action Worker machine contracts / shared governance
        ↓
this repository's project architecture / project boundary
        ↓
implementation documentation
        ↓
README / examples
```

Shared governance is not duplicated here. Project documents may add stricter product-specific constraints but must not bypass the shared trust, PR Gate, release or repository-governance contracts.
