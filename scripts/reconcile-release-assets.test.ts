import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'reconcile-release-assets.sh');
const VERSION = '5.260714.3';
const PLATFORMS = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];
const NAMES = PLATFORMS.flatMap((platform) => {
  const tarball = `genie-${VERSION}-${platform}.tar.gz`;
  return [tarball, `${tarball}.bundle`, `${tarball}.intoto.jsonl`];
});
const roots: string[] = [];

interface FakeState {
  draft: boolean;
  assets: Record<string, string>;
  calls?: Array<{ tool: string; args: string[] }>;
  failOn?: string;
  controlSha?: string;
  secondControlSha?: string;
  remoteAssets?: unknown;
  invalidGeneric?: boolean;
  invalidNative?: boolean;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function localAssets(prefix = 'local'): Record<string, string> {
  return Object.fromEntries(NAMES.map((name) => [name, `${prefix}:${name}`]));
}

function run(state: FakeState, mutate?: (dist: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'genie-release-assets-'));
  roots.push(root);
  const dist = join(root, 'dist');
  mkdirSync(dist);
  for (const [name, contents] of Object.entries(localAssets())) writeFileSync(join(dist, name), contents);
  mutate?.(dist);

  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify({ controlSha: 'c'.repeat(40), ...state }));
  const recordPrelude = `
import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.GH_FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls ??= [];
const save = () => writeFileSync(statePath, JSON.stringify(state));
const record = (tool) => { state.calls.push({ tool, args }); };
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
`;

  writeFileSync(
    join(root, 'gh'),
    `#!/usr/bin/env bun
${recordPrelude}
import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
record('gh');
if (state.failOn && ('gh ' + args.join(' ')).includes(state.failOn)) { save(); process.exit(42); }
if (args[0] === 'release' && args[1] === 'view') {
  const assets = state.remoteAssets ?? Object.keys(state.assets).map((name) => ({ name }));
  console.log(JSON.stringify({ assets, isDraft: state.draft }));
  save(); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'download') {
  const name = value('--pattern');
  const dir = value('--dir');
  if (!(name in state.assets)) { save(); process.exit(4); }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), state.assets[name]);
  save(); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'upload') {
  if (args.includes('--clobber')) state.usedClobber = true;
  const paths = [];
  for (let index = 3; index < args.length; index += 1) {
    if (args[index] === '--repo') { index += 1; continue; }
    if (!args[index].startsWith('-')) paths.push(args[index]);
  }
  for (const path of paths) state.assets[basename(path)] = readFileSync(path, 'utf8');
  save(); process.exit(0);
}
if (args[0] === 'attestation' && args[1] === 'verify') {
  const digest = value('--source-digest') ?? value('--signer-digest');
  if (digest && digest !== state.controlSha) { save(); process.exit(5); }
  const sourceSha = state.invalidNative ? 'not-a-sha' : 'a'.repeat(40);
  const predicateControlSha = digest && state.secondControlSha ? state.secondControlSha : state.controlSha;
  const statement = {
    predicateType: 'https://github.com/automagik-dev/genie/release-tarballs@v1',
    predicate: {
      runDetails: { builder: { id: 'https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@refs/heads/main' } },
      buildDefinition: {
        buildType: 'https://github.com/automagik-dev/genie/release-tarballs@v1',
        externalParameters: {
          version: '${VERSION}', channel: 'dev', source_sha: sourceSha, source_branch: 'dev',
          source_ci_run_id: '123', control_sha: predicateControlSha,
        },
        resolvedDependencies: [
          { uri: 'git+https://github.com/automagik-dev/genie@refs/heads/dev', digest: { gitCommit: sourceSha } },
          { uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main', digest: { gitCommit: predicateControlSha } },
        ],
      },
    },
  };
  console.log(JSON.stringify([{ verificationResult: { statement } }]));
  save(); process.exit(0);
}
save(); process.exit(2);
`,
  );

  writeFileSync(
    join(root, 'cosign'),
    `#!/usr/bin/env bun
${recordPrelude}
record('cosign');
if (state.failOn && ('cosign ' + args.join(' ')).includes(state.failOn)) { save(); process.exit(42); }
save();
`,
  );

  writeFileSync(
    join(root, 'slsa-verifier'),
    `#!/usr/bin/env bun
${recordPrelude}
record('slsa-verifier');
if (state.failOn && ('slsa-verifier ' + args.join(' ')).includes(state.failOn)) { save(); process.exit(42); }
const headBranch = state.invalidGeneric ? 'main' : 'dev';
console.log(JSON.stringify({
  predicateType: 'https://slsa.dev/provenance/v0.2',
  predicate: {
    builder: { id: 'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0' },
    buildType: 'https://github.com/slsa-framework/slsa-github-generator/generic@v1',
    invocation: {
      configSource: {
        uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main',
        digest: { sha1: state.controlSha },
        entryPoint: '.github/workflows/version.yml',
      },
      environment: {
        github_event_name: 'workflow_run', github_ref: 'refs/heads/main', github_sha1: state.controlSha,
        github_event_payload: { workflow_run: {
          id: 123, path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success',
          head_branch: headBranch, repository: { full_name: 'automagik-dev/genie' },
        } },
      },
    },
    materials: [{ uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main', digest: { sha1: state.controlSha } }],
  },
}));
save();
`,
  );
  for (const tool of ['gh', 'cosign', 'slsa-verifier']) chmodSync(join(root, tool), 0o755);

  const result = Bun.spawnSync(['bash', SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      GH_FAKE_STATE: statePath,
      VERSION,
      RELEASE_REPOSITORY: 'automagik-dev/genie',
      DIST_DIR: dist,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { result, state: JSON.parse(readFileSync(statePath, 'utf8')) as FakeState & { usedClobber?: boolean } };
}

function calls(state: FakeState, tool: string, command?: string): Array<{ tool: string; args: string[] }> {
  return (state.calls ?? []).filter(
    (call) => call.tool === tool && (!command || call.args.slice(0, 2).join(' ') === command),
  );
}

describe('exact GitHub release asset reconciliation', () => {
  test('uploads and byte-verifies all 12 assets into an empty draft without clobber', () => {
    const { result, state } = run({ draft: true, assets: {} });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(state.assets).sort()).toEqual([...NAMES].sort());
    expect(calls(state, 'gh', 'release upload')).toHaveLength(1);
    expect(state.usedClobber).not.toBe(true);
  });

  test('rejects missing and extra local inventory before any GitHub mutation', () => {
    const missing = run({ draft: true, assets: {} }, (dist) => rmSync(join(dist, NAMES[0])));
    expect(missing.result.exitCode).toBe(3);
    expect(calls(missing.state, 'gh')).toHaveLength(0);

    const extra = run({ draft: true, assets: {} }, (dist) => writeFileSync(join(dist, 'unexpected'), 'x'));
    expect(extra.result.exitCode).toBe(3);
    expect(calls(extra.state, 'gh')).toHaveLength(0);
  });

  test('rejects empty, symlinked, and directory local assets before GitHub mutation', () => {
    const empty = run({ draft: true, assets: {} }, (dist) => writeFileSync(join(dist, NAMES[0]), ''));
    expect(empty.result.exitCode).toBe(3);
    expect(calls(empty.state, 'gh')).toHaveLength(0);

    const directory = run({ draft: true, assets: {} }, (dist) => {
      rmSync(join(dist, NAMES[0]));
      mkdirSync(join(dist, NAMES[0]));
    });
    expect(directory.result.exitCode).toBe(3);
    expect(calls(directory.state, 'gh')).toHaveLength(0);

    const symlink = run({ draft: true, assets: {} }, (dist) => {
      rmSync(join(dist, NAMES[0]));
      symlinkSync(join(dist, NAMES[1]), join(dist, NAMES[0]));
    });
    expect(symlink.result.exitCode).toBe(3);
    expect(calls(symlink.state, 'gh')).toHaveLength(0);
  });

  test('resumes a matching partial draft and refuses a mismatched partial draft', () => {
    const local = localAssets();
    const matching = run({
      draft: true,
      assets: Object.fromEntries(NAMES.slice(0, 2).map((name) => [name, local[name]])),
    });
    expect(matching.result.exitCode).toBe(0);
    expect(Object.keys(matching.state.assets)).toHaveLength(12);

    const mismatch = run({ draft: true, assets: { [NAMES[0]]: 'different' } });
    expect(mismatch.result.exitCode).toBe(3);
    expect(mismatch.result.stderr.toString()).toContain('refusing to replace');
    expect(calls(mismatch.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('a complete draft must match the current run byte-for-byte', () => {
    const draft = run({ draft: true, assets: localAssets('older-run') });
    expect(draft.result.exitCode).toBe(3);
    expect(draft.result.stderr.toString()).toContain('complete draft assets differ');
    expect(calls(draft.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('reuses a complete published inventory only after pinned cryptographic verification', () => {
    const publishedAssets = localAssets('published');
    const { result, state } = run({ draft: false, assets: publishedAssets });
    expect(result.exitCode).toBe(0);
    expect(state.assets).toEqual(publishedAssets);
    expect(calls(state, 'gh', 'release upload')).toHaveLength(0);
    expect(calls(state, 'cosign')).toHaveLength(4);
    expect(calls(state, 'slsa-verifier')).toHaveLength(4);
    expect(calls(state, 'gh', 'attestation verify')).toHaveLength(8);
    for (const secondPass of calls(state, 'gh', 'attestation verify').filter((_, index) => index % 2 === 1)) {
      expect(secondPass.args).toContain('--source-digest');
      expect(secondPass.args).toContain('--signer-digest');
    }
  });

  test('never repairs a partial published release or accepts remote extras', () => {
    const partial = run({ draft: false, assets: { [NAMES[0]]: localAssets()[NAMES[0]] } });
    expect(partial.result.exitCode).toBe(3);
    expect(partial.result.stderr.toString()).toContain('incomplete published release');
    expect(calls(partial.state, 'gh', 'release upload')).toHaveLength(0);

    const extra = run({ draft: true, assets: { unexpected: 'x' } });
    expect(extra.result.exitCode).toBe(3);
    expect(extra.result.stderr.toString()).toContain('unexpected assets');
    expect(calls(extra.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('rejects duplicate and malformed remote inventory before upload', () => {
    const duplicate = run({
      draft: true,
      assets: {},
      remoteAssets: [{ name: NAMES[0] }, { name: NAMES[0] }],
    });
    expect(duplicate.result.exitCode).toBe(3);
    expect(calls(duplicate.state, 'gh', 'release upload')).toHaveLength(0);

    const malformed = run({ draft: true, assets: {}, remoteAssets: [{ name: 7 }] });
    expect(malformed.result.exitCode).toBe(3);
    expect(calls(malformed.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('propagates upload and verification failures', () => {
    const upload = run({ draft: true, assets: {}, failOn: 'gh release upload' });
    expect(upload.result.exitCode).toBe(42);

    const verification = run({ draft: false, assets: localAssets('published'), failOn: 'cosign verify-blob' });
    expect(verification.result.exitCode).toBe(42);
    expect(calls(verification.state, 'gh', 'release upload')).toHaveLength(0);

    const mismatchedSecondPass = run({
      draft: false,
      assets: localAssets('published'),
      secondControlSha: 'd'.repeat(40),
    });
    expect(mismatchedSecondPass.result.exitCode).toBe(3);
    expect(mismatchedSecondPass.result.stderr.toString()).toContain('control digest mismatch');

    const genericPolicy = run({ draft: false, assets: localAssets('published'), invalidGeneric: true });
    expect(genericPolicy.result.exitCode).not.toBe(0);
    expect(calls(genericPolicy.state, 'gh', 'release upload')).toHaveLength(0);

    const nativePolicy = run({ draft: false, assets: localAssets('published'), invalidNative: true });
    expect(nativePolicy.result.exitCode).not.toBe(0);
    expect(calls(nativePolicy.state, 'gh', 'release upload')).toHaveLength(0);
  }, 15_000);
});
