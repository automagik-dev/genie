import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BANNED_TOKEN_GUIDANCE,
  checkResourceLine,
  collectBannedTokenViolations,
  collectResourceViolations,
  extractInlineCodeSpans,
  getGenieCommands,
  isResourceAllowlisted,
  validateSkillMetadata,
} from './skills-lint.ts';

const SCRIPT = join(import.meta.dir, 'skills-lint.ts');

interface LintRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Write a structurally valid fixture skill (`SKILL.md` + `agents/openai.yaml`). */
function writeSkillIn(dir: string, name: string, body: string): string {
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
  return skillDir;
}

/**
 * Run the gate with `SKILLS_LINT_DIR` pointed at a fixture tree. `spawnSync`
 * (not `execFileSync`) so stderr is captured on the SUCCESS path too — the
 * "OK (…)" summary the positive fixtures assert against is written to stderr.
 */
function runLintIn(dir: string): LintRun {
  const result = spawnSync('bun', [SCRIPT], {
    env: { ...process.env, SKILLS_LINT_DIR: dir },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('clean checkout probes the current source CLI when dist is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-lint-clean-root-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'genie.ts'),
      "process.stdout.write('Usage: genie\\n\\nCommands:\\n  context  current source command\\n');\n",
    );
    expect(getGenieCommands(root)).toContain('context');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    writeSkillIn(dir, name, body);
  }

  function runLint(): LintRun {
    return runLintIn(dir);
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

describe('collectBannedTokenViolations — plain-substring vocabulary scan', () => {
  test('BANNED-13 is exactly thirteen tokens with no duplicates', () => {
    const tokens = BANNED_TOKEN_GUIDANCE.map(([token]) => token);
    expect(tokens).toHaveLength(13);
    expect(new Set(tokens).size).toBe(13);
  });

  test('matches as a plain substring, with no word boundary and no allowlist', () => {
    // Embedded mid-word: a word-boundary regex would MISS this; String.includes must not.
    const hits = collectBannedTokenViolations('prefixgenie_reviewerSUFFIX').map((v) => v.token);
    expect(hits).toEqual(['genie_reviewer']);
  });

  test('reports the 1-indexed line of every hit', () => {
    const text = ['clean line', 'route to engineer-standard here', 'clean', 'and to engineer-standard again'].join(
      '\n',
    );
    expect(collectBannedTokenViolations(text).map((v) => v.line)).toEqual([2, 4]);
  });

  test('legitimate prose and the surviving bare role names are clean', () => {
    const text = [
      'genie task checkout <id> --worker w',
      'bun run check',
      'The engineer implements; the reviewer reviews; the fixer fixes.',
      'A final-gate pass, then a scout for read-only discovery.',
      'implementor-low / implementor-mid / implementor-high',
    ].join('\n');
    expect(collectBannedTokenViolations(text)).toEqual([]);
  });
});

describe('end-to-end: retired-vocabulary and directory-shape fixtures', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-lint-tokens-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // One negative fixture per BANNED-13 token: exit code AND message text.
  // The frontmatter is written explicitly so the offending line number (6) is
  // asserted, not inferred.
  for (const [token, guidance] of BANNED_TOKEN_GUIDANCE) {
    test(`rejects the retired token ${token}`, () => {
      writeSkillIn(
        dir,
        'offender',
        [
          '---',
          'name: offender',
          'description: "Use offender for this test workflow."',
          '---',
          '',
          `Dispatch through ${token} for this group.`,
          '',
        ].join('\n'),
      );
      const { code, stderr } = runLintIn(dir);
      expect(code).toBe(1);
      expect(stderr).toContain('file(s) name a retired agent/runtime token');
      expect(stderr).toContain(`offender/SKILL.md:6: [retired-token] ${token} — ${guidance}`);
    });
  }

  test('scans NON-markdown files — a banned token in agents/openai.yaml fails', () => {
    const skillDir = writeSkillIn(dir, 'yaml-offender', '# yaml-offender\n\nOrdinary prose.\n');
    writeFileSync(
      join(skillDir, 'agents', 'openai.yaml'),
      [
        '# starter card for the genie_scout role',
        'interface:',
        '  display_name: "yaml-offender"',
        '  short_description: "Run the yaml-offender workflow"',
        '  default_prompt: "Run the yaml-offender workflow for this task."',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('yaml-offender/agents/openai.yaml:1: [retired-token] genie_scout');
  });

  test('the skills-lint:ignore marker does NOT exempt a file from the vocabulary scan', () => {
    writeSkillIn(
      dir,
      'ignored',
      [
        '---',
        'name: ignored',
        'description: "Use ignored for this test workflow."',
        '---',
        '',
        '<!-- skills-lint:ignore -->',
        '',
        'Route complexity 2-3 to genie_engineer_standard.',
        '',
        '```bash',
        'cp templates/wish-template.md dest.md',
        '```',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    // The token rule runs BEFORE the bailout...
    expect(stderr).toContain('ignored/SKILL.md:8: [retired-token] genie_engineer_standard');
    // ...while the bailout still suppresses only the command/resource checks.
    expect(stderr).not.toContain('cp-repo-template');
  });

  test('rejects a nested SKILL.md that skills.sh cannot discover', () => {
    writeSkillIn(dir, 'outer', '# outer\n\nOrdinary prose.\n');
    mkdirSync(join(dir, 'outer', 'inner'), { recursive: true });
    writeFileSync(
      join(dir, 'outer', 'inner', 'SKILL.md'),
      '---\nname: inner\ndescription: "Nested."\n---\n\n# inner\n',
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('skills/ directory shape violation(s)');
    expect(stderr).toContain('[nested skill dir] outer/inner/SKILL.md hides under outer/');
    expect(stderr).toContain('move it to a uniquely named top-level directory');
  });

  test('rejects a top-level skill directory with no root SKILL.md', () => {
    writeSkillIn(dir, 'present', '# present\n\nOrdinary prose.\n');
    mkdirSync(join(dir, 'hollow', 'references'), { recursive: true });
    writeFileSync(join(dir, 'hollow', 'references', 'notes.md'), '# notes\n');
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('[empty skill dir] hollow/ has no SKILL.md at its root');
    expect(stderr).toContain('add hollow/SKILL.md or remove the directory');
  });

  test('legitimate prose, bundled subdirectories and surviving role names pass', () => {
    const skillDir = writeSkillIn(
      dir,
      'clean',
      [
        '# clean',
        '',
        'The engineer implements, the reviewer reviews, the fixer fixes,',
        'a final-gate closes the wish and a scout does read-only discovery.',
        'Route by complexity to implementor-low, implementor-mid or implementor-high.',
        '',
        '```bash',
        'genie task checkout t_1 --worker w',
        'bun run check',
        '```',
        '',
      ].join('\n'),
    );
    // references/ and templates/ carry no SKILL.md and must never trip the shape rule.
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    mkdirSync(join(skillDir, 'templates'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'catalog.md'), '# catalog\n\nAn implementor-mid recipe.\n');
    writeFileSync(join(skillDir, 'templates', 'brief.md'), '# brief\n\nDispatch a scout first.\n');
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(0);
    expect(stderr).toContain('0 retired tokens, 0 structure violations');
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
