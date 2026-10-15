import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { classifyLegacySkillEntry } from '../src/lib/legacy-skills.js';
import {
  CATALOG_CHECK_GAP,
  collectCatalog,
  evaluateCatalogCheck,
  mergeCatalog,
  recordedCatalog,
  render,
} from './legacy-skills-catalog.js';

/** Render tests cover the additive union; isolated CLI histories below cover ownership collection. */
const ROOT = join(import.meta.dir, '..');

/** A description genie really shipped — the 2026-07 `pm` skill's, found as residue on the dogfood host. */
const SHIPPED_PM_DESCRIPTION =
  'Full PM playbook — triage backlog, prioritize, assign, track, report, escalate. Copilot, autopilot, or pair modes.';

function shippedSkillNames(): string[] {
  return readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function frontmatterDescription(name: string): string | null {
  const markdown = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  if (!markdown.startsWith('---\n')) return null;
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return null;
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[1] as string).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

/** The first shipped skill whose frontmatter carries a description — the subtraction fixture. */
function aShippedSkill(): { name: string; description: string } {
  for (const name of shippedSkillNames()) {
    const description = frontmatterDescription(name);
    if (description !== null) return { name, description };
  }
  throw new Error('no shipped skill carries a frontmatter description');
}

describe('render is additive', () => {
  test('a recorded name and description survive a render over an empty collected catalog', () => {
    const rendered = render(new Map(), { names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] });

    expect(rendered).toContain('"pm"');
    expect(rendered).toContain(JSON.stringify(SHIPPED_PM_DESCRIPTION));
  });

  test('history entries join the recorded ones rather than replacing them', () => {
    const collected = new Map<string, Set<string>>([
      ['from-history', new Set(['A description only git history knows.'])],
    ]);
    const rendered = render(collected, { names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] });

    expect(rendered).toContain('"from-history"');
    expect(rendered).toContain(JSON.stringify('A description only git history knows.'));
    expect(rendered).toContain('"pm"');
    expect(rendered).toContain(JSON.stringify(SHIPPED_PM_DESCRIPTION));
  });

  test('a collected-only entry needs no recorded catalog to appear', () => {
    const collected = new Map<string, Set<string>>([['solo', new Set(['Solo description.'])]]);
    const rendered = render(collected, { names: [], descriptions: [] });

    expect(rendered).toContain('"solo"');
    expect(rendered).toContain(JSON.stringify('Solo description.'));
  });

  test('only currently shipped names and descriptions are subtracted, from either source', () => {
    const shipped = aShippedSkill();
    const collected = new Map<string, Set<string>>([[shipped.name, new Set([shipped.description])]]);
    const rendered = render(collected, { names: [shipped.name], descriptions: [shipped.description] });

    expect(rendered).not.toContain(`"${shipped.name}"`);
    expect(rendered).not.toContain(JSON.stringify(shipped.description));
  });
});

describe('--check is an additive-union SUPERSET check', () => {
  const collected = new Map<string, Set<string>>([['pm', new Set([SHIPPED_PM_DESCRIPTION])]]);
  const current = new Set<string>();
  const shipping = new Set<string>();

  /** The verdict for a committed catalog that carries exactly `recorded`. */
  function verdictFor(recorded: { names: string[]; descriptions: string[] }, existing?: string) {
    const expected = render(collected, recorded);
    return evaluateCatalogCheck(existing ?? expected, expected, {
      merged: mergeCatalog(collected, recorded, current, shipping),
      recorded,
    });
  }

  test('a seeded stale catalog — one history entry dropped — is reported and names the gap', () => {
    const verdict = verdictFor({ names: [], descriptions: [] }, '// a hand-truncated catalog\n');

    expect(verdict.stale).toBe(true);
    expect(verdict.lines.join('\n')).toContain('stale');
    expect(verdict.lines.join('\n')).toContain('legacy-skills-catalog.ts --write');
    // The gap the CI job closes: history yields entries the committed file lacks.
    expect(verdict.lines.join('\n')).toContain('1 name(s)');
  });

  test('a catalog that already carries every history entry is current', () => {
    const verdict = verdictFor({ names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] });

    expect(verdict.stale).toBe(false);
    expect(verdict.lines.join('\n')).toContain('current');
  });

  /**
   * The gap itself, stated as a test rather than a comment: the union means
   * `--check` proves the committed catalog is a SUPERSET of what THIS clone's
   * history yields — never an exact match. An entry no history yields rides
   * along silently, which is also why a shallow checkout cannot run it.
   */
  test('an entry no history yields is never reported — the union makes it invisible', () => {
    const verdict = verdictFor({
      names: ['pm', 'never-shipped-by-any-ref'],
      descriptions: [SHIPPED_PM_DESCRIPTION, 'A description no commit ever carried.'],
    });

    expect(verdict.stale).toBe(false);
    expect(verdict.lines.join('\n')).toContain(CATALOG_CHECK_GAP);
  });

  test('a text-only difference is stale with no missing entry, and says so', () => {
    const recorded = { names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] };
    const verdict = verdictFor(recorded, `${render(collected, recorded)}\n// hand-edited trailer\n`);

    expect(verdict.stale).toBe(true);
    expect(verdict.lines.join('\n')).toContain('formatting or ordering');
  });
});

