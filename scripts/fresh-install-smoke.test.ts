import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSkillStarterPrompts, repositoryRootFromModuleUrl } from './fresh-install-smoke.ts';

const SMOKE_SCRIPT = join(import.meta.dir, 'fresh-install-smoke.ts');
const REPO_ROOT = repositoryRootFromModuleUrl(import.meta.url);

const DOCUMENTED_SCAFFOLD = [
  '<!-- wish-scaffold-command:start -->',
  '```sh',
  "WISH_SKILL_DIR='<absolute directory containing this SKILL.md>'",
  "WISH_SLUG='<slug>'",
  'case "$WISH_SLUG" in',
  `  ''|*[!a-z0-9-]*|-*|*-) printf 'invalid wish slug: %s\\n' "$WISH_SLUG" >&2; exit 2 ;;`,
  'esac',
  'WISH_DEST=".genie/wishes/$WISH_SLUG/WISH.md"',
  'test -f "$WISH_SKILL_DIR/templates/wish-template.md"',
  'test ! -e "$WISH_DEST"',
  'mkdir -p "$(dirname "$WISH_DEST")"',
  'cp "$WISH_SKILL_DIR/templates/wish-template.md" "$WISH_DEST"',
  '```',
  '<!-- wish-scaffold-command:end -->',
].join('\n');

function wishSkillBody(): string {
  return [
    '---',
    'name: wish',
    'description: "Create a structured wish from an accepted design."',
    '---',
    '',
    '# wish',
    '',
    'Use the documented scaffold command with `templates/wish-template.md`.',
    '',
    DOCUMENTED_SCAFFOLD,
    '',
  ].join('\n');
}

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

function writeOpenAiMetadata(skillDir: string, name: string): void {
  mkdirSync(join(skillDir, 'agents'), { recursive: true });
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

describe('fresh-install-smoke', () => {
  test('decodes escaped characters when resolving the checkout root', () => {
    const checkout = join(tmpdir(), 'genie checkout');
    const moduleUrl = pathToFileURL(join(checkout, 'scripts', 'fresh-install-smoke.ts')).href;
    expect(moduleUrl).toContain('%20');
    expect(repositoryRootFromModuleUrl(moduleUrl)).toBe(checkout);
  });

  test('passes the digest-bound design review and post-stamp drift checks against the real skills tree', () => {
    const result = runSmoke();
    // Surface the failure reason if this ever regresses.
    expect(result.stdout + result.stderr).toContain('fresh-install-smoke: OK');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  // The staged and extracted payload trees build-binary.sh checks are passed
  // through --skills-dir, so the shipped-inventory comparison has to run for
  // those too: a payload that dropped a skill must fail here, not ship.
  test('a payload skills tree missing a shipped skill fails the inventory guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-payload-inventory-fixture-'));
    try {
      const payload = join(root, 'skills');
      cpSync(join(REPO_ROOT, 'skills'), payload, { recursive: true });
      const dropped = readdirSync(payload, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()[0];
      expect(dropped).toBeString();
      rmSync(join(payload, dropped), { recursive: true, force: true });

      const result = runSmoke(['--skills-dir', payload]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('shipped skill inventory mismatch');
      expect(result.stderr).toContain(`missing: ${dropped}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the same metadata is safe in plugin and user tiers because prompts contain no selector', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-selector-free-fixture-'));
    try {
      for (const tier of ['plugin', 'user']) {
        const skill = join(root, tier, 'fixture');
        writeOpenAiMetadata(skill, 'fixture');
        expect(() => checkSkillStarterPrompts(join(root, tier), ['fixture'])).not.toThrow();
      }
      const metadata = join(root, 'user', 'fixture', 'agents', 'openai.yaml');
      writeFileSync(
        metadata,
        readFileSync(metadata, 'utf8').replace(
          'default_prompt: "Run the fixture workflow',
          'default_prompt: "Use $genie:fixture or $fixture to run',
        ),
      );
      expect(() => checkSkillStarterPrompts(join(root, 'user'), ['fixture'])).toThrow(
        'starter prompt must be selector-free across physical tiers',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('broken fixture', () => {
    let skillsDir: string;

    beforeEach(() => {
      skillsDir = mkdtempSync(join(tmpdir(), 'genie-fresh-install-fixture-'));
      const skill = join(skillsDir, 'brokenskill');
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, 'SKILL.md'),
        [
          '---',
          'name: brokenskill',
          'description: "Exercise a deliberately broken bundled resource."',
          '---',
          '',
          '# Broken skill',
          '',
          'Read `templates/does-not-exist.md` before continuing.',
          '',
        ].join('\n'),
      );
      writeOpenAiMetadata(skill, 'brokenskill');
    });

    afterEach(() => {
      rmSync(skillsDir, { recursive: true, force: true });
    });

    test('exits non-zero when a SKILL.md references a missing bundled path', () => {
      const result = runSmoke(['--skills-dir', skillsDir, '--allow-partial-inventory']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('references missing bundled resource');
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
      writeFileSync(join(wishDir, 'SKILL.md'), wishSkillBody());
      writeFileSync(join(wishDir, 'templates', 'wish-template.md'), templateBody);
      writeOpenAiMetadata(wishDir, 'wish');
    }

    const FULL_SECTIONS = [
      '## Summary',
      '## Scope',
      '### IN',
      '### OUT',
      '## Dependencies',
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

      const result = runSmoke(['--skills-dir', skillsDir, '--allow-partial-inventory']);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('fresh-install-smoke: FAIL');
      expect(result.stderr).toContain('## Execution Groups');

      const leaked = [...scaffoldWorkDirs()].filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    });

    test('a clean phase-b run exits 0 and leaves no scaffold temp dir behind', () => {
      writeWishFixture(`${[...FULL_SECTIONS, '## Execution Groups'].join('\n')}\n`);
      const before = scaffoldWorkDirs();

      const result = runSmoke(['--skills-dir', skillsDir, '--allow-partial-inventory']);

      expect(result.code).toBe(0);
      const leaked = [...scaffoldWorkDirs()].filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    });
  });

  test('rejects a missing singular reference resource such as genie lifecycle.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-reference-resource-fixture-'));
    try {
      const skillsDir = join(root, 'skills');
      const wishDir = join(skillsDir, 'wish');
      mkdirSync(join(wishDir, 'templates'), { recursive: true });
      writeFileSync(join(wishDir, 'SKILL.md'), wishSkillBody());
      writeFileSync(
        join(wishDir, 'templates', 'wish-template.md'),
        '## Summary\n## Scope\n### IN\n### OUT\n## Dependencies\n## Success Criteria\n## Execution Strategy\n## Execution Groups\n',
      );
      writeOpenAiMetadata(wishDir, 'wish');

      const genieDir = join(skillsDir, 'genie');
      mkdirSync(join(genieDir, 'reference'), { recursive: true });
      writeFileSync(
        join(genieDir, 'SKILL.md'),
        '---\nname: genie\ndescription: "Explain Genie using its bundled lifecycle reference."\n---\n\nRead `reference/lifecycle.md`.\n',
      );
      writeFileSync(join(genieDir, 'reference', 'lifecycle.md'), '# lifecycle\n');
      writeOpenAiMetadata(genieDir, 'genie');
      rmSync(join(genieDir, 'reference', 'lifecycle.md'));

      const result = runSmoke(['--skills-dir', skillsDir, '--allow-partial-inventory']);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('reference/lifecycle.md');
      expect(result.stderr).toContain('references missing bundled resource');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
