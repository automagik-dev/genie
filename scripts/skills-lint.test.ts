import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkResourceLine,
  collectResourceViolations,
  extractInlineCodeSpans,
  isResourceAllowlisted,
  validateSkillMetadata,
} from './skills-lint.ts';

const SCRIPT = join(import.meta.dir, 'skills-lint.ts');

describe('checkResourceLine — imperative discriminators', () => {
  test('flags an imperative repo-root template copy', () => {
    expect(checkResourceLine('cp templates/wish-template.md dest.md').map((v) => v.rule)).toEqual(['cp-repo-template']);
    expect(checkResourceLine('cp -r templates/foo bar').map((v) => v.rule)).toEqual(['cp-repo-template']);
    expect(checkResourceLine('cp ./templates/foo.md dest').map((v) => v.rule)).toEqual(['cp-repo-template']);
  });

  test('rejects host-specific skill-root variables', () => {
    expect(checkResourceLine('cp "${CLAUDE_SKILL_DIR}/templates/wish-template.md" dest.md').map((v) => v.rule)).toEqual(
      ['host-specific-skill-root'],
    );
    expect(checkResourceLine('cp "${CLAUDE_PLUGIN_ROOT}/templates/foo.md" dest.md').map((v) => v.rule)).toEqual([
      'host-specific-skill-root',
    ]);
  });

  test('flags an unguarded repo-only lint invocation', () => {
    expect(checkResourceLine('bun run wishes:lint').map((v) => v.rule)).toEqual(['unguarded-repo-lint']);
    expect(checkResourceLine('bun run skills:lint').map((v) => v.rule)).toEqual(['unguarded-repo-lint']);
  });

  test('passes a SAME-LINE package.json-guarded invocation', () => {
    const guarded = `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint`;
    expect(checkResourceLine(guarded)).toEqual([]);
  });

  test('passes other short-circuit package.json probe shapes', () => {
    expect(checkResourceLine('test -f package.json && bun run skills:lint')).toEqual([]);
    expect(checkResourceLine('[ -f package.json ] && bun run wishes:lint')).toEqual([]);
  });

  test('flags a line that only mentions package.json incidentally', () => {
    // Trailing comment — the probe does not gate the command.
    expect(checkResourceLine('bun run skills:lint  # regenerates package.json entries').map((v) => v.rule)).toEqual([
      'unguarded-repo-lint',
    ]);
    // package.json referenced AFTER the command — no short-circuit guard.
    expect(checkResourceLine('bun run wishes:lint && cat package.json').map((v) => v.rule)).toEqual([
      'unguarded-repo-lint',
    ]);
    // Mention in a `;`-joined prose segment is not a short-circuit guard.
    expect(checkResourceLine('echo "see package.json"; bun run skills:lint').map((v) => v.rule)).toEqual([
      'unguarded-repo-lint',
    ]);
  });

  test('flags an imperative repo-script invocation but not a descriptive mention', () => {
    expect(checkResourceLine('bun run scripts/skills-lint.ts').map((v) => v.rule)).toEqual(['repo-script-invocation']);
    expect(checkResourceLine('node scripts/foo.ts').map((v) => v.rule)).toEqual(['repo-script-invocation']);
    // Descriptive/paraphrase mention with no run verb must NOT trip.
    expect(checkResourceLine('The linter (scripts/wishes-lint.ts) accepts the stub text.')).toEqual([]);
  });
});

describe('collectResourceViolations — fence + inline surfaces', () => {
  test('scans inline-code spans, not just fences', () => {
    const md = 'Run the linter — `bun run wishes:lint` after editing.';
    expect(collectResourceViolations(md).map((v) => v.rule)).toEqual(['unguarded-repo-lint']);
  });

  test('same-line guard inside one inline span passes', () => {
    const md = 'Handoff: `grep -q \'"wishes:lint"\' package.json 2>/dev/null && bun run wishes:lint`.';
    expect(collectResourceViolations(md)).toEqual([]);
  });

  test('SPLIT-LINE guard (probe on line N, command on line N+1) still FAILS', () => {
    const md = ['```bash', `grep -q '"wishes:lint"' package.json 2>/dev/null`, 'bun run wishes:lint', '```'].join('\n');
    expect(collectResourceViolations(md).map((v) => v.rule)).toEqual(['unguarded-repo-lint']);
  });

  test('descriptive prose path mention outside code context is clean', () => {
    const md = 'The template lives under templates/ and scripts/foo.ts documents it.';
    expect(collectResourceViolations(md)).toEqual([]);
  });
});

describe('extractInlineCodeSpans', () => {
  test('captures single-line backtick spans, skips fences-only content', () => {
    expect(extractInlineCodeSpans('a `one` b `two` c')).toEqual(['one', 'two']);
    expect(extractInlineCodeSpans('no code here')).toEqual([]);
  });
});

