import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The repository was renamed in 2026-11. Every genie released before that reads
// its channel from .well-known/latest.json or .well-known/dev.json and accepts
// only a release signed under the previous name, so those two files stay on the
// last such releases for good. The pipeline and every newer genie use
// .well-known/v2/ instead.
//
// This file owns the "stay for good" half: the bytes, the one script that writes
// channel manifests, and every line of the pipeline and the clients that names
// the old location.

const REPO_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(import.meta.dir, 'reconcile-channel-manifests.sh');

/** The frozen pair: file, the release it stays on, and the sha256 of its bytes. */
const FROZEN = [
  {
    file: 'latest.json',
    version: '6.261108.1',
    sha256: '9a8ec392d98b18c64b20cbeca959dfe7717604fcdb5f8b1a2c8e255457b65cc7',
  },
  {
    file: 'dev.json',
    version: '6.261109.9',
    sha256: '06119a7bcc1bad9f3295fe6420ea13e212931d5a08fb0a72725dd47a8dd22e1e',
  },
] as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A working tree holding the frozen pair exactly as this repository commits it. */
function treeWithFrozenPair(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-frozen-manifests-'));
  roots.push(root);
  mkdirSync(join(root, '.well-known'));
  for (const { file } of FROZEN) {
    writeFileSync(join(root, '.well-known', file), readFileSync(join(REPO_ROOT, '.well-known', file)));
  }
  return root;
}

function snapshot(root: string) {
  return FROZEN.map(({ file }) => {
    const path = join(root, '.well-known', file);
    const stat = statSync(path);
    return { file, sha256: sha256(readFileSync(path)), ino: stat.ino, mtimeMs: stat.mtimeMs, mode: stat.mode };
  });
}

