import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveCodexDir } from './genie-home.js';

describe('resolveCodexDir', () => {
  test('honors a non-empty override', () => {
    expect(resolveCodexDir({ CODEX_HOME: '/tmp/custom-codex' } as NodeJS.ProcessEnv, '/home/test')).toBe(
      '/tmp/custom-codex',
    );
  });

  test('empty and whitespace-only overrides fall back instead of becoming cwd-relative', () => {
    expect(resolveCodexDir({ CODEX_HOME: '' } as NodeJS.ProcessEnv, '/home/test')).toBe(join('/home/test', '.codex'));
    expect(resolveCodexDir({ CODEX_HOME: '   ' } as NodeJS.ProcessEnv, '/home/test')).toBe(
      join('/home/test', '.codex'),
    );
  });
});
