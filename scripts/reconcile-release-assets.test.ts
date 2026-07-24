import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'reconcile-release-assets.sh');
const VERSION = '5.260714.3';
const CHANNEL = 'dev';
const PLATFORMS = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];
function namesFor(channel: 'stable' | 'homolog' | 'dev'): string[] {
  const channels =
    channel === 'stable' ? ['stable', 'homolog', 'dev'] : channel === 'homolog' ? ['homolog', 'dev'] : ['dev'];
  return PLATFORMS.flatMap((platform) => {
    const tarball = `genie-${VERSION}-${platform}.tar.gz`;
    return [
      tarball,
      `${tarball}.bundle`,
      `${tarball}.intoto.jsonl`,
      ...channels.flatMap((evidenceChannel) => {
        const descriptor = `${tarball}.${evidenceChannel}.delivery.json`;
        return [descriptor, `${descriptor}.sigstore.json`];
      }),
    ];
  });
}
const NAMES = namesFor(CHANNEL);
const roots: string[] = [];
const candidateBytes = (channel: string) => `candidate-manifest:${channel}\n`;

interface FakeState {
  draft: boolean;
  prerelease?: boolean;
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

function localAssets(prefix = 'local', channel: 'stable' | 'homolog' | 'dev' = CHANNEL): Record<string, string> {
  return Object.fromEntries(
    namesFor(channel).map((name) => {
      if (!name.endsWith('.delivery.json')) return [name, `${prefix}:${name}`];
      const platform = PLATFORMS.find((candidate) => name.includes(`-${candidate}.tar.gz`))!;
      const platformTriple = platform.startsWith('linux-x64') ? 'linux-x64' : platform;
      const evidenceChannel = name.match(/\.tar\.gz\.(stable|homolog|dev)\.delivery\.json$/)?.[1];
      return [
        name,
        `${JSON.stringify({
          schemaVersion: 1,
          repository: 'automagik-dev/genie',
          version: VERSION,
          channel: evidenceChannel,
          platformId: platform,
          platformTriple,
          releaseTag: `v${VERSION}`,
          releaseName: `genie-${VERSION}-${platform}.tar.gz`,
          releaseManifestSha256: createHash('sha256').update(candidateBytes(evidenceChannel!)).digest('hex'),
          artifactSha256: createHash('sha256').update(`${prefix}:genie-${VERSION}-${platform}.tar.gz`).digest('hex'),
          installedBinarySha256: '3'.repeat(64),
          canonicalPayloadSha256: '4'.repeat(64),
          digestAlgorithm: 'genie-physical-tree-v1',
          sourceSha: 'a'.repeat(40),
          sourceBranch: channel === 'stable' ? 'main' : channel,
          sourceCiRunId: '123',
          controlSha: 'c'.repeat(40),
        })}\n`,
      ];
    }),
  );
}

function run(
  state: FakeState,
  mutate?: (dist: string) => void,
  channel: 'stable' | 'homolog' | 'dev' = CHANNEL,
  localPrefix = 'local',
) {
  const root = mkdtempSync(join(tmpdir(), 'genie-release-assets-'));
  roots.push(root);
  const dist = join(root, 'dist');
  const candidates = join(root, 'candidates');
  mkdirSync(dist);
  mkdirSync(candidates);
  writeFileSync(join(candidates, 'latest.json'), candidateBytes('stable'));
  writeFileSync(join(candidates, 'homolog.json'), candidateBytes('homolog'));
  writeFileSync(join(candidates, 'dev.json'), candidateBytes('dev'));
  for (const [name, contents] of Object.entries(localAssets(localPrefix, channel)))
    writeFileSync(join(dist, name), contents);
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
  console.log(JSON.stringify({ assets, isDraft: state.draft, isPrerelease: state.prerelease ?? !state.draft }));
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
  if (args.includes('--bundle')) {
    const descriptor = JSON.parse(readFileSync(args[2], 'utf8'));
    console.log(JSON.stringify([{ verificationResult: { statement: { predicate: descriptor } } }]));
    save(); process.exit(0);
  }
  const digest = value('--source-digest') ?? value('--signer-digest');
  if (digest && digest !== state.controlSha) { save(); process.exit(5); }
  const sourceSha = state.invalidNative ? 'not-a-sha' : 'a'.repeat(40);
  const predicateControlSha = digest && state.secondControlSha ? state.secondControlSha : state.controlSha;
  const statement = {
    predicateType: 'https://github.com/automagik-dev/genie/release-tarballs/v1',
    predicate: {
      runDetails: { builder: { id: 'https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@refs/heads/main' } },
      buildDefinition: {
        buildType: 'https://github.com/automagik-dev/genie/release-tarballs/v1',
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
      CHANNEL: channel,
      CANDIDATE_MANIFEST_DIR: candidates,
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
  test('uploads and byte-verifies the exact dev fanout inventory into an empty draft without clobber', () => {
    const { result, state } = run({ draft: true, assets: {} });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(state.assets).sort()).toEqual([...NAMES].sort());
    expect(calls(state, 'gh', 'release upload')).toHaveLength(1);
    expect(state.usedClobber).not.toBe(true);
  });

  test('expands exact descriptor inventory by selected-channel fanout', () => {
    for (const channel of ['dev', 'homolog', 'stable'] as const) {
      const { result, state } = run({ draft: true, assets: {} }, undefined, channel);
      expect(result.exitCode).toBe(0);
      expect(Object.keys(state.assets).sort()).toEqual(namesFor(channel).sort());
    }
    expect(namesFor('dev')).toHaveLength(20);
    expect(namesFor('homolog')).toHaveLength(28);
    expect(namesFor('stable')).toHaveLength(36);
  }, 15_000);

  test('never mutates a published prerelease; channel promotions require fresh immutable tags', () => {
    const devAssets = localAssets('dev-release', 'dev');
    const homolog = run({ draft: false, prerelease: true, assets: devAssets }, undefined, 'homolog', 'dev-release');
    expect(homolog.result.exitCode).toBe(3);
    expect(homolog.result.stderr.toString()).toContain('published immutable release');
    expect(homolog.state.assets).toEqual(devAssets);
    expect(calls(homolog.state, 'gh', 'release upload')).toHaveLength(0);
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

  test('resumes authenticated partial drafts and rejects a cryptographically inconsistent mix', () => {
    const local = localAssets();
    const matching = run({
      draft: true,
      assets: Object.fromEntries(NAMES.slice(0, 2).map((name) => [name, local[name]])),
    });
    expect(matching.result.exitCode).toBe(0);
    expect(Object.keys(matching.state.assets)).toHaveLength(NAMES.length);

    const mismatch = run({ draft: true, assets: { [NAMES[0]]: 'different' } });
    expect(mismatch.result.exitCode).toBe(3);
    expect(calls(mismatch.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('a complete authenticated draft reuses prior nondeterministic bundle bytes', () => {
    const draft = run({ draft: true, assets: localAssets('older-run') });
    expect(draft.result.exitCode).toBe(0);
    expect(draft.result.stdout.toString()).toContain('preserves its complete authenticated draft inventory');
    expect(calls(draft.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('a retry rejects authenticated old descriptors bound to different candidate manifest bytes', () => {
    const stale = localAssets('older-run');
    for (const [name, value] of Object.entries(stale)) {
      if (!name.endsWith('.delivery.json')) continue;
      const descriptor = JSON.parse(value);
      descriptor.releaseManifestSha256 = 'f'.repeat(64);
      stale[name] = `${JSON.stringify(descriptor)}\n`;
    }
    const retry = run({ draft: true, assets: stale });
    expect(retry.result.exitCode).toBe(3);
    expect(calls(retry.state, 'gh', 'release upload')).toHaveLength(0);
  });

  test('an interrupted draft preserves prior bundle bytes while uploading only missing assets', () => {
    const current = localAssets();
    const priorBundle = NAMES.find((name) => name.endsWith('.sigstore.json'))!;
    const partial = {
      [NAMES[0]]: current[NAMES[0]],
      [NAMES[1]]: current[NAMES[1]],
      [NAMES[2]]: current[NAMES[2]],
      [NAMES[3]]: current[NAMES[3]],
      [priorBundle]: 'prior nondeterministic sigstore bundle',
    };
    const resumed = run({ draft: true, assets: partial });
    expect(resumed.result.exitCode).toBe(0);
    expect(resumed.state.assets[priorBundle]).toBe(partial[priorBundle]);
    expect(Object.keys(resumed.state.assets).sort()).toEqual([...NAMES].sort());
    expect(calls(resumed.state, 'gh', 'release upload')).toHaveLength(1);
  });

  test('reuses a complete published inventory only after pinned cryptographic verification', () => {
    const publishedAssets = localAssets('published');
    const { result, state } = run({ draft: false, assets: publishedAssets });
    expect(result.exitCode).toBe(0);
    expect(state.assets).toEqual(publishedAssets);
    expect(calls(state, 'gh', 'release upload')).toHaveLength(0);
    expect(calls(state, 'cosign')).toHaveLength(4);
    expect(calls(state, 'slsa-verifier')).toHaveLength(4);
    expect(calls(state, 'gh', 'attestation verify')).toHaveLength(12);
    const tarballAttestations = calls(state, 'gh', 'attestation verify').filter(
      (call) => !call.args.includes('--bundle'),
    );
    for (const secondPass of tarballAttestations.filter((_, index) => index % 2 === 1)) {
      expect(secondPass.args).toContain('--source-digest');
      expect(secondPass.args).toContain('--signer-digest');
    }
    for (const delivery of calls(state, 'gh', 'attestation verify').filter((call) => call.args.includes('--bundle'))) {
      expect(delivery.args).toContain('https://github.com/automagik-dev/genie/delivery-evidence/v1');
      expect(delivery.args).toContain(
        'https://github.com/automagik-dev/genie/.github/workflows/release-publish.yml@refs/heads/main',
      );
    }
  });

  test('never repairs a partial published release or accepts remote extras', () => {
    const partial = run({ draft: false, prerelease: false, assets: { [NAMES[0]]: localAssets()[NAMES[0]] } });
    expect(partial.result.exitCode).toBe(3);
    expect(partial.result.stderr.toString()).toContain('incomplete published immutable release');
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

    const endorsement = run({ draft: true, assets: {}, failOn: 'gh attestation verify' });
    expect(endorsement.result.exitCode).toBe(42);

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
