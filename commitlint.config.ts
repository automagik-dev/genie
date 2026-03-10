export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message: string) => message.startsWith('[skip ci]'),
    // GitHub merge/squash-merge commits have auto-generated bodies that
    // violate body-max-line-length and contain nested commit messages.
    // Individual commits are already linted on dev before merge.
    (message: string) => message.startsWith('Merge'),
  ],
};
