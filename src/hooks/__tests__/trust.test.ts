/**
 * Trust allowlist tests — Group 1 of hookify-third-party-absorption.
 *
 * Asserts the security boundary: filesystem-presence is NOT consent. A file
 * that doesn't appear in `trusted.json` with a matching SHA-256 is rejected
 * by the verifier. Repo-scoped entries pin to `remote.origin.url` so the
 * same `.ts` in a different clone is independently untrusted.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TrustFile, parseCapabilities, readTrustFile, sha256OfFile, verifyTrust } from '../trust.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'genie-trust-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('readTrustFile', () => {
  test('returns empty entries when the file is absent', () => {
    const trust = readTrustFile(join(tmpRoot, 'absent.json'));
    expect(trust.version).toBe(1);
    expect(trust.entries).toEqual([]);
  });

  test('returns empty entries when the file is empty', () => {
    const path = writeFile(join(tmpRoot, 'empty.json'), '');
    const trust = readTrustFile(path);
    expect(trust.entries).toEqual([]);
  });

  test('rejects unsupported version', () => {
    const path = writeFile(join(tmpRoot, 'v2.json'), JSON.stringify({ version: 2, entries: [] }));
    expect(() => readTrustFile(path)).toThrow(/Unsupported trust file version/);
  });

  test('rejects malformed entries field', () => {
    const path = writeFile(join(tmpRoot, 'bad.json'), JSON.stringify({ version: 1, entries: 'not-array' }));
    expect(() => readTrustFile(path)).toThrow(/entries must be an array/);
  });

  test('reads a well-formed file', () => {
    const path = writeFile(
      join(tmpRoot, 'good.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: '/abs/path.ts',
            sha256: 'a'.repeat(64),
            scope: 'global',
            trustedAt: '2026-04-29T00:00:00Z',
          },
        ],
      }),
    );
    const trust = readTrustFile(path);
    expect(trust.entries).toHaveLength(1);
    expect(trust.entries[0].scope).toBe('global');
  });
});

describe('verifyTrust — security boundary', () => {
  test('rejects a file not listed in trust', () => {
    const filePath = writeFile(join(tmpRoot, 'untrusted.ts'), 'export default {};');
    const trustFile: TrustFile = { version: 1, entries: [] };
    const result = verifyTrust(filePath, trustFile);
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toBe('not_in_trust_file');
  });

  test('rejects a file when the SHA does not match (post-edit detection)', () => {
    const filePath = writeFile(join(tmpRoot, 'edited.ts'), 'export default { name: "v1" };');
    const trustFile: TrustFile = {
      version: 1,
      entries: [
        {
          path: filePath,
          sha256: 'a'.repeat(64), // wrong on purpose
          scope: 'global',
          trustedAt: '2026-04-29T00:00:00Z',
        },
      ],
    };
    const result = verifyTrust(filePath, trustFile);
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toBe('sha256_mismatch');
  });

  test('rejects a missing file', () => {
    const filePath = join(tmpRoot, 'never-existed.ts');
    const trustFile: TrustFile = {
      version: 1,
      entries: [{ path: filePath, sha256: 'a'.repeat(64), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' }],
    };
    const result = verifyTrust(filePath, trustFile);
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toBe('file_missing');
  });

  test('accepts a file with matching SHA in global scope', () => {
    const filePath = writeFile(join(tmpRoot, 'ok.ts'), 'export default { v: 1 };');
    const sha = sha256OfFile(filePath);
    const trustFile: TrustFile = {
      version: 1,
      entries: [{ path: filePath, sha256: sha, scope: 'global', trustedAt: '2026-04-29T00:00:00Z' }],
    };
    const result = verifyTrust(filePath, trustFile);
    expect(result.trusted).toBe(true);
  });

  test('repo scope rejects when remote URL does not match', () => {
    const filePath = writeFile(join(tmpRoot, 'repo.ts'), 'export default { v: 1 };');
    const sha = sha256OfFile(filePath);
    const trustFile: TrustFile = {
      version: 1,
      entries: [
        {
          path: filePath,
          sha256: sha,
          scope: 'repo',
          repoRemoteUrl: 'https://github.com/owner/expected.git',
          trustedAt: '2026-04-29T00:00:00Z',
        },
      ],
    };
    const result = verifyTrust(filePath, trustFile, {
      currentRepoRemoteUrl: 'https://github.com/owner/different.git',
    });
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toBe('repo_remote_mismatch');
  });

  test('repo scope rejects when entry has no repoRemoteUrl set', () => {
    const filePath = writeFile(join(tmpRoot, 'repo.ts'), 'export default { v: 1 };');
    const sha = sha256OfFile(filePath);
    const trustFile: TrustFile = {
      version: 1,
      entries: [{ path: filePath, sha256: sha, scope: 'repo', trustedAt: '2026-04-29T00:00:00Z' }],
    };
    const result = verifyTrust(filePath, trustFile, {
      currentRepoRemoteUrl: 'https://github.com/owner/repo.git',
    });
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toBe('missing_repo_remote');
  });

  test('repo scope accepts when remote URL matches', () => {
    const filePath = writeFile(join(tmpRoot, 'repo.ts'), 'export default { v: 1 };');
    const sha = sha256OfFile(filePath);
    const trustFile: TrustFile = {
      version: 1,
      entries: [
        {
          path: filePath,
          sha256: sha,
          scope: 'repo',
          repoRemoteUrl: 'https://github.com/owner/repo.git',
          trustedAt: '2026-04-29T00:00:00Z',
        },
      ],
    };
    const result = verifyTrust(filePath, trustFile, {
      currentRepoRemoteUrl: 'https://github.com/owner/repo.git',
    });
    expect(result.trusted).toBe(true);
  });
});

describe('parseCapabilities', () => {
  test('returns empty array when no declaration', () => {
    expect(parseCapabilities('export default {};')).toEqual([]);
  });

  test('parses a single-line declaration', () => {
    const source = '// @capabilities: pg-read, fs-read .genie/state/, network\nexport default {};';
    expect(parseCapabilities(source)).toEqual(['pg-read', 'fs-read .genie/state/', 'network']);
  });

  test('handles whitespace around the colon and commas', () => {
    const source = '//   @capabilities:   one   ,    two,three\n';
    expect(parseCapabilities(source)).toEqual(['one', 'two', 'three']);
  });

  test('drops empty entries', () => {
    const source = '// @capabilities: pg-read, , fs-read,\n';
    expect(parseCapabilities(source)).toEqual(['pg-read', 'fs-read']);
  });
});
