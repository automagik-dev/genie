import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'reconcile-channel-manifests.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'genie-channel-manifests-'));
  roots.push(path);
  mkdirSync(join(path, '.well-known'));
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

function run(cwd: string, version: string, channel: string) {
  return Bun.spawnSync(['bash', SCRIPT], {
    cwd,
    env: {
      ...process.env,
      VERSION: version,
      CHANNEL: channel,
      RELEASE_REPOSITORY: 'automagik-dev/genie',
      RELEASED_AT: '2026-07-14T12:00:00Z',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('channel manifest monotonic reconciliation', () => {
  test('stable advances only older pointers and preserves equal/newer downstream feeds byte-for-byte', () => {
    const cwd = root();
    const latest = join(cwd, '.well-known', 'latest.json');
    const homolog = join(cwd, '.well-known', 'homolog.json');
    const dev = join(cwd, '.well-known', 'dev.json');
    writeFileSync(latest, manifest('stable', '5.260712.9'));
    writeFileSync(homolog, manifest('homolog', '5.260713.1'));
    writeFileSync(dev, manifest('dev', '5.260714.1'));
    const homologBefore = readFileSync(homolog, 'utf8');
    const devBefore = readFileSync(dev, 'utf8');

    const result = run(cwd, '5.260713.1', 'stable');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(latest, 'utf8')).version).toBe('5.260713.1');
    expect(readFileSync(homolog, 'utf8')).toBe(homologBefore);
    expect(readFileSync(dev, 'utf8')).toBe(devBefore);
    expect(result.stdout.toString()).toContain('refusing downgrade to v5.260713.1');
  });

  test('an equal-version replay is byte-for-byte idempotent and preserves released_at', () => {
    const cwd = root();
    const dev = join(cwd, '.well-known', 'dev.json');
    writeFileSync(dev, manifest('dev', '5.260714.1'));
    const before = readFileSync(dev, 'utf8');

    const result = run(cwd, '5.260714.1', 'dev');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(dev, 'utf8')).toBe(before);
    expect(result.stdout.toString()).toContain('already points to exact');
  });

  test('a newer dev release advances the dev pointer', () => {
    const cwd = root();
    const dev = join(cwd, '.well-known', 'dev.json');
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
    for (const name of ['latest.json', 'homolog.json', 'dev.json']) {
      expect(readFileSync(join(first, '.well-known', name))).toEqual(readFileSync(join(second, '.well-known', name)));
    }
    expect(JSON.parse(readFileSync(join(first, '.well-known', 'latest.json'), 'utf8')).released_at).toBe(
      '2026-07-14T00:00:00Z',
    );
  });

  test('CAS reconciliation copies the exact pre-endorsed candidate bytes', () => {
    const candidateRoot = root();
    expect(run(candidateRoot, '5.260714.2', 'homolog').exitCode).toBe(0);
    const target = root();
    writeFileSync(join(target, '.well-known', 'homolog.json'), manifest('homolog', '5.260714.1'));
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd: target,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'homolog',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-07-14T12:00:00Z',
        CANDIDATE_MANIFEST_DIR: join(candidateRoot, '.well-known'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(target, '.well-known', 'homolog.json'))).toEqual(
      readFileSync(join(candidateRoot, '.well-known', 'homolog.json')),
    );
    expect(readFileSync(join(target, '.well-known', 'dev.json'))).toEqual(
      readFileSync(join(candidateRoot, '.well-known', 'dev.json')),
    );
  });

  test('invalid pre-endorsed candidate fails without advancing the pointer', () => {
    const candidateRoot = root();
    writeFileSync(join(candidateRoot, '.well-known', 'dev.json'), manifest('stable', '5.260714.2'));
    const target = root();
    const before = manifest('dev', '5.260714.1');
    writeFileSync(join(target, '.well-known', 'dev.json'), before);
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd: target,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'dev',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-07-14T12:00:00Z',
        CANDIDATE_MANIFEST_DIR: join(candidateRoot, '.well-known'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(join(target, '.well-known', 'dev.json'), 'utf8')).toBe(before);
  });

  test('equal-version CAS fails when existing bytes differ from the endorsed candidate', () => {
    const candidateRoot = root();
    expect(run(candidateRoot, '5.260714.2', 'dev').exitCode).toBe(0);
    const target = root();
    const divergent = manifest('dev', '5.260714.2', '2026-07-14T11:59:59Z');
    writeFileSync(join(target, '.well-known', 'dev.json'), divergent);
    const result = Bun.spawnSync(['bash', SCRIPT], {
      cwd: target,
      env: {
        ...process.env,
        VERSION: '5.260714.2',
        CHANNEL: 'dev',
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        RELEASED_AT: '2026-07-14T12:00:00Z',
        CANDIDATE_MANIFEST_DIR: join(candidateRoot, '.well-known'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('differs from exact endorsed candidate bytes');
    expect(readFileSync(join(target, '.well-known', 'dev.json'), 'utf8')).toBe(divergent);
  });

  test('malformed current state and unsupported candidate versions fail closed', () => {
    const cwd = root();
    writeFileSync(join(cwd, '.well-known', 'dev.json'), '{"channel":"dev","version":"newest"}\n');
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
      writeFileSync(join(cwd, '.well-known', 'dev.json'), manifest('dev', '5.260714.1', undefined, corruption));
      const result = run(cwd, '5.260714.1', 'dev');
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
    expect(existsSync(join(cwd, '.well-known', 'dev.json'))).toBe(false);
  });
});
