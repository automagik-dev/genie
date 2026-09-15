import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CATALOG_END_MARKER,
  CATALOG_START_MARKER,
  SKILL_CATEGORIES,
  SKILL_MUTATES_LEVELS,
  checkSkillCatalogDrift,
  evaluateSkillCatalogBlock,
  evaluateSkillsInventoryParity,
  formatSkillsInventoryParityFailures,
  parseCliArgs,
  parseSkillFrontmatter,
  parseSkillsListOutput,
  readSkillCatalog,
  renderSkillCatalogBlock,
  scanRepoSkills,
  stripAnsi,
  writeSkillCatalogBlock,
} from './skills-inventory-parity.js';

// Fixtures only — this test never reaches the network. The CI job
// `skills-inventory-parity` is what runs the real pinned CLI; this file owns
// the comparison logic so a parser or scanner regression fails locally.

const ESC = String.fromCharCode(27);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(): string {
  const root = mkdtempSync(join(tmpdir(), 'skills-inventory-parity-'));
  roots.push(root);
  return root;
}

/** Write a repo-shaped tree: `paths` are relative to the repo root. */
function repoWith(paths: readonly string[]): string {
  const root = mkroot();
  mkdirSync(join(root, 'skills'), { recursive: true });
  for (const path of paths) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `# ${path}\n`, 'utf8');
  }
  return root;
}

/**
 * The pinned CLI's real `--list` shape: a spinner redraw before the count, a
 * `Available Skills` header, name rows at indent 4 and description rows at
 * indent 6. Captured verbatim from `skills@1.5.23 add automagik-dev/genie@<sha>
 * --list` on 2026-08-30 and reduced to the rows that matter.
 */
function listOutput(names: readonly string[], options: { declared?: number | null } = {}): string {
  const declared = options.declared === undefined ? names.length : options.declared;
  const head = [
    '│',
    `${ESC}[?25l◇  Source: https://github.com/automagik-dev/genie.git @deadbeef`,
    `${ESC}[?25h${ESC}[?25l│`,
    `◒  Cloning repository…${ESC}[1G${ESC}[J◐  Cloning repository…${ESC}[1G${ESC}[J◇  Repository cloned`,
    `${ESC}[?25h${ESC}[?25l│`,
    ...(declared === null ? [] : [`${ESC}[1G${ESC}[J◇  Found ${declared} skills`]),
    `${ESC}[?25h`,
    '│',
    '◇  Available Skills',
    '│',
  ];
  const rows = names.flatMap((name) => [`│    ${name}`, '│', `│      Description for ${name}.`, '│']);
  return [...head, ...rows, '', '│', '└  Use --skill <name> to install specific skills', ''].join('\n');
}

describe('stripAnsi', () => {
  test('removes CSI and OSC sequences and carriage returns', () => {
    const raw = `${ESC}[1G${ESC}[Jplain${ESC}]0;title${String.fromCharCode(7)}\r tail`;
    expect(stripAnsi(raw)).toBe('plain tail');
  });
});

describe('parseSkillsListOutput', () => {
  test('reads the indent-4 name rows and the declared count', () => {
    const parsed = parseSkillsListOutput(listOutput(['architecture', 'wish', 'work']));
    expect(parsed.names).toEqual(['architecture', 'wish', 'work']);
    expect(parsed.declaredCount).toBe(3);
  });

  test('never mistakes an indent-6 description row for a name', () => {
    const text = ['◇  Available Skills', '│', '│    wish', '│', '│      wish', '│'].join('\n');
    expect(parseSkillsListOutput(text).names).toEqual(['wish']);
  });

  test('ignores chrome printed before the Available Skills header', () => {
    const text = ['│    notaskill', '◇  Available Skills', '│', '│    wish', '│'].join('\n');
    expect(parseSkillsListOutput(text).names).toEqual(['wish']);
  });

  test('reports a null declared count when the CLI printed none', () => {
    expect(parseSkillsListOutput(listOutput(['wish'], { declared: null })).declaredCount).toBeNull();
  });
});

