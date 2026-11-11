import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'reconcile-channel-manifests.sh');
const REPO_ROOT = join(import.meta.dir, '..');
/** Where the pipeline writes channel manifests. */
const MANIFESTS = join('.well-known', 'v2');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'genie-channel-manifests-'));
  roots.push(path);
  mkdirSync(join(path, MANIFESTS), { recursive: true });
  return path;
}

function manifest(
  channel: string,
  version: string,
  releasedAt = '2026-07-13T00:00:00Z',
  overrides: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    schema_version: 1,
    channel,
    version,
    released_at: releasedAt,
    tarball_base: `https://github.com/automagik-dev/genie/releases/download/v${version}`,
    platforms: ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'],
    ...overrides,
  })}\n`;
}

function run(cwd: string, version: string, channel: string, repository = 'automagik-dev/genie') {
  return Bun.spawnSync(['bash', SCRIPT], {
    cwd,
    env: {
      ...process.env,
      VERSION: version,
      CHANNEL: channel,
      RELEASE_REPOSITORY: repository,
      RELEASED_AT: '2026-07-14T12:00:00Z',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('channel manifest monotonic reconciliation', () => {
  test('stable advances only older pointers and preserves equal/newer downstream feeds byte-for-byte', () => {
    const cwd = root();
    const latest = join(cwd, MANIFESTS, 'latest.json');
    const dev = join(cwd, MANIFESTS, 'dev.json');
    writeFileSync(latest, manifest('stable', '5.260712.9'));
    writeFileSync(dev, manifest('dev', '5.260714.1'));
    const devBefore = readFileSync(dev, 'utf8');

    const result = run(cwd, '5.260713.1', 'stable');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(latest, 'utf8')).version).toBe('5.260713.1');
    expect(readFileSync(dev, 'utf8')).toBe(devBefore);
    expect(result.stdout.toString()).toContain('refusing downgrade to v5.260713.1');
  });

  test('an equal-version replay is byte-for-byte idempotent and preserves released_at', () => {
    const cwd = root();
    const dev = join(cwd, MANIFESTS, 'dev.json');
    writeFileSync(dev, manifest('dev', '5.260714.1'));
    const before = readFileSync(dev, 'utf8');

    const result = run(cwd, '5.260714.1', 'dev');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(dev, 'utf8')).toBe(before);
    expect(result.stdout.toString()).toContain('already points to exact');
  });

  test('a newer dev release advances the dev pointer', () => {
    const cwd = root();
    const dev = join(cwd, MANIFESTS, 'dev.json');
    writeFileSync(dev, manifest('dev', '5.260714.1'));

    const result = run(cwd, '5.260714.2', 'dev');
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(readFileSync(dev, 'utf8')) as { version: string; released_at: string };
    expect(updated.version).toBe('5.260714.2');
    expect(updated.released_at).toBe('2026-07-14T12:00:00Z');
  });

  test('default candidate bytes are retry-stable and derive released_at from the version date', () => {
    const first = root();
    const second = root();
    const env = {
      ...process.env,
      VERSION: '5.260714.2',
      CHANNEL: 'stable',
      RELEASE_REPOSITORY: 'automagik-dev/genie',
    };
    expect(Bun.spawnSync(['bash', SCRIPT], { cwd: first, env }).exitCode).toBe(0);
    expect(Bun.spawnSync(['bash', SCRIPT], { cwd: second, env }).exitCode).toBe(0);
    for (const name of ['latest.json', 'dev.json']) {
      expect(readFileSync(join(first, MANIFESTS, name))).toEqual(readFileSync(join(second, MANIFESTS, name)));
    }
    expect(JSON.parse(readFileSync(join(first, MANIFESTS, 'latest.json'), 'utf8')).released_at).toBe(
      '2026-07-14T00:00:00Z',
    );
  });

  test('CAS reconciliation copies the exact pre-endorsed candidate bytes', () => {
    const candidateRoot = root();
    expect(run(candidateRoot, '5.260714.2', 'stable').exitCode).toBe(0);
    const target = root();
    writeFileSync(join(target, MANIFESTS, 'latest.json'), manifest('stable', '5.260714.1'));
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd: target,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'stable',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-07-14T12:00:00Z',
        CANDIDATE_MANIFEST_DIR: join(candidateRoot, MANIFESTS),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(target, MANIFESTS, 'latest.json'))).toEqual(
      readFileSync(join(candidateRoot, MANIFESTS, 'latest.json')),
    );
    expect(readFileSync(join(target, MANIFESTS, 'dev.json'))).toEqual(
      readFileSync(join(candidateRoot, MANIFESTS, 'dev.json')),
    );
  });

  test('invalid pre-endorsed candidate fails without advancing the pointer', () => {
    const candidateRoot = root();
    writeFileSync(join(candidateRoot, MANIFESTS, 'dev.json'), manifest('stable', '5.260714.2'));
    const target = root();
    const before = manifest('dev', '5.260714.1');
    writeFileSync(join(target, MANIFESTS, 'dev.json'), before);
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd: target,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'dev',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-07-14T12:00:00Z',
        CANDIDATE_MANIFEST_DIR: join(candidateRoot, MANIFESTS),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(join(target, MANIFESTS, 'dev.json'), 'utf8')).toBe(before);
  });

  test('equal-version CAS fails when existing bytes differ from the endorsed candidate', () => {
    const candidateRoot = root();
    expect(run(candidateRoot, '5.260714.2', 'dev').exitCode).toBe(0);
    const target = root();
    const divergent = manifest('dev', '5.260714.2', '2026-07-14T11:59:59Z');
    writeFileSync(join(target, MANIFESTS, 'dev.json'), divergent);
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd: target,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'dev',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-07-14T12:00:00Z',
        CANDIDATE_MANIFEST_DIR: join(candidateRoot, MANIFESTS),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('differs from exact endorsed candidate bytes');
    expect(readFileSync(join(target, MANIFESTS, 'dev.json'), 'utf8')).toBe(divergent);
  });

  test('malformed current state and unsupported candidate versions fail closed', () => {
    const cwd = root();
    writeFileSync(join(cwd, MANIFESTS, 'dev.json'), '{"channel":"dev","version":"newest"}\n');
    expect(run(cwd, '5.260714.2', 'dev').exitCode).toBe(3);
    expect(run(cwd, '5.260714.2-rc.1', 'dev').exitCode).toBe(2);
  });

  test('equal/newer manifests are preserved only after their complete schema validates', () => {
    const corruptions: Record<string, unknown>[] = [
      { schema_version: 2 },
      { released_at: 'not-a-timestamp' },
      { tarball_base: 'https://example.invalid/releases/download/v5.260714.1' },
      { platforms: ['linux-x64-glibc'] },
      { unexpected: true },
    ];
    for (const corruption of corruptions) {
      const cwd = root();
      writeFileSync(join(cwd, MANIFESTS, 'dev.json'), manifest('dev', '5.260714.1', undefined, corruption));
      const result = run(cwd, '5.260714.1', 'dev');
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain('manifest schema is invalid');
    }
  });

  // The repository was renamed while both committed manifests named releases
  // published under the previous name. Those bytes are bound by signed
  // descriptors, so the first release under the new name has to accept them as
  // they are and write its own manifest with the current name.
  test('the first release after the rename advances a manifest committed under the previous name', () => {
    const cwd = root();
    const latest = join(cwd, MANIFESTS, 'latest.json');
    const dev = join(cwd, MANIFESTS, 'dev.json');
    writeFileSync(latest, manifest('stable', '6.261108.1'));
    writeFileSync(dev, manifest('dev', '6.261109.9'));
    const latestBefore = readFileSync(latest, 'utf8');

    const result = run(cwd, '6.261111.2', 'dev', 'automagik-si/genie');
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(readFileSync(dev, 'utf8')) as { version: string; tarball_base: string };
    expect(updated.version).toBe('6.261111.2');
    expect(updated.tarball_base).toBe('https://github.com/automagik-si/genie/releases/download/v6.261111.2');
    expect(readFileSync(latest, 'utf8')).toBe(latestBefore);
  });

  test('the committed manifests of this repository validate under its current name, byte for byte', () => {
    const cwd = root();
    const committed = {
      latest: readFileSync(join(REPO_ROOT, MANIFESTS, 'latest.json')),
      dev: readFileSync(join(REPO_ROOT, MANIFESTS, 'dev.json')),
    };
    writeFileSync(join(cwd, MANIFESTS, 'latest.json'), committed.latest);
    writeFileSync(join(cwd, MANIFESTS, 'dev.json'), committed.dev);
    const version = (JSON.parse(committed.dev.toString()) as { version: string }).version;

    // An equal-version replay changes nothing and must not be refused.
    const result = run(cwd, version, 'dev', 'automagik-si/genie');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(cwd, MANIFESTS, 'dev.json'))).toEqual(committed.dev);
    expect(readFileSync(join(cwd, MANIFESTS, 'latest.json'))).toEqual(committed.latest);
  });

  test('a manifest naming the current repository is not accepted under the previous name', () => {
    const cwd = root();
    writeFileSync(
      join(cwd, MANIFESTS, 'dev.json'),
      manifest('dev', '6.261111.2', undefined, {
        tarball_base: 'https://github.com/automagik-si/genie/releases/download/v6.261111.2',
      }),
    );
    const result = run(cwd, '6.261111.3', 'dev', 'automagik-dev/genie');
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('manifest schema is invalid');
  });

  test('the previous name is accepted for this repository only, and only with the manifest version', () => {
    for (const [repository, base] of [
      ['another-owner/genie', 'https://github.com/automagik-dev/genie/releases/download/v6.261109.9'],
      ['automagik-si/genie', 'https://github.com/automagik-dev/genie/releases/download/v6.261109.8'],
      ['automagik-si/genie', 'https://github.com/automagik-dev/other/releases/download/v6.261109.9'],
    ]) {
      const cwd = root();
      writeFileSync(join(cwd, MANIFESTS, 'dev.json'), manifest('dev', '6.261109.9', undefined, { tarball_base: base }));
      const result = run(cwd, '6.261111.2', 'dev', repository);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain('manifest schema is invalid');
    }
  });

  test('rejects an invalid candidate timestamp before writing manifests', () => {
    const cwd = root();
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'dev',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-99-99T12:00:00Z',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('invalid release timestamp');
    expect(existsSync(join(cwd, MANIFESTS, 'dev.json'))).toBe(false);
  });
});
