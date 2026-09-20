# Development Policy

Shared Fongap Labs development governance is maintained in:

- https://github.com/fongap-labs/action-worker/tree/main/docs

This file is retained temporarily because the current ai-gateway policy contract test still reads this path. It is not an independent governance authority.

Project-local development invariants are defined in [product-policy.md](product-policy.md):

- Clean replacement rule: when the canonical design changes, remove the superseded path in the same change.
- Tier 1 is free-token capacity; Tier 2 is reserved for membership/subscription entitlements; Tier 3 is reserved for paid API capacity.
- Project release numbering is not an engineering automation concern.
- Gateway-specific quality and dependency requirements remain in this directory.

After the machine contract is updated to read the canonical documents directly, this compatibility page should be removed.
