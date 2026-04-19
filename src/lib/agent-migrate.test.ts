/**
 * Tests for `migrateAgentToYaml` — cover every acceptance criterion from
 * wish `dir-sync-frontmatter-refresh` Group 2.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentTemplateRow, migrateAgentToYaml } from './agent-migrate.js';
import { type AgentConfig, parseAgentYaml } from './agent-yaml.js';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'agent-migrate-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function seedAgentDir(name: string, agentsMdContent: string): Promise<string> {
  const dir = join(tempRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), agentsMdContent);
  return dir;
}

const FRONTMATTER_BASIC = `---
name: simone
team: simone
description: "Sócia invisível do escritório"
color: pink
promptMode: system
---

# AGENTS.md body

Agent instructions live here.
`;

describe('migrateAgentToYaml — idempotency', () => {
  test('second call is a no-op: returns already-migrated, no disk writes', async () => {
    const dir = await seedAgentDir('simone', FRONTMATTER_BASIC);

    const first = await migrateAgentToYaml(dir);
    expect(first.migrated).toBe(true);

    const yamlBefore = await readFile(join(dir, 'agent.yaml'), 'utf-8');
    const mdBefore = await readFile(join(dir, 'AGENTS.md'), 'utf-8');
    const bakBefore = await readFile(join(dir, 'AGENTS.md.bak'), 'utf-8');

    const second = await migrateAgentToYaml(dir);
    expect(second.migrated).toBe(false);
    if (!second.migrated) expect(second.reason).toBe('already-migrated');

    expect(await readFile(join(dir, 'agent.yaml'), 'utf-8')).toBe(yamlBefore);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe(mdBefore);
    expect(await readFile(join(dir, 'AGENTS.md.bak'), 'utf-8')).toBe(bakBefore);
  });
});

describe('migrateAgentToYaml — body preservation', () => {
  test('AGENTS.md body after frontmatter is preserved byte-for-byte', async () => {
    const body = '# Header\n\nParagraph with **bold** and `code`.\n\n- bullet\n- list\n';
    const md = `---\nname: simone\npromptMode: system\n---\n${body}`;
    const dir = await seedAgentDir('simone', md);

    await migrateAgentToYaml(dir);

    const rewritten = await readFile(join(dir, 'AGENTS.md'), 'utf-8');
    expect(rewritten).toBe(body);
  });

  test('CRLF body survives migration', async () => {
    const body = 'line-a\r\nline-b\r\n';
    const md = `---\nname: simone\npromptMode: system\n---\n${body}`;
    const dir = await seedAgentDir('simone', md);

    await migrateAgentToYaml(dir);

    const rewritten = await readFile(join(dir, 'AGENTS.md'), 'utf-8');
    expect(rewritten).toBe(body);
  });

  test('Unicode body survives migration', async () => {
    const body = '# 我 🦄 Олівець\n\n日本語テスト\n';
    const md = `---\nname: simone\npromptMode: system\n---\n${body}`;
    const dir = await seedAgentDir('simone', md);

    await migrateAgentToYaml(dir);

    const rewritten = await readFile(join(dir, 'AGENTS.md'), 'utf-8');
    expect(rewritten).toBe(body);
  });
});

describe('migrateAgentToYaml — .bak integrity', () => {
  test('.bak equals pre-migration AGENTS.md byte-for-byte', async () => {
    const dir = await seedAgentDir('simone', FRONTMATTER_BASIC);

    await migrateAgentToYaml(dir);

    const bak = await readFile(join(dir, 'AGENTS.md.bak'), 'utf-8');
    expect(bak).toBe(FRONTMATTER_BASIC);
  });
});

describe('migrateAgentToYaml — dbRow merge', () => {
  test('dbRow fills fields absent from frontmatter', async () => {
    const md = '---\nname: simone\npromptMode: system\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);
    const dbRow: AgentTemplateRow = {
      team: 'simone',
      model: 'opus',
      color: 'pink',
    };

    await migrateAgentToYaml(dir, dbRow);

    const yamlParsed = await parseAgentYaml(join(dir, 'agent.yaml'));
    expect(yamlParsed.team).toBe('simone');
    expect(yamlParsed.model).toBe('opus');
    expect(yamlParsed.color).toBe('pink');
    expect(yamlParsed.promptMode).toBe('system');
  });

  test('frontmatter wins when both frontmatter and dbRow set the same field', async () => {
    const md = '---\nname: simone\npromptMode: system\nteam: frontmatter-team\ncolor: blue\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);
    const dbRow: AgentTemplateRow = {
      team: 'db-team',
      color: 'red',
    };

    await migrateAgentToYaml(dir, dbRow);

    const yamlParsed = await parseAgentYaml(join(dir, 'agent.yaml'));
    expect(yamlParsed.team).toBe('frontmatter-team');
    expect(yamlParsed.color).toBe('blue');
  });

  test('DB-only fields (skill, extra_args, id) are silently dropped — never reach agent.yaml', async () => {
    const md = '---\nname: simone\npromptMode: system\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);
    const dbRow: AgentTemplateRow = {
      id: 'simone',
      skill: 'legal-research',
      extra_args: ['--fast'],
      extraArgs: ['--fast'],
      team: 'simone',
    };

    const result = await migrateAgentToYaml(dir, dbRow);
    expect(result.migrated).toBe(true);

    const yamlRaw = await readFile(join(dir, 'agent.yaml'), 'utf-8');
    expect(yamlRaw).not.toMatch(/skill:/);
    expect(yamlRaw).not.toMatch(/extra_args:/);
    expect(yamlRaw).not.toMatch(/extraArgs:/);
    expect(yamlRaw).not.toMatch(/^id:/m);

    const yamlParsed = await parseAgentYaml(join(dir, 'agent.yaml'));
    expect(yamlParsed.team).toBe('simone');
    // Schema has no skill/extraArgs so they can't exist on the parsed type
    expect((yamlParsed as unknown as { skill?: string }).skill).toBeUndefined();
  });

  test('nested permissions from dbRow survive into agent.yaml', async () => {
    const md = '---\nname: simone\npromptMode: system\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);
    const dbRow: AgentTemplateRow = {
      permissions: {
        preset: 'read-only',
        allow: ['Read', 'Grep'],
        bashAllowPatterns: ['^ls\\b'],
      } satisfies AgentConfig['permissions'],
    };

    await migrateAgentToYaml(dir, dbRow);

    const yamlParsed = await parseAgentYaml(join(dir, 'agent.yaml'));
    expect(yamlParsed.permissions?.preset).toBe('read-only');
    expect(yamlParsed.permissions?.allow).toEqual(['Read', 'Grep']);
    expect(yamlParsed.permissions?.bashAllowPatterns).toEqual(['^ls\\b']);
  });
});

describe('migrateAgentToYaml — no-frontmatter', () => {
  test('AGENTS.md with no frontmatter returns no-frontmatter and makes no writes', async () => {
    const content = '# Plain AGENTS.md\n\nNo fence at the top.\n';
    const dir = await seedAgentDir('simone', content);

    const result = await migrateAgentToYaml(dir);
    expect(result.migrated).toBe(false);
    if (!result.migrated) expect(result.reason).toBe('no-frontmatter');

    expect(existsSync(join(dir, 'agent.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md.bak'))).toBe(false);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe(content);
  });
});

describe('migrateAgentToYaml — error paths', () => {
  test('malformed frontmatter throws and leaves all files untouched', async () => {
    const md = '---\nname: simone\n  bad: : indent\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);
    const mdBefore = await readFile(join(dir, 'AGENTS.md'), 'utf-8');

    await expect(migrateAgentToYaml(dir)).rejects.toThrow(/frontmatter/i);

    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe(mdBefore);
    expect(existsSync(join(dir, 'agent.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md.bak'))).toBe(false);
  });

  test('unknown schema field in frontmatter throws and leaves files untouched', async () => {
    const md = '---\nname: simone\npromptMode: system\nbogus_key: nope\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);
    const mdBefore = await readFile(join(dir, 'AGENTS.md'), 'utf-8');

    // bogus_key is not in YAML_ALLOWED_KEYS so it's silently dropped during merge.
    // Verify the migration still succeeds and bogus_key does not reach agent.yaml.
    const result = await migrateAgentToYaml(dir);
    expect(result.migrated).toBe(true);

    const yamlRaw = await readFile(join(dir, 'agent.yaml'), 'utf-8');
    expect(yamlRaw).not.toMatch(/bogus_key/);
    // Backup still has the original frontmatter byte-for-byte
    expect(await readFile(join(dir, 'AGENTS.md.bak'), 'utf-8')).toBe(mdBefore);
  });

  test('empty frontmatter mapping parses to empty-but-valid config', async () => {
    const md = '---\npromptMode: system\n---\nbody\n';
    const dir = await seedAgentDir('simone', md);

    const result = await migrateAgentToYaml(dir);
    expect(result.migrated).toBe(true);

    const yamlParsed = await parseAgentYaml(join(dir, 'agent.yaml'));
    expect(yamlParsed.promptMode).toBe('system');
  });
});

describe('migrateAgentToYaml — return shape', () => {
  test('migrated=true result carries yamlPath and bakPath', async () => {
    const dir = await seedAgentDir('simone', FRONTMATTER_BASIC);

    const result = await migrateAgentToYaml(dir);
    expect(result.migrated).toBe(true);
    if (result.migrated) {
      expect(result.yamlPath).toBe(join(dir, 'agent.yaml'));
      expect(result.bakPath).toBe(join(dir, 'AGENTS.md.bak'));
    }
  });
});
