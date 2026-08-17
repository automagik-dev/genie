import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'reconcile-release-assets.sh');
const VERSION = '5.260714.3';
const CHANNEL = 'dev';
const PLATFORMS = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];
function namesFor(channel: 'stable' | 'dev'): string[] {
  const channels = channel === 'stable' ? ['stable', 'dev'] : ['dev'];
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
  assetIds?: Record<string, number>;
  calls?: Array<{ tool: string; args: string[] }>;
  attestationBatchSizes?: number[];
  failOn?: string;
  failTimes?: Record<string, number>;
  noRelease?: boolean;
  uploadLandThenFail?: number;
  uploadCorruptFirst?: boolean;
  controlSha?: string;
  secondControlSha?: string;
  remoteAssets?: unknown;
  invalidGeneric?: boolean;
  invalidNative?: boolean;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function localAssets(prefix = 'local', channel: 'stable' | 'dev' = CHANNEL): Record<string, string> {
  return Object.fromEntries(
    namesFor(channel).map((name) => {
      if (!name.endsWith('.delivery.json')) return [name, `${prefix}:${name}`];
      const platform = PLATFORMS.find((candidate) => name.includes(`-${candidate}.tar.gz`))!;
      const platformTriple = platform.startsWith('linux-x64') ? 'linux-x64' : platform;
      const evidenceChannel = name.match(/\.tar\.gz\.(stable|dev)\.delivery\.json$/)?.[1];
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
  channel: 'stable' | 'dev' = CHANNEL,
  localPrefix = 'local',
) {
  const root = mkdtempSync(join(tmpdir(), 'genie-release-assets-'));
  roots.push(root);
  const dist = join(root, 'dist');
  const candidates = join(root, 'candidates');
  mkdirSync(dist);
  mkdirSync(candidates);
  writeFileSync(join(candidates, 'latest.json'), candidateBytes('stable'));
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
record('gh');
const joined = 'gh ' + args.join(' ');
if (state.failTimes) {
  for (const key of Object.keys(state.failTimes)) {
    if (state.failTimes[key] > 0 && joined.includes(key)) {
      state.failTimes[key] -= 1;
      save();
      console.error('gh: Internal Server Error (HTTP 502)');
      process.exit(1);
    }
  }
}
if (state.failOn && joined.includes(state.failOn)) { save(); process.exit(42); }
const ensureIds = () => {
  state.assetIds ??= {};
  let next = Object.values(state.assetIds).reduce((left, right) => Math.max(left, right), 0);
  for (const name of Object.keys(state.assets)) if (!(name in state.assetIds)) state.assetIds[name] = ++next;
};
const releaseJson = () => {
  ensureIds();
  const assets = state.remoteAssets ?? Object.keys(state.assets).map((name) => ({ name, id: state.assetIds[name] }));
  return JSON.stringify({
    id: 500,
    tag_name: 'v${VERSION}',
    draft: state.draft,
    prerelease: state.prerelease ?? !state.draft,
    assets,
  });
};
if (args[0] === 'api' && /\\/releases\\/tags\\//.test(args[1] ?? '')) {
  // Published releases resolve via the tag ref; drafts have none.
  if (!state.noRelease && state.draft !== true) { console.log(releaseJson()); save(); process.exit(0); }
  save();
  console.error('gh: Not Found (HTTP 404)');
  process.exit(1);
}
if (args[0] === 'api' && args.includes('--paginate')) {
  if (!state.noRelease && state.draft === true) console.log('500');
  save();
  process.exit(0);
}
const assetPath = args.find((arg) => /\\/releases\\/assets\\/[0-9]+$/.test(arg));
if (args[0] === 'api' && assetPath) {
  ensureIds();
  const id = Number(assetPath.split('/').pop());
  const name = Object.keys(state.assetIds).find((candidate) => state.assetIds[candidate] === id);
  if (!name || !(name in state.assets)) { save(); console.error('gh: Not Found (HTTP 404)'); process.exit(4); }
  process.stdout.write(state.assets[name]);
  save();
  process.exit(0);
}
if (args[0] === 'api' && args.includes('POST') && args.some((arg) => arg.includes('uploads.github.com'))) {
  if (args.includes('--clobber')) state.usedClobber = true;
  const url = args.find((arg) => arg.includes('uploads.github.com'));
  const name = url.split('name=')[1];
  const bytes = readFileSync(value('--input'), 'utf8');
  ensureIds();
  if (name in state.assets) {
    save();
    console.error('HTTP 422: Validation Failed (already_exists)');
    process.exit(1);
  }
  if (state.uploadLandThenFail && state.uploadLandThenFail > 0) {
    // The upload landed server-side but the response was lost: store the
    // bytes, then report a transient failure so the caller retries into
    // already_exists.
    state.uploadLandThenFail -= 1;
    state.assets[name] = state.uploadCorruptFirst ? 'corrupted-bytes-from-lost-response' : bytes;
    ensureIds();
    save();
    console.error('gh: unexpected EOF');
    process.exit(1);
  }
  state.assets[name] = bytes;
  ensureIds();
  save();
  process.exit(0);
}
if (args[0] === 'api' && !args.includes('POST') && /\\/releases\\/500$/.test(args[1] ?? '')) {
  if (state.noRelease) { save(); console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(releaseJson());
  save();
  process.exit(0);
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
  // A published tarball carries TWO attestations for the same digest: GitHub's
  // own in-toto immutable-release attestation (minted when the release is
  // locked) and ours. The attestations API returns both, GitHub's first.
  // Production must select by predicate type — never by position or by count.
  const immutableRelease = {
    verificationResult: {
      statement: {
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://in-toto.io/attestation/release/v0.2',
        subject: [{ name: 'genie-${VERSION}', digest: { sha256: 'e'.repeat(64) } }],
        predicate: { purl: 'pkg:github/automagik-dev/genie@v${VERSION}', releaseId: 4242 },
      },
    },
  };
  const attestations = [immutableRelease, { verificationResult: { statement } }];
  state.attestationBatchSizes ??= [];
  state.attestationBatchSizes.push(attestations.length);
  console.log(JSON.stringify(attestations));
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
      GH_RETRY_SLEEPS: '0 0 0 0',
      GH_RETRY_LOOKUP_LAG_SLEEP: '0',
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

function uploadCalls(state: FakeState): Array<{ tool: string; args: string[] }> {
  return (state.calls ?? []).filter(
    (call) => call.tool === 'gh' && call.args.some((arg) => arg.includes('uploads.github.com')),
  );
}

describe('exact GitHub release asset reconciliation', () => {
  test('uploads and byte-verifies the exact dev fanout inventory into an empty draft without clobber', () => {
    const { result, state } = run({ draft: true, assets: {} });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(state.assets).sort()).toEqual([...NAMES].sort());
    // One by-id POST per asset — finer resumption than the old batch upload.
    expect(uploadCalls(state)).toHaveLength(NAMES.length);
    expect(state.usedClobber).not.toBe(true);
  });

  test('expands exact descriptor inventory by selected-channel fanout', () => {
    for (const channel of ['dev', 'stable'] as const) {
      const { result, state } = run({ draft: true, assets: {} }, undefined, channel);
      expect(result.exitCode).toBe(0);
      expect(Object.keys(state.assets).sort()).toEqual(namesFor(channel).sort());
    }
    // Per platform: tarball + bundle + intoto (3) plus (descriptor +
    // sigstore bundle) per evidence channel. 4 platforms:
    //   dev    = 4 * (3 + 1*2) = 20
    //   stable = 4 * (3 + 2*2) = 28
    expect(namesFor('dev')).toHaveLength(20);
    expect(namesFor('stable')).toHaveLength(28);
  }, 15_000);

  test('never mutates a published prerelease; channel promotions require fresh immutable tags', () => {
    const devAssets = localAssets('dev-release', 'dev');
    const stable = run({ draft: false, prerelease: true, assets: devAssets }, undefined, 'stable', 'dev-release');
    expect(stable.result.exitCode).toBe(3);
    expect(stable.result.stderr.toString()).toContain('published immutable release');
    expect(stable.state.assets).toEqual(devAssets);
    expect(uploadCalls(stable.state)).toHaveLength(0);
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
    expect(uploadCalls(mismatch.state)).toHaveLength(0);
  });

  test('a complete authenticated draft reuses prior nondeterministic bundle bytes', () => {
    const draft = run({ draft: true, assets: localAssets('older-run') });
    expect(draft.result.exitCode).toBe(0);
    expect(draft.result.stdout.toString()).toContain('preserves its complete authenticated draft inventory');
    expect(uploadCalls(draft.state)).toHaveLength(0);
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
    expect(uploadCalls(retry.state)).toHaveLength(0);
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
    expect(uploadCalls(resumed.state)).toHaveLength(NAMES.length - Object.keys(partial).length);
  });

  test('reuses a complete published inventory only after pinned cryptographic verification', () => {
    const publishedAssets = localAssets('published');
    const { result, state } = run({ draft: false, assets: publishedAssets });
    expect(result.exitCode).toBe(0);
    expect(state.assets).toEqual(publishedAssets);
    expect(uploadCalls(state)).toHaveLength(0);
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

  test('selects our release predicate when GitHub also attests the immutable release', () => {
    const publishedAssets = localAssets('published');
    const { result, state } = run({ draft: false, assets: publishedAssets });
    expect(result.exitCode).toBe(0);
    expect(state.assets).toEqual(publishedAssets);
    expect(uploadCalls(state)).toHaveLength(0);
    // 4 platforms x 2 passes (unfiltered, then certificate-filtered), each
    // answered with GitHub's immutable-release attestation ahead of ours.
    expect(state.attestationBatchSizes).toHaveLength(8);
    expect(state.attestationBatchSizes?.every((size) => size === 2)).toBe(true);
  });

  test('never repairs a partial published release or accepts remote extras', () => {
    const partial = run({ draft: false, prerelease: false, assets: { [NAMES[0]]: localAssets()[NAMES[0]] } });
    expect(partial.result.exitCode).toBe(3);
    expect(partial.result.stderr.toString()).toContain('incomplete published immutable release');
    expect(uploadCalls(partial.state)).toHaveLength(0);

    const extra = run({ draft: true, assets: { unexpected: 'x' } });
    expect(extra.result.exitCode).toBe(3);
    expect(extra.result.stderr.toString()).toContain('unexpected assets');
    expect(uploadCalls(extra.state)).toHaveLength(0);
  });

  test('rejects duplicate and malformed remote inventory before upload', () => {
    const duplicate = run({
      draft: true,
      assets: {},
      remoteAssets: [
        { name: NAMES[0], id: 1 },
        { name: NAMES[0], id: 2 },
      ],
    });
    expect(duplicate.result.exitCode).toBe(3);
    expect(uploadCalls(duplicate.state)).toHaveLength(0);

    const malformed = run({ draft: true, assets: {}, remoteAssets: [{ name: 7 }] });
    expect(malformed.result.exitCode).toBe(3);
    expect(uploadCalls(malformed.state)).toHaveLength(0);
  });

  test('rides out transient upload failures without duplicating or clobbering assets', () => {
    // One 502 on the first upload POST; the retry succeeds. Every asset lands
    // exactly once and the post-upload byte verification passes.
    const { result, state } = run({ draft: true, assets: {}, failTimes: { 'uploads.github.com': 1 } });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(state.assets).sort()).toEqual([...NAMES].sort());
    expect(state.usedClobber).not.toBe(true);
    expect((state.calls ?? []).every((call) => !call.args.includes('DELETE'))).toBe(true);
  });

  test('an upload that landed but lost its response is skipped, and byte verification adjudicates', () => {
    // The first POST stores the bytes server-side but reports a transient
    // failure; the retry surfaces already_exists and is skipped — never
    // deleted, never clobbered. Identical bytes → success.
    const clean = run({ draft: true, assets: {}, uploadLandThenFail: 1 });
    expect(clean.result.exitCode).toBe(0);
    expect(clean.result.stdout.toString()).toContain('release-assets.upload_skipped');
    expect(Object.keys(clean.state.assets).sort()).toEqual([...NAMES].sort());

    // Same scenario but the landed bytes are corrupt: the skip must NOT hide
    // the mismatch — the post-upload byte compare fails closed.
    const corrupt = run({ draft: true, assets: {}, uploadLandThenFail: 1, uploadCorruptFirst: true });
    expect(corrupt.result.exitCode).toBe(3);
    expect(corrupt.result.stderr.toString()).toContain('remote release asset verification failed after upload');
  }, 30_000);

  test('fails closed before any mutation when the release cannot be resolved', () => {
    const unknown = run({ draft: true, assets: {}, failTimes: { 'releases/tags': 99 } });
    expect(unknown.result.exitCode).toBe(3);
    expect(unknown.result.stderr.toString()).toContain('cannot determine whether release');
    expect(uploadCalls(unknown.state)).toHaveLength(0);

    const absent = run({ draft: true, assets: {}, noRelease: true });
    expect(absent.result.exitCode).toBe(3);
    expect(absent.result.stderr.toString()).toContain('run prepare first');
    expect(uploadCalls(absent.state)).toHaveLength(0);
  });

  test('propagates upload and verification failures', () => {
    const upload = run({ draft: true, assets: {}, failOn: 'uploads.github.com' });
    expect(upload.result.exitCode).toBe(42);

    const endorsement = run({ draft: true, assets: {}, failOn: 'gh attestation verify' });
    expect(endorsement.result.exitCode).toBe(42);

    const verification = run({ draft: false, assets: localAssets('published'), failOn: 'cosign verify-blob' });
    expect(verification.result.exitCode).toBe(42);
    expect(uploadCalls(verification.state)).toHaveLength(0);

    const mismatchedSecondPass = run({
      draft: false,
      assets: localAssets('published'),
      secondControlSha: 'd'.repeat(40),
    });
    expect(mismatchedSecondPass.result.exitCode).toBe(3);
    expect(mismatchedSecondPass.result.stderr.toString()).toContain('control digest mismatch');

    const genericPolicy = run({ draft: false, assets: localAssets('published'), invalidGeneric: true });
    expect(genericPolicy.result.exitCode).not.toBe(0);
    expect(uploadCalls(genericPolicy.state)).toHaveLength(0);

    const nativePolicy = run({ draft: false, assets: localAssets('published'), invalidNative: true });
    expect(nativePolicy.result.exitCode).not.toBe(0);
    expect(uploadCalls(nativePolicy.state)).toHaveLength(0);
  }, 15_000);
});
