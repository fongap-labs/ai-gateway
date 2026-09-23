# Changelog

## [Unreleased]

- refactor: derive model fallback families from the final capability tier so new prefixed Pro/Max/Ultra families require no code changes.

- fix: preserve logical-model prefixes during family fallback so aliases such as `Audit-Ultra` can fail over to `Audit-Max` and `Audit-Pro` without crossing model families.

- fix: infer built-in request policies from the tier suffix of prefixed logical model names such as `Audit-Ultra` and `Editor-Air`.

- fix: configure the Cloudflare custom domain with a valid host-only route pattern.


- fix: align built-in model policies with fallback topology: Air gets a bounded four-model pass, reasoning models get the full six-attempt family plan with 60s phase timeouts and a 180s request budget, while access-key allowlists remain fail-closed.

- refactor: align merge CI with Action Worker using ci-evidence and centralized PR Governance.

- fix: drive dashboard quick-start access groups and public endpoint from runtime configuration instead of front-end constants.

- fix: rotate to another upstream after a node-local HTTP 400 rejection instead of terminating the whole request.

- fix: update the Fongap Labs dashboard link to https://labs.fongap.com.

- fix: default deployment to enabled and derive repository identity from GitHub context.
- refactor [breaking, migration]: hard cut gateway access, deployment, node-shard, credential-shard, binding, timeout, cooldown, and Boolean configuration names; derive Action Worker dispatch target from GITHUB_REPOSITORY_OWNER.