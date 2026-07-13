import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** True when a `<config>.genie-backup-*` sibling exists in the dir. */
function hasBackup(root: string): boolean {
  return readdirSync(root).some((f) => f.includes('genie-backup'));
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

  // A top-level `skills:` carrying an inline/flow/scalar value on the same line is
  // refused with a typed error rather than blindly appending a duplicate top-level
  // key. The refusal happens before any backup or write, so user siblings survive.
  test('empty flow `skills: {}` → typed error, nothing written, no backup', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'version: 1\nskills: {}\n';
    writeFileSync(configPath, original);

    expect(() => mergeSkillsExternalDir({ configPath, skillsRoot })).toThrow(HermesConfigError);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('flow-with-content is refused cleanly — user sibling survives verbatim, backup untouched', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'skills: {external_dirs: [/home/u/mine]}\n';
    writeFileSync(configPath, original);

    expect(() => mergeSkillsExternalDir({ configPath, skillsRoot })).toThrow(HermesConfigError);
    // The user's sibling entry is never deleted: the file is left byte-for-byte.
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('scalar/null on the same line `skills: null` → typed error, nothing written', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'skills: null\n';
    writeFileSync(configPath, original);

    expect(() => mergeSkillsExternalDir({ configPath, skillsRoot })).toThrow(HermesConfigError);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('refusal is idempotent: a repeated call still throws and never writes or backs up', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'skills: {external_dirs: [/home/u/mine]}\n';
    writeFileSync(configPath, original);

    for (let i = 0; i < 2; i++) {
      expect(() => mergeSkillsExternalDir({ configPath, skillsRoot })).toThrow(HermesConfigError);
    }
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
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

  // Nested inline child inside a block-style `skills:` — the real isit profile shape.
  // An inline empty `external_dirs: []` child must be merged IN PLACE (replaced with
  // the managed block), never appended as a second `external_dirs` key.
  test('isit shape: inline empty external_dirs child merged in place → exactly one key, siblings byte-identical', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original =
      'skills:\n' +
      '  external_dirs: []\n' +
      '  template_vars: true\n' +
      '  inline_shell: false\n' +
      '  inline_shell_timeout: 10\n';
    writeFileSync(configPath, original);

    const result = mergeSkillsExternalDir({ configPath, skillsRoot, now: new Date('2026-07-13T00:00:00Z') });
    expect(result.status).toBe('updated');
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(original);

    const text = readFileSync(configPath, 'utf8');
    // Exactly ONE external_dirs key inside the skills mapping (no spec-invalid duplicate).
    expect(text.match(/external_dirs:/g)?.length).toBe(1);
    // Siblings preserved byte-for-byte.
    expect(text).toContain('  template_vars: true\n');
    expect(text).toContain('  inline_shell: false\n');
    expect(text).toContain('  inline_shell_timeout: 10\n');

    const parsed = Bun.YAML.parse(text) as {
      skills: {
        external_dirs: string[];
        template_vars: boolean;
        inline_shell: boolean;
        inline_shell_timeout: number;
      };
    };
    expect(parsed.skills.external_dirs).toEqual([skillsRoot]);
    expect(parsed.skills.template_vars).toBe(true);
    expect(parsed.skills.inline_shell).toBe(false);
    expect(parsed.skills.inline_shell_timeout).toBe(10);
  });

  test('inline NON-empty external_dirs child → typed refusal, file + backup untouched', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'skills:\n  external_dirs: [/home/u/mine]\n  template_vars: true\n';
    writeFileSync(configPath, original);

    expect(() => mergeSkillsExternalDir({ configPath, skillsRoot })).toThrow(HermesConfigError);
    // The user's inline entry is never deleted: the file is left byte-for-byte.
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('the inline non-empty nested refusal carries the distinct inline-nested-key code', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    writeFileSync(configPath, 'skills:\n  external_dirs: [/home/u/mine]\n');

    try {
      mergeSkillsExternalDir({ configPath, skillsRoot });
      throw new Error('expected a HermesConfigError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HermesConfigError);
      expect((err as HermesConfigError).code).toBe('inline-nested-key');
    }
  });

  test('isit shape merge is idempotent: second run is unchanged', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'));
    const configPath = join(root, 'config.yaml');
    const original = 'skills:\n  external_dirs: []\n  template_vars: true\n';
    writeFileSync(configPath, original);

    const first = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(first.status).toBe('updated');
    const afterFirst = readFileSync(configPath, 'utf8');

    const second = mergeSkillsExternalDir({ configPath, skillsRoot });
    expect(second.status).toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
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

  test('a shrunk source prunes stale managed files: a removed skill is gone after re-sync', () => {
    const root = tmp();
    const skillsRoot = makeSkillsRoot(join(root, 'skills'), ['brainstorm', 'wish', 'review']);
    const targetDir = join(root, 'hermes-managed-skills');

    const first = copyProductSkillsDigestManaged({ skillsRoot, targetDir });
    expect(first.status).toBe('copied');
    expect(existsSync(join(targetDir, 'review', 'SKILL.md'))).toBe(true);

    // Source shrinks: the 'review' skill is removed upstream.
    rmSync(join(skillsRoot, 'review'), { recursive: true, force: true });

    const second = copyProductSkillsDigestManaged({ skillsRoot, targetDir });
    expect(second.status).toBe('copied'); // digest changed → re-copy
    // The managed target no longer carries the deleted skill (managed dir is pruned first).
    expect(existsSync(join(targetDir, 'review', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(targetDir, 'brainstorm', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'wish', 'SKILL.md'))).toBe(true);
  });
});
