import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import packageMetadata from '../../package.json';
import { scanPhysicalTree } from '../../src/lib/codex-activation.js';
import { buildTestDeliveryEvidencePack } from '../../src/lib/codex-delivery-evidence.test-support.js';
import type { DogfoodEntryInput, DogfoodHarnessDependencies } from './codex-dogfood-harness.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');
export const FIXTURE_N = '5.260720.10';
export const FIXTURE_T = packageMetadata.version;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function platformId(): 'darwin-arm64' | 'linux-arm64' | 'linux-x64-glibc' {
  if (process.platform === 'darwin') return 'darwin-arm64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64-glibc';
}

function stageRelease(
  root: string,
  version: string,
): { releaseRoot: string; binarySha256: string; payloadSha256: string } {
  const releaseRoot = join(root, `release-${version}`);
  mkdirSync(releaseRoot, { recursive: true });
  cpSync(join(REPO_ROOT, 'plugins', 'genie'), join(releaseRoot, 'plugins', 'genie'), { recursive: true });
  const binary = join(releaseRoot, 'genie');
  writeFileSync(
    binary,
    [
      `#!${process.execPath}`,
      "import { createHash } from 'node:crypto';",
      "import { readFileSync } from 'node:fs';",
      `const version = ${JSON.stringify(version)};`,
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write(`genie ${version}\\n`); process.exit(0); }",
      "if (args.join(' ') === 'update --print-update-capabilities --json') {",
      "  const binarySha256 = createHash('sha256').update(readFileSync(process.argv[1])).digest('hex');",
      "  process.stdout.write(JSON.stringify({ schemaVersion: 1, reportedVersion: version, binarySha256, codexActivationProtocol: 1, readableIntentSchemas: [1] }) + '\\n');",
      '  process.exit(0);',
      '}',
      `const sourceCli = ${JSON.stringify(join(REPO_ROOT, 'src', 'genie.ts'))};`,
      `const lifecycleRunner = ${JSON.stringify(join(REPO_ROOT, 'tests', 'support', 'codex-lifecycle-test-runner.ts'))};`,
      'let target = sourceCli;',
      'let forwarded = args;',
      "if (args[0] === 'setup' && args.includes('--codex')) { target = lifecycleRunner; forwarded = args; }",
      "else if (args[0] === 'doctor') { target = lifecycleRunner; forwarded = args; }",
      "else if (args[0] === 'update' && args[1] === '--publish-local-delivery' && args.length === 3) {",
      "  target = lifecycleRunner; forwarded = ['publish-local-delivery', args[2]];",
      '}',
      "const child = Bun.spawn([process.execPath, target, ...forwarded], { cwd: process.cwd(), env: process.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });",
      'process.exit(await child.exited);',
      '',
    ].join('\n'),
  );
  chmodSync(binary, 0o755);
  writeFileSync(join(releaseRoot, 'VERSION'), `${version}\n`);
  const tree = scanPhysicalTree(join(releaseRoot, 'plugins', 'genie'));
  if (tree.status !== 'ok' || tree.digest === undefined) throw new Error('fixture payload could not be hashed');
  return { releaseRoot, binarySha256: sha256(binary), payloadSha256: tree.digest };
}

export function buildDogfoodFixture(root: string): {
  input: DogfoodEntryInput;
  dependencies: DogfoodHarnessDependencies;
} {
  const platform = platformId();
  const previous = stageRelease(root, FIXTURE_N);
  const candidate = stageRelease(root, FIXTURE_T);
  const previousArtifact = join(root, `genie-${FIXTURE_N}-${platform}.tar.gz`);
  const candidateArtifact = join(root, `genie-${FIXTURE_T}-${platform}.tar.gz`);
  execFileSync('tar', ['-czf', previousArtifact, '-C', previous.releaseRoot, '.']);
  execFileSync('tar', ['-czf', candidateArtifact, '-C', candidate.releaseRoot, '.']);

  const previousManifest = join(root, 'previous-stable.json');
  writeFileSync(
    previousManifest,
    `${JSON.stringify({
      schema_version: 1,
      channel: 'stable',
      version: FIXTURE_N,
      released_at: '2026-07-20T00:00:00Z',
      tarball_base: `https://github.com/automagik-dev/genie/releases/download/v${FIXTURE_N}`,
      platforms: [platform],
    })}\n`,
  );
  const previousBundle = `${previousArtifact}.bundle`;
  const previousProvenance = `${previousArtifact}.intoto.jsonl`;
  writeFileSync(previousBundle, '{"fixture":"cosign identity verified by test dependency"}\n');
  writeFileSync(previousProvenance, '{"fixture":"SLSA identity verified by test dependency"}\n');

  const pack = buildTestDeliveryEvidencePack({
    descriptor: {
      version: FIXTURE_T,
      channel: 'stable',
      platformId: platform,
      platformTriple: `${process.platform}-${process.arch}`,
      releaseTag: `v${FIXTURE_T}`,
      releaseName: `genie-${FIXTURE_T}-${platform}.tar.gz`,
      artifactSha256: sha256(candidateArtifact),
      installedBinarySha256: candidate.binarySha256,
      canonicalPayloadSha256: candidate.payloadSha256,
      sourceSha: 'a'.repeat(40),
      controlSha: 'b'.repeat(40),
      sourceBranch: 'main',
    },
    manifest: { platforms: [platform] },
  });
  const candidateManifest = join(root, 'candidate-stable.json');
  const candidateDescriptor = `${candidateArtifact}.stable.delivery.json`;
  const candidateBundle = `${candidateDescriptor}.sigstore.json`;
  writeFileSync(candidateManifest, pack.manifestBytes);
  writeFileSync(candidateDescriptor, pack.descriptorBytes);
  writeFileSync(candidateBundle, pack.bundleBytes);

  return {
    input: {
      previous: {
        artifact: previousArtifact,
        manifest: previousManifest,
        identity: previousProvenance,
        bundle: previousBundle,
        identityKind: 'slsa-provenance',
      },
      candidate: {
        artifact: candidateArtifact,
        manifest: candidateManifest,
        identity: candidateDescriptor,
        bundle: candidateBundle,
        identityKind: 'delivery-descriptor',
      },
      platformId: platform,
      evidenceKind: 'verified-local-fixture',
      outputEvidence: join(root, 'evidence', `codex-dogfood-${FIXTURE_T}-${platform}.md`),
    },
    dependencies: {
      root: join(root, 'run'),
      deliveryEvidenceVerification: pack.dependencies,
      verifyLegacyProvenance: () => ({
        sourceCommit: 'c'.repeat(40),
        sourceBranch: 'main',
        sourceCiRunId: '26072010',
        controlCommit: 'd'.repeat(40),
      }),
    },
  };
}
