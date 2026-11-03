import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacySkillDigest } from '../src/lib/legacy-skill-digest.js';
import type { classifyLegacySkillEntry } from '../src/lib/legacy-skills.js';
import { catalogGenieCommits } from './git-history-ownership.js';
import {
  CATALOG_CHECK_GAP,
  collectCatalog,
  currentSkills,
  evaluateCatalogCheck,
  mergeCatalog,
  recordedCatalog,
  render,
} from './legacy-skills-catalog.js';

/** Render tests cover the additive union; isolated CLI histories below cover ownership collection. */
const ROOT = join(import.meta.dir, '..');

/** The catalog's form of plain names or descriptions: their digests, sorted as the generator sorts them. */
function digests(values: readonly string[]): string[] {
  return values.map(legacySkillDigest).sort();
}

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
    const rendered = render(new Map(), { names: digests(['pm']), descriptions: digests([SHIPPED_PM_DESCRIPTION]) });

    expect(rendered).toContain(JSON.stringify(legacySkillDigest('pm')));
    expect(rendered).toContain(JSON.stringify(legacySkillDigest(SHIPPED_PM_DESCRIPTION)));
  });

  test('history entries join the recorded ones rather than replacing them', () => {
    const collected = new Map<string, Set<string>>([
      ['from-history', new Set(['A description only git history knows.'])],
    ]);
    const rendered = render(collected, { names: digests(['pm']), descriptions: digests([SHIPPED_PM_DESCRIPTION]) });

    expect(rendered).toContain(JSON.stringify(legacySkillDigest('from-history')));
    expect(rendered).toContain(JSON.stringify(legacySkillDigest('A description only git history knows.')));
    expect(rendered).toContain(JSON.stringify(legacySkillDigest('pm')));
    expect(rendered).toContain(JSON.stringify(legacySkillDigest(SHIPPED_PM_DESCRIPTION)));
    // Digests only: the retired text itself never reaches the file.
    expect(rendered).not.toContain('from-history');
    expect(rendered).not.toContain('A description only git history knows.');
  });

  test('a collected-only entry needs no recorded catalog to appear', () => {
    const collected = new Map<string, Set<string>>([['solo', new Set(['Solo description.'])]]);
    const rendered = render(collected, { names: [], descriptions: [] });

    expect(rendered).toContain(JSON.stringify(legacySkillDigest('solo')));
    expect(rendered).toContain(JSON.stringify(legacySkillDigest('Solo description.')));
  });

  test('only currently shipped names and descriptions are subtracted, from either source', () => {
    const shipped = aShippedSkill();
    const collected = new Map<string, Set<string>>([[shipped.name, new Set([shipped.description])]]);
    const recorded = { names: digests([shipped.name]), descriptions: digests([shipped.description]) };
    const rendered = render(collected, recorded);

    expect(rendered).not.toContain(legacySkillDigest(shipped.name));
    expect(rendered).not.toContain(legacySkillDigest(shipped.description));
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
    const verdict = verdictFor({ names: digests(['pm']), descriptions: digests([SHIPPED_PM_DESCRIPTION]) });

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
      names: digests(['pm', 'never-shipped-by-any-ref']),
      descriptions: digests([SHIPPED_PM_DESCRIPTION, 'A description no commit ever carried.']),
    });

    expect(verdict.stale).toBe(false);
    expect(verdict.lines.join('\n')).toContain(CATALOG_CHECK_GAP);
  });

  test('a text-only difference is stale with no missing entry, and says so', () => {
    const recorded = { names: digests(['pm']), descriptions: digests([SHIPPED_PM_DESCRIPTION]) };
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
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'lib', 'legacy-skill-digest.ts'),
      readFileSync(join(ROOT, 'src', 'lib', 'legacy-skill-digest.ts'), 'utf8'),
    );
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    return dir;
  }

  const RECORDED_ONLY_DESCRIPTION = 'Recorded from an unavailable Genie ref.';

  /** A minimal repo carrying both collector sources, with history a shallow clone truncates. */
  function seedOrigin(): string {
    const dir = seedRepo('legacy-catalog-origin-');
    skill(dir, 'skills/demo', 'Demo.');
    skill(dir, 'skills/genie-retired', 'Historical Genie root skill.');
    skill(dir, 'plugins/genie/skills/genie-nested', 'Historical Genie plugin skill.');
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'lib', 'legacy-skills-catalog.ts'),
      `export const LEGACY_SKILL_NAME_DIGESTS = ${JSON.stringify(digests(['recorded-only']))};\n` +
        `export const LEGACY_SKILL_DESCRIPTION_DIGESTS = ${JSON.stringify(digests([RECORDED_ONLY_DESCRIPTION]))};\n`,
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

  /** `retired`: the skill is added, then removed, so the ref's history carries it and its tip does not. */
  function sideRef(repo: string, base: string, ref: string, name: string, retired = false): string {
    git(repo, 'checkout', '-q', '--detach', base);
    skill(repo, `skills/${name}`, `The ${name} skill.`);
    let tip = commit(repo, `add ${name}`);
    if (retired) {
      rmSync(join(repo, 'skills', name), { recursive: true });
      tip = commit(repo, `retire ${name}`);
    }
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

  function anchorWarning(root: string): string {
    return `legacy-skills-catalog: trusting operator anchor ${root} and ALL ordinary-parent ancestors; a broad/wrong anchor trusts broad/wrong history\n`;
  }

  function outputCatalog(
    repo: string,
    provenance?: string,
    trustedRoot?: string,
  ): { names: string[]; descriptions: string[] } {
    const run = runCheck(
      repo,
      ...(provenance === undefined ? [] : ['--ref-provenance', provenance]),
      ...(trustedRoot === undefined ? [] : ['--trusted-genie-root', trustedRoot]),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe(trustedRoot === undefined ? '' : anchorWarning(trustedRoot));
    const names = /LEGACY_SKILL_NAME_DIGESTS: readonly string\[\] = (\[[\s\S]*?\]);/.exec(run.stdout);
    const descriptions = /LEGACY_SKILL_DESCRIPTION_DIGESTS: readonly string\[\] = (\[[\s\S]*?\]);/.exec(run.stdout);
    expect(names).not.toBeNull();
    expect(descriptions).not.toBeNull();
    return {
      names: JSON.parse((names?.[1] ?? '').replace(/,\s*\]$/, ']')),
      descriptions: JSON.parse((descriptions?.[1] ?? '').replace(/,\s*\]$/, ']')),
    };
  }

  /** Runtime-selected module: a static import would read the root catalog, not this CLI's output. */
  async function consumerFor(
    repo: string,
    provenance?: string,
    trustedRoot?: string,
  ): Promise<{
    home: string;
    classify: typeof classifyLegacySkillEntry;
  }> {
    const run = runCheck(
      repo,
      ...(provenance === undefined ? [] : ['--ref-provenance', provenance]),
      ...(trustedRoot === undefined ? [] : ['--trusted-genie-root', trustedRoot]),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe(trustedRoot === undefined ? '' : anchorWarning(trustedRoot));
    const dir = mkdtempSync(join(tmpdir(), 'legacy-catalog-consumer-'));
    scratch.push(dir);
    for (const file of ['legacy-skills.ts', 'skills-agents.ts', 'legacy-skill-digest.ts']) {
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

  const GENIE_HISTORY_NAMES = ['genie-branch', 'genie-nested', 'genie-retired', 'recorded-only'];
  const GENIE_HISTORY_DESCRIPTIONS = [
    'Demo.',
    'Genie skill only an archived ref delivered.',
    'Historical Genie plugin skill.',
    'Historical Genie root skill.',
    'Recorded from an unavailable Genie ref.',
  ];

  function expectGenieHistory(catalog: { names: string[]; descriptions: string[] }): void {
    expect(catalog.names).toEqual(digests(GENIE_HISTORY_NAMES));
    expect(catalog.descriptions).toEqual(digests(GENIE_HISTORY_DESCRIPTIONS));
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
    // Retired at the tip: a skill a release branch still ships is current, never retired (#3141).
    sideRef(repo, base, 'refs/remotes/origin/main', 'on-main', true);
    sideRef(repo, base, 'refs/remotes/origin/dev', 'on-dev', true);
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

  test('skill live on origin/dev, missing in HEAD is not reported retired', async () => {
    const { repo, base } = seedShippingOrigin();
    // `live` ships on the tip of origin/dev but HEAD (main) never carried it;
    // `old` is in shipped tag history and on no current tree, so it stays retired.
    sideRef(repo, base, 'refs/remotes/origin/dev', 'live');
    expect(git(repo, 'ls-tree', '--name-only', 'HEAD', 'skills/').trim().split('\n')).toEqual(['skills/kept']);
    const current = currentSkills(repo);
    expect([...current.names].sort()).toEqual(['kept', 'live']);
    expect([...current.descriptions].sort()).toEqual(['The kept skill.', 'The live skill.']);

    const catalog = outputCatalog(repo);
    expect(catalog.names).toEqual(digests(['old']));
    expect(catalog.descriptions).toEqual(digests(['The old skill.']));

    const { home, classify } = await consumerFor(repo);
    skill(home, 'live', 'The live skill.');
    skill(home, 'old', 'The old skill.');
    expect(classify(home, 'live', ['kept'])).toBeNull();
    expect(classify(home, 'old', ['kept'])?.kind).toBe('proven');
  });

  test('a descendant of an exact release-branch name is neither current nor retirement history', async () => {
    const { repo, base } = seedShippingOrigin();
    // origin/dev itself is absent, so its descendant can exist beside it.
    sideRef(repo, base, 'refs/remotes/origin/dev/live-under-dev', 'under-dev');
    sideRef(repo, base, 'refs/remotes/origin/main/retired-under-main', 'under-main', true);
    expect(
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/dev', 'refs/remotes/origin/main'),
    ).toBe('refs/remotes/origin/dev/live-under-dev\nrefs/remotes/origin/main/retired-under-main\n');
    const current = currentSkills(repo);
    expect([...current.names]).toEqual(['kept']);
    expect([...current.descriptions]).toEqual(['The kept skill.']);
    expect([...collectCatalog(repo).keys()].sort()).toEqual(['kept', 'old']);

    const catalog = outputCatalog(repo);
    expect(catalog.names).toEqual(digests(['old']));
    expect(catalog.descriptions).toEqual(digests(['The old skill.']));

    const { home, classify } = await consumerFor(repo);
    for (const name of ['under-dev', 'under-main']) {
      skill(home, name, `The ${name} skill.`);
      expect(classify(home, name, ['kept'])).toBeNull();
    }
  });

  test('exact trusted Genie archive proof opts an unrecorded root outside shipped refs into real retirement', async () => {
    const repo = seedOrigin();
    git(repo, 'update-ref', '-d', 'refs/archive/genie-archive');
    const archive = git(repo, 'rev-parse', 'refs/heads/genie-archive').trim();
    const before = outputCatalog(repo);
    expect(before.names).not.toContain(legacySkillDigest('genie-branch'));
    expect(before.descriptions).not.toContain(legacySkillDigest('Genie skill only an archived ref delivered.'));

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
      const catalog = outputCatalog(repo, provenance, shared ? provenance?.slice(0, 40) : undefined);
      expect(catalog.names).toEqual(digests(GENIE_HISTORY_NAMES));
      expect(catalog.descriptions).toEqual(digests(['Demo, revised.', ...GENIE_HISTORY_DESCRIPTIONS]));
    },
  );

  test.each([
    [false, 'tip', false],
    [false, 'ancestor', false],
    [false, 'descendant', false],
    [true, 'tip', false],
    [true, 'ancestor', false],
    [true, 'descendant', false],
    [false, 'tip', true],
    [false, 'ancestor', true],
    [false, 'descendant', true],
    [true, 'tip', true],
    [true, 'ancestor', true],
    [true, 'descendant', true],
  ] as const)('declared-source oracle: shared=%s crossing=%s reverseRoles=%s', (shared, crossing, reverse) => {
    const repo = seedRepo('catalog-declared-oracle-');
    skill(repo, 'skills/kept', 'Current genuine Genie skill.');
    skill(repo, 'skills/genuine-retired', 'Independent genuine Genie retirement sentinel.');
    commit(repo, 'independent Genie root');
    const source = mkdtempSync(join(tmpdir(), 'catalog-declared-source-'));
    scratch.push(source);
    if (shared) git(source, 'clone', '-q', repo, '.');
    else git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'core.hooksPath', '/dev/null');
    git(source, 'config', 'commit.gpgsign', 'false');
    skill(source, 'skills/foreign-root', 'Known foreign root sentinel.');
    skill(source, 'plugins/foreign/skills/foreign-nested', 'Known foreign nested sentinel.');
    const ancestor = commit(source, 'foreign ancestor');
    writeFileSync(join(source, 'tip'), 'source tip');
    const tip = commit(source, 'foreign source tip');
    writeFileSync(join(source, 'descendant'), 'source descendant');
    const descendant = commit(source, 'foreign descendant');
    const ref = 'refs/remotes/source/main';
    git(repo, 'fetch', '-q', source, `${tip}:${ref}`);
    git(repo, 'fetch', '-q', source, `${ancestor}:refs/tags/source-ancestor`);
    git(repo, 'fetch', '-q', source, descendant);
    const roles = [
      { ref, commit: tip, owner: 'source' },
      { ref: 'refs/tags/source-ancestor', commit: ancestor, owner: 'source' },
    ];
    writeFileSync(join(repo, 'proof.json'), JSON.stringify({ version: 1, refs: reverse ? roles.reverse() : roles }));
    writeFileSync(
      join(repo, 'src/lib/legacy-skills-catalog.ts'),
      'export const LEGACY_SKILL_NAME_DIGESTS = [];\nexport const LEGACY_SKILL_DESCRIPTION_DIGESTS = [];\n',
    );
    rmSync(join(repo, 'skills/genuine-retired'), { recursive: true });
    const anchor = commit(repo, 'safe premerge exact source proof');
    const proof = `${anchor}:proof.json`;
    expect([...collectCatalog(repo, proof, anchor).keys()].sort()).toEqual(['genuine-retired', 'kept']);
    expect(outputCatalog(repo, proof, anchor)).toEqual({
      names: digests(['genuine-retired']),
      descriptions: digests(['Independent genuine Genie retirement sentinel.']),
    });
    if (shared) {
      const ambiguous = runCheck(repo, '--ref-provenance', proof);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stdout).toBe('');
      expect(ambiguous.stderr).toContain('--trusted-genie-root');
    } else expect([...collectCatalog(repo, proof).keys()].sort()).toEqual(['genuine-retired', 'kept']);
    const sourceParent = crossing === 'tip' ? tip : crossing === 'ancestor' ? ancestor : descendant;
    const mixed = git(
      repo,
      'commit-tree',
      `${anchor}^{tree}`,
      '-p',
      anchor,
      '-p',
      sourceParent,
      '-m',
      'ordinary source crossing',
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', mixed);
    const before = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
    expect(() => collectCatalog(repo, proof, anchor)).toThrow('source-crossing HEAD history');
    const denied = runCheck(repo, '--trusted-genie-root', anchor, '--ref-provenance', proof, '--write');
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('source-crossing HEAD history');
    expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(before);
  });

  test('source-carried import metadata cannot bootstrap a declared-source core', () => {
    const repo = seedOrigin();
    const source = seedRepo('catalog-source-metadata-');
    skill(source, 'skills/foreign-root', 'Foreign root imported metadata sentinel.');
    skill(source, 'plugins/foreign/skills/foreign-nested', 'Foreign nested imported metadata sentinel.');
    writeFileSync(join(source, 'proof.json'), JSON.stringify({ version: 1, refs: [] }));
    const y = commit(source, 'foreign root Y');
    writeFileSync(join(source, 'child'), 'foreign C');
    const c = commit(source, 'foreign C');
    writeFileSync(join(source, 'split'), 'foreign Si');
    const split = commit(source, 'foreign split Si');
    const ref = 'refs/remotes/source/Y';
    git(repo, 'fetch', '-q', source, `${y}:${ref}`);
    git(repo, 'fetch', '-q', source, split);
    writeFileSync(
      join(repo, 'proof.json'),
      JSON.stringify({ version: 1, refs: [{ ref, commit: y, owner: 'source' }] }),
    );
    const d = commit(repo, 'independent safe D source proof');
    expectGenieHistory(outputCatalog(repo, `${d}:proof.json`, d));
    git(repo, 'read-tree', `${c}^{tree}`);
    git(repo, 'read-tree', '--prefix=mikro/', `${split}^{tree}`);
    const imported = git(
      repo,
      'commit-tree',
      git(repo, 'write-tree').trim(),
      '-p',
      c,
      '-p',
      split,
      '-m',
      `Source-carried import\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: ${split}`,
    ).trim();
    const mixed = git(repo, 'commit-tree', `${d}^{tree}`, '-p', d, '-p', imported, '-m', 'mixed HEAD').trim();
    git(repo, 'update-ref', 'refs/heads/main', mixed);
    const before = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
    for (const anchor of [undefined, d]) {
      expect(() => collectCatalog(repo, `${d}:proof.json`, anchor)).toThrow('source-crossing HEAD history');
      for (const selector of [`${y}:proof.json`, `${c}:proof.json`, `${mixed}:proof.json`]) {
        const run = runCheck(
          repo,
          '--write',
          '--ref-provenance',
          selector,
          ...(anchor === undefined ? [] : ['--trusted-genie-root', anchor]),
        );
        expect(run.code).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.stderr).toContain('not independently Genie-owned');
        expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(before);
      }
    }
  });

  test('anchor closure includes ordinary side parents but never authenticates clean descendants', () => {
    const repo = seedOrigin();
    const archived = git(repo, 'rev-parse', 'refs/heads/genie-archive').trim();
    const anchor = git(
      repo,
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      'HEAD',
      '-p',
      archived,
      '-m',
      'reviewed ordinary merge',
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', anchor);
    const { provenance } = importMikro(repo, true);
    if (provenance === undefined) throw new Error('fixture requires descendant proof');
    expectGenieHistory(outputCatalog(repo, undefined, anchor));
    const denied = runCheck(repo, '--write', '--trusted-genie-root', anchor, '--ref-provenance', provenance);
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('not independently Genie-owned');
    expectGenieHistory(outputCatalog(repo, provenance, provenance.slice(0, 40)));
  });

  test('anchor CLI validates all flags before writes and supports mode/option ordering idempotently', () => {
    const repo = seedOrigin();
    const anchor = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'tag', '-a', 'anchor-tag', '-m', 'annotated tag', anchor);
    const tag = git(repo, 'rev-parse', 'refs/tags/anchor-tag').trim();
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
    const blob = git(repo, 'rev-parse', 'HEAD:scripts/legacy-skills-catalog.ts').trim();
    const offHead = git(repo, 'rev-parse', 'refs/heads/genie-archive').trim();
    const before = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
    const invalid = [
      [],
      ['HEAD'],
      [anchor.slice(0, 12)],
      [anchor.toUpperCase()],
      ['f'.repeat(40)],
      [tag],
      [tree],
      [blob],
      [offHead],
      [anchor, '--trusted-genie-root', anchor],
      [anchor, '--check', '--check'],
      [anchor, '--check', '--write'],
      [anchor, '--unknown'],
      [anchor, '--ref-provenance'],
      [anchor, '--ref-provenance', `${anchor}:x`, '--ref-provenance', `${anchor}:x`],
    ];
    for (const values of invalid) {
      const denied = runCheck(repo, '--write', '--trusted-genie-root', ...values);
      expect(denied.code).toBe(1);
      expect(denied.stdout).toBe('');
      expect(denied.stderr.length).toBeGreaterThan(0);
      expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(before);
    }
    const wrote = runCheck(repo, '--trusted-genie-root', anchor, '--write');
    expect(wrote.code).toBe(0);
    expect(wrote.stdout).toContain('legacy-skills-catalog: wrote');
    expect(wrote.stderr).toBe(anchorWarning(anchor));
    const bytes = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
    const check = runCheck(repo, '--trusted-genie-root', anchor, '--check');
    expect(check.code).toBe(0);
    expect(check.stdout).toContain('legacy-skills-catalog: current');
    expect(check.stderr).toBe(anchorWarning(anchor));
    const twice = runCheck(repo, '--write', '--trusted-genie-root', anchor);
    expect(twice.code).toBe(0);
    expect(twice.stderr).toBe(anchorWarning(anchor));
    expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(bytes);
  });

  test.each([
    ['split', false],
    ['split', true],
    ['ancestor', false],
    ['ancestor', true],
  ] as const)(
    'catalog refuses ordinary source-crossing HEAD (%s, descendant: %s) before retirement/write',
    (source, descendant) => {
      const repo = seedOrigin();
      const { split, foreign } = importMikro(repo, false);
      expectGenieHistory(outputCatalog(repo));
      const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
      const merge = git(
        repo,
        'commit-tree',
        tree,
        '-p',
        'HEAD',
        '-p',
        source === 'split' ? split : foreign,
        '-m',
        'ordinary source crossing',
      ).trim();
      const head = descendant
        ? git(repo, 'commit-tree', tree, '-p', merge, '-m', 'after source crossing').trim()
        : merge;
      git(repo, 'update-ref', 'refs/heads/main', head);
      // These identities exist at source root/nested paths, not just under mikro/.
      expect(git(repo, 'show', `${foreign}:skills/foreign-ancestor/SKILL.md`)).toContain(
        'Mikro skill retired before import.',
      );
      expect(git(repo, 'show', `${split}:plugins/claude-code/skills/foreign-nested/SKILL.md`)).toContain(
        'Mikro nested skill at import.',
      );
      expect(() => collectCatalog(repo)).toThrow('source-crossing HEAD history');
      const recorded = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
      for (const args of [[], ['--write']]) {
        const run = runCheck(repo, ...args);
        expect(run.code).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.stderr).toContain('source-crossing HEAD history');
        expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recorded);
      }
    },
  );

  test.each([false, true])(
    'source-crossing HEAD cannot authenticate source-carried proof (descendant: %s)',
    (descendant) => {
      const repo = seedOrigin();
      const { split, provenance } = importMikro(repo, false, undefined, false, true);
      const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
      const merge = git(repo, 'commit-tree', tree, '-p', 'HEAD', '-p', split, '-m', 'source proof bootstrap').trim();
      const head = descendant ? git(repo, 'commit-tree', tree, '-p', merge, '-m', 'after bootstrap').trim() : merge;
      git(repo, 'update-ref', 'refs/heads/main', head);
      const recorded = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
      for (const selector of [`${split}:ref-provenance.json`, `${head}:ref-provenance.json`, provenance]) {
        if (selector === undefined) throw new Error('fixture requires trusted provenance');
        const run = runCheck(repo, '--write', '--ref-provenance', selector);
        expect(run.code).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.stderr).toMatch(/source-crossing HEAD history|not independently Genie-owned/);
        expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recorded);
      }
    },
  );

  test.each([false, true])('multiple validated imports preserve shared Genie ownership (shared: %s)', (shared) => {
    const repo = seedOrigin();
    const { split, provenance } = importMikro(repo, shared);
    const trustedRoot = shared ? provenance?.slice(0, 40) : undefined;
    const before = outputCatalog(repo, provenance, trustedRoot);
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
    const imported = git(
      repo,
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-p',
      split,
      '-m',
      `Repeat validated import\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: ${split}`,
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', imported);
    expect(outputCatalog(repo, provenance, trustedRoot)).toEqual(before);
  });

  test('safe pre-merge proof can justify a shared-source Genie archive, but the archive cannot prove itself', () => {
    const repo = seedOrigin();
    const { provenance } = importMikro(repo, true);
    if (provenance === undefined) throw new Error('fixture requires trusted archive proof');
    const trustedRoot = provenance.slice(0, 40);
    expect(runCheck(repo, '--ref-provenance', provenance).stderr).toContain('--trusted-genie-root');
    const before = outputCatalog(repo, provenance, trustedRoot);
    const archive = git(repo, 'rev-parse', 'refs/heads/genie-archive').trim();
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
    const merge = git(
      repo,
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-p',
      archive,
      '-m',
      'merge independently proven archive',
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', merge);
    expect(outputCatalog(repo, provenance, trustedRoot)).toEqual(before);
    for (const authority of [archive, merge]) {
      const run = runCheck(
        repo,
        '--trusted-genie-root',
        trustedRoot,
        '--ref-provenance',
        `${authority}:ref-provenance.json`,
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('not independently Genie-owned');
    }
  });

  test('an off-HEAD validated import cannot taint legitimate current-HEAD proof authority', () => {
    const repo = seedRepo('legacy-catalog-off-head-import-');
    skill(repo, 'skills/kept', 'Legitimate Genie skill.');
    const base = commit(repo, 'Genie root');
    skill(repo, 'skills/head-only', 'Legitimate newer Genie skill.');
    commit(repo, 'legitimate Genie HEAD');
    const split = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'source fork of newer Genie').trim();
    git(repo, 'read-tree', '--prefix=mikro/', `${split}^{tree}`);
    const imported = git(
      repo,
      'commit-tree',
      git(repo, 'write-tree').trim(),
      '-p',
      base,
      '-p',
      split,
      '-m',
      `Off-HEAD import\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: ${split}`,
    ).trim();
    const ref = 'refs/remotes/origin/off-head-import';
    git(repo, 'update-ref', ref, imported);
    writeFileSync(
      join(repo, 'ref-provenance.json'),
      JSON.stringify({ version: 1, refs: [{ ref, commit: imported, owner: 'source' }] }),
    );
    const authority = commit(repo, 'independent HEAD proof for off-head source ref');
    const unanchored = runCheck(repo, '--ref-provenance', `${authority}:ref-provenance.json`);
    expect(unanchored.code).toBe(1);
    expect(unanchored.stdout).toBe('');
    expect(unanchored.stderr).toContain('--trusted-genie-root');
    expect(outputCatalog(repo, `${authority}:ref-provenance.json`, authority)).toEqual({ names: [], descriptions: [] });
  });

  test('a later validated import cannot launder an older ordinary source crossing', () => {
    const repo = seedOrigin();
    const { split } = importMikro(repo, false);
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
    const mixed = git(repo, 'commit-tree', tree, '-p', 'HEAD', '-p', split, '-m', 'ordinary source crossing').trim();
    const imported = git(
      repo,
      'commit-tree',
      tree,
      '-p',
      mixed,
      '-p',
      split,
      '-m',
      `Later import\n\ngit-subtree-dir: mikro\n\ngit-subtree-split: ${split}`,
    ).trim();
    git(repo, 'update-ref', 'refs/heads/main', imported);
    expect(() => collectCatalog(repo)).toThrow('source-crossing HEAD history');
  });

  test('an unmerged branch that merges Mikro source does not make the shipped refs ambiguous', () => {
    const repo = seedOrigin();
    const { split } = importMikro(repo, false);
    // A subtree-pull PR branch: source history merged into a Genie commit without the
    // validated import metadata. It grants no authority, but it must not mark the whole
    // Genie history source-connected - that failed every other PR's CI (#3201, #3203).
    skill(repo, 'skills/never-shipped', 'Mixed branch skill never delivered.');
    git(repo, 'add', '-A');
    const tree = git(repo, 'write-tree').trim();
    const merge = git(repo, 'commit-tree', tree, '-p', 'HEAD', '-p', split, '-m', 'pull the Mikro subtree').trim();
    const descendant = git(repo, 'commit-tree', tree, '-p', merge, '-m', 'continue mixed branch').trim();
    git(repo, 'update-ref', 'refs/remotes/origin/pull-mikro-subtree', merge);
    git(repo, 'update-ref', 'refs/remotes/origin/pull-mikro-descendant', descendant);

    expectGenieHistory(outputCatalog(repo));
    // A shipped mixed tip cannot silently lose required retirement history.
    git(repo, 'tag', 'mixed-release', descendant);
    const refused = runCheck(repo);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('ambiguous shipped mixed history');
  });

  test.each([
    'refs/tags/shipped-side',
    'refs/archive/shipped-side',
    'refs/remotes/origin/dev',
    'refs/remotes/origin/main',
  ])('a divergent shipped lineage witnesses an unshipped mixed branch without changing the catalog (%s)', (ref) => {
    const repo = seedOrigin();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const side = sideRef(repo, base, ref, 'shipped-side', true);
    const { split } = importMikro(repo, false);
    const before = outputCatalog(repo);
    expect(before.names).toContain(legacySkillDigest('shipped-side'));
    skill(repo, 'skills/mixed-only', 'Unshipped mixed branch identity.');
    git(repo, 'add', '-A');
    const tree = git(repo, 'write-tree').trim();
    const merge = git(
      repo,
      'commit-tree',
      tree,
      '-p',
      side,
      '-p',
      split,
      '-m',
      'mix divergent shipped and source',
    ).trim();
    const descendant = git(repo, 'commit-tree', tree, '-p', merge, '-m', 'continue mixed branch').trim();
    git(repo, 'update-ref', 'refs/remotes/origin/mixed-shipped-side', merge);
    git(repo, 'update-ref', 'refs/remotes/origin/mixed-shipped-descendant', descendant);
    expect(outputCatalog(repo)).toEqual(before);
  });

  test.each([
    'refs/tags/shared-source-side',
    'refs/archive/shared-source-side',
    'refs/remotes/origin/dev',
    'refs/remotes/origin/main',
  ])('a source-connected selected root cannot bootstrap a boundary witness (%s)', (ref) => {
    const repo = seedOrigin();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const side = sideRef(repo, base, ref, 'shared-source-side', true);
    const { split, provenance } = importMikro(repo, true);
    if (provenance === undefined) throw new Error('shared source fixture requires archive provenance');
    const before = runCheck(repo, '--trusted-genie-root', provenance.slice(0, 40), '--ref-provenance', provenance);
    expect(before.code).toBe(1);
    expect(before.stdout).toBe('');
    expect(before.stderr).toContain(`ambiguous history reference ${ref}`);
    const merge = git(
      repo,
      'commit-tree',
      `${side}^{tree}`,
      '-p',
      side,
      '-p',
      split,
      '-m',
      'shared source merge',
    ).trim();
    git(repo, 'update-ref', 'refs/remotes/origin/shared-source-mixed', merge);
    const after = runCheck(repo, '--trusted-genie-root', provenance.slice(0, 40), '--ref-provenance', provenance);
    expect(after.code).toBe(1);
    expect(after.stdout).toBe('');
    expect(after.stderr).toContain('ambiguous history reference');
  });

  test('an arbitrary unshipped divergent lineage cannot witness a mixed boundary', () => {
    const repo = seedOrigin();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const side = sideRef(repo, base, 'refs/remotes/origin/unshipped-side', 'unshipped-side', true);
    const { split } = importMikro(repo, false);
    expectGenieHistory(outputCatalog(repo));
    const merge = git(
      repo,
      'commit-tree',
      `${side}^{tree}`,
      '-p',
      side,
      '-p',
      split,
      '-m',
      'unproved mixed branch',
    ).trim();
    git(repo, 'update-ref', 'refs/remotes/origin/unproved-mixed', merge);
    const refused = runCheck(repo);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('ambiguous history reference refs/remotes/origin/unproved-mixed');
  });

  test.each([false, true])('reconvergent source closure is independent of sibling row order (swap: %s)', (swap) => {
    const repo = seedOrigin();
    const { split } = importMikro(repo, false);
    const tree = `${split}^{tree}`;
    const x = git(repo, 'commit-tree', tree, '-p', split, '-m', 'source X').trim();
    const y = git(repo, 'commit-tree', tree, '-p', split, '-m', 'source Y').trim();
    const z = git(repo, 'commit-tree', tree, '-p', x, '-m', 'source Z').trim();
    const merge = git(repo, 'commit-tree', tree, '-p', z, '-p', y, '-m', 'source reconvergence').trim();
    const ref = 'refs/remotes/origin/unknown-source';
    git(repo, 'update-ref', ref, merge);
    const readGit = (...args: string[]) => {
      const result = git(repo, ...args);
      if (args[0] !== 'rev-list' || args[1] !== '--parents') return result;
      const rows = result.trim().split('\n');
      const siblings = rows.filter((row) => row.startsWith(x) || row.startsWith(y));
      const rest = rows.filter((row) => !row.startsWith(x) && !row.startsWith(y));
      return [...rest, ...(swap ? siblings.reverse() : siblings)].join('\n');
    };
    expect(() => catalogGenieCommits(readGit, ['--all'], ['HEAD', '--tags', '--glob=refs/archive/*'])).toThrow(
      `ambiguous history reference ${ref}`,
    );
    writeFileSync(
      join(repo, 'ref-provenance.json'),
      JSON.stringify({
        version: 1,
        refs: [{ ref, commit: merge, owner: 'source' }],
      }),
    );
    const authority = commit(repo, 'prove exact source reconvergence');
    const owned = catalogGenieCommits(readGit, ['--all'], ['HEAD'], `${authority}:ref-provenance.json`);
    for (const source of [split, x, y, z, merge]) expect(owned.has(source)).toBe(false);
    expectGenieHistory(outputCatalog(repo, `${authority}:ref-provenance.json`));
  });

  test.each([false, true])('a foreign/source mixed descendant needs proof (shipped tag: %s)', (shipped) => {
    const repo = seedOrigin();
    const { split } = importMikro(repo, false);
    const tree = `${split}^{tree}`;
    const foreign = git(repo, 'commit-tree', tree, '-m', 'unrelated foreign root').trim();
    const merge = git(repo, 'commit-tree', tree, '-p', foreign, '-p', split, '-m', 'foreign mixed merge').trim();
    const descendant = git(repo, 'commit-tree', tree, '-p', merge, '-m', 'foreign mixed descendant').trim();
    const ref = shipped ? 'refs/tags/foreign-mixed' : 'refs/remotes/origin/foreign-mixed';
    git(repo, 'update-ref', ref, descendant);
    const refused = runCheck(repo);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain(
      shipped ? 'ambiguous shipped mixed history' : `ambiguous history reference ${ref}`,
    );
    writeFileSync(
      join(repo, 'ref-provenance.json'),
      JSON.stringify({
        version: 1,
        refs: [{ ref, commit: descendant, owner: 'source' }],
      }),
    );
    const authority = commit(repo, 'exclude exact foreign mixed source');
    expectGenieHistory(outputCatalog(repo, `${authority}:ref-provenance.json`));
  });

  test('trusted proof keeps shared Genie archives and core despite source roles', async () => {
    const repo = seedOrigin();
    const { provenance, split, foreign, side } = importMikro(repo, true, undefined, false, true);
    if (provenance === undefined || side === undefined)
      throw new Error('fixture requires provenance and an off-tip ref');
    const trustedRoot = provenance.slice(0, 40);
    const unanchored = runCheck(repo, '--ref-provenance', provenance);
    expect(unanchored.code).toBe(1);
    expect(unanchored.stdout).toBe('');
    expect(unanchored.stderr).toContain('--trusted-genie-root');
    const recordedBefore = readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8');
    // Unknown roots refuse BEFORE output/write: neither silent loss of the
    // Genie archive nor untrusted source retirement authority is acceptable.
    const unknown = runCheck(repo, '--trusted-genie-root', trustedRoot);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('ambiguous history reference');
    const blockedWrite = runCheck(repo, '--write', '--trusted-genie-root', trustedRoot);
    expect(blockedWrite.code).toBe(1);
    expect(blockedWrite.stdout).toBe('');
    expect(blockedWrite.stderr).toContain('ambiguous history reference');
    expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recordedBefore);

    expectGenieHistory(outputCatalog(repo, provenance, trustedRoot));
    const { home, classify } = await consumerFor(repo, provenance, trustedRoot);
    skill(home, 'genie-branch', 'Genie skill only an archived ref delivered.');
    skill(home, 'genie-retired', 'Historical Genie root skill.');
    skill(home, 'foreign-ancestor', 'Mikro skill retired before import.');
    skill(home, 'foreign-nested', 'Mikro nested skill at import.');
    expect(classify(home, 'genie-branch', ['demo'])?.kind).toBe('proven');
    expect(classify(home, 'genie-retired', ['demo'])?.kind).toBe('proven');
    expect(classify(home, 'foreign-ancestor', ['demo'])).toBeNull();
    expect(classify(home, 'foreign-nested', ['demo'])).toBeNull();
    const once = runCheck(repo, '--ref-provenance', provenance, '--trusted-genie-root', trustedRoot);
    const again = runCheck(repo, '--trusted-genie-root', trustedRoot, '--ref-provenance', provenance);
    expect(again.code).toBe(0);
    expect(again.stderr).toBe(anchorWarning(trustedRoot));
    expect(again.stdout).toBe(once.stdout);

    const authority = provenance.slice(0, 40);
    for (const [selector, error] of [
      [`${split}:ref-provenance.json`, 'not independently Genie-owned'],
      [`${side}:ref-provenance.json`, 'not independently Genie-owned'],
      [`${authority}:mikro/ref-provenance.json`, 'canonical non-Mikro root blob'],
      [`${authority}:missing-provenance.json`, 'does not exist'],
    ] as const) {
      const denied = runCheck(repo, '--write', '--trusted-genie-root', trustedRoot, '--ref-provenance', selector);
      expect(denied.code).toBe(1);
      expect(denied.stdout).toBe('');
      expect(denied.stderr).toContain(error);
      expect(readFileSync(join(repo, 'src/lib/legacy-skills-catalog.ts'), 'utf8')).toBe(recordedBefore);
    }

    // The name alone cannot preserve an old ownership assertion after its tip moves.
    git(repo, 'update-ref', 'refs/heads/genie-archive', foreign);
    const stale = runCheck(repo, '--write', '--trusted-genie-root', trustedRoot, '--ref-provenance', provenance);
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
    const run = runCheck(
      repo,
      '--trusted-genie-root',
      authority,
      '--ref-provenance',
      `${authority}:incomplete-provenance.json`,
    );
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
    const unanchored = runCheck(repo, '--ref-provenance', `${authority}:ref-provenance.json`);
    expect(unanchored.code).toBe(1);
    expect(unanchored.stdout).toBe('');
    expect(unanchored.stderr).toContain('--trusted-genie-root');
    expectGenieHistory(outputCatalog(repo, `${authority}:ref-provenance.json`, authority));
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
    expect(run.stdout).toContain('LEGACY_SKILL_NAME_DIGESTS');
  });
});

describe('recordedCatalog', () => {
  test('reads the committed catalog back, so a regeneration can only ever add to it', async () => {
    const recorded = await recordedCatalog();

    expect(recorded.names).toContain(legacySkillDigest('pm'));
    expect(recorded.descriptions).toContain(legacySkillDigest(SHIPPED_PM_DESCRIPTION));
  });
});
