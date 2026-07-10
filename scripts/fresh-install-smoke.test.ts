import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SMOKE_SCRIPT = join(import.meta.dir, 'fresh-install-smoke.ts');

// Internal work dirs the script mkdtemps in runWishScaffoldSmoke. A survivor
// with this prefix (and NOT this test's own '-fixture-' dirs) means the phase-b
// cleanup was skipped.
const WORKDIR_PREFIX = 'genie-fresh-install-';
function scaffoldWorkDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(WORKDIR_PREFIX) && !n.includes('-fixture-')));
}

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

  // Phase-b failures create a scaffold work dir BEFORE the assertion trips, so
  // they are the path where the old process.exit() bypassed cleanup. Induce one
  // and prove the temp dir is gone regardless.
  describe('phase-b failure cleanup', () => {
    let skillsDir: string;

    // Wish skill whose SKILL.md references its in-skill template (phase-a
    // passes) but whose template omits `## Execution Groups`, so the phase-b
    // structural check fails after the work dir already exists.
    function writeWishFixture(templateBody: string): void {
      const wishDir = join(skillsDir, 'wish');
      mkdirSync(join(wishDir, 'templates'), { recursive: true });
      writeFileSync(
        join(wishDir, 'SKILL.md'),
        ['# wish', '', '```bash', 'cp "${CLAUDE_SKILL_DIR}/templates/wish-template.md" out.md', '```', ''].join('\n'),
      );
      writeFileSync(join(wishDir, 'templates', 'wish-template.md'), templateBody);
    }

    const FULL_SECTIONS = [
      '## Summary',
      '## Scope',
      '### IN',
      '### OUT',
      '## Success Criteria',
      '## Execution Strategy',
    ];

    beforeEach(() => {
      skillsDir = mkdtempSync(join(tmpdir(), 'phaseb-fixture-'));
    });
    afterEach(() => {
      rmSync(skillsDir, { recursive: true, force: true });
    });

    test('a phase-b failure exits non-zero and leaves no scaffold temp dir behind', () => {
      writeWishFixture(`${FULL_SECTIONS.join('\n')}\n`); // no '## Execution Groups'
      const before = scaffoldWorkDirs();

      const result = runSmoke(['--skills-dir', skillsDir]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('fresh-install-smoke: FAIL');
      expect(result.stderr).toContain('## Execution Groups');

      const leaked = [...scaffoldWorkDirs()].filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    });

    test('a clean phase-b run exits 0 and leaves no scaffold temp dir behind', () => {
      writeWishFixture(`${[...FULL_SECTIONS, '## Execution Groups'].join('\n')}\n`);
      const before = scaffoldWorkDirs();

      const result = runSmoke(['--skills-dir', skillsDir]);

      expect(result.code).toBe(0);
      const leaked = [...scaffoldWorkDirs()].filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    });
  });
});
