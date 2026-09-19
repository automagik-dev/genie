import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_CATEGORIES, SKILL_MUTATES_LEVELS } from './skills-inventory-parity.ts';
import {
  BANNED_TOKEN_GUIDANCE,
  HAZARD_RULES,
  HAZARD_WAIVERS,
  SKILL_MAX_LINES,
  SKILL_MIN_LINES,
  SKILL_SIZE_WAIVERS,
  checkHazardLine,
  checkMutationLine,
  checkResourceLine,
  checkSkillSize,
  collectBannedTokenViolations,
  collectHazardViolations,
  collectMutationViolations,
  collectResourceViolations,
  countSkillLines,
  extractInlineCodeSpans,
  getGenieCommands,
  hasUnpinnedNpxInstaller,
  isHazardWaived,
  isPinnedNpxPackage,
  isResourceAllowlisted,
  validateSkillMetadata,
} from './skills-lint.ts';

const SCRIPT = join(import.meta.dir, 'skills-lint.ts');

interface LintRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Pad a fixture up to the house-size floor. Padding is appended AFTER the
 * body, so every line number an assertion pins stays exactly where the fixture
 * put it. Fixtures that mean to violate the size rule write their own body and
 * bypass this helper.
 */
function padToHouseSize(text: string): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  while (lines.length < SKILL_MIN_LINES)
    lines.push(`Filler line ${lines.length + 1} keeps this fixture in house size.`);
  return `${lines.join('\n')}\n`;
}

