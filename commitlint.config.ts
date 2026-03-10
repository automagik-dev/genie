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
  ],
};