describe('end-to-end: skills-lint against fixture skills trees', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-lint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSkill(name: string, body: string): void {
    const skillDir = join(dir, name);
    mkdirSync(join(skillDir, 'agents'), { recursive: true });
    const skill = body.startsWith('---\n')
      ? body
      : `---\nname: ${name}\ndescription: "Use ${name} for this test workflow."\n---\n\n${body}`;
    writeFileSync(join(skillDir, 'SKILL.md'), skill);
    writeFileSync(
      join(skillDir, 'agents', 'openai.yaml'),
      [
        'interface:',
        `  display_name: "${name}"`,
        `  short_description: "Run the ${name} workflow safely"`,
        `  default_prompt: "Run the ${name} workflow for this task."`,
        '',
      ].join('\n'),
    );
  }

  function runLint(): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('bun', [SCRIPT], {
        env: { ...process.env, SKILLS_LINT_DIR: dir },
        encoding: 'utf8',
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        code: e.status ?? 1,
        stdout: e.stdout?.toString() ?? '',
        stderr: e.stderr?.toString() ?? '',
      };
    }
  }

  test('an offending skill (cp templates/...) exits non-zero', () => {
    writeSkill('bad', ['# bad', '', '```bash', 'cp templates/wish-template.md dest.md', '```', ''].join('\n'));
    const { code, stderr } = runLint();
    expect(code).not.toBe(0);
    expect(stderr).toContain('cp-repo-template');
  });

  test('a ${CLAUDE_SKILL_DIR} skill fails the portable resource contract', () => {
    writeSkill(
      'good',
      ['# good', '', '```bash', 'cp "${CLAUDE_SKILL_DIR}/templates/wish-template.md" dest.md', '```', ''].join('\n'),
    );
    const result = runLint();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('host-specific-skill-root');
  });

  test('allowlisted genie-hacks content passes even with repo-root recipes', () => {
    writeSkill(
      'genie-hacks',
      ['# hacks', '', '```bash', 'cp templates/foo.md dest.md', 'bun run wishes:lint', '```', ''].join('\n'),
    );
    expect(runLint().code).toBe(0);
  });

  test('a same-line-guarded invocation passes while a split-line guard fails', () => {
    writeSkill(
      'guarded',
      [
        '# guarded',
        '',
        'Handoff: `grep -q \'"wishes:lint"\' package.json 2>/dev/null && bun run wishes:lint`.',
        '',
      ].join('\n'),
    );
    expect(runLint().code).toBe(0);

    rmSync(join(dir, 'guarded'), { recursive: true, force: true });
    writeSkill(
      'split',
      [
        '# split',
        '',
        '```bash',
        `grep -q '"wishes:lint"' package.json 2>/dev/null`,
        'bun run wishes:lint',
        '```',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runLint();
    expect(code).not.toBe(0);
    expect(stderr).toContain('unguarded-repo-lint');
  });
});

describe('validateSkillMetadata', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-metadata-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMetadataFixture(skill: string, openai: string): string {
    const skillDir = join(dir, 'fixture');
    mkdirSync(join(skillDir, 'agents'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skill);
    writeFileSync(join(skillDir, 'agents', 'openai.yaml'), openai);
    return skillDir;
  }

  test('accepts name/description frontmatter and a selector-free prompt', () => {
    const skillDir = writeMetadataFixture(
      '---\nname: fixture\ndescription: "Fixture workflow for metadata validation."\n---\n\n# Fixture\n',
      'interface:\n  display_name: "Fixture"\n  short_description: "Validate the fixture workflow"\n  default_prompt: "Validate this input with the fixture workflow."\n',
    );
    expect(validateSkillMetadata(skillDir).violations).toEqual([]);
  });

  test('rejects unsupported frontmatter and any physical-tier selector', () => {
    const skillDir = writeMetadataFixture(
      '---\nname: fixture\ndescription: fixture\nmodel: opus\n---\n\n# Fixture\n',
      'interface:\n  display_name: "Fixture"\n  short_description: "Validate the fixture workflow"\n  default_prompt: "Use $genie:fixture or $fixture to validate this input."\n',
    );
    const violations = validateSkillMetadata(skillDir).violations.join('\n');
    expect(violations).toContain('unsupported frontmatter field: model');
    expect(violations).toContain('must be selector-free because metadata ships in multiple physical tiers');
  });

  test('rejects host-specific skill variables and a missing openai manifest', () => {
    const skillDir = join(dir, 'fixture');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: fixture\ndescription: fixture\n---\n\nRead ${CLAUDE_SKILL_DIR}/reference.md.\n',
    );
    const violations = validateSkillMetadata(skillDir).violations.join('\n');
    expect(violations).toContain('CLAUDE_SKILL_DIR');
    expect(violations).toContain('missing agents/openai.yaml');
  });
});

describe('isResourceAllowlisted', () => {
  test('genie-hacks and the contributor README are allowlisted', () => {
    const skillsDir = '/repo/skills';
    expect(isResourceAllowlisted('/repo/skills/genie-hacks/SKILL.md', skillsDir)).toBe(true);
    expect(isResourceAllowlisted('/repo/skills/genie-hacks/references/catalog.md', skillsDir)).toBe(true);
    expect(isResourceAllowlisted('/repo/skills/README.md', skillsDir)).toBe(true);
    expect(isResourceAllowlisted('/repo/skills/wish/SKILL.md', skillsDir)).toBe(false);
  });
});
