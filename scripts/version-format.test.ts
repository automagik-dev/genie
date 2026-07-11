import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateManifestVersion } from './build.js';
import { updateJsonVersion } from './version.ts';

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
});
