import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const GENIE = join(import.meta.dir, '..', 'genie.ts');
const RETIRED_DIAGNOSTIC =
  'Error: genie mcp has been retired; use `genie task` and `genie board`, or roll back to a pre-A7 signed release.\n';

describe('genie mcp retirement', () => {
  test('returns the stable non-zero retirement diagnostic without speaking MCP', () => {
    const result = Bun.spawnSync(['bun', GENIE, 'mcp'], {
      stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe(RETIRED_DIAGNOSTIC);
  });

  test('documents retirement in command help', () => {
    const result = Bun.spawnSync(['bun', GENIE, 'mcp', '--help'], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('retired');
  });
});
