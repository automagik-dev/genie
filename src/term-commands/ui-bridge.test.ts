import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENIE = join(import.meta.dir, '..', 'genie.ts');
const RETIRED_DIAGNOSTIC =
  'Error: genie ui-bridge has been retired; the Orca integration is the supported UI surface, or roll back to a pre-retirement signed release.\n';

describe('genie ui-bridge retirement', () => {
  test('returns the stable non-zero retirement diagnostic without speaking the bridge protocol', () => {
    const result = Bun.spawnSync(['bun', GENIE, 'ui-bridge'], {
      stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe(RETIRED_DIAGNOSTIC);
  });

  test('opens no database and creates no repository state', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-ui-bridge-retired-'));
    try {
      const result = Bun.spawnSync(['bun', GENIE, 'ui-bridge'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GENIE_HOME: join(root, 'home'), NO_COLOR: '1' },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toBe(RETIRED_DIAGNOSTIC);
      expect(existsSync(join(root, '.genie'))).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('documents retirement in command help', () => {
    const result = Bun.spawnSync(['bun', GENIE, 'ui-bridge', '--help'], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('retired');
  });
});
