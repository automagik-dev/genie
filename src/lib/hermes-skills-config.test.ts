import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesConfigError } from './hermes-mcp-config.js';
import {
  copyProductSkillsDigestManaged,
  mergeSkillsExternalDir,
  resolveProductSkillsRoot,
} from './hermes-skills-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-skills-'));
  roots.push(root);
  return root;
}

/** Materialize a populated product-skills root (each skill needs a SKILL.md). */
function makeSkillsRoot(dir: string, names: string[] = ['brainstorm', 'wish']): string {
  for (const name of names) {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n`);
  }
  return dir;
}

describe('resolveProductSkillsRoot', () => {
  test('prefers $GENIE_HOME/skills when populated', () => {
    const home = tmp();
    const populated = makeSkillsRoot(join(home, 'skills'));
    expect(resolveProductSkillsRoot({ genieHome: home })).toBe(populated);
  });

  test('falls back to the plugin mirror when $GENIE_HOME/skills is empty', () => {
    const home = tmp();
    mkdirSync(join(home, 'skills'), { recursive: true }); // exists but empty → not populated
    const mirror = makeSkillsRoot(join(home, 'plugins', 'genie', 'skills'));
    expect(resolveProductSkillsRoot({ genieHome: home })).toBe(mirror);
  });

  test('an explicit populated override wins over the installed layout', () => {
    const home = tmp();
    makeSkillsRoot(join(home, 'skills'));
    const override = makeSkillsRoot(join(tmp(), 'repo-skills'));
    expect(resolveProductSkillsRoot({ genieHome: home, skillsRoot: override })).toBe(override);
  });

  test('throws a typed error when no populated root is found', () => {
    const home = tmp();
    expect(() => resolveProductSkillsRoot({ genieHome: home })).toThrow(HermesConfigError);
  });

  test('rejects an empty or relative override with a typed error', () => {
    const home = tmp();
    expect(() => resolveProductSkillsRoot({ genieHome: home, skillsRoot: '' })).toThrow(HermesConfigError);
    expect(() => resolveProductSkillsRoot({ genieHome: home, skillsRoot: 'rel/skills' })).toThrow(HermesConfigError);
  });
});

describe('mergeSkillsExternalDir', () => {
  test('missing config.yaml → creates skills.external_dirs with only the resolved root', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');

    const result = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(result.status).toBe('created');
    expect(result.backupPath).toBeUndefined();
    expect(result.skillsRoot).toBe(skillsRoot);

    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as { skills: { external_dirs: string[] } };
    expect(Object.keys(parsed)).toEqual(['skills']);
    expect(parsed.skills.external_dirs).toEqual([skillsRoot]);
  });

  test('preserves other user external_dirs entries and unrelated keys, backing up first', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original =
      'version: 2\n' +
      'skills:\n' +
      '  external_dirs:\n' +
      '    - /home/user/my-skills\n' +
      '    - /opt/team/skills\n' +
      'log_level: info\n';
    writeFileSync(configPath, original);

    const result = mergeSkillsExternalDir({ configPath, skillsRoot, now: new Date('2026-07-12T00:00:00Z') });
    expect(result.status).toBe('updated');
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(original);

    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      version: number;
      skills: { external_dirs: string[] };
      log_level: string;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.log_level).toBe('info');
    // User entries preserved, genie root appended exactly once.
    expect(parsed.skills.external_dirs).toEqual(['/home/user/my-skills', '/opt/team/skills', skillsRoot]);
  });

  test('already-listed root → no write, unchanged, no backup', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = `skills:\n  external_dirs:\n    - ${JSON.stringify(skillsRoot)}\n`;
    writeFileSync(configPath, original);

    const result = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(result.status).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  test('skills key present without external_dirs → adds external_dirs, preserving siblings', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'skills:\n  enabled: true\n';
    writeFileSync(configPath, original);

    const result = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(result.status).toBe('updated');

    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      skills: { enabled: boolean; external_dirs: string[] };
    };
    expect(parsed.skills.enabled).toBe(true);
    expect(parsed.skills.external_dirs).toEqual([skillsRoot]);
  });

  test('is idempotent: second merge is a no-op unchanged', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');

    const first = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(first.status).toBe('created');
    const afterFirst = readFileSync(configPath, 'utf8');

    const second = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(second.status).toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  test('a changed root replaces the single managed entry, never leaving two genie entries', () => {
    const root = tmp();
    const oldRoot = makeSkillsRoot(join(root, 'old-skills'));
    const newRoot = makeSkillsRoot(join(root, 'new-skills'));
    const configPath = join(root, 'config.yaml');

    mergeSkillsExternalDir({ configPath, skillsRoot: oldRoot });
    const result = mergeSkillsExternalDir({ configPath, skillsRoot: newRoot });
    expect(result.status).toBe('updated');

    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as { skills: { external_dirs: string[] } };
    // Exactly one managed entry — old genie root replaced, not accumulated.
    expect(parsed.skills.external_dirs).toEqual([newRoot]);
  });
});

describe('copyProductSkillsDigestManaged (older-Hermes fallback)', () => {
  test('copies the resolved skills tree into the target dir and records a digest manifest', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'), ['brainstorm', 'wish', 'review']);
    const targetDir = join(root, 'hermes-managed-skills');

    const result = copyProductSkillsDigestManaged({ skillsRoot, targetDir });
    expect(result.status).toBe('copied');
    expect(existsSync(join(targetDir, 'brainstorm', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'review', 'SKILL.md'))).toBe(true);
    expect(result.digest.length).toBeGreaterThan(0);
  });

  test('is digest-idempotent: an unchanged source is not re-copied', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const targetDir = join(root, 'hermes-managed-skills');

    const first = copyProductSkillsDigestManaged({ skillsRoot, targetDir });
    expect(first.status).toBe('copied');
    const second = copyProductSkillsDigestManaged({ skillsRoot, targetDir });
    expect(second.status).toBe('unchanged');
    expect(second.digest).toBe(first.digest);
  });
});
