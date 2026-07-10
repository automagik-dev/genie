import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SMOKE_SCRIPT = join(import.meta.dir, 'fresh-install-smoke.ts');

function runSmoke(args: string[] = []): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', SMOKE_SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('fresh-install-smoke', () => {
  test('exits 0 against the real repository skills tree', () => {
    const result = runSmoke();
    // Surface the failure reason if this ever regresses.
    expect(result.stdout + result.stderr).toContain('fresh-install-smoke: OK');
    expect(result.code).toBe(0);
  });

  describe('broken fixture', () => {
    let skillsDir: string;

    beforeEach(() => {
      skillsDir = mkdtempSync(join(tmpdir(), 'genie-fresh-install-fixture-'));
      const skill = join(skillsDir, 'brokenskill');
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, 'SKILL.md'),
        '# Broken skill\n\n```bash\ncp "${CLAUDE_SKILL_DIR}/templates/does-not-exist.md" out.md\n```\n',
      );
    });

    afterEach(() => {
      rmSync(skillsDir, { recursive: true, force: true });
    });

    test('exits non-zero when a SKILL.md references a missing ${CLAUDE_SKILL_DIR} path', () => {
      const result = runSmoke(['--skills-dir', skillsDir]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('does not resolve to a real file');
    });
  });
});
