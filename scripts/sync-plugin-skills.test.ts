import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SkillMirrorOptions,
  assertPluginSkillsInSync,
  assertShippedSkillInventory,
  syncPluginSkills,
} from './sync-plugin-skills.ts';

describe('sync-plugin-skills', () => {
  let root: string;
  let options: SkillMirrorOptions;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-plugin-skills-'));
    const canonicalDir = join(root, 'skills');
    const pluginSkillsDir = join(root, 'plugins', 'genie', 'skills');
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(canonicalDir, name, 'agents'), { recursive: true });
      writeFileSync(join(canonicalDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
      writeFileSync(
        join(canonicalDir, name, 'agents', 'openai.yaml'),
        `interface:\n  display_name: "${name}"\n  short_description: "Run the ${name} workflow safely"\n  default_prompt: "Use $${name} for this task."\n`,
      );
    }
    writeFileSync(join(canonicalDir, 'README.md'), 'canonical\n');
    mkdirSync(join(root, 'plugins', 'genie'), { recursive: true });
    options = {
      canonicalDir,
      pluginRoot: join(root, 'plugins', 'genie'),
      pluginSkillsDir,
      expectedSkillNames: ['alpha', 'beta'],
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('rejects an escaping/source-equal destination symlink before removal', () => {
    symlinkSync('../../skills', options.pluginSkillsDir as string);

    expect(() => syncPluginSkills(options)).toThrow('must not be a symlink (resolves to canonical source)');
    expect(lstatSync(options.pluginSkillsDir as string).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(options.canonicalDir as string, 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha');
  });

  test('rejects a destination outside the declared plugin root before removal', () => {
    const outside = join(root, 'outside', 'skills');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'keep\n');

    expect(() => syncPluginSkills({ ...options, pluginSkillsDir: outside })).toThrow(
      'must be the expected in-plugin mirror',
    );
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep\n');
  });

  test('rejects a source-equal destination before removal', () => {
    const canonicalDir = options.canonicalDir as string;

    expect(() =>
      syncPluginSkills({
        ...options,
        pluginRoot: root,
        pluginSkillsDir: canonicalDir,
      }),
    ).toThrow('must differ from canonical source');
    expect(readFileSync(join(canonicalDir, 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha');
  });

  test('check fails closed on missing, extra, or changed mirror content', () => {
    syncPluginSkills(options);
    writeFileSync(join(options.pluginSkillsDir as string, 'alpha', 'SKILL.md'), 'drift\n');
    writeFileSync(join(options.pluginSkillsDir as string, 'extra.txt'), 'extra\n');
    rmSync(join(options.pluginSkillsDir as string, 'beta', 'SKILL.md'));

    expect(() => assertPluginSkillsInSync(options)).toThrow('plugin skills mirror drift');
  });

  test('rejects symlinks anywhere in the canonical payload', () => {
    symlinkSync('../README.md', join(options.canonicalDir as string, 'alpha', 'linked.md'));
    expect(() => syncPluginSkills(options)).toThrow('contains a symlink');
  });

  test('requires the intentional shipped inventory and each openai manifest', () => {
    rmSync(join(options.canonicalDir as string, 'beta', 'agents', 'openai.yaml'));
    expect(() => assertShippedSkillInventory(options)).toThrow('missing agents/openai.yaml');

    mkdirSync(join(options.canonicalDir as string, 'gamma'), { recursive: true });
    writeFileSync(
      join(options.canonicalDir as string, 'gamma', 'SKILL.md'),
      '---\nname: gamma\ndescription: gamma\n---\n',
    );
    expect(() => assertShippedSkillInventory(options)).toThrow('extra: gamma');
  });

  test('regeneration removes stale files rather than layering over them', () => {
    syncPluginSkills(options);
    writeFileSync(join(options.pluginSkillsDir as string, 'stale.txt'), 'stale\n');

    syncPluginSkills(options);

    expect(existsSync(join(options.pluginSkillsDir as string, 'stale.txt'))).toBe(false);
    expect(() => assertPluginSkillsInSync(options)).not.toThrow();
  });
});