describe('scanRepoSkills', () => {
  test('accepts a flat tree of top-level SKILL.md files and ignores skills/README.md', () => {
    const root = repoWith(['skills/README.md', 'skills/wish/SKILL.md', 'skills/work/SKILL.md']);
    expect(scanRepoSkills(root)).toEqual({
      names: ['wish', 'work'],
      nestedSkillFiles: [],
      dirsWithoutSkillMd: [],
      invalidNames: [],
      skippedSymlinks: [],
    });
  });

  test('keeps sibling assets inside a skill directory out of the inventory', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/wish/templates/report.md', 'skills/wish/agents/x.md']);
    const scan = scanRepoSkills(root);
    expect(scan.names).toEqual(['wish']);
    expect(scan.nestedSkillFiles).toEqual([]);
  });

  test('flags a nested SKILL.md', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/wish/sub/SKILL.md']);
    expect(scanRepoSkills(root).nestedSkillFiles).toEqual(['wish/sub/SKILL.md']);
  });

  test('flags a stray skills/SKILL.md', () => {
    const root = repoWith(['skills/SKILL.md', 'skills/wish/SKILL.md']);
    expect(scanRepoSkills(root).nestedSkillFiles).toEqual(['SKILL.md']);
  });

  test('flags a directory with no top-level SKILL.md', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/orphan/README.md']);
    const scan = scanRepoSkills(root);
    expect(scan.dirsWithoutSkillMd).toEqual(['orphan']);
    expect(scan.names).toEqual(['wish']);
  });

  test('flags a directory name that is not a safe path segment', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/bad name/SKILL.md']);
    expect(scanRepoSkills(root).invalidNames).toEqual(['bad name']);
  });

  test('never counts a file whose name merely ends in SKILL.md', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/wish/NOTSKILL.md', 'skills/decoy/NOTSKILL.md']);
    const scan = scanRepoSkills(root);
    expect(scan.names).toEqual(['wish']);
    expect(scan.nestedSkillFiles).toEqual([]);
    expect(scan.dirsWithoutSkillMd).toEqual(['decoy']);
  });

  test('reports a symlinked skill directory instead of silently dropping it', () => {
    const root = repoWith(['skills/wish/SKILL.md']);
    symlinkSync(join(root, 'skills', 'wish'), join(root, 'skills', 'aliased'));
    const scan = scanRepoSkills(root);
    expect(scan.names).toEqual(['wish']);
    expect(scan.skippedSymlinks).toEqual(['aliased']);
  });

  test('reports a symlink nested inside a skill directory', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/wish/references/real.mjs']);
    symlinkSync(join(root, 'skills', 'wish', 'references', 'real.mjs'), join(root, 'skills', 'wish', 'alias.mjs'));
    expect(scanRepoSkills(root).skippedSymlinks).toEqual(['wish/alias.mjs']);
  });
});

describe('evaluateSkillsInventoryParity', () => {
  test('passes when the CLI list and the checkout agree exactly', () => {
    const root = repoWith(['skills/README.md', 'skills/wish/SKILL.md', 'skills/work/SKILL.md']);
    const report = evaluateSkillsInventoryParity(listOutput(['wish', 'work']), root);
    expect(formatSkillsInventoryParityFailures(report)).toEqual([]);
    expect(report.listed).toEqual(['wish', 'work']);
    expect(report.repo).toEqual(['wish', 'work']);
  });

  test('fails on a nested SKILL.md', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/wish/sub/SKILL.md']);
    const failures = formatSkillsInventoryParityFailures(evaluateSkillsInventoryParity(listOutput(['wish']), root));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('nested SKILL.md');
    expect(failures[0]).toContain('wish/sub/SKILL.md');
  });

  test('fails on a skills/ directory without SKILL.md', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/orphan/README.md']);
    const failures = formatSkillsInventoryParityFailures(evaluateSkillsInventoryParity(listOutput(['wish']), root));
    expect(failures.some((line) => line.includes('without a top-level SKILL.md') && line.includes('orphan'))).toBe(
      true,
    );
  });

  test('fails when the CLI names a skill the checkout does not ship', () => {
    const root = repoWith(['skills/wish/SKILL.md']);
    const failures = formatSkillsInventoryParityFailures(
      evaluateSkillsInventoryParity(listOutput(['wish', 'ghost']), root),
    );
    expect(failures).toEqual(['named by the skills CLI but absent from skills/: ghost']);
  });

  test('fails when the checkout ships a skill the CLI never names', () => {
    const root = repoWith(['skills/wish/SKILL.md', 'skills/work/SKILL.md']);
    const failures = formatSkillsInventoryParityFailures(evaluateSkillsInventoryParity(listOutput(['wish']), root));
    expect(failures).toEqual(['present in skills/ but never named by the skills CLI: work']);
  });

  test('fails when the CLI count disagrees with the rows it printed', () => {
    const root = repoWith(['skills/wish/SKILL.md']);
    const failures = formatSkillsInventoryParityFailures(
      evaluateSkillsInventoryParity(listOutput(['wish'], { declared: 7 }), root),
    );
    expect(failures).toEqual(['the CLI reported "Found 7 skills" but 1 name(s) were parsed']);
  });

  test('fails closed when the CLI printed nothing parseable', () => {
    const root = repoWith(['skills/wish/SKILL.md']);
    const failures = formatSkillsInventoryParityFailures(evaluateSkillsInventoryParity('npm ERR! 404\n', root));
    expect(failures[0]).toContain('named no skills');
  });

  test('fails closed on a symlinked skill directory', () => {
    const root = repoWith(['skills/wish/SKILL.md']);
    symlinkSync(join(root, 'skills', 'wish'), join(root, 'skills', 'aliased'));
    const failures = formatSkillsInventoryParityFailures(evaluateSkillsInventoryParity(listOutput(['wish']), root));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('symlinks under skills/');
    expect(failures[0]).toContain('aliased');
  });

  test('the live repository satisfies its own contract', () => {
    const repoRoot = join(import.meta.dir, '..');
    const scan = scanRepoSkills(repoRoot);
    expect(scan.nestedSkillFiles).toEqual([]);
    expect(scan.dirsWithoutSkillMd).toEqual([]);
    expect(scan.invalidNames).toEqual([]);
    expect(scan.skippedSymlinks).toEqual([]);
    expect(scan.names.length).toBeGreaterThan(0);
  });
});

