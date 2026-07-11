import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stampReleasePayloadVersion, verifyReleasePayloadVersion } from './release-payload-version.ts';

describe('release payload version contract', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeJson(root: string, relativePath: string, value: unknown): void {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-release-payload-version-'));
    roots.push(root);
    for (const path of [
      'plugins/genie/package.json',
      'plugins/genie/.claude-plugin/plugin.json',
      'plugins/genie/.codex-plugin/plugin.json',
    ]) {
      writeJson(root, path, { name: 'genie', version: '5.000000.0' });
    }
    writeJson(root, '.claude-plugin/marketplace.json', {
      name: 'automagik',
      plugins: [{ name: 'genie', version: '5.000000.0', source: './plugins/genie' }],
    });
    writeJson(root, '.agents/plugins/marketplace.json', {
      name: 'automagik',
      plugins: [
        {
          name: 'genie',
          source: { source: 'local', path: './plugins/genie' },
          policy: { installation: 'AVAILABLE' },
        },
      ],
    });
    return root;
  }

  test('stamps and verifies VERSION plus every copied version-bearing manifest', () => {
    const root = fixture();
    const version = '5.260711.9-rc.1';

    stampReleasePayloadVersion(root, version);

    expect(() => verifyReleasePayloadVersion(root, version)).not.toThrow();
    expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe(`${version}\n`);
    for (const path of [
      'plugins/genie/package.json',
      'plugins/genie/.claude-plugin/plugin.json',
      'plugins/genie/.codex-plugin/plugin.json',
    ]) {
      expect(JSON.parse(readFileSync(join(root, path), 'utf8')).version).toBe(version);
    }
    const claude = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(claude.plugins[0].version).toBe(version);
  });

  test('verification catches one diverging copied manifest', () => {
    const root = fixture();
    const version = '5.260711.10';
    stampReleasePayloadVersion(root, version);
    writeJson(root, 'plugins/genie/.codex-plugin/plugin.json', { name: 'genie', version: '5.260711.9' });

    expect(() => verifyReleasePayloadVersion(root, version)).toThrow('.codex-plugin/plugin.json');
  });

  test('fails closed on missing metadata, malformed versions, and an invalid Codex marketplace target', () => {
    const root = fixture();
    rmSync(join(root, 'plugins/genie/package.json'));
    expect(() => stampReleasePayloadVersion(root, '5.260711.10')).toThrow('metadata is missing');

    const second = fixture();
    expect(() => stampReleasePayloadVersion(second, '../escape')).toThrow('invalid release version');

    const third = fixture();
    stampReleasePayloadVersion(third, '5.260711.10');
    writeJson(third, '.agents/plugins/marketplace.json', {
      plugins: [{ name: 'genie', source: { source: 'local', path: '../outside' } }],
    });
    expect(() => verifyReleasePayloadVersion(third, '5.260711.10')).toThrow('must target local ./plugins/genie');
  });

  test('build-binary wires both stage stamping and post-copy verification', () => {
    const buildScript = readFileSync(join(import.meta.dir, 'build-binary.sh'), 'utf8');
    expect(buildScript).toContain('release-payload-version.ts" --stamp');
    expect(buildScript).toContain('release-payload-version.ts" --verify');
  });
});
