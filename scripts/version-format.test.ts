import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pluginPackageManifest, updateManifestVersion } from './build.js';
import { synchronizeVersionFiles, updateJsonVersion } from './version.ts';

describe('manifest version formatting', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { path: string; original: string } {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-format-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    const original = [
      '{',
      '  "name": "genie",',
      '  "version": "5.260710.14",',
      '  "keywords": ["workflow", "codex", "skills"],',
      '  "interface": {',
      '    "capabilities": ["Skills", "Hooks", "MCP"]',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(path, original);
    return { path, original };
  }

  function synchronizationFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-sync-'));
    roots.push(root);
    const writeJson = (relativePath: string, value: unknown) => {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    };
    for (const path of [
      'package.json',
      'plugins/genie/.claude-plugin/plugin.json',
      'plugins/genie/.codex-plugin/plugin.json',
      'plugins/genie/package.json',
    ]) {
      writeJson(path, { name: 'genie', version: '5.000000.0' });
    }
    writeJson('.claude-plugin/marketplace.json', {
      plugins: [{ name: 'genie', version: '5.000000.0' }],
    });
    return root;
  }

  test('version.ts changes only the version token', async () => {
    const { path, original } = fixture();
    await updateJsonVersion(path, '5.260711.1');
    expect(readFileSync(path, 'utf8')).toBe(original.replace('5.260710.14', '5.260711.1'));
  });

  test('build.js changes only the version token', () => {
    const { path, original } = fixture();
    updateManifestVersion(path, '5.260711.2');
    expect(readFileSync(path, 'utf8')).toBe(original.replace('5.260710.14', '5.260711.2'));
  });

  test('version stampers target the top-level key when a nested version appears first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-version-nested-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    const original = '{\n  "metadata": { "version": "nested" },\n  "version": "5.0.0"\n}\n';

    writeFileSync(path, original);
    await updateJsonVersion(path, '5.260711.7');
    expect(readFileSync(path, 'utf8')).toBe(original.replace('"5.0.0"', '"5.260711.7"'));
    expect(JSON.parse(readFileSync(path, 'utf8')).metadata.version).toBe('nested');

    writeFileSync(path, original);
    updateManifestVersion(path, '5.260711.8');
    expect(readFileSync(path, 'utf8')).toBe(original.replace('"5.0.0"', '"5.260711.8"'));
    expect(JSON.parse(readFileSync(path, 'utf8')).metadata.version).toBe('nested');
  });

  test('plugin package generator preserves reviewed MIT metadata', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'plugins', 'genie', 'package.json'), 'utf8');
    const tracked = JSON.parse(source);
    expect(pluginPackageManifest(tracked.version)).toEqual(tracked);
    expect(pluginPackageManifest(tracked.version).license).toBe('MIT');
    expect(`${JSON.stringify(pluginPackageManifest(tracked.version), null, 2)}\n`).toBe(source);
  });

  test('synchronization updates every required file or rejects the run', async () => {
    const root = synchronizationFixture();
    await synchronizeVersionFiles(root, '5.260711.3');
    expect(JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].version).toBe(
      '5.260711.3',
    );

    rmSync(join(root, 'plugins/genie/.codex-plugin/plugin.json'));
    await expect(synchronizeVersionFiles(root, '5.260711.4')).rejects.toThrow(
      'version synchronization preflight failed',
    );
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('5.260711.3');
  });

  test('synchronization rejects malformed required metadata', async () => {
    const root = synchronizationFixture();
    writeFileSync(join(root, '.claude-plugin/marketplace.json'), '{"plugins":[]}\n');
    await expect(synchronizeVersionFiles(root, '5.260711.4')).rejects.toThrow(
      'version synchronization preflight failed',
    );
  });
});
