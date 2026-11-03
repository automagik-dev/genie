import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// genie-v7-tasks 1c: `bun run check` runs `cargo test --locked` through scripts/cargo-gate.sh, which
// FAILS (never skips) with one line naming the remedy when cargo is missing (R-L4).
const ROOT = join(import.meta.dir, '..');
const GATE = join(ROOT, 'scripts', 'cargo-gate.sh');
const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-cargo-gate-'));
  roots.push(root);
  return root;
}

function runGate(path: string): { code: number; stdout: string; stderr: string } {
  // The gate's interpreter is resolved here, so the PATH the gate sees can omit bash and cargo alike.
  const bash = Bun.which('bash') as string;
  const result = Bun.spawnSync([bash, GATE], { env: { PATH: path }, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('cargo gate', () => {
  test('bun run check runs the gate after bun test', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:cargo']).toBe('bash scripts/cargo-gate.sh');
    expect(pkg.scripts.check.split(' && ').at(-1)).toBe('bun run test:cargo');
  });

  test('with no cargo on PATH it exits non-zero with exactly one stderr line naming the remedy', () => {
    // An empty directory: no cargo, and nothing else either (the gate needs only bash builtins to refuse).
    const result = runGate(scratch());
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cargo not found on PATH');
    expect(lines[0]).toContain('rustup');
    expect(result.stderr.endsWith('\n')).toBe(true);
  });

  test.each([0, 101])(
    'with cargo on PATH it runs cargo test --workspace --locked at the repo root and returns %d',
    (code) => {
      const bin = join(scratch(), 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'cargo'), `#!/bin/sh\npwd\nfor a in "$@"; do printf '%s\\n' "$a"; done\nexit ${code}\n`, {
        mode: 0o755,
      });
      const result = runGate(`${bin}:/usr/bin:/bin`);
      expect(result.code).toBe(code);
      expect(result.stdout.trim().split('\n')).toEqual([ROOT, 'test', '--workspace', '--locked']);
    },
  );
});
