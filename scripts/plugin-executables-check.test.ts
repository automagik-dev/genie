import { describe, expect, test } from 'bun:test';
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
    expect(result.output).toContain('8 strict checked sources, 8 shipped scripts');
    expect(result.code).toBe(0);
  });

  test('rejects an implicit-any negative fixture', () => {
    const result = runCheck(['--strict-fixture', IMPLICIT_ANY_FIXTURE]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('implicit-any.cjs');
    expect(result.output).toContain('error TS7006');
    expect(result.output).toContain('implicitly has an');
  });
});
