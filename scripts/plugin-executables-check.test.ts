import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const CHECK_SCRIPT = join(import.meta.dir, 'plugin-executables-check.ts');
const IMPLICIT_ANY_FIXTURE = join(import.meta.dir, 'fixtures', 'plugin-executables', 'implicit-any.cjs');

function runCheck(args: string[] = []): { code: number; output: string } {
  const result = Bun.spawnSync(['bun', CHECK_SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

describe('plugin executable static gate', () => {
  test('strict-checks every shipped source', () => {
    const result = runCheck();
    expect(result.output).toContain('8 strict checked sources, 1 exec-bit asserted, 8 shipped scripts');
    expect(result.code).toBe(0);
  });

  // Kimi's manifest execs mcp-launcher.cjs through its own shebang, so the
  // committed mode is a runtime contract, not a cosmetic file attribute.
  // Owner bit only: git materializes 100755 as 0777 & ~umask, so group/other
  // exec bits are absent on a clean checkout under a restrictive umask.
  test('asserts the shebang-exec launcher keeps its committed executable bit', () => {
    const mode = statSync(join(import.meta.dir, '..', 'plugins', 'genie', 'scripts', 'mcp-launcher.cjs')).mode;
    expect(mode & 0o100).toBe(0o100);
  });

  test('rejects an implicit-any negative fixture', () => {
    const result = runCheck(['--strict-fixture', IMPLICIT_ANY_FIXTURE]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('implicit-any.cjs');
    expect(result.output).toContain('error TS7006');
    expect(result.output).toContain('implicitly has an');
  });
});
