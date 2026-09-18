import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_MARKER_DIRS, LEGACY_SKILL_DESCRIPTIONS, LEGACY_SKILL_NAMES } from './legacy-skills-catalog.js';
import { classifyLegacySkillEntry, findLegacySkillLeftovers, readSkillDescription } from './legacy-skills.js';

/** A description genie really shipped — the 2026-07 `pm` skill's, found as residue on the dogfood host. */
const SHIPPED_PM_DESCRIPTION =
  'Full PM playbook — triage backlog, prioritize, assign, track, report, escalate. Copilot, autopilot, or pair modes.';

let home: string;
let agentDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'genie-legacy-skills-'));
  agentDir = join(home, '.agents', 'skills');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedSkill(name: string, frontmatter: string, body = `# ${name}\n`): string {
  const dir = join(agentDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `${frontmatter}\n${body}`, 'utf8');
  return dir;
}

/** The skills the tree ships right now, enumerated from disk — a hardcoded list ages out silently. */
const SKILLS_ROOT = join(import.meta.dir, '..', '..', 'skills');
function shippedSkillNames(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('legacy skills catalog', () => {
  test('names none of the skills the tree currently ships, and carries the residue that was found', () => {
    // The generator excludes the current inventory; the reader relies on it. Every shipped skill is
    // checked, not a spot sample: one shipped name in the catalog would make `genie update` archive
    // a live skill dir, and one shipped description would make a user's fork of it look proven.
    const shipped = shippedSkillNames();
    expect(shipped.length).toBeGreaterThan(0);
    for (const name of shipped) {
      expect(LEGACY_SKILL_NAMES).not.toContain(name);
      const description = readSkillDescription(join(SKILLS_ROOT, name));
      if (description !== null) expect(LEGACY_SKILL_DESCRIPTIONS).not.toContain(description);
    }
    for (const name of ['pm', 'wizard', 'brain']) expect(LEGACY_SKILL_NAMES).toContain(name);
    expect(LEGACY_SKILL_DESCRIPTIONS).toContain(SHIPPED_PM_DESCRIPTION);
    expect(new Set(LEGACY_SKILL_DESCRIPTIONS).size).toBe(LEGACY_SKILL_DESCRIPTIONS.length);
    expect(LEGACY_SKILL_DESCRIPTIONS.every((entry) => entry.length > 0)).toBe(true);
    // A fork of a CURRENT skill keeps a current description; none of those may prove anything.
    expect(LEGACY_SKILL_DESCRIPTIONS).not.toContain(
      readSkillDescription(join(import.meta.dir, '..', '..', 'skills', 'review')),
    );
    expect(LEGACY_MARKER_DIRS).toEqual(['.genie-codex-fallback-retirement']);
  });
});

describe('readSkillDescription', () => {
  test('unquotes a quoted description and ignores files without frontmatter', () => {
    expect(readSkillDescription(seedSkill('a', `---\nname: a\ndescription: "Quoted — value"\n---`))).toBe(
      'Quoted — value',
    );
    expect(readSkillDescription(seedSkill('b', '---\nname: b\ndescription: plain value\n---'))).toBe('plain value');
    expect(readSkillDescription(seedSkill('c', '# no frontmatter'))).toBeNull();
    expect(readSkillDescription(seedSkill('d', '---\nname: d\n---'))).toBeNull();
    expect(readSkillDescription(join(agentDir, 'missing'))).toBeNull();
  });
});

describe('classifyLegacySkillEntry', () => {
  test('a retired description under a genie name is proven; either half alone is only reported', () => {
    seedSkill('pm', `---\nname: pm\ndescription: "${SHIPPED_PM_DESCRIPTION}"\n---`);
    // The 2026-07 `genie-review` residue: never a `skills/genie-review` dir in
    // history, but the `genie-` prefix is genie's and its description is a
    // retired one — the July text of the skill shipped as `review` today.
    seedSkill('genie-review', `---\nname: genie-review\ndescription: "${SHIPPED_PM_DESCRIPTION}"\n---`);
    // A live third-party `brain` product shares a retired genie NAME and nothing else.
    seedSkill('brain', '---\nname: brain\ndescription: Route Brain knowledge, memory, setup, health\n---');
    // A user's fork of a retired genie skill under a custom name keeps genie's
    // description: reported, never moved (Codex review on PR #2928).
    seedSkill('my-pm', `---\nname: my-pm\ndescription: "${SHIPPED_PM_DESCRIPTION}"\n---`);
    expect(classifyLegacySkillEntry(agentDir, 'pm', [])).toEqual({ agentDir, entry: 'pm', kind: 'proven' });
    expect(classifyLegacySkillEntry(agentDir, 'genie-review', [])).toEqual({
      agentDir,
      entry: 'genie-review',
      kind: 'proven',
    });
    expect(classifyLegacySkillEntry(agentDir, 'brain', [])).toEqual({ agentDir, entry: 'brain', kind: 'unproven' });
    expect(classifyLegacySkillEntry(agentDir, 'my-pm', [])).toEqual({ agentDir, entry: 'my-pm', kind: 'unproven' });
  });

  test('the current inventory, symlinks, markerless unknown dirs and files are never leftovers', () => {
    seedSkill('pm', `---\nname: pm\ndescription: "${SHIPPED_PM_DESCRIPTION}"\n---`);
    // Delivered right now: the record's business, whatever its description says.
    expect(classifyLegacySkillEntry(agentDir, 'pm', ['pm'])).toBeNull();
    symlinkSync(join(agentDir, 'pm'), join(agentDir, 'pm-link'));
    expect(classifyLegacySkillEntry(agentDir, 'pm-link', [])).toBeNull();
    seedSkill('theirs', `---\nname: theirs\ndescription: Someone else's skill\n---`);
    expect(classifyLegacySkillEntry(agentDir, 'theirs', [])).toBeNull();
    // A retired NAME with no SKILL.md at all is not even unproven: nothing to read.
    mkdirSync(join(agentDir, 'wizard'));
    expect(classifyLegacySkillEntry(agentDir, 'wizard', [])).toBeNull();
    writeFileSync(join(agentDir, 'trace'), 'a file, not a dir\n');
    expect(classifyLegacySkillEntry(agentDir, 'trace', [])).toBeNull();
  });

  test('a genie marker directory is genie’s by name alone', () => {
    mkdirSync(join(agentDir, '.genie-codex-fallback-retirement', 'txn-1'), { recursive: true });
    expect(classifyLegacySkillEntry(agentDir, '.genie-codex-fallback-retirement', [])).toEqual({
      agentDir,
      entry: '.genie-codex-fallback-retirement',
      kind: 'marker',
    });
  });
});

describe('findLegacySkillLeftovers', () => {
  test('walks every home once, in path order, and skips homes that cannot be listed', () => {
    const other = join(home, '.claude', 'skills');
    mkdirSync(other, { recursive: true });
    seedSkill('pm', `---\nname: pm\ndescription: "${SHIPPED_PM_DESCRIPTION}"\n---`);
    mkdirSync(join(agentDir, '.genie-codex-fallback-retirement'));
    mkdirSync(join(other, 'wizard'));
    writeFileSync(join(other, 'wizard', 'SKILL.md'), '---\nname: wizard\ndescription: not genie’s text\n---\n');

    expect(findLegacySkillLeftovers([agentDir, other, agentDir, join(home, 'absent')], [])).toEqual([
      { agentDir, entry: '.genie-codex-fallback-retirement', kind: 'marker' },
      { agentDir, entry: 'pm', kind: 'proven' },
      { agentDir: other, entry: 'wizard', kind: 'unproven' },
    ]);
  });
});
