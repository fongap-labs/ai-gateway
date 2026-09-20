# Governance

ai-gateway inherits shared naming, change classification, development, PR Gate, release and repository governance from [Fongap Labs Action Worker](https://github.com/fongap-labs/action-worker/tree/main/docs).

This directory contains only ai-gateway-specific policy.

## Project-specific authority

| Document | Authority |
| --- | --- |
| [product-policy.md](product-policy.md) | Product scope, Tier 1/2/3 roles, clean replacement, human-owned release identity and simplicity boundary |
| [quality-policy.md](quality-policy.md) | Gateway-specific CI, protocol, reliability, security and production validation |
| [dependency-policy.md](dependency-policy.md) | Worker runtime, GitHub Actions, Wrangler and dependency-update rules |
| [documentation-policy.md](documentation-policy.md) | ai-gateway document ownership and code-to-doc synchronization |
| [development-policy.md](development-policy.md) | Temporary non-authoritative redirect retained for the current policy contract test |

## Document classes

| Directory | Purpose |
| --- | --- |
| `docs/architecture/` | Durable gateway design boundaries and runtime invariants |
| `docs/operations/` | Current configuration, deployment and troubleshooting procedures |
| `docs/governance/` | ai-gateway-specific product and quality rules |

Shared branch naming, PR structure, changelog classification and general engineering rules belong to Action Worker.

Executable behavior remains authoritative in runtime code, schemas, configuration parsers, tests and workflows. Project documentation must be corrected when it drifts.
