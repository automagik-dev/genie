import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryRootFromModuleUrl } from './fresh-install-smoke.ts';

const SMOKE_SCRIPT = join(import.meta.dir, 'fresh-install-smoke.ts');
const REPO_ROOT = join(import.meta.dir, '..');

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
      `  default_prompt: "Use $genie:${name} (or $${name} only for a separately installed personal copy) for this task."`,
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
      const result = runSmoke(['--skills-dir', skillsDir]);
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

  test('rejects an escaping source-plugin skills symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-source-plugin-fixture-'));
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

      const pluginRoot = join(root, 'plugin');
      mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
      writeFileSync(
        join(pluginRoot, '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'fixture',
          skills: './skills/',
          interface: {
            defaultPrompt: ['Use $genie:wish for this request.', 'Use $genie:work.', 'Use $genie:review.'],
          },
        }),
      );
      symlinkSync('../skills', join(pluginRoot, 'skills'));

      const result = runSmoke(['--skills-dir', skillsDir, '--plugin-root', pluginRoot]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('must be physical');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects source/package skill drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-plugin-parity-fixture-'));
    try {
      const canonical = join(root, 'skills');
      const wishDir = join(canonical, 'wish');
      mkdirSync(join(wishDir, 'templates'), { recursive: true });
      writeFileSync(join(wishDir, 'SKILL.md'), wishSkillBody());
      writeFileSync(
        join(wishDir, 'templates', 'wish-template.md'),
        '## Summary\n## Scope\n### IN\n### OUT\n## Dependencies\n## Success Criteria\n## Execution Strategy\n## Execution Groups\n',
      );
      writeOpenAiMetadata(wishDir, 'wish');

      const pluginRoot = join(root, 'plugin');
      mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
      cpSync(canonical, join(pluginRoot, 'skills'), { recursive: true });
      writeFileSync(join(pluginRoot, 'skills', 'wish', 'SKILL.md'), 'drift\n');
      writeFileSync(
        join(pluginRoot, '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'fixture',
          skills: './skills/',
          interface: {
            defaultPrompt: ['Use $genie:wish for this request.', 'Use $genie:work.', 'Use $genie:review.'],
          },
        }),
      );

      const result = runSmoke(['--skills-dir', canonical, '--plugin-root', pluginRoot]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('plugin skills mirror drift');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects unsupported camelCase plugin MCP config before source/cache packaging passes', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-plugin-mcp-schema-fixture-'));
    try {
      const pluginRoot = join(root, 'plugin');
      cpSync(join(REPO_ROOT, 'plugins', 'genie'), pluginRoot, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      writeFileSync(
        join(pluginRoot, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            genie: { command: 'node', args: ['./scripts/mcp-launcher.cjs'], cwd: '.' },
          },
        }),
      );

      const result = runSmoke(['--skills-dir', join(REPO_ROOT, 'skills'), '--plugin-root', pluginRoot]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('must not use unsupported camelCase mcpServers');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

      const result = runSmoke(['--skills-dir', skillsDir]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('reference/lifecycle.md');
      expect(result.stderr).toContain('references missing bundled resource');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