function reconcile(cwd: string, env: Record<string, string>) {
  return Bun.spawnSync(['bash', SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('the frozen channel manifests', () => {
  test('are the committed bytes of the last releases signed under the previous name', () => {
    for (const { file, version, sha256: expected } of FROZEN) {
      const bytes = readFileSync(join(REPO_ROOT, '.well-known', file));
      expect(sha256(bytes)).toBe(expected);
      const manifest = JSON.parse(bytes.toString()) as { version: string; tarball_base: string };
      expect(manifest.version).toBe(version);
      expect(manifest.tarball_base).toBe(`https://github.com/automagik-dev/genie/releases/download/v${version}`);
    }
  });

  test('the v2 pair exists and never names a release older than the frozen one', () => {
    for (const { file, version } of FROZEN) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.well-known', 'v2', file), 'utf8')) as {
        version: string;
      };
      const [frozen, current] = [version, manifest.version].map((v) => v.split('.').map(Number));
      const order = current.map((part, index) => part - frozen[index]).find((difference) => difference !== 0) ?? 0;
      expect(order).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('reconcile-channel-manifests.sh never touches the frozen pair', () => {
  const REPOSITORIES = ['automagik-si/genie', 'automagik-dev/genie', 'another-owner/genie'];
  const CHANNELS = ['stable', 'dev'];
  const VERSION = '6.261111.2';

  for (const repository of REPOSITORIES) {
    for (const channel of CHANNELS) {
      test(`${repository}, ${channel}: a first run and a replay write .well-known/v2 only`, () => {
        const cwd = treeWithFrozenPair();
        const before = snapshot(cwd);

        for (const _run of ['first', 'replay']) {
          const result = reconcile(cwd, { VERSION, CHANNEL: channel, RELEASE_REPOSITORY: repository });
          expect(result.stderr.toString()).toBe('');
          expect(result.exitCode).toBe(0);
          expect(snapshot(cwd)).toEqual(before);
        }

        expect(readdirSync(join(cwd, '.well-known')).sort()).toEqual(['dev.json', 'latest.json', 'v2']);
        const written = JSON.parse(readFileSync(join(cwd, '.well-known', 'v2', 'dev.json'), 'utf8')) as {
          version: string;
          tarball_base: string;
        };
        expect(written.version).toBe(VERSION);
        expect(written.tarball_base).toBe(`https://github.com/${repository}/releases/download/v${VERSION}`);
        expect(existsSync(join(cwd, '.well-known', 'v2', 'latest.json'))).toBe(channel === 'stable');
      });

      test(`${repository}, ${channel}: the commit step, fed pre-endorsed candidates, writes .well-known/v2 only`, () => {
        // The pipeline runs the script twice: once in an empty directory to produce
        // the candidates the descriptors bind, once on main with those candidates.
        const candidates = mkdtempSync(join(tmpdir(), 'genie-frozen-candidates-'));
        roots.push(candidates);
        expect(reconcile(candidates, { VERSION, CHANNEL: channel, RELEASE_REPOSITORY: repository }).exitCode).toBe(0);
        expect(readdirSync(join(candidates, '.well-known'))).toEqual(['v2']);

        const cwd = treeWithFrozenPair();
        const before = snapshot(cwd);
        const result = reconcile(cwd, {
          VERSION,
          CHANNEL: channel,
          RELEASE_REPOSITORY: repository,
          CANDIDATE_MANIFEST_DIR: join(candidates, '.well-known', 'v2'),
        });
        expect(result.stderr.toString()).toBe('');
        expect(result.exitCode).toBe(0);
        expect(snapshot(cwd)).toEqual(before);
        expect(readdirSync(join(cwd, '.well-known')).sort()).toEqual(['dev.json', 'latest.json', 'v2']);
        expect(readFileSync(join(cwd, '.well-known', 'v2', 'dev.json'))).toEqual(
          readFileSync(join(candidates, '.well-known', 'v2', 'dev.json')),
        );
      });
    }
  }

  test('a tree without the frozen pair does not get one', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'genie-frozen-manifests-'));
    roots.push(cwd);
    expect(reconcile(cwd, { VERSION, CHANNEL: 'stable', RELEASE_REPOSITORY: 'automagik-si/genie' }).exitCode).toBe(0);
    expect(readdirSync(join(cwd, '.well-known'))).toEqual(['v2']);
    expect(readdirSync(join(cwd, '.well-known', 'v2')).sort()).toEqual(['dev.json', 'latest.json']);
  });

  test('the manifest directory is not an input: an environment value naming the old location is ignored', () => {
    const cwd = treeWithFrozenPair();
    const before = snapshot(cwd);
    const result = reconcile(cwd, {
      VERSION,
      CHANNEL: 'stable',
      RELEASE_REPOSITORY: 'automagik-si/genie',
      MANIFEST_DIR: '.well-known',
    });
    expect(result.exitCode).toBe(0);
    expect(snapshot(cwd)).toEqual(before);
    expect(readdirSync(join(cwd, '.well-known', 'v2')).sort()).toEqual(['dev.json', 'latest.json']);
  });

  test('a candidate directory that IS the old location cannot move the frozen pair', () => {
    // The frozen files name older releases, so as candidates for this version they
    // are refused; the old location is read as a candidate and never written.
    const cwd = treeWithFrozenPair();
    const before = snapshot(cwd);
    const result = reconcile(cwd, {
      VERSION,
      CHANNEL: 'stable',
      RELEASE_REPOSITORY: 'automagik-si/genie',
      CANDIDATE_MANIFEST_DIR: join(cwd, '.well-known'),
    });
    expect(result.exitCode).toBe(3);
    expect(snapshot(cwd)).toEqual(before);
    expect(readdirSync(join(cwd, '.well-known', 'v2'))).toEqual([]);
  });

  test('a refused run leaves the frozen pair alone too', () => {
    const cwd = treeWithFrozenPair();
    mkdirSync(join(cwd, '.well-known', 'v2'));
    writeFileSync(join(cwd, '.well-known', 'v2', 'dev.json'), '{"channel":"dev","version":"newest"}\n');
    const before = snapshot(cwd);
    const result = reconcile(cwd, { VERSION, CHANNEL: 'dev', RELEASE_REPOSITORY: 'automagik-si/genie' });
    expect(result.exitCode).toBe(3);
    expect(snapshot(cwd)).toEqual(before);
  });

  test('a symlinked v2 directory pointing at the old location is refused', () => {
    const cwd = treeWithFrozenPair();
    const before = snapshot(cwd);
    Bun.spawnSync(['ln', '-s', '.', join(cwd, '.well-known', 'v2')]);
    const result = reconcile(cwd, { VERSION, CHANNEL: 'stable', RELEASE_REPOSITORY: 'automagik-si/genie' });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('.well-known/v2 must be a physical directory');
    expect(snapshot(cwd)).toEqual(before);
  });
});

describe('every place that names the old manifest location', () => {
  /** Tracked pipeline and client sources: workflows, scripts, the installer, the CLI. */
  function sources(): string[] {
    const listed = Bun.spawnSync(
      ['git', 'ls-files', '-z', '--', '.github/workflows', '.github/actions', 'scripts', 'install.sh', 'src'],
      { cwd: REPO_ROOT, stdout: 'pipe' },
    );
    expect(listed.exitCode).toBe(0);
    return listed.stdout
      .toString()
      .split('\0')
      .filter((path) => path !== '' && !/\.test\.ts$|test-support\.ts$/.test(path));
  }

  /** A line that is only a comment, in YAML, shell or TypeScript. */
  function isComment(line: string): boolean {
    return /^\s*(#|\/\/|\*|\/\*)/.test(line);
  }

  // `.well-known/` followed by anything but the `v2` directory or `security.txt`: a
  // literal old file, a glob, or an interpolation directly under the old directory.
  const OLD_LOCATION = /\.well-known\/(?!v2(?![\w.-])|security\.txt)/;

  test('is a read-only comparison: no step, script or client line writes or reads a manifest there', () => {
    const found: Record<string, string[]> = {};
    for (const path of sources()) {
      const lines = readFileSync(join(REPO_ROOT, path), 'utf8')
        .split('\n')
        .filter((line) => OLD_LOCATION.test(line) && !isComment(line))
        .map((line) => line.trim());
      if (lines.length > 0) found[path] = lines;
    }
    expect(found).toEqual({
      // Stops the manifest commit when the frozen pair differs from the fetched main.
      '.github/workflows/release-publish.yml': [
        'if ! git diff --quiet HEAD -- .well-known/latest.json .well-known/dev.json ||',
        '[[ -n "$(git status --porcelain -- .well-known/latest.json .well-known/dev.json)" ]]; then',
        'echo "::error::release-manifest.frozen .well-known/latest.json and .well-known/dev.json must not change"',
      ],
      // Pathspec exclusions of a tree comparison.
      '.github/workflows/version.yml': [
        "':(exclude).well-known/latest.json' \\",
        "':(exclude).well-known/dev.json' \\",
      ],
    });
  });

  test('the one script that writes channel manifests holds the directory as a constant', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script.match(/^MANIFEST_DIR=.*$/gm)).toEqual(['MANIFEST_DIR=".well-known/v2"']);
    expect(script).not.toContain('${MANIFEST_DIR:');
    // Every path it creates, replaces or removes is built from that constant.
    const writes = script.split('\n').filter((line) => /\b(mktemp|mv|cp|rm|mkdir)\b/.test(line) && !/^\s*#/.test(line));
    expect(writes.map((line) => line.trim())).toEqual([
      'mkdir "$directory"',
      'temporary="$(mktemp "${MANIFEST_DIR}/.${file}.XXXXXX")"',
      'rm -f "$temporary"',
      'cp "$candidate" "$temporary"',
      'rm -f "$temporary"',
      'mv "$temporary" "$path"',
    ]);
    expect(script).toContain('path="${MANIFEST_DIR}/${file}"');
    expect(script).toContain('for directory in .well-known "$MANIFEST_DIR"; do');
  });

  test('the publish job stages only v2 manifests, after the frozen-pair check', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release-publish.yml'), 'utf8');
    const step = workflow.slice(
      workflow.indexOf('- name: Update channel manifests'),
      workflow.indexOf('\n  finalize:'),
    );
    expect(step).not.toBe('');
    // One staging command and one commit in the step, and nothing stages by glob or by directory.
    expect(step.match(/\bgit add\b.*$/gm)).toEqual(['git add -- "${MANIFEST_PATHS[@]}"']);
    expect(step.match(/MANIFEST_PATHS\+=.*$/gm)).toEqual(['MANIFEST_PATHS+=(".well-known/v2/${f}")']);
    expect(step).not.toMatch(/git (add|commit) (-A|-a|--all|\.)/);
    expect(step.match(/\bgit commit\b/g)).toHaveLength(1);
    const guard = step.indexOf('release-manifest.frozen');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(step.indexOf('bash "$MANIFEST_RECONCILER"'));
    expect(guard).toBeLessThan(step.indexOf('git add'));
    expect(guard).toBeLessThan(step.indexOf('git push'));
  });

  test('no other workflow commits to the repository from a release job', () => {
    // The manifest commit above is the only `git push` to a branch in the release chain.
    const pushes: string[] = [];
    for (const name of ['release.yml', 'release-publish.yml', 'sign-attest.yml']) {
      const path = join(REPO_ROOT, '.github', 'workflows', name);
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (/\bgit push\b/.test(line) && !isComment(line)) pushes.push(`${name}: ${line.trim()}`);
      }
    }
    expect(pushes).toEqual([
      'release-publish.yml: if push_output="$(git push origin "HEAD:refs/heads/main" 2>&1)"; then',
    ]);
  });

  test('the update client and the installer read v2, by name and by repository id', () => {
    const update = readFileSync(join(REPO_ROOT, 'src', 'genie-commands', 'update.ts'), 'utf8');
    expect(update).toContain("const MANIFEST_DIRECTORY = '.well-known/v2';");
    expect(update.split('${MANIFEST_DIRECTORY}/${manifestFileName(channel)}').length - 1).toBe(2);
    const install = readFileSync(join(REPO_ROOT, 'install.sh'), 'utf8');
    expect(install).toContain('MANIFEST_BASE="https://raw.githubusercontent.com/${REPO}/main/.well-known/v2"');
    expect(install).toContain(
      'MANIFEST_API_BASE="https://api.github.com/repositories/${EXPECTED_REPOSITORY_ID}/contents/.well-known/v2"',
    );
  });
});
