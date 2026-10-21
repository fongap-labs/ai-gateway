/**
 * Commitlint configuration for fongap-labs/action-worker.
 *
 * The authority for the eleven types and the subject format is
 * docs/04_CHANGELOG_CONVENTIONS.md; the local guard is .githooks/commit-msg.
 * This file only powers optional manual linting, for example:
 *
 *   npx --yes --package=@commitlint/cli@19 commitlint --from origin/main --to HEAD
 */
/** @type {import('@commitlint/types').UserConfig} */
const config = {
  rules: {
    "type-enum": [
      2,
      "always",
      ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"],
    ],
    "type-empty": [2, "never"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "subject-case": [0],
    "header-max-length": [0],
  },
};

module.exports = config;
