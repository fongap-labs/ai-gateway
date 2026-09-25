-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Labs
--
-- Subscription model discovery results. The subscription adapter's
-- discoverModels() runs best-effort at onboarding completion and stores the
-- upstream model ids the credential can actually reach. Discovered ids are
-- OPERATOR DIAGNOSTICS (what the entitlement currently grants); the static
-- node models mapping remains the routing authority.
--
-- Forward-compatibility: additive only. The previous Worker ignores the
-- column, so a Worker rollback over an applied migration stays safe.

ALTER TABLE subscription_tokens ADD COLUMN discovered_models TEXT;
