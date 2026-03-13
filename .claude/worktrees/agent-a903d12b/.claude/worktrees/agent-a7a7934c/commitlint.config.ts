export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message: string) => message.startsWith('[skip ci]')],
};