describe('parseCliArgs', () => {
  test('resolves --repo and --list-file to absolute paths', () => {
    const parsed = parseCliArgs(['--repo', '/abs/repo', '--list-file', '/abs/list.txt']);
    expect(parsed).toEqual({ repoRoot: '/abs/repo', listFile: '/abs/list.txt', write: false });
  });

  test('defaults to cwd with stdin input', () => {
    expect(parseCliArgs([])).toEqual({ repoRoot: process.cwd(), listFile: null, write: false });
  });

  test('--write is a valueless flag', () => {
    expect(parseCliArgs(['--write', '--repo', '/abs/repo'])).toEqual({
      repoRoot: '/abs/repo',
      listFile: null,
      write: true,
    });
  });

  test('rejects an unknown flag and a valueless flag', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow('unknown argument: --nope');
    expect(() => parseCliArgs(['--repo'])).toThrow('--repo requires a value');
  });
});

describe('parseSkillFrontmatter — the one SKILL.md frontmatter reader', () => {
  test('reads flat keys and strips surrounding quotes', () => {
    const parsed = parseSkillFrontmatter(
      [
        '---',
        'name: wish',
        'description: "Plan a wish."',
        'category: lifecycle',
        'mutates: documents',
        '---',
        '',
        '# Wish',
        '',
      ].join('\n'),
    );
    expect(parsed.violations).toEqual([]);
    expect([...(parsed.fields as Map<string, string>)]).toEqual([
      ['name', 'wish'],
      ['description', 'Plan a wish.'],
      ['category', 'lifecycle'],
      ['mutates', 'documents'],
    ]);
  });

  test('fails closed on an absent or unterminated block', () => {
    expect(parseSkillFrontmatter('# Wish\n')).toEqual({
      fields: null,
      violations: ['SKILL.md must start with YAML frontmatter'],
    });
    expect(parseSkillFrontmatter('---\nname: wish\n')).toEqual({
      fields: null,
      violations: ['SKILL.md frontmatter is not closed'],
    });
  });

  test('reports nested syntax and duplicate keys', () => {
    const parsed = parseSkillFrontmatter(
      ['---', 'name: wish', 'metadata:', '  verifiedAgainst: x', 'name: other', '---', ''].join('\n'),
    );
    expect(parsed.violations).toEqual([
      'unsupported frontmatter syntax: metadata:',
      'unsupported frontmatter syntax: verifiedAgainst: x',
      'duplicate frontmatter field: name',
    ]);
  });
});