/** Write a structurally valid fixture skill (`SKILL.md` + `agents/openai.yaml`). */
function writeSkillIn(dir: string, name: string, body: string): string {
  const skillDir = join(dir, name);
  mkdirSync(join(skillDir, 'agents'), { recursive: true });
  const skill = body.startsWith('---\n')
    ? body
    : `---\nname: ${name}\ndescription: "Use ${name} for this test workflow."\n---\n\n${body}`;
  writeFileSync(join(skillDir, 'SKILL.md'), padToHouseSize(skill));
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
  test('BANNED-15 is exactly fifteen tokens with no duplicates', () => {
    const tokens = BANNED_TOKEN_GUIDANCE.map(([token]) => token);
    expect(tokens).toHaveLength(15);
    expect(new Set(tokens).size).toBe(15);
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

  // Issue #2917: the five shipped workflow front doors and the catalogue README named one
  // client tool as the actor — seven `Claude Code` hits and five `Workflow tool` hits — while
  // every one of them also stated the runtime-neutral script-path rule. This case owns that
  // regression, and it reads the SHIPPED files rather than a fixture, because a fixture
  // cannot fail when a front door is rewritten.
  test('the shipped workflow front doors and the catalogue README name no client tool', () => {
    const shipped = join(import.meta.dir, '..', 'skills');
    const frontDoors = [
      'council/SKILL.md',
      'docs/SKILL.md',
      'research/SKILL.md',
      'skill-audit/SKILL.md',
      'workfly/SKILL.md',
      'README.md',
    ];
    for (const rel of frontDoors) {
      const hits = collectBannedTokenViolations(readFileSync(join(shipped, rel), 'utf8'));
      expect(hits.map((v) => `${rel}:${v.line}: ${v.token}`)).toEqual([]);
    }
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

  // One negative fixture per BANNED-15 token: exit code AND message text.
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
    expect(stderr).toContain('0 retired tokens, 0 mutates-none violations, 0 structure violations');
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

describe('frontmatter taxonomy — optional closed enums', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-lint-taxonomy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTaxonomySkill(extra: readonly string[]): void {
    writeSkillIn(
      dir,
      'fixture',
      [
        '---',
        'name: fixture',
        'description: "Use fixture for this test workflow."',
        ...extra,
        '---',
        '',
        '# Fixture',
        '',
      ].join('\n'),
    );
  }

  test('absent category and mutates are legal', () => {
    writeTaxonomySkill([]);
    const metadata = validateSkillMetadata(join(dir, 'fixture'));
    expect(metadata.violations).toEqual([]);
    expect(metadata.category).toBeNull();
    expect(metadata.mutates).toBeNull();
    expect(runLintIn(dir).code).toBe(0);
  });

  test('every enum member is accepted', () => {
    for (const category of SKILL_CATEGORIES) {
      for (const mutates of SKILL_MUTATES_LEVELS) {
        writeTaxonomySkill([`category: ${category}`, `mutates: ${mutates}`]);
        expect(validateSkillMetadata(join(dir, 'fixture')).violations).toEqual([]);
      }
    }
  });

  test('an unknown category value fails and names the enum', () => {
    writeTaxonomySkill(['category: orchestration']);
    expect(validateSkillMetadata(join(dir, 'fixture')).violations).toEqual([
      'unsupported category: orchestration (one of lifecycle, routing, delivery, investigation, authoring, verification, integration, skill-ops)',
    ]);
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('unsupported category: orchestration');
  });

  test('an unknown mutates value fails and names the enum', () => {
    writeTaxonomySkill(['mutates: filesystem']);
    expect(validateSkillMetadata(join(dir, 'fixture')).violations).toEqual([
      'unsupported mutates: filesystem (one of none, documents, repo, external)',
    ]);
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('unsupported mutates: filesystem');
  });

  test('a key outside the four is still unsupported', () => {
    writeTaxonomySkill(['model: opus']);
    expect(validateSkillMetadata(join(dir, 'fixture')).violations).toEqual(['unsupported frontmatter field: model']);
  });
});

describe('checkMutationLine — repo-write commands inside a fence', () => {
  test('names each repo-write command class', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['git commit -m "x"', 'git commit'],
      ['git push origin dev', 'git push'],
      ['git merge dev', 'git merge'],
      ['git rebase origin/dev', 'git rebase'],
      ['gh pr create --fill', 'gh pr create'],
      ['gh pr merge --squash', 'gh pr merge'],
      ['genie task export --write', 'genie task export --write'],
      ['genie task done t_1', 'genie task <mutating verb>'],
      ['rm -rf .genie/tmp', 'rm -rf'],
      ['cp -r skills/wish /tmp/wish', 'cp -r'],
      ['mkdir -p .genie/wishes/slug', 'mkdir -p'],
      ['echo hi > notes.md', '> redirection into a path'],
      ['bun run check >> build.log', '> redirection into a path'],
    ];
    for (const [line, command] of cases) {
      expect(checkMutationLine(line).map((v) => v.command)).toContain(command);
    }
  });

  test('read-only commands and placeholder angle brackets stay clean', () => {
    expect(checkMutationLine('genie task list --json')).toEqual([]);
    expect(checkMutationLine('genie task status t_1')).toEqual([]);
    expect(checkMutationLine('genie board --wish slug')).toEqual([]);
    expect(checkMutationLine('git status --short')).toEqual([]);
    // A closing placeholder bracket followed by a space is not a redirect.
    expect(checkMutationLine('genie task status <task-id> <agent-name>')).toEqual([]);
    // 2>&1 is not a redirect into a path.
    expect(checkMutationLine('bun run check 2>&1')).toEqual([]);
  });

  test('scans ``` fences of any language and reports the 1-indexed line', () => {
    const md = ['# doc', '', '```text', 'git push origin dev', '```', ''].join('\n');
    expect(collectMutationViolations(md)).toEqual([{ command: 'git push', line: 4, snippet: 'git push origin dev' }]);
  });

  test('inline code and prose are NOT scanned — only fences are', () => {
    const md = "The coordinator relays it with `genie task comment <id> --worker orchestrator -- '…'` once.";
    expect(collectMutationViolations(md)).toEqual([]);
    expect(collectMutationViolations('Do not run git push from this skill.')).toEqual([]);
  });
});

describe('end-to-end: the advisory mutates label is earned', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-lint-mutates-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLabelled(mutates: string): void {
    writeSkillIn(
      dir,
      'labelled',
      [
        '---',
        'name: labelled',
        'description: "Use labelled for this test workflow."',
        `mutates: ${mutates}`,
        '---',
        '',
        '# labelled',
        '',
        '```bash',
        'git push origin dev',
        '```',
        '',
      ].join('\n'),
    );
  }

  test('`mutates: none` with a fenced git push fails', () => {
    writeLabelled('none');
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('claim `mutates: none` but fence a repo write');
    expect(stderr).toContain('labelled/SKILL.md:10: [mutates-none] git push — git push origin dev');
  });

  test('`mutates: repo` with the same fence passes', () => {
    writeLabelled('repo');
    expect(runLintIn(dir).code).toBe(0);
  });

  test('the skills-lint:ignore marker does NOT exempt the mutates-none rule', () => {
    writeSkillIn(
      dir,
      'ignored',
      [
        '---',
        'name: ignored',
        'description: "Use ignored for this test workflow."',
        'mutates: none',
        '---',
        '',
        '<!-- skills-lint:ignore -->',
        '',
        '```bash',
        'gh pr merge --squash',
        '```',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('[mutates-none] gh pr merge');
  });

  test('a mutates-none skill with only read-only fences passes', () => {
    writeSkillIn(
      dir,
      'reader',
      [
        '---',
        'name: reader',
        'description: "Use reader for this test workflow."',
        'mutates: none',
        '---',
        '',
        '# reader',
        '',
        '```bash',
        'genie task status <task-id>',
        'genie board --json',
        '```',
        '',
      ].join('\n'),
    );
    expect(runLintIn(dir).code).toBe(0);
  });
});

describe('git merge vs its read-only siblings', () => {
  test('read-only merge plumbing passes', () => {
    expect(checkMutationLine('git merge-base HEAD origin/dev')).toEqual([]);
    expect(checkMutationLine('BASE=$(git merge-base --is-ancestor origin/dev HEAD)')).toEqual([]);
    expect(checkMutationLine('git merge-tree $(git merge-base HEAD dev) HEAD dev')).toEqual([]);
  });

  test('a real merge still fails', () => {
    expect(checkMutationLine('git merge dev').map((v) => v.command)).toEqual(['git merge']);
    expect(checkMutationLine('git merge --no-ff wish/slug').map((v) => v.command)).toEqual(['git merge']);
    // PRE-EXISTING LIMITATION, unchanged by the sibling fix: every repo-write
    // pattern keys on `git <verb>`, so a global option between the two
    // (`git -C <dir> merge`) is invisible to `git merge` exactly as it is to
    // `git commit`. No shipped skill writes that form today.
    expect(checkMutationLine('git -C /repo merge origin/dev')).toEqual([]);
    expect(checkMutationLine('git -C /repo commit -m x')).toEqual([]);
    // Exempted BY NAME: a plumbing sibling that DOES write is still caught.
    expect(checkMutationLine('git merge-file mine.txt base.txt theirs.txt').map((v) => v.command)).toEqual([
      'git merge',
    ]);
  });

  test('end-to-end: a mutates-none skill may fence git merge-base but not git merge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-lint-mergebase-'));
    try {
      writeSkillIn(
        dir,
        'reader',
        [
          '---',
          'name: reader',
          'description: "Use reader for this test workflow."',
          'mutates: none',
          '---',
          '',
          '# reader',
          '',
          '```bash',
          'git merge-base HEAD origin/dev',
          '```',
          '',
        ].join('\n'),
      );
      expect(runLintIn(dir).code).toBe(0);

      rmSync(join(dir, 'reader'), { recursive: true, force: true });
      writeSkillIn(
        dir,
        'writer',
        [
          '---',
          'name: writer',
          'description: "Use writer for this test workflow."',
          'mutates: none',
          '---',
          '',
          '# writer',
          '',
          '```bash',
          'git merge origin/dev',
          '```',
          '',
        ].join('\n'),
      );
      const { code, stderr } = runLintIn(dir);
      expect(code).toBe(1);
      expect(stderr).toContain('[mutates-none] git merge — git merge origin/dev');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('house size — every shipped SKILL.md is 40-90 lines', () => {
  /** A SKILL.md body of exactly `count` lines. */
  function skillOf(count: number): string {
    const lines = ['---', 'name: fixture', 'description: "Use fixture for this test workflow."', '---', ''];
    while (lines.length < count) lines.push(`Line ${lines.length + 1} of the fixture body.`);
    return `${lines.slice(0, count).join('\n')}\n`;
  }

  test('countSkillLines counts like wc -l, plus an unterminated final line', () => {
    expect(countSkillLines('a\nb\nc\n')).toBe(3);
    expect(countSkillLines('a\nb\nc')).toBe(3);
    expect(countSkillLines('')).toBe(0);
  });

  test('the window boundaries are inclusive', () => {
    expect(checkSkillSize('fixture', skillOf(SKILL_MIN_LINES))).toBeNull();
    expect(checkSkillSize('fixture', skillOf(SKILL_MAX_LINES))).toBeNull();
    expect(checkSkillSize('fixture', skillOf(60))).toBeNull();
  });

  test('a stub under the floor names the remedy', () => {
    const violation = checkSkillSize('fixture', skillOf(SKILL_MIN_LINES - 1));
    expect(violation?.lines).toBe(SKILL_MIN_LINES - 1);
    expect(violation?.detail).toContain(`grow to at least ${SKILL_MIN_LINES} line(s)`);
    expect(violation?.detail).toContain('fold the workflow into the skill that owns it');
    expect(violation?.detail).toContain(`house size ${SKILL_MIN_LINES}-${SKILL_MAX_LINES}`);
  });

  test('a manual over the ceiling names the remedy', () => {
    const violation = checkSkillSize('fixture', skillOf(SKILL_MAX_LINES + 1));
    expect(violation?.lines).toBe(SKILL_MAX_LINES + 1);
    expect(violation?.detail).toContain(`trim to ${SKILL_MAX_LINES} line(s) or fewer`);
    expect(violation?.detail).toContain('fixture/references/');
  });

  test('the waiver table holds exactly quick, with a real ceiling and a reason', () => {
    expect([...SKILL_SIZE_WAIVERS.keys()]).toEqual(['quick']);
    for (const [, waiver] of SKILL_SIZE_WAIVERS) {
      expect(Number.isFinite(waiver.max)).toBe(true);
      expect(waiver.max).toBeLessThanOrEqual(SKILL_MAX_LINES);
      expect(waiver.reason.length).toBeGreaterThan(20);
    }
    expect(SKILL_SIZE_WAIVERS.get('quick')?.max).toBe(8);
  });

  test('the quick waiver lets the retirement stub shrink but never grow', () => {
    expect(checkSkillSize('quick', skillOf(8))).toBeNull();
    expect(checkSkillSize('quick', skillOf(5))).toBeNull();
    const grown = checkSkillSize('quick', skillOf(9));
    expect(grown?.lines).toBe(9);
    expect(grown?.detail).toContain('trim to 8 line(s) or fewer');
    expect(grown?.detail).toContain('waived window 0-8');
    expect(grown?.detail).toContain('retirement stub');
  });

  test('wish is held to the plain house window — its waiver was retired once it fit', () => {
    expect(SKILL_SIZE_WAIVERS.has('wish')).toBe(false);
    expect(checkSkillSize('wish', skillOf(85))).toBeNull();
    expect(checkSkillSize('wish', skillOf(SKILL_MAX_LINES))).toBeNull();
    const grown = checkSkillSize('wish', skillOf(SKILL_MAX_LINES + 1));
    expect(grown?.detail).toContain(`trim to ${SKILL_MAX_LINES} line(s) or fewer`);
    expect(grown?.detail).toContain(`house size ${SKILL_MIN_LINES}-${SKILL_MAX_LINES}`);
  });

  test('a waiver covers only the skill it names', () => {
    expect(checkSkillSize('other', skillOf(95))?.detail).toContain(`trim to ${SKILL_MAX_LINES} line(s) or fewer`);
    expect(checkSkillSize('other', skillOf(8))?.detail).toContain(`grow to at least ${SKILL_MIN_LINES} line(s)`);
  });

  test('end-to-end: an undersized skill fails the gate and an in-window one passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-lint-size-'));
    try {
      const tiny = join(dir, 'tiny');
      mkdirSync(join(tiny, 'agents'), { recursive: true });
      writeFileSync(join(tiny, 'SKILL.md'), skillOf(12).replace(/name: fixture/, 'name: tiny'));
      writeFileSync(
        join(tiny, 'agents', 'openai.yaml'),
        'interface:\n  display_name: "tiny"\n  short_description: "Run the tiny workflow safely"\n  default_prompt: "Run the tiny workflow for this task."\n',
      );
      const { code, stderr } = runLintIn(dir);
      expect(code).toBe(1);
      expect(stderr).toContain(`skill(s) outside the ${SKILL_MIN_LINES}-${SKILL_MAX_LINES} line house size`);
      expect(stderr).toContain('tiny/SKILL.md: 12 lines');

      rmSync(join(dir, 'tiny'), { recursive: true, force: true });
      writeSkillIn(dir, 'sized', '# sized\n\nOrdinary prose.\n');
      const ok = runLintIn(dir);
      expect(ok.code).toBe(0);
      expect(ok.stderr).toContain('0 house-size violations');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hazards and residue — npx pinning', () => {
  test('isPinnedNpxPackage accepts a version or a documented placeholder only', () => {
    expect(isPinnedNpxPackage('skills@1.5.23')).toBe(true);
    expect(isPinnedNpxPackage('skills@<version>')).toBe(true);
    expect(isPinnedNpxPackage('@scope/pkg@1.2.3')).toBe(true);
    expect(isPinnedNpxPackage('skills')).toBe(false);
    expect(isPinnedNpxPackage('@scope/pkg')).toBe(false);
    expect(isPinnedNpxPackage('skills@latest')).toBe(false);
    expect(isPinnedNpxPackage('skills@next')).toBe(false);
    expect(isPinnedNpxPackage('skills@')).toBe(false);
  });

  test('the two shipped installer forms pass', () => {
    expect(hasUnpinnedNpxInstaller("npx -y skills@1.5.23 add ~/.genie/skills --skill '*' -y --copy -g")).toBe(false);
    expect(hasUnpinnedNpxInstaller('npx -y skills@<version> add <dir>')).toBe(false);
    expect(hasUnpinnedNpxInstaller('npx skills add automagik-dev/genie')).toBe(false);
  });

  test('any other npx installer is unpinned', () => {
    expect(hasUnpinnedNpxInstaller('npx create-something')).toBe(true);
    expect(hasUnpinnedNpxInstaller('npx -y some-tool@latest run')).toBe(true);
    expect(hasUnpinnedNpxInstaller('npx @scope/installer init')).toBe(true);
    // The documented form is the documented TARGET, not the word `skills`.
    expect(hasUnpinnedNpxInstaller('npx skills add someone-else/their-skills')).toBe(true);
  });
});

describe('hazards and residue — one test per pattern family', () => {
  /** Every hazard label hit on a line inside a fence. */
  function fenced(line: string): string[] {
    return checkHazardLine(line, 'fence').map((v) => v.label);
  }

  /** Every hazard label hit on a line of prose. */
  function prose(line: string): string[] {
    return checkHazardLine(line, 'prose').map((v) => v.label);
  }

  test('root escalation', () => {
    expect(fenced('sudo apt-get install ripgrep')).toEqual(['sudo']);
    expect(fenced('bun run check')).toEqual([]);
    expect(fenced('echo pseudocode')).toEqual([]);
  });

  test('unpinned installers', () => {
    expect(fenced('npx create-thing@latest')).toEqual(['unpinned npx installer']);
    expect(fenced('npx -y skills@1.5.23 add <dir>')).toEqual([]);
    expect(fenced('npx skills add automagik-dev/genie')).toEqual([]);
    expect(fenced('pip install requests')).toEqual(['pip install']);
    expect(fenced('pip3 install --break-system-packages requests')).toEqual(['pip install', '--break-system-packages']);
  });

  test('credential handling', () => {
    expect(fenced('curl -H "Authorization: Bearer $TOKEN" https://api.example.com')).toEqual([
      'curl with an Authorization header',
    ]);
    expect(fenced('curl -fsSL https://example.com/public.json')).toEqual([]);
    expect(fenced('echo "no Authorization needed"')).toEqual([]);
    expect(fenced('export GITHUB_TOKEN=$(cat token)')).toEqual(['GITHUB_TOKEN']);
    expect(fenced('cat ~/.git-credentials')).toEqual(['.git-credentials']);
    expect(fenced('gh pr view 1 --json state')).toEqual([]);
  });

  test('work-destroying git verbs', () => {
    expect(fenced('git stash --include-untracked')).toEqual(['git stash']);
    expect(fenced('git add -A')).toEqual(['git add -A']);
    expect(fenced('git add --all')).toEqual(['git add -A']);
    expect(fenced('git add .')).toEqual(['git add -A']);
    // Staging by path is the replacement the guidance names, so it must pass.
    expect(fenced('git add skills/wish/SKILL.md')).toEqual([]);
    expect(fenced('git add genie/hacks.mdx')).toEqual([]);
  });

  test('permission bypass', () => {
    expect(fenced('claude --dangerously-skip-permissions')).toEqual(['--dangerously flag']);
    expect(fenced('SKIP_TRUST=1 run-the-thing')).toEqual(['SKIP_TRUST']);
  });

  test('residue markers are banned in prose as well as in fences', () => {
    expect(prose('Route the group to Hermes for review.')).toEqual(['Hermes']);
    expect(prose('Record brn_01H9Z4 in the ledger.')).toEqual(['brn_ identifier']);
    expect(prose('Never set SKIP_TRUST anywhere.')).toEqual(['SKIP_TRUST']);
    // Word-boundary matched: an ordinary word that merely contains the letters passes.
    expect(prose('The hermeneutic reading of the brief.')).toEqual([]);
    expect(prose('The brn column is empty.')).toEqual([]);
    // A file-scope rule holds inside a fence too — residue is residue anywhere.
    expect(fenced('genie task assign t_1 --agent hermes --why x')).toEqual(['Hermes']);
    expect(fenced('echo brn_01H9Z4')).toEqual(['brn_ identifier']);
  });

  test('a prohibition or a documented command in prose is not a hazard', () => {
    // The sentence the house wants skills to carry must not be the sentence that fails.
    expect(prose('Never run git stash in a shared checkout — it hides another worker’s changes.')).toEqual([]);
    expect(prose('Stage by path; `git add -A` sweeps up files this skill never touched.')).toEqual([]);
    expect(prose('A skill never asks for sudo.')).toEqual([]);
    expect(prose('Do not export GITHUB_TOKEN from a skill body.')).toEqual([]);
  });

  test('collectHazardViolations reports the 1-indexed line and the fence boundary', () => {
    const md = [
      '# doc', // 1
      '', // 2
      'Never run git stash here.', // 3 — prohibition, clean
      '', // 4
      '```bash', // 5
      'git stash', // 6 — recipe, fails
      '```', // 7
      '', // 8
      'Hermes owns the rollout.', // 9 — residue, fails in prose
      '',
    ].join('\n');
    expect(collectHazardViolations(md).map((v) => [v.label, v.line])).toEqual([
      ['git stash', 6],
      ['Hermes', 9],
    ]);
  });

  test('every rule names its replacement, and every waiver names a real rule', () => {
    const labels = new Set(HAZARD_RULES.map((rule) => rule.label));
    expect(labels.size).toBe(HAZARD_RULES.length);
    for (const rule of HAZARD_RULES) {
      expect(rule.guidance.length).toBeGreaterThan(20);
      expect(['fence', 'file']).toContain(rule.scope);
    }
    for (const waiver of HAZARD_WAIVERS) {
      expect(labels).toContain(waiver.label);
      expect(waiver.reason).toContain('pre-existing');
    }
  });

  test('the waiver table is empty, so nothing is waived', () => {
    expect(HAZARD_WAIVERS).toHaveLength(0);
    expect(isHazardWaived('merge/SKILL.md', 'git add -A')).toBe(false);
    expect(isHazardWaived('merge/SKILL.md', 'git stash')).toBe(false);
    expect(isHazardWaived('work/SKILL.md', 'git add -A')).toBe(false);
    expect(isHazardWaived('genie-hacks/references/catalog.md', 'Hermes')).toBe(false);
    expect(isHazardWaived('genie-hacks/SKILL.md', 'Hermes')).toBe(false);
  });
});

describe('end-to-end: the hazard gate on a fixture tree', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-lint-hazard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fenced hazard fails and names the replacement', () => {
    writeSkillIn(
      dir,
      'offender',
      [
        '---',
        'name: offender',
        'description: "Use offender for this test workflow."',
        '---',
        '',
        '# offender',
        '',
        '```bash',
        'sudo npx create-thing',
        '```',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('file(s) ship a hazard or a residue marker');
    expect(stderr).toContain('offender/SKILL.md:9: [hazard] sudo — run as the invoking user');
    expect(stderr).toContain('[hazard] unpinned npx installer — pin the package');
  });

  test('a hazard in references/ fails too, and the ignore marker does not exempt it', () => {
    const skillDir = writeSkillIn(
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
        '# ignored',
        '',
      ].join('\n'),
    );
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(
      join(skillDir, 'references', 'notes.md'),
      ['# notes', '', '```bash', 'git add -A', '```', ''].join('\n'),
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('ignored/references/notes.md:4: [hazard] git add -A — stage by path');
  });

  test('prohibitions, the documented installer and staging by path all pass', () => {
    writeSkillIn(
      dir,
      'clean',
      [
        '---',
        'name: clean',
        'description: "Use clean for this test workflow."',
        '---',
        '',
        '# clean',
        '',
        'Never run git stash in a shared checkout, and never stage with git add -A.',
        '',
        '```bash',
        'npx skills add automagik-dev/genie',
        'git add skills/clean/SKILL.md',
        'git merge-base HEAD origin/dev',
        '```',
        '',
      ].join('\n'),
    );
    const { code, stderr } = runLintIn(dir);
    expect(code).toBe(0);
    expect(stderr).toContain('0 hazards, 0 house-size violations');
  });
});
