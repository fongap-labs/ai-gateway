# Deployment

Production deployment uses the shared Action Worker execution plane. This repository owns the product code, deploy manifest, validation, and Cloudflare deployment entrypoint. Action Worker owns source admission, CI evidence, main-write provenance, runner resolution, GitHub Environment binding, secret scoping, and deploy orchestration.

## Production path

```text
Pull Request
    ↓
Action Worker PR Governance
    ↓
validate-merge
    ↓
squash merge to main
    ↓
ai-gateway .github/workflows/ci.yml
    ↓ thin dispatch only
Action Worker Central CI
    ↓
CI Evidence + Main Write Guard
    ↓
.github/deploy.json
    ↓
Action Worker Source Script Deploy
    ↓ environment: production
scripts/deploy.sh
    ↓
preflight + deploy validation
    ↓
Cloudflare Worker deployment
    ↓
health verification by exact source SHA
    ↓
success / Worker rollback on failure
```

The source repository does not own a separate production deploy workflow. The deployment contract is declared in `.github/deploy.json`:

```json
{
  "schema_version": "1",
  "adapter": "source-script",
  "automatic": true,
  "ignore_docs_only": true,
  "runner_profile": "production-deploy",
  "environment": "production",
  "entrypoint": "scripts/deploy.sh"
}
```

The manifest expresses deployment intent. It does not grant runner access, credentials, or production authority.

## Automatic deployment

After Central CI succeeds for the current default-branch HEAD, Action Worker resolves the source-owned deploy manifest. Automatic deployment proceeds only when:

- the source SHA is the current default-branch HEAD;
- the repository has the central `deploy` capability;
- trusted Action Worker `CI Evidence` is successful;
- Main Write Guard proves the source came through the governed merge path;
- the manifest has `automatic: true`;
- the selected runner profile resolves to the privileged trust domain;
- the change is not documentation-only when `ignore_docs_only: true`.

Pull-request CI does not trigger production deployment.

## Manual central deployment

Action Worker's `Source Script Deploy` workflow can be started manually with:

```text
source_repository = fongap-labs/ai-gateway
source_sha        = <exact 40-character current main SHA>
```

Manual execution is not a validation bypass. The same source, CI Evidence, Main Write Guard, deploy manifest, runner, Environment, and secret-scope checks apply.

## Production Environment

The deploy manifest binds the execution job to the GitHub Environment named `production`. Non-sensitive runtime configuration belongs in Variables; credentials belong in Secrets.

Action Worker exports the resolved Variables and exposes only source-declared deploy Secrets. `.github/deploy.secrets.allowed` defines the maximum application-secret surface. Central control credentials are removed before `scripts/deploy.sh` executes.

Core production Variables include:

- optional `AIG_IS_DEPLOY_ENABLED=false` emergency kill switch;
- `CLOUDFLARE_ACCOUNT_ID`;
- `AIG_PUBLIC_URL`;
- at least one `AIG_TIER{1,2,3}_NODES_XX` shard;
- `AIG_AFFINITY_KV_ID` when Tier 1 affinity is used;
- optional `AIG_USAGE_D1_ID`;
- corresponding `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}`;
- optional `AIG_MODELS_CONFIG`, `AIG_POLICIES_CONFIG`, and other runtime Variables.

Core production Secrets include:

- `CLOUDFLARE_API_TOKEN`;
- configured `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}`;
- tier-scoped `AIG_TIER{1,2,3}_CREDENTIALS_01..10`;
- `AIG_TOKEN_ENCRYPTION_KEY` when encrypted subscription credentials are used.

The application preflight fails closed when required production inputs are missing.

## Source-owned deploy entrypoint

`scripts/deploy.sh` receives the exact admitted source SHA as `DEPLOY_SOURCE_SHA`. It:

1. honors the emergency deploy kill switch;
2. requires a full immutable source SHA;
3. installs the locked Node dependencies;
4. runs `npm run validate:deploy` and `npm run check:deploy`;
5. prepares the Cloudflare deployment configuration and secret payload;
6. deploys through the pinned Wrangler wrapper;
7. verifies the live build against the exact source SHA;
8. rolls back the Worker deployment if post-deploy verification fails.

Cloudflare remains the execution target, not the canonical configuration editor.

## Node credential binding

Config and Secret shards are independent partitions. Runtime binding is by **Tier + node id**, not by matching shard suffixes.

To add or rotate an upstream key:

1. keep the node in the appropriate `AIG_TIER*_NODES_XX` Variable;
2. add or update its credential under the same node id in any Secret shard for that tier;
3. let the next governed deployment rebuild runtime configuration.

Do not place credentials in node JSON.

## Gateway access groups

```text
AIG_ACCESS_KEY_AIR       + AIG_ACCESS_MODELS_AIR
AIG_ACCESS_KEY_PRO       + AIG_ACCESS_MODELS_PRO
AIG_ACCESS_KEY_MAX       + AIG_ACCESS_MODELS_MAX
AIG_ACCESS_KEY_ULTRA     + AIG_ACCESS_MODELS_ULTRA
AIG_ACCESS_KEY_AGENT     + AIG_ACCESS_MODELS_AGENT
```

A configured key with an empty or missing model allowlist is fail-closed and grants zero model access.

## Verification and rollback

The deployed Git commit SHA is passed into the Worker build. Authenticated `/health` exposes that build identity.

Post-deploy verification requires the live build to match the exact admitted source SHA and then validates the required gateway surfaces. A failed health check triggers Worker rollback.

D1 migrations are not transactionally undone by Worker rollback. Migration changes must therefore remain safe across deployment and rollback boundaries.

## Local/operator lifecycle

Local direct deployment remains an operator path and is separate from the governed GitHub production path:

- `scripts/install.sh` / `scripts/install.ps1` — first-time bootstrap;
- `scripts/reconfigure.sh` / `scripts/reconfigure.ps1` — update operator configuration;
- `npm run deploy` — direct deployment from an already configured checkout;
- `npm run cf:login`, `npm run cf:whoami`, `npm run tail` — Cloudflare operator commands.

All direct Cloudflare CLI calls route through `scripts/cloudflare-wrangler.mjs`. The tracked `wrangler.jsonc` remains the repository baseline; local overrides belong in gitignored `wrangler.user.jsonc`.

## Repository protection

`validate-merge` is the PR-time required merge authority. Production deployment is post-merge execution and is not a PR required check.

See [github-repository-settings.md](github-repository-settings.md) for repository settings and [Configuration](configuration.md) for runtime configuration semantics.