describe('skills/README.md catalog block', () => {
  /** A skills root holding `<name>/SKILL.md` for each entry. */
  function skillsRootWith(entries: ReadonlyArray<readonly [string, readonly string[]]>): string {
    const root = mkroot();
    const skillsRoot = join(root, 'skills');
    for (const [name, frontmatter] of entries) {
      mkdirSync(join(skillsRoot, name), { recursive: true });
      writeFileSync(
        join(skillsRoot, name, 'SKILL.md'),
        ['---', `name: ${name}`, ...frontmatter, '---', '', `# ${name}`, ''].join('\n'),
        'utf8',
      );
    }
    return skillsRoot;
  }

  test('derives the catalog from the tree, ordered by category then name', () => {
    const skillsRoot = skillsRootWith([
      ['omni', ['description: "Wire a channel."', 'category: integration', 'mutates: external']],
      ['work', ['description: "Execute a wish."', 'category: lifecycle', 'mutates: repo']],
      ['fix', ['description: "Repair gaps."', 'category: lifecycle', 'mutates: repo']],
      ['stray', ['description: "No taxonomy yet."']],
    ]);
    expect(readSkillCatalog(skillsRoot)).toEqual([
      { name: 'fix', category: 'lifecycle', mutates: 'repo', description: 'Repair gaps.' },
      { name: 'work', category: 'lifecycle', mutates: 'repo', description: 'Execute a wish.' },
      { name: 'omni', category: 'integration', mutates: 'external', description: 'Wire a channel.' },
      // Absent keys are legal and sort last, rendered as an em dash.
      { name: 'stray', category: null, mutates: null, description: 'No taxonomy yet.' },
    ]);
  });

  test('renders a marker-wrapped table and escapes a pipe in a description', () => {
    const block = renderSkillCatalogBlock([
      { name: 'refine', category: 'authoring', mutates: 'documents', description: 'Use --for openai | claude.' },
      { name: 'stray', category: null, mutates: null, description: 'No taxonomy yet.' },
    ]);
    expect(block.startsWith(CATALOG_START_MARKER)).toBe(true);
    expect(block.endsWith(CATALOG_END_MARKER)).toBe(true);
    expect(block).toContain('| `refine` | authoring | documents | Use --for openai \\| claude. |');
    expect(block).toContain('| `stray` | — | — | No taxonomy yet. |');
  });

  test('a new skill directory appears without being hand-listed', () => {
    const skillsRoot = skillsRootWith([
      ['work', ['description: "Execute a wish."', 'category: lifecycle', 'mutates: repo']],
    ]);
    const readme = join(skillsRoot, 'README.md');
    writeFileSync(readme, `# Skills\n\n${renderSkillCatalogBlock(readSkillCatalog(skillsRoot))}\n\nTail.\n`, 'utf8');
    expect(checkSkillCatalogDrift(skillsRoot)).toEqual([]);

    mkdirSync(join(skillsRoot, 'verify'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'verify', 'SKILL.md'),
      [
        '---',
        'name: verify',
        'description: "Prove a claim."',
        'category: verification',
        'mutates: none',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(checkSkillCatalogDrift(skillsRoot)).toEqual([
      'the skills/README.md catalog block is stale — regenerate it with `bun scripts/skills-inventory-parity.ts --write`',
    ]);

    expect(writeSkillCatalogBlock(readme, readSkillCatalog(skillsRoot))).toBe(true);
    expect(checkSkillCatalogDrift(skillsRoot)).toEqual([]);
    // The rewrite is idempotent and preserves the surrounding prose.
    expect(writeSkillCatalogBlock(readme, readSkillCatalog(skillsRoot))).toBe(false);
    const text = readFileSync(readme, 'utf8');
    expect(text.startsWith('# Skills\n')).toBe(true);
    expect(text.endsWith('\nTail.\n')).toBe(true);
    expect(text).toContain('| `verify` | verification | none | Prove a claim. |');
  });

  test('a missing block is a failure, not a silent pass', () => {
    const entries = [{ name: 'work', category: 'lifecycle', mutates: 'repo', description: 'Execute a wish.' }];
    const failures = evaluateSkillCatalogBlock('# Skills\n\nNo markers here.\n', entries).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing the <!-- skills-catalog:start -->');
  });

  test('a tree with no README has no catalog to be stale', () => {
    expect(checkSkillCatalogDrift(skillsRootWith([['work', ['description: "Execute a wish."']]]))).toEqual([]);
  });

  test('the live repository catalog block is current and fully labelled', () => {
    const skillsRoot = join(import.meta.dir, '..', 'skills');
    expect(checkSkillCatalogDrift(skillsRoot)).toEqual([]);
    for (const entry of readSkillCatalog(skillsRoot)) {
      expect(SKILL_CATEGORIES).toContain(entry.category as never);
      expect(SKILL_MUTATES_LEVELS).toContain(entry.mutates as never);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
