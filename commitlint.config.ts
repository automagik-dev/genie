export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message: string) => message.startsWith('[skip ci]'),
    // GitHub merge/squash-merge commits have auto-generated bodies that
    // violate body-max-line-length and contain nested commit messages.
    // Individual commits are already linted on dev before merge.
    (message: string) => message.startsWith('Merge'),
    // GitHub squash-merge commits without conventional prefix: "Title (#123)\n\n* feat: ..."
    // These have a PR number suffix and nested conventional commits in the body.
    // Already linted individually on dev before merge.
    (message: string) =>
      /\(#\d+\)/.test(message.split('\n')[0]) &&
      !/^(feat|fix|chore|refactor|docs|style|test|perf|ci|build|revert)/.test(message),
    // Historical exception: one `wip:` commit landed on dev via #1065 before
    // pre-commit hooks caught it (commit 2b226b3b). Ignoring it here unblocks
    // the rolling promotion PRs without rewriting dev history. Do NOT add
    // more `wip:` commits — type-enum still rejects them for new commits.
    (message: string) => message.startsWith('wip: fix-omni-bridge-hardening#1'),
    // Historical exception: two docs(wish) commits merged via #1249 before
    // pre-commit hooks caught body-max-line-length. Their bodies quote live
    // PostgreSQL SQL idioms (#>>'{}')::jsonb and jsonb drift samples that
    // cannot be reflowed without destroying meaning. Ignoring unblocks the
    // rolling promotion PR without rewriting dev history. Do NOT reuse
    // these exact subjects for new commits — use shorter bodies instead.
    (message: string) => message.startsWith('docs(wish): scaffold fix-pg-disk-rehydration'),
    (message: string) =>
      message.startsWith('docs(wish): correct SQL idiom in migration 045 sample + success criterion'),
  ],
};
