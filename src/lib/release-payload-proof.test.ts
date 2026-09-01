import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareReleaseVersions,
  parseReleaseVersion,
  scanPhysicalTree,
  stripControl,
} from './release-payload-proof.js';

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `genie-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

// Moved verbatim from the retired Codex activation test's `release version grammar`
// describe (minus `deriveDirection`, which stayed with the retired activation
// protocol) when the grammar and the payload-tree proof were rehomed here.
describe('release version grammar', () => {
  test('accepts MAJOR.YYMMDD.N and strips build metadata after matching', () => {
    expect(parseReleaseVersion('5.260712.1')?.canonical).toBe('5.260712.1');
    expect(parseReleaseVersion('5.260712.1+build.7')?.canonical).toBe('5.260712.1');
  });

  test('rejects malformed or non-string versions', () => {
    for (const bad of ['5.26712.1', '5.260712', 'v5.260712.1', '', 'latest', '5.260712.1.2']) {
      expect(parseReleaseVersion(bad)).toBeNull();
    }
    expect(parseReleaseVersion(null)).toBeNull();
    expect(parseReleaseVersion(42 as unknown)).toBeNull();
  });

  test('orders validated versions totally across every component', () => {
    const ver = (raw: string) => {
      const parsed = parseReleaseVersion(raw);
      if (parsed === null) throw new Error(`fixture version ${raw} is malformed`);
      return parsed;
    };
    expect(compareReleaseVersions(ver('5.260712.1'), ver('5.260712.2'))).toBe(-1);
    expect(compareReleaseVersions(ver('5.260712.2'), ver('5.260712.1'))).toBe(1);
    expect(compareReleaseVersions(ver('5.260712.1'), ver('5.260712.1+build.7'))).toBe(0);
    expect(compareReleaseVersions(ver('5.260712.9'), ver('5.260713.1'))).toBe(-1);
    expect(compareReleaseVersions(ver('4.260712.1'), ver('5.260712.1'))).toBe(-1);
  });

  test('strips ANSI CSI and OSC control sequences from modeled output', () => {
    expect(stripControl('\u001b[31mred\u001b[0m')).toBe('red');
    expect(stripControl('\u001b]0;title\u0007tail')).toBe('tail');
  });
});

describe('physical payload tree proof', () => {
  test('digests file content, relative path and the executable bit', () => {
    const root = tempRoot('payload-proof');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', 'a.txt'), 'alpha');
    const before = scanPhysicalTree(root);
    expect(before.status).toBe('ok');
    expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(before.identity).toMatch(/^\d+:\d+$/);

    // Same bytes, same path: the digest is stable.
    expect(scanPhysicalTree(root).digest).toBe(before.digest);

    chmodSync(join(root, 'nested', 'a.txt'), 0o755);
    expect(scanPhysicalTree(root).digest).not.toBe(before.digest);
  });

  test('rejects a symlink anywhere inside the payload and names it', () => {
    const root = tempRoot('payload-symlink');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', 'a.txt'), 'alpha');
    symlinkSync(join(root, 'nested', 'a.txt'), join(root, 'nested', 'link.txt'));
    const report = scanPhysicalTree(root);
    expect(report.status).toBe('symlink');
    expect(report.detail).toBe('symlink at nested/link.txt');
  });

  test('reports absent, symlinked and non-directory roots without throwing', () => {
    const root = tempRoot('payload-root');
    expect(scanPhysicalTree(join(root, 'missing')).status).toBe('absent');

    writeFileSync(join(root, 'file'), 'x');
    expect(scanPhysicalTree(join(root, 'file')).status).toBe('unsafe');

    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(scanPhysicalTree(join(root, 'link')).status).toBe('symlink');
  });
});