/**
 * The vacuous-green case: on a shallow clone the history walk sees nothing, the
 * collected catalog is empty, and the additive union leaves the committed file
 * unchanged — so `--check` would pass having proven nothing at all. It refuses
 * instead, BEFORE any history walk or biome call. `--write` is untouched.
 */
describe('catalog CLI over isolated Git histories', () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    });
  }

  function skill(repo: string, path: string, description: string): void {
    mkdirSync(join(repo, path), { recursive: true });
    writeFileSync(join(repo, path, 'SKILL.md'), `---\ndescription: ${JSON.stringify(description)}\n---\n`);
  }

  function commit(repo: string, message: string): string {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD').trim();
  }

  function seedRepo(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'legacy-skills-catalog.ts'),
      readFileSync(join(ROOT, 'scripts', 'legacy-skills-catalog.ts'), 'utf8'),
    );
    writeFileSync(
      join(dir, 'scripts', 'git-history-ownership.ts'),
      readFileSync(join(ROOT, 'scripts', 'git-history-ownership.ts'), 'utf8'),
    );
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    return dir;
  }

  /** A minimal repo carrying both collector sources, with history a shallow clone truncates. */
  function seedOrigin(): string {
    const dir = seedRepo('legacy-catalog-origin-');
    skill(dir, 'skills/demo', 'Demo.');
    skill(dir, 'skills/genie-retired', 'Historical Genie root skill.');
    skill(dir, 'plugins/genie/skills/genie-nested', 'Historical Genie plugin skill.');
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'lib', 'legacy-skills-catalog.ts'),
      'export const LEGACY_SKILL_NAMES = ["recorded-only"];\n' +
        'export const LEGACY_SKILL_DESCRIPTIONS = ["Recorded from an unavailable Genie ref."];\n',
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'seed');
    writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: "Demo, revised."\n---\n');
    rmSync(join(dir, 'skills', 'genie-retired'), { recursive: true });
    rmSync(join(dir, 'plugins'), { recursive: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'revise');
    // Default archive history remains eligible without an explicit proof.
    skill(dir, 'skills/genie-branch', 'Genie skill only an archived ref delivered.');
    git(dir, 'add', '-A');
    const branch = git(dir, 'commit-tree', git(dir, 'write-tree').trim(), '-p', 'HEAD', '-m', 'archived Genie skill');
    git(dir, 'update-ref', 'refs/heads/genie-archive', branch.trim());
    git(dir, 'update-ref', 'refs/archive/genie-archive', branch.trim());
    rmSync(join(dir, 'skills', 'genie-branch'), { recursive: true });
    git(dir, 'add', '-A');
    return dir;
  }

  function sideRef(repo: string, base: string, ref: string, name: string): string {
    git(repo, 'checkout', '-q', '--detach', base);
    skill(repo, `skills/${name}`, `The ${name} skill.`);
    const tip = commit(repo, `add ${name}`);
    git(repo, 'update-ref', ref, tip);
    git(repo, 'checkout', '-q', 'main');
    return tip;
  }

  /** `old` is tag-only; `new` is unmerged; the optional shipping refs are absent. */
  function seedShippingOrigin(): { repo: string; base: string } {
    const repo = seedRepo('legacy-catalog-shipped-');
    skill(repo, 'skills/kept', 'The kept skill.');
    commit(repo, 'add kept');
    skill(repo, 'skills/old', 'The old skill.');
    commit(repo, 'add old');
    git(repo, 'tag', '-a', 'v1', '-m', 'shipped release');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(repo, 'README.md'), 'after the release\n');
    const base = commit(repo, 'move on');
    sideRef(repo, base, 'refs/remotes/origin/feature', 'new');
    return { repo, base };
  }

  function runCheck(repo: string, ...args: string[]) {
    const result = spawnSync('bun', [join(repo, 'scripts', 'legacy-skills-catalog.ts'), ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function outputCatalog(repo: string, provenance?: string): { names: string[]; descriptions: string[] } {
    const run = runCheck(repo, ...(provenance === undefined ? [] : ['--ref-provenance', provenance]));
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const names = /LEGACY_SKILL_NAMES: readonly string\[\] = (\[[^\n]*\]);/.exec(run.stdout);
    const descriptions = /LEGACY_SKILL_DESCRIPTIONS: readonly string\[\] = (\[[\s\S]*?\n\]);/.exec(run.stdout);
    expect(names).not.toBeNull();
    expect(descriptions).not.toBeNull();
    return {
      names: JSON.parse(names?.[1] ?? ''),
      descriptions: JSON.parse((descriptions?.[1] ?? '').replace(/,\s*\]$/, ']')),
    };
  }

  /** Runtime-selected module: a static import would read the root catalog, not this CLI's output. */
  async function consumerFor(
    repo: string,
    provenance?: string,
  ): Promise<{
    home: string;
    classify: typeof classifyLegacySkillEntry;
  }> {
    const run = runCheck(repo, ...(provenance === undefined ? [] : ['--ref-provenance', provenance]));
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const dir = mkdtempSync(join(tmpdir(), 'legacy-catalog-consumer-'));
    scratch.push(dir);
    for (const file of ['legacy-skills.ts', 'skills-agents.ts']) {
      cpSync(join(ROOT, 'src', 'lib', file), join(dir, file));
    }
    writeFileSync(join(dir, 'legacy-skills-catalog.ts'), run.stdout);
    const { classifyLegacySkillEntry } = await import(join(dir, 'legacy-skills.ts'));
    return { home: join(dir, 'home'), classify: classifyLegacySkillEntry };
  }

  function importMikro(
    repo: string,
    sharedAncestry: boolean,
    metadata?: string,
    alterTree = false,
    sourceTag = false,
  ): { provenance?: string; split: string; foreign: string; side?: string } {
    const source = mkdtempSync(join(tmpdir(), 'legacy-catalog-source-'));
    scratch.push(source);
    if (sharedAncestry) {
      // This independent archive now needs proof both for ownership and for
      // eligibility: its only remaining ref is outside the shipped defaults.
      git(repo, 'update-ref', '-d', 'refs/archive/genie-archive');
      git(source, 'clone', '-q', repo, '.');
    } else {
      git(source, 'init', '-q', '-b', 'main');
    }
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'commit.gpgsign', 'false');
    git(source, 'config', 'core.hooksPath', '/dev/null');
    // The archive is also a source ancestor, so it needs independent role proof.
    if (sharedAncestry) git(source, 'merge', '-q', '--no-edit', 'origin/genie-archive');
    skill(source, 'skills/foreign-ancestor', 'Mikro skill retired before import.');
    const foreign = commit(source, 'foreign historical skill');
    rmSync(join(source, 'skills', 'foreign-ancestor'), { recursive: true });
    skill(source, 'plugins/claude-code/skills/foreign-nested', 'Mikro nested skill at import.');
    if (sourceTag) {
      git(source, 'tag', '-a', 'archive', '-m', 'Historical source reference', foreign);
      // Source data cannot attest its own root skill as Genie-owned.
      writeFileSync(
        join(source, 'ref-provenance.json'),
        JSON.stringify({
          version: 1,
          refs: [{ ref: 'refs/tags/archive', commit: foreign, owner: 'genie' }],
        }),
      );
    }
    const split = commit(source, 'foreign import tip');
    let side: string | undefined;
    if (sourceTag) {
      side = git(source, 'commit-tree', `${split}^{tree}`, '-p', foreign, '-m', 'unmerged source branch').trim();
      git(source, 'update-ref', 'refs/tags/side', side);
    }
    git(repo, 'fetch', '-q', source, `${split}:refs/heads/mikro-source`);
    if (sourceTag) git(repo, 'fetch', '-q', source, 'refs/tags/archive:refs/tags/archive');
    if (sourceTag) git(repo, 'fetch', '-q', source, 'refs/tags/side:refs/tags/side');
    mkdirSync(join(repo, 'mikro'));
    for (const entry of readdirSync(source)) {
      if (entry !== '.git') cpSync(join(source, entry), join(repo, 'mikro', entry), { recursive: true });
    }
    if (alterTree) skill(repo, 'mikro/skills/extra', 'Not the declared imported tree.');
    git(repo, 'add', '-A');
    const tree = git(repo, 'write-tree').trim();
    const trailers = metadata?.replaceAll('$SOURCE', split) ?? `git-subtree-dir: mikro\n\ngit-subtree-split: ${split}`;
    const imported = git(
      repo,
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-p',
      split,
      '-m',
      `Import Mikro\n\n${trailers}`,
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', imported);
    let provenance: string | undefined;
    if (sharedAncestry || sourceTag) {
      const refs = [
        {
          ref: 'refs/heads/genie-archive',
          commit: git(repo, 'rev-parse', 'refs/heads/genie-archive').trim(),
          owner: 'genie',
        },
      ];
      if (sourceTag) refs.push({ ref: 'refs/tags/archive', commit: foreign, owner: 'source' });
      if (side !== undefined) refs.push({ ref: 'refs/tags/side', commit: side, owner: 'source' });
      if (sourceTag && sharedAncestry) {
        const core = git(repo, 'rev-parse', `${imported}^1^`).trim();
        git(repo, 'update-ref', 'refs/tags/genie-core', core);
        refs.push({ ref: 'refs/tags/genie-core', commit: core, owner: 'source' });
      }
      writeFileSync(join(repo, 'ref-provenance.json'), JSON.stringify({ version: 1, refs }));
      const authority = commit(repo, 'record independent reference provenance');
      provenance = `${authority}:ref-provenance.json`;
    }
    return { provenance, split, foreign, side };
  }

  function expectGenieHistory(catalog: { names: string[]; descriptions: string[] }): void {
    expect(catalog.names).toEqual(['genie-branch', 'genie-nested', 'genie-retired', 'recorded-only']);
    expect(catalog.descriptions).toEqual([
      'Demo.',
      'Genie skill only an archived ref delivered.',
      'Historical Genie plugin skill.',
      'Historical Genie root skill.',
      'Recorded from an unavailable Genie ref.',
    ]);
  }

  test('tag-only retirement reaches the consumer, while unmerged work cannot grant it without Mikro imports', async () => {
    const { repo } = seedShippingOrigin();
    const recorded = { names: [], descriptions: [] };
    const merged = mergeCatalog(collectCatalog(repo), recorded, new Set(['kept']), new Set(['The kept skill.']));
    const verdict = evaluateCatalogCheck('// committed', '// regenerated', { merged, recorded });
    expect(verdict.stale).toBe(true);
    expect(verdict.missingNames).toEqual(['old']);
    expect(verdict.missingDescriptions).toEqual(['The old skill.']);
    expect(verdict.lines.join('\n')).toContain('1 name(s) and 1 description(s)');
    expect(verdict.lines.join('\n')).toContain('(old)');

    const { home, classify } = await consumerFor(repo);
    skill(home, 'old', 'The old skill.');
    skill(home, 'new', 'The new skill.');
    skill(home, 'kept', 'The kept skill.');
    expect(classify(home, 'old', ['kept'])?.kind).toBe('proven');
    expect(classify(home, 'new', ['kept'])).toBeNull();
    expect(classify(home, 'kept', ['kept'])).toBeNull();
  });

  test('exact origin/main, origin/dev and refs/archive/* ship; lookalike and unmerged refs do not', async () => {
    const { repo, base } = seedShippingOrigin();
    sideRef(repo, base, 'refs/remotes/origin/main', 'on-main');
    sideRef(repo, base, 'refs/remotes/origin/dev', 'on-dev');
    sideRef(repo, base, 'refs/archive/shelved', 'archived');
    sideRef(repo, base, 'refs/remotes/origin/dev-experiment', 'dev-lookalike');
    sideRef(repo, base, 'refs/remotes/origin/main-experiment', 'main-lookalike');
    sideRef(repo, base, 'refs/archives/shelved', 'archive-lookalike');
    expect([...collectCatalog(repo).keys()].sort()).toEqual(['archived', 'kept', 'old', 'on-dev', 'on-main']);

    const { home, classify } = await consumerFor(repo);
    for (const name of ['old', 'on-main', 'on-dev', 'archived']) {
      skill(home, name, `The ${name} skill.`);
      expect(classify(home, name, ['kept'])?.kind).toBe('proven');
    }
    for (const name of ['new', 'dev-lookalike', 'main-lookalike', 'archive-lookalike']) {
      skill(home, name, `The ${name} skill.`);
      expect(classify(home, name, ['kept'])).toBeNull();
    }
  });

  test('exact trusted Genie archive proof opts an unrecorded root outside shipped refs into real retirement', async () => {
    const repo = seedOrigin();
    git(repo, 'update-ref', '-d', 'refs/archive/genie-archive');
    const archive = git(repo, 'rev-parse', 'refs/heads/genie-archive').trim();
    const before = outputCatalog(repo);
    expect(before.names).not.toContain('genie-branch');
    expect(before.descriptions).not.toContain('Genie skill only an archived ref delivered.');

    writeFileSync(
      join(repo, 'ref-provenance.json'),
      JSON.stringify({
        version: 1,
        refs: [{ ref: 'refs/heads/genie-archive', commit: archive, owner: 'genie' }],
      }),
    );
    const authority = commit(repo, 'opt exact Genie archive into retirement history');
    const provenance = `${authority}:ref-provenance.json`;
    expect(collectCatalog(repo, provenance).get('genie-branch')).toEqual(
      new Set(['Genie skill only an archived ref delivered.']),
    );
    expectGenieHistory(outputCatalog(repo, provenance));

    const { home, classify } = await consumerFor(repo, provenance);
    skill(home, 'genie-branch', 'Genie skill only an archived ref delivered.');
    expect(classify(home, 'genie-branch', ['demo'])?.kind).toBe('proven');
    skill(home, 'genie-branch', 'A user-owned replacement description.');
    expect(classify(home, 'genie-branch', ['demo'])?.kind).toBe('unproven');
    expect(classify(home, 'genie-branch', ['genie-branch'])).toBeNull();

    const selfProof = runCheck(repo, '--ref-provenance', `${archive}:ref-provenance.json`);
    expect(selfProof.code).toBe(1);
    expect(selfProof.stdout).toBe('');
    expect(selfProof.stderr).toContain('not independently Genie-owned');
  });

  test('standalone history retains root, nested, shipped archive and recorded proof, but not current skills', () => {
    expectGenieHistory(outputCatalog(seedOrigin()));
  });

  test.each([false, true])(
    'foreign ancestry and prefixed integration trees are excluded (shared Genie ancestry: %s)',
    (shared) => {
      const repo = seedOrigin();
      const { provenance } = importMikro(repo, shared);
      // A later integration revision must not leak a new prefixed identity, even
      // when the same commit changes a Genie skill and is necessarily scanned.
      skill(repo, 'mikro/skills/foreign-later', 'Mikro skill added after import.');
      skill(repo, 'skills/demo', 'Demo, revised again.');
      commit(repo, 'revise both package trees');
      const catalog = outputCatalog(repo, provenance);
      expect(catalog.names).toEqual(['genie-branch', 'genie-nested', 'genie-retired', 'recorded-only']);
      expect(catalog.descriptions).toEqual([
        'Demo, revised.',
        'Demo.',
        'Genie skill only an archived ref delivered.',
        'Historical Genie plugin skill.',
        'Historical Genie root skill.',
        'Recorded from an unavailable Genie ref.',
      ]);
    },
  );

  test('trusted proof keeps shared Genie archives and core despite source roles', async () => {
    const repo = seedOrigin();
    const { provenance, split, foreign, side } = importMikro(repo, true, undefined, false, true);
    if (provenance === undefined || side === undefined)
      throw new Error('fixture requires provenance and an off-tip ref');
    const recordedBefore = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
    // Unknown roots refuse BEFORE output/write: neither silent loss of the
    // Genie archive nor untrusted source retirement authority is acceptable.
    const unknown = runCheck(repo);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('ambiguous history reference');
    const blockedWrite = runCheck(repo, '--write');
    expect(blockedWrite.code).toBe(1);
    expect(blockedWrite.stdout).toBe('');
    expect(blockedWrite.stderr).toContain('ambiguous history reference');
    expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recordedBefore);

    expectGenieHistory(outputCatalog(repo, provenance));
    const { home, classify } = await consumerFor(repo, provenance);
    skill(home, 'genie-branch', 'Genie skill only an archived ref delivered.');
    skill(home, 'genie-retired', 'Historical Genie root skill.');
    skill(home, 'foreign-ancestor', 'Mikro skill retired before import.');
    skill(home, 'foreign-nested', 'Mikro nested skill at import.');
    expect(classify(home, 'genie-branch', ['demo'])?.kind).toBe('proven');
    expect(classify(home, 'genie-retired', ['demo'])?.kind).toBe('proven');
    expect(classify(home, 'foreign-ancestor', ['demo'])).toBeNull();
    expect(classify(home, 'foreign-nested', ['demo'])).toBeNull();
    const once = runCheck(repo, '--ref-provenance', provenance);
    const again = runCheck(repo, '--ref-provenance', provenance);
    expect(again.code).toBe(0);
    expect(again.stderr).toBe('');
    expect(again.stdout).toBe(once.stdout);

    const authority = provenance.slice(0, 40);
    for (const [selector, error] of [
      [`${split}:ref-provenance.json`, 'not independently Genie-owned'],
      [`${side}:ref-provenance.json`, 'not independently Genie-owned'],
      [`${authority}:mikro/ref-provenance.json`, 'canonical non-Mikro root blob'],
      [`${authority}:missing-provenance.json`, 'does not exist'],
    ] as const) {
      const denied = runCheck(repo, '--write', '--ref-provenance', selector);
      expect(denied.code).toBe(1);
      expect(denied.stdout).toBe('');
      expect(denied.stderr).toContain(error);
      expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recordedBefore);
    }

    // The name alone cannot preserve an old ownership assertion after its tip moves.
    git(repo, 'update-ref', 'refs/heads/genie-archive', foreign);
    const stale = runCheck(repo, '--write', '--ref-provenance', provenance);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toBe('');
    expect(stale.stderr).toContain('stale or unknown reference provenance');
    expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recordedBefore);
  });

  test.each(['unknown owner', 'conflicting duplicate'] as const)(
    'refuses %s in trusted reference proof without granting partial authority',
    (kind) => {
      const repo = seedOrigin();
      const { foreign } = importMikro(repo, true, undefined, false, true);
      const entry = { ref: 'refs/tags/archive', commit: foreign, owner: 'genie' };
      const refs =
        kind === 'unknown owner' ? [{ ...entry, owner: 'unproven' }] : [entry, { ...entry, owner: 'source' }];
      writeFileSync(join(repo, 'bad-provenance.json'), JSON.stringify({ version: 1, refs }));
      const authority = commit(repo, 'record invalid provenance fixture');
      const run = runCheck(repo, '--ref-provenance', `${authority}:bad-provenance.json`);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain(
        kind === 'unknown owner' ? 'invalid reference provenance entry' : 'duplicate reference provenance entry',
      );
    },
  );

  test('an otherwise valid proof cannot silently omit a source-connected off-tip reference', () => {
    const repo = seedOrigin();
    const { foreign } = importMikro(repo, true, undefined, false, true);
    writeFileSync(
      join(repo, 'incomplete-provenance.json'),
      JSON.stringify({
        version: 1,
        refs: [
          {
            ref: 'refs/heads/genie-archive',
            commit: git(repo, 'rev-parse', 'refs/heads/genie-archive').trim(),
            owner: 'genie',
          },
          { ref: 'refs/tags/archive', commit: foreign, owner: 'source' },
        ],
      }),
    );
    const authority = commit(repo, 'record incomplete provenance fixture');
    const run = runCheck(repo, '--ref-provenance', `${authority}:incomplete-provenance.json`);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('ambiguous history reference refs/tags/side');
  });

  test('ref-provenance requires a value instead of treating a missing proof as ordinary history', () => {
    const run = runCheck(seedOrigin(), '--ref-provenance');
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('--ref-provenance requires one exact commit-bound');
  });

  test('nested foreign import metadata cannot erase shared Genie retirement proof', () => {
    const repo = seedOrigin();
    const shared = git(repo, 'rev-parse', 'HEAD^').trim();
    // The nested import's destination is genuinely foreign. Treating every
    // import's first parent as Genie-owned would wrongly retain this skill.
    git(repo, 'read-tree', '--empty');
    skill(repo, 'skills/foreign-parent', 'Mikro destination skill, never delivered by Genie.');
    git(repo, 'add', 'skills/foreign-parent');
    const foreignTree = git(repo, 'write-tree').trim();
    const foreignParent = git(repo, 'commit-tree', foreignTree, '-m', 'foreign destination').trim();
    rmSync(join(repo, 'skills', 'foreign-parent'), { recursive: true });
    const source = git(
      repo,
      'commit-tree',
      `${shared}^{tree}`,
      '-p',
      shared,
      '-m',
      'source from shared history',
    ).trim();
    git(repo, 'read-tree', '--prefix=mikro', `${source}^{tree}`);
    const nestedTree = git(repo, 'write-tree').trim();
    const nested = git(
      repo,
      'commit-tree',
      nestedTree,
      '-p',
      foreignParent,
      '-p',
      source,
      '-m',
      `Nested import\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: ${source}`,
    ).trim();
    git(repo, 'read-tree', 'HEAD');
    writeFileSync(
      join(repo, 'ref-provenance.json'),
      JSON.stringify({
        version: 1,
        refs: [
          {
            ref: 'refs/heads/genie-archive',
            commit: git(repo, 'rev-parse', 'refs/heads/genie-archive').trim(),
            owner: 'genie',
          },
        ],
      }),
    );
    const authority = commit(repo, 'record independent archived Genie reference');
    git(repo, 'read-tree', '--prefix=mikro', nestedTree);
    const outer = git(
      repo,
      'commit-tree',
      git(repo, 'write-tree').trim(),
      '-p',
      'HEAD',
      '-p',
      nested,
      '-m',
      `Outer import\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: ${nested}`,
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', outer);
    git(repo, 'update-ref', 'refs/heads/mikro-source', nested);
    expectGenieHistory(outputCatalog(repo, `${authority}:ref-provenance.json`));
  });

  test.each([
    ['malformed split', 'git-subtree-dir: mikro\n\ngit-subtree-split: --all'],
    ['duplicate split', 'git-subtree-dir: mikro\n\ngit-subtree-split: $SOURCE\n\ngit-subtree-split: $SOURCE'],
    ['duplicate directory', 'git-subtree-dir: mikro\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: $SOURCE'],
    ['noncanonical prefix', 'git-subtree-dir: mikro/\n\ngit-subtree-split: $SOURCE'],
    ['wrong source parent', `git-subtree-dir: mikro\n\ngit-subtree-split: ${'0'.repeat(40)}`],
  ])('refuses %s metadata instead of granting foreign ownership', (_label, metadata) => {
    const repo = seedOrigin();
    importMikro(repo, false, metadata);
    const run = runCheck(repo);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('invalid Mikro subtree import metadata');
  });

  test('refuses import metadata whose prefixed tree does not match the source', () => {
    const repo = seedOrigin();
    importMikro(repo, false, undefined, true);
    const run = runCheck(repo);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Mikro subtree import tree does not match its source');
  });

  test('a --depth 1 clone is refused with exit 1, before any history walk', () => {
    const origin = seedOrigin();
    const clone = mkdtempSync(join(tmpdir(), 'legacy-catalog-shallow-'));
    scratch.push(clone);
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, join(clone, 'repo')], { stdio: 'ignore' });

    const run = runCheck(join(clone, 'repo'), '--check');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('refusing --check on a shallow clone');
    expect(run.stderr).toContain('fetch-depth: 0');
  });

  test('the same generator on the full origin is not refused', () => {
    const origin = seedOrigin();
    // No mode: prints the rendered catalog, walking the real history. The
    // refusal is scoped to `--check`, so nothing here mentions it.
    const run = runCheck(origin);
    expect(run.stderr).not.toContain('shallow clone');
    expect(run.stdout).toContain('LEGACY_SKILL_NAMES');
  });
});

describe('recordedCatalog', () => {
  test('reads the committed catalog back, so a regeneration can only ever add to it', async () => {
    const recorded = await recordedCatalog();

    expect(recorded.names).toContain('pm');
    expect(recorded.descriptions).toContain(SHIPPED_PM_DESCRIPTION);
  });
});
