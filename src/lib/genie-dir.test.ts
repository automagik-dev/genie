import { describe, expect, test } from 'bun:test';
import { getRepoGenieDir } from './genie-dir.js';

describe('getRepoGenieDir', () => {
  test('returns .genie path under the given repo path', () => {
    const dir = getRepoGenieDir('/tmp/some-repo');
    expect(dir).toEndWith('.genie');
  });

  test('returns path for current repo', () => {
    const dir = getRepoGenieDir(process.cwd());
    expect(dir).toContain('.genie');
  });
});
