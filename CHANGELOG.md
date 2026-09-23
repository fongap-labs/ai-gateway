# Changelog

## [Unreleased]

- fix: default deployment to enabled and derive repository identity from GitHub context.
- refactor [breaking, migration]: hard cut gateway access, deployment, node-shard, credential-shard, binding, timeout, cooldown, and Boolean configuration names; derive Action Worker dispatch target from GITHUB_REPOSITORY_OWNER.