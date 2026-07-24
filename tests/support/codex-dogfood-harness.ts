/**
 * Parameterized Group-F dogfood harness.
 *
 * Release inputs cross the boundary only as explicit paths. Both evidence packs
 * go through the production descriptor/manifest/bundle verifier, extracted
 * payloads go through production physical-tree hashing and capability parsing,
 * the candidate delivery is published by the production deep store, activation
 * uses the real consent/permit/executor path, role agents use the production
 * convergence function, and repository observations use the real stdio MCP
 * server. The only injectable seam is the cryptographic bundle verifier and is
 * exposed to tests through this support module, never by the CLI runner.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  LIVE_DOGFOOD_SCHEMA_VERSION,
  type REQUIRED_STAGE_IDS,
  validateLiveDogfoodEvidence,
  validateLiveDogfoodEvidenceFile,
} from '../../scripts/validate-live-dogfood-evidence.js';
import { compareReleaseVersions, parseReleaseVersion, scanPhysicalTree } from '../../src/lib/codex-activation.js';
import {
  DELIVERY_EVIDENCE_OIDC_ISSUER,
  DELIVERY_EVIDENCE_PREDICATE_TYPE,
  DELIVERY_EVIDENCE_REPOSITORY,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
  type DeliveryEvidenceDescriptor,
  type DeliveryEvidencePlatformId,
  type DeliveryEvidenceVerificationDependencies,
  type VerifiedDeliveryEvidence,
  verifiedDeliveryEvidenceFacts,
  verifyDownloadedDeliveryEvidence,
} from '../../src/lib/codex-delivery-evidence.js';
import { parseUpdateCapabilityReport } from '../../src/lib/update-capabilities.js';
const PLATFORM_TRIPLES: Readonly<Record<DeliveryEvidencePlatformId, string>> = {
  'linux-x64-glibc': 'linux-x64',
  'linux-x64-musl': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-arm64': 'darwin-arm64',
};

export interface GenerationInputPaths {
  artifact: string;
  manifest: string;
  identity: string;
  bundle: string;
  identityKind: 'slsa-provenance' | 'delivery-descriptor';
}

export interface DogfoodEntryInput {
  previous: GenerationInputPaths;
  candidate: GenerationInputPaths;
  platformId: DeliveryEvidencePlatformId;
  outputEvidence?: string;
  /** Executable invoked as: adapter <binary> update --print-update-capabilities --json. */
  executionAdapter?: string;
  evidenceKind?: 'host-native' | 'verified-local-fixture';
}

export interface DogfoodHarnessDependencies {
  /** Test-only cryptographic seam. The CLI never supplies this. */
  deliveryEvidenceVerification?: DeliveryEvidenceVerificationDependencies;
  /** Test-only substitute for external cosign+slsa verification of historical N. */
  verifyLegacyProvenance?: (input: {
    artifact: string;
    bundle: string;
    provenance: string;
    version: string;
    root: string;
  }) => LegacyProvenanceFacts;
  /** Test-only substitute for the real Codex app-server → exact-binary MCP proof. */
  observeNativeMcp?: (input: NativeMcpEvidenceInput) => Promise<NativeMcpEvidence>;
  root?: string;
}

export interface LegacyProvenanceFacts {
  sourceCommit: string;
  sourceBranch: string;
  sourceCiRunId: string;
  controlCommit: string;
}

export interface VerifiedGeneration {
  paths: GenerationInputPaths;
  facts: GenerationFacts;
  evidence: VerifiedDeliveryEvidence | null;
  evidenceDigest: string;
  manifestSha256: string;
  artifactSha256: string;
  binarySha256: string;
  payloadSha256: string;
  identitySha256: string;
  bundleSha256: string;
  releaseRoot: string;
  binaryPath: string;
  payloadPath: string;
}

interface GenerationFacts {
  version: string;
  channel: DeliveryEvidenceDescriptor['channel'];
  platformId: DeliveryEvidencePlatformId;
  platformTriple: string;
  releaseTag: string;
  releaseName: string;
  releaseManifestSha256: string;
  artifactSha256: string;
  installedBinarySha256: string;
  canonicalPayloadSha256: string;
  sourceSha: string;
  sourceBranch: string;
  sourceCiRunId: string;
  controlSha: string;
}

interface TaskIdentity {
  wish: string;
  taskId: string;
  title: string;
  status: 'in_progress';
  claimedBy: string;
}

interface RepoObservation {
  root: string;
  requestedCwd: string;
  effectiveCwd: string;
  cwdIdentity: string;
  childPid: number;
  sentinel: {
    token: string;
    expected: TaskIdentity;
    observed: TaskIdentity;
    boardCount: 1;
  };
  routeState?: 'managed-project';
}

interface BoardResult {
  pid: number;
  isError: boolean;
  payload: Record<string, unknown>;
}

export interface NativeMcpEvidenceInput {
  tag: string;
  requestedCwd: string;
  candidateBinary: string;
  candidateBinarySha256: string;
  executionAdapter?: string;
  root: string;
  env: Record<string, string>;
}

export interface NativeMcpEvidence {
  requestedCwd: string;
  effectiveCwd: string;
  cwdIdentity: string;
  controlCwd: string;
  controlCwdIdentity: string;
  childPid: number;
  threadId: string;
  isError: boolean;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface CapturedCommand {
  executable: string;
  executableSha256: string;
  candidateBinary: string | null;
  candidateBinarySha256: string | null;
  argv: string[];
  pid: number;
  requestedCwd: string;
  cwdIdentity: string;
  exit: number;
  stdout: string;
  stderr: string;
}

interface StageProjection {
  id: (typeof REQUIRED_STAGE_IDS)[number];
  command: string;
  exit: number;
  humanState: string;
  jsonState: string;
  activeVersion: string;
  trailer: Record<string, unknown> | null;
  observationPath: string;
  observationSha256: string;
  observation: {
    schemaVersion: 1;
    commands: CapturedCommand[];
  };
}

export interface DogfoodRunResult {
  evidence: string;
  manifest: Record<string, unknown>;
  doctor: Record<string, unknown>;
  outputEvidence?: string;
}

function isolatedDogfoodEnv(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  const home = join(root, 'process-home');
  const temp = join(root, 'tmp');
  const xdgConfig = join(home, '.config');
  const xdgCache = join(home, '.cache');
  const xdgData = join(home, '.local', 'share');
  const xdgState = join(home, '.local', 'state');
  const genieHome = join(root, 'genie-home');
  const codexHome = join(root, 'codex-home');
  const bin = join(root, 'bin');
  for (const path of [home, temp, xdgConfig, xdgCache, xdgData, xdgState, genieHome, codexHome, bin]) {
    mkdirSync(path, { recursive: true });
  }
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: home,
    GENIE_HOME: genieHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    HERMES_HOME: join(home, '.hermes'),
    GENIE_AGENTS_SKILLS_DIR: join(home, '.agents', 'skills'),
    TMPDIR: temp,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    BUN_INSTALL_CACHE_DIR: join(xdgCache, 'bun'),
    NPM_CONFIG_CACHE: join(xdgCache, 'npm'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GENIE_TEST_SKIP_PGSERVE: '1',
    NO_COLOR: '1',
    ...overrides,
  };
  for (const key of ['LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function runDogfoodEntry(
  rawInput: DogfoodEntryInput,
  dependencies: DogfoodHarnessDependencies = {},
): Promise<DogfoodRunResult> {
  const input = normalizeInput(rawInput);
  const ownsRoot = dependencies.root === undefined;
  const root = dependencies.root ?? mkdtempSync(join(tmpdir(), 'genie-dogfood-entry-'));
  mkdirSync(root, { recursive: true });
  try {
    const previous = verifyGeneration(
      'previous',
      input.previous,
      input.platformId,
      input.executionAdapter,
      root,
      dependencies,
    );
    const candidate = verifyGeneration(
      'candidate',
      input.candidate,
      input.platformId,
      input.executionAdapter,
      root,
      dependencies,
    );
    const previousVersion = parseReleaseVersion(previous.facts.version);
    const candidateVersion = parseReleaseVersion(candidate.facts.version);
    if (
      previousVersion === null ||
      candidateVersion === null ||
      compareReleaseVersions(previousVersion, candidateVersion) >= 0
    ) {
      throw new Error('previous stable N must be older than candidate T');
    }
    if (previous.artifactSha256 === candidate.artifactSha256) {
      throw new Error('previous and candidate artifacts unexpectedly have the same digest');
    }
    const expectedEvidenceName = `codex-dogfood-${candidate.facts.version}-${input.platformId}.md`;
    if (input.outputEvidence !== undefined && basename(input.outputEvidence) !== expectedEvidenceName) {
      throw new Error(`output evidence filename must be ${expectedEvidenceName}`);
    }

    const lifecycle = await runLifecycle(root, input, previous, candidate, dependencies);
    const repositories = lifecycle.repositories;
    if (input.outputEvidence !== undefined) {
      stageEvidenceInputs(dirname(input.outputEvidence), previous, candidate, lifecycle.stages);
    }
    const manifest = buildManifest(input, previous, candidate, lifecycle, repositories);
    const doctor = lifecycle.doctor;
    const evidence = renderEvidence(manifest, doctor);
    const errors = validateLiveDogfoodEvidence(evidence);
    if (errors.length > 0) throw new Error(`generated evidence failed validation:\n${errors.join('\n')}`);
    if (input.outputEvidence !== undefined) {
      mkdirSync(dirname(input.outputEvidence), { recursive: true });
      writeFileSync(input.outputEvidence, evidence);
      const fileErrors = validateLiveDogfoodEvidenceFile(input.outputEvidence, dirname(input.outputEvidence));
      if (fileErrors.length > 0) throw new Error(`staged evidence failed validation:\n${fileErrors.join('\n')}`);
    }
    return { evidence, manifest, doctor, outputEvidence: input.outputEvidence };
  } finally {
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
  }
}

function stageEvidenceInputs(
  outputRoot: string,
  previous: VerifiedGeneration,
  candidate: VerifiedGeneration,
  stages: StageProjection[],
): void {
  mkdirSync(outputRoot, { recursive: true });
  for (const [label, generation] of [
    ['previous', previous],
    ['candidate', candidate],
  ] as const) {
    const target = join(outputRoot, label);
    mkdirSync(target, { recursive: true });
    for (const key of ['artifact', 'manifest', 'identity', 'bundle'] as const) {
      const path = generation.paths[key];
      const destination = join(target, basename(path));
      if (realpathIfPresent(destination) === realpathSync(path)) continue;
      copyFileSync(path, destination);
    }
  }
  const observationsRoot = join(outputRoot, 'observations');
  mkdirSync(observationsRoot, { recursive: true });
  for (const value of stages) {
    const destination = join(outputRoot, value.observationPath);
    writeFileSync(destination, serializeStageObservation(value.observation));
    if (sha256File(destination) !== value.observationSha256) {
      throw new Error(`staged ${value.id} observation digest drifted`);
    }
  }
}

function realpathIfPresent(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function normalizeInput(input: DogfoodEntryInput): DogfoodEntryInput {
  const normalizeGeneration = (label: string, value: GenerationInputPaths): GenerationInputPaths => {
    const out = {} as GenerationInputPaths;
    for (const key of ['artifact', 'manifest', 'identity', 'bundle'] as const) {
      const path = resolve(value[key]);
      if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error(`${label} ${key} is unavailable or not a regular file: ${path}`);
      }
      out[key] = realpathSync(path);
    }
    out.identityKind = value.identityKind;
    return out;
  };
  if (!(input.platformId in PLATFORM_TRIPLES)) throw new Error(`unsupported platform id: ${input.platformId}`);
  const executionAdapter =
    input.executionAdapter === undefined ? undefined : realpathSync(resolve(input.executionAdapter));
  if (executionAdapter !== undefined && !lstatSync(executionAdapter).isFile()) {
    throw new Error(`execution adapter is not a regular file: ${executionAdapter}`);
  }
  return {
    ...input,
    previous: normalizeGeneration('previous', input.previous),
    candidate: normalizeGeneration('candidate', input.candidate),
    outputEvidence: input.outputEvidence === undefined ? undefined : resolve(input.outputEvidence),
    executionAdapter,
    evidenceKind: input.evidenceKind ?? 'host-native',
  };
}

function verifyGeneration(
  label: 'previous' | 'candidate',
  paths: GenerationInputPaths,
  platformId: DeliveryEvidencePlatformId,
  executionAdapter: string | undefined,
  root: string,
  dependencies: DogfoodHarnessDependencies,
): VerifiedGeneration {
  const identityBytes = readFileSync(paths.identity);
  const bundleBytes = readFileSync(paths.bundle);
  const manifestBytes = readFileSync(paths.manifest);
  const artifactSha256 = sha256File(paths.artifact);
  const manifest = parseReleaseManifest(label, manifestBytes, platformId);
  const releaseName = `genie-${manifest.version}-${platformId}.tar.gz`;
  if (basename(paths.artifact) !== releaseName) throw new Error(`${label} artifact name is not manifest-derived`);

  const authenticated = authenticateGenerationInputs({
    label,
    paths,
    platformId,
    manifest,
    manifestBytes,
    identityBytes,
    bundleBytes,
    artifactSha256,
    releaseName,
    root,
    dependencies,
  });

  const extractRoot = join(root, `${label}-extract`);
  mkdirSync(extractRoot, { recursive: true });
  execFileSync('tar', ['-xzf', paths.artifact, '-C', extractRoot], {
    env: isolatedDogfoodEnv(root),
    stdio: 'pipe',
  });
  const releaseRoot = findReleaseRoot(extractRoot);
  const binaryPath = join(releaseRoot, 'genie');
  const payloadPath = join(releaseRoot, 'plugins', 'genie');
  if (!existsSync(binaryPath) || !lstatSync(binaryPath).isFile())
    throw new Error(`${label} extracted binary unavailable`);
  const tree = scanPhysicalTree(payloadPath);
  if (tree.status !== 'ok' || tree.digest === undefined) throw new Error(`${label} extracted payload is invalid`);
  const binarySha256 = sha256File(binaryPath);
  verifyCapability(binaryPath, manifest.version, binarySha256, executionAdapter, root);

  const bound = bindExtractedGeneration({
    label,
    authenticated,
    manifest,
    manifestBytes,
    identityBytes,
    bundleBytes,
    artifactSha256,
    releaseName,
    platformId,
    binarySha256,
    payloadSha256: tree.digest,
  });
  return {
    paths,
    facts: bound.facts,
    evidence: bound.evidence,
    evidenceDigest: bound.evidenceDigest,
    manifestSha256: sha256Bytes(manifestBytes),
    artifactSha256,
    binarySha256,
    payloadSha256: tree.digest,
    identitySha256: sha256Bytes(identityBytes),
    bundleSha256: sha256Bytes(bundleBytes),
    releaseRoot,
    binaryPath,
    payloadPath,
  };
}

type ParsedReleaseManifest = ReturnType<typeof parseReleaseManifest>;
type AuthenticatedGeneration =
  | { kind: 'delivery-descriptor'; descriptor: DeliveryEvidenceDescriptor; evidence: VerifiedDeliveryEvidence }
  | { kind: 'slsa-provenance'; provenance: LegacyProvenanceFacts };

function authenticateGenerationInputs(input: {
  label: 'previous' | 'candidate';
  paths: GenerationInputPaths;
  platformId: DeliveryEvidencePlatformId;
  manifest: ParsedReleaseManifest;
  manifestBytes: Buffer;
  identityBytes: Buffer;
  bundleBytes: Buffer;
  artifactSha256: string;
  releaseName: string;
  root: string;
  dependencies: DogfoodHarnessDependencies;
}): AuthenticatedGeneration {
  if (input.paths.identityKind === 'slsa-provenance') {
    const provenance = (input.dependencies.verifyLegacyProvenance ?? verifyLegacyReleaseProvenance)({
      artifact: input.paths.artifact,
      bundle: input.paths.bundle,
      provenance: input.paths.identity,
      version: input.manifest.version,
      root: input.root,
    });
    return { kind: 'slsa-provenance', provenance };
  }
  const descriptor = JSON.parse(input.identityBytes.toString('utf8')) as DeliveryEvidenceDescriptor;
  if (descriptor.platformId !== input.platformId || descriptor.platformTriple !== PLATFORM_TRIPLES[input.platformId]) {
    throw new Error(`${input.label} descriptor platform identity is inconsistent`);
  }
  if (
    descriptor.version !== input.manifest.version ||
    descriptor.channel !== input.manifest.channel ||
    descriptor.releaseName !== input.releaseName ||
    descriptor.artifactSha256 !== input.artifactSha256
  ) {
    throw new Error(`${input.label} delivery descriptor does not bind the authenticated artifact`);
  }
  const evidence = verifyDownloadedDeliveryEvidence(
    {
      descriptorBytes: input.identityBytes,
      bundleBytes: input.bundleBytes,
      manifestBytes: input.manifestBytes,
      targetVersion: descriptor.version,
      channel: descriptor.channel,
      platformId: descriptor.platformId,
      platformTriple: descriptor.platformTriple,
      releaseTag: descriptor.releaseTag,
      releaseName: descriptor.releaseName,
      artifactSha256: descriptor.artifactSha256,
      installedBinarySha256: descriptor.installedBinarySha256,
      canonicalPayloadSha256: descriptor.canonicalPayloadSha256,
    },
    input.dependencies.deliveryEvidenceVerification,
  );
  return { kind: 'delivery-descriptor', descriptor, evidence };
}

function bindExtractedGeneration(input: {
  label: 'previous' | 'candidate';
  authenticated: AuthenticatedGeneration;
  manifest: ParsedReleaseManifest;
  manifestBytes: Buffer;
  identityBytes: Buffer;
  bundleBytes: Buffer;
  artifactSha256: string;
  releaseName: string;
  platformId: DeliveryEvidencePlatformId;
  binarySha256: string;
  payloadSha256: string;
}): Pick<VerifiedGeneration, 'facts' | 'evidence' | 'evidenceDigest'> {
  if (input.authenticated.kind === 'delivery-descriptor') {
    const { descriptor, evidence } = input.authenticated;
    if (
      descriptor.installedBinarySha256 !== input.binarySha256 ||
      descriptor.canonicalPayloadSha256 !== input.payloadSha256
    ) {
      throw new Error(`${input.label} delivery descriptor does not bind the extracted artifact`);
    }
    return {
      facts: descriptor,
      evidence,
      evidenceDigest: verifiedDeliveryEvidenceFacts(evidence).evidenceDigest,
    };
  }
  const { provenance } = input.authenticated;
  return {
    facts: {
      version: input.manifest.version,
      channel: input.manifest.channel,
      platformId: input.platformId,
      platformTriple: PLATFORM_TRIPLES[input.platformId],
      releaseTag: `v${input.manifest.version}`,
      releaseName: input.releaseName,
      releaseManifestSha256: sha256Bytes(input.manifestBytes),
      artifactSha256: input.artifactSha256,
      installedBinarySha256: input.binarySha256,
      canonicalPayloadSha256: input.payloadSha256,
      sourceSha: provenance.sourceCommit,
      sourceBranch: provenance.sourceBranch,
      sourceCiRunId: provenance.sourceCiRunId,
      controlSha: provenance.controlCommit,
    },
    evidence: null,
    evidenceDigest: createHash('sha256')
      .update('genie-legacy-release-proof-v1\0')
      .update(input.manifestBytes)
      .update(input.identityBytes)
      .update(input.bundleBytes)
      .digest('hex'),
  };
}

function parseReleaseManifest(
  label: string,
  bytes: Uint8Array,
  platformId: DeliveryEvidencePlatformId,
): {
  schema_version: 1;
  channel: DeliveryEvidenceDescriptor['channel'];
  version: string;
  platforms: string[];
} {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    schema_version?: unknown;
    channel?: unknown;
    version?: unknown;
    platforms?: unknown;
  };
  const valid =
    value.schema_version === 1 &&
    ['stable', 'homolog', 'dev'].includes(String(value.channel)) &&
    typeof value.version === 'string' &&
    Array.isArray(value.platforms) &&
    value.platforms.includes(platformId);
  if (!valid) throw new Error(`${label} release manifest does not bind the requested version/channel/platform`);
  return value as {
    schema_version: 1;
    channel: DeliveryEvidenceDescriptor['channel'];
    version: string;
    platforms: string[];
  };
}

function findReleaseRoot(extractRoot: string): string {
  if (existsSync(join(extractRoot, 'genie')) && existsSync(join(extractRoot, 'plugins', 'genie'))) return extractRoot;
  const children = readdirSync(extractRoot).filter((name) => lstatSync(join(extractRoot, name)).isDirectory());
  if (children.length === 1) {
    const nested = join(extractRoot, children[0] as string);
    if (existsSync(join(nested, 'genie')) && existsSync(join(nested, 'plugins', 'genie'))) return nested;
  }
  throw new Error('release archive does not contain one extracted Genie release root');
}

function verifyCapability(
  binary: string,
  version: string,
  binarySha256: string,
  executionAdapter: string | undefined,
  root: string,
): void {
  const args = ['update', '--print-update-capabilities', '--json'];
  const command = executionAdapter ?? binary;
  const commandArgs = executionAdapter === undefined ? args : [binary, ...args];
  const result = Bun.spawnSync([command, ...commandArgs], {
    env: isolatedDogfoodEnv(root),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`native capability probe unavailable (${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  if (result.stderr.length > 0)
    throw new Error(`native capability probe wrote stderr: ${result.stderr.toString().trim()}`);
  const report = parseUpdateCapabilityReport(result.stdout.toString().trim());
  if (report === null) throw new Error('native capability probe did not return schema-valid JSON');
  if (report.reportedVersion !== version) throw new Error('native capability probe version mismatch');
  if (report.binarySha256 !== binarySha256) throw new Error('native capability probe binary digest mismatch');
}

function verifyLegacyReleaseProvenance(input: {
  artifact: string;
  bundle: string;
  provenance: string;
  version: string;
  root: string;
}): LegacyProvenanceFacts {
  const cosign = Bun.which('cosign');
  const slsaVerifier = Bun.which('slsa-verifier');
  if (cosign === null) throw new Error('cosign is unavailable for previous-release verification');
  if (slsaVerifier === null) throw new Error('slsa-verifier is unavailable for previous-release verification');
  execFileSync(
    cosign,
    [
      'verify-blob',
      '--bundle',
      input.bundle,
      '--certificate-identity',
      'https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@refs/heads/main',
      '--certificate-oidc-issuer',
      DELIVERY_EVIDENCE_OIDC_ISSUER,
      input.artifact,
    ],
    { env: isolatedDogfoodEnv(input.root), stdio: 'pipe' },
  );
  const verified = execFileSync(
    slsaVerifier,
    [
      'verify-artifact',
      input.artifact,
      '--provenance-path',
      input.provenance,
      '--source-uri',
      `github.com/${DELIVERY_EVIDENCE_REPOSITORY}`,
      '--source-branch',
      'main',
      '--print-provenance',
    ],
    { encoding: 'utf8', env: isolatedDogfoodEnv(input.root), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const verifyRoot = mkdtempSync(join(input.root, 'legacy-provenance-'));
  try {
    const verifiedPath = join(verifyRoot, 'verified.json');
    writeFileSync(verifiedPath, verified);
    execFileSync(
      'bash',
      [join(import.meta.dir, '..', '..', 'scripts', 'release-generic-provenance.sh'), 'verify-reusable', verifiedPath],
      {
        env: {
          ...isolatedDogfoodEnv(input.root),
          RELEASE_REPOSITORY: DELIVERY_EVIDENCE_REPOSITORY,
          VERSION: input.version,
        },
        stdio: 'pipe',
      },
    );
    const statement = JSON.parse(verified) as {
      predicate?: {
        invocation?: {
          configSource?: { digest?: { sha1?: unknown } };
          parameters?: { event_inputs?: Record<string, unknown> };
        };
      };
    };
    const parameters = statement.predicate?.invocation?.parameters?.event_inputs;
    const controlCommit = statement.predicate?.invocation?.configSource?.digest?.sha1;
    const facts = {
      sourceCommit: parameters?.source_sha,
      sourceBranch: parameters?.source_branch,
      sourceCiRunId: parameters?.source_ci_run_id,
      controlCommit,
    };
    if (
      typeof facts.sourceCommit !== 'string' ||
      !/^[0-9a-f]{40}$/.test(facts.sourceCommit) ||
      typeof facts.sourceBranch !== 'string' ||
      !/^(?:main|homolog|dev)$/.test(facts.sourceBranch) ||
      typeof facts.sourceCiRunId !== 'string' ||
      !/^(?:0|[1-9]\d*)$/.test(facts.sourceCiRunId) ||
      typeof facts.controlCommit !== 'string' ||
      !/^[0-9a-f]{40}$/.test(facts.controlCommit)
    ) {
      throw new Error('verified previous-release provenance omitted a required identity');
    }
    return facts as LegacyProvenanceFacts;
  } finally {
    rmSync(verifyRoot, { recursive: true, force: true });
  }
}

function captureCommand(input: {
  root: string;
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  executionAdapter?: string;
  stdin?: Uint8Array;
  timeoutMs?: number;
}): CapturedCommand {
  const command = input.executionAdapter ?? input.binary;
  const argv = input.executionAdapter === undefined ? input.args : [input.binary, ...input.args];
  const env =
    input.executionAdapter === undefined
      ? input.env
      : { ...input.env, DOGFOOD_ROOT: input.root, DOGFOOD_ADAPTER_CWD: realpathSync(input.cwd) };
  const result = Bun.spawnSync([command, ...argv], {
    cwd: input.cwd,
    env,
    stdin: input.stdin,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: input.timeoutMs ?? 120_000,
  });
  if (result.exitedDueToTimeout === true) {
    throw new Error(`bounded candidate command timed out: ${[command, ...argv].join(' ')}`);
  }
  const cwdStat = statSync(realpathSync(input.cwd));
  return {
    executable: realpathSync(command),
    executableSha256: sha256File(realpathSync(command)),
    candidateBinary: realpathSync(input.binary),
    candidateBinarySha256: sha256File(realpathSync(input.binary)),
    argv,
    pid: result.pid,
    requestedCwd: realpathSync(input.cwd),
    cwdIdentity: `${cwdStat.dev}:${cwdStat.ino}`,
    exit: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function capturePtySetup(input: {
  root: string;
  binary: string;
  cwd: string;
  env: Record<string, string>;
  executionAdapter?: string;
}): CapturedCommand {
  const command = input.executionAdapter ?? input.binary;
  const commandArgs =
    input.executionAdapter === undefined
      ? [input.binary, 'setup', '--codex']
      : [input.executionAdapter, input.binary, 'setup', '--codex'];
  const env = {
    ...input.env,
    CI: '',
    CODEX_THREAD_ID: '',
    ...(input.executionAdapter === undefined ? {} : { DOGFOOD_ROOT: input.root }),
  };
  let result: ReturnType<typeof Bun.spawnSync>;
  if (process.platform === 'darwin') {
    const expect = Bun.which('expect');
    if (expect === null) throw new Error('real-PTY dogfood requires expect(1) on macOS');
    const spawnWords = commandArgs.map((part) => `{${part}}`).join(' ');
    const script = [
      'set timeout 120',
      `spawn -noecho ${spawnWords}`,
      'send -- "yes\\r"',
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    result = Bun.spawnSync([expect, '-c', script], {
      cwd: input.cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 150_000,
    });
  } else if (process.platform === 'linux') {
    const script = Bun.which('script');
    if (script === null) throw new Error('real-PTY dogfood requires script(1) on Linux');
    const commandLine = commandArgs.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
    result = Bun.spawnSync([script, '-qec', commandLine, '/dev/null'], {
      cwd: input.cwd,
      env,
      stdin: Buffer.from('yes\n'),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 150_000,
    });
  } else {
    throw new Error(`real-PTY dogfood is unsupported on ${process.platform}`);
  }
  if (result.exitedDueToTimeout === true) throw new Error('real-PTY candidate setup timed out');
  const cwdStat = statSync(realpathSync(input.cwd));
  return {
    executable: realpathSync(command),
    executableSha256: sha256File(realpathSync(command)),
    candidateBinary: realpathSync(input.binary),
    candidateBinarySha256: sha256File(realpathSync(input.binary)),
    argv: commandArgs.slice(1),
    pid: result.pid,
    requestedCwd: realpathSync(input.cwd),
    cwdIdentity: `${cwdStat.dev}:${cwdStat.ino}`,
    exit: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function requireExit(observation: CapturedCommand, expected: number, label: string): CapturedCommand {
  if (observation.exit !== expected) {
    throw new Error(
      `${label} exited ${observation.exit}, expected ${expected}: ${observation.stderr.trim() || observation.stdout.trim()}`,
    );
  }
  return observation;
}

function parseResultTrailer(output: string): Record<string, unknown> {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    const objectStart = trimmed.indexOf('{');
    if (objectStart < 0) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(objectStart)) as Record<string, unknown>;
      if (
        parsed.schemaVersion === 1 &&
        typeof parsed.code === 'string' &&
        typeof parsed.deliveryComplete === 'boolean' &&
        typeof parsed.retry === 'boolean' &&
        typeof parsed.nextAction === 'string'
      ) {
        return parsed;
      }
    } catch {
      // Keep scanning bounded command output for the canonical trailer line.
    }
  }
  throw new Error(`candidate command did not emit a schema-valid delivery trailer: ${output.trim().slice(-2_000)}`);
}

interface LifecycleResult {
  genieHome: string;
  delivery: Record<string, unknown>;
  doctor: Record<string, unknown>;
  stages: StageProjection[];
  repositories: { cacheRoot: string; a: RepoObservation; b: Record<string, unknown> };
  convergence: {
    route: { state: 'managed-project'; command: string; cwdOverride: null };
    roles: { expectedCount: number; observedCount: number; current: true; reviewerSha256: string };
  };
}

function initRepo(path: string, env: Record<string, string>): string {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env });
  execFileSync('git', ['config', 'user.email', 'dogfood@test.invalid'], { cwd: path, env });
  execFileSync('git', ['config', 'user.name', 'Dogfood'], { cwd: path, env });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: path, env });
  return realpathSync(path);
}

function installGeneration(generation: VerifiedGeneration, genieHome: string): string {
  const binary = join(genieHome, 'bin', 'genie');
  const payload = join(genieHome, 'plugins', 'genie');
  mkdirSync(dirname(binary), { recursive: true });
  rmSync(payload, { recursive: true, force: true });
  copyFileSync(generation.binaryPath, binary);
  chmodSync(binary, 0o755);
  cpSync(generation.payloadPath, payload, { recursive: true });
  writeFileSync(join(genieHome, 'VERSION'), `${generation.facts.version}\n`);
  if (sha256File(binary) !== generation.binarySha256) throw new Error('installed generation binary digest drifted');
  const tree = scanPhysicalTree(payload);
  if (tree.status !== 'ok' || tree.digest !== generation.payloadSha256) {
    throw new Error('installed generation payload digest drifted');
  }
  return realpathSync(binary);
}

function installFakeCodex(
  root: string,
  previous: VerifiedGeneration,
  candidate: VerifiedGeneration,
  env: Record<string, string>,
): { command: string; stateDir: string } {
  const stateDir = join(root, 'codex-state');
  const command = join(root, 'bin', 'codex');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'registered'), `${previous.facts.version}\n`);
  writeFileSync(
    command,
    `#!/bin/bash
set -euo pipefail
cmd="$*"
if [ "\${1:-}" = "--version" ]; then echo "codex 0.0.0-dogfood"; exit 0; fi
if [ "$cmd" = "plugin list --json" ]; then
  version=$(tr -d '\\n' < "$FAKE_CODEX_STATE/registered")
  enabled=true
  grep -q 'enabled = false' "$CODEX_HOME/config.toml" 2>/dev/null && enabled=false
  printf '{"installed":[{"pluginId":"genie@automagik","enabled":%s,"version":"%s"}]}\\n' "$enabled" "$version"
  exit 0
fi
if [ "$cmd" = "plugin add genie@automagik --json" ]; then
  target="$CODEX_HOME/plugins/cache/automagik/genie/$FAKE_CODEX_TARGET"
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$GENIE_HOME/plugins/genie/." "$target/"
  printf '%s\\n' "$FAKE_CODEX_TARGET" > "$FAKE_CODEX_STATE/registered"
  echo '{}'
  exit 0
fi
if [[ "$cmd" == plugin\\ marketplace* ]]; then echo '{}'; exit 0; fi
echo '{}'
`,
  );
  chmodSync(command, 0o755);
  env.FAKE_CODEX_STATE = stateDir;
  env.FAKE_CODEX_TARGET = candidate.facts.version;
  return { command: realpathSync(command), stateDir };
}

function readRegisteredVersion(stateDir: string): string {
  return readFileSync(join(stateDir, 'registered'), 'utf8').trim();
}

function seedSentinelWithCli(input: {
  root: string;
  binary: string;
  executionAdapter?: string;
  repo: string;
  env: Record<string, string>;
  label: string;
  initialize: boolean;
}): { expected: TaskIdentity & { token: string }; commands: CapturedCommand[] } {
  const commands: CapturedCommand[] = [];
  if (input.initialize) {
    commands.push(
      requireExit(
        captureCommand({
          root: input.root,
          binary: input.binary,
          args: ['init'],
          cwd: input.repo,
          env: input.env,
          executionAdapter: input.executionAdapter,
        }),
        0,
        `${input.label} init`,
      ),
    );
  }
  const token = randomBytes(20).toString('hex');
  const wish = `dogfood-${input.label}-${token}`;
  const title = `task-${input.label}-${token}`;
  const worker = `dogfood-${input.label}-${token.slice(0, 12)}`;
  const created = requireExit(
    captureCommand({
      root: input.root,
      binary: input.binary,
      args: ['task', 'create', '--title', title, '--wish', wish],
      cwd: input.repo,
      env: input.env,
      executionAdapter: input.executionAdapter,
    }),
    0,
    `${input.label} task create`,
  );
  commands.push(created);
  const taskId = created.stdout.match(/Created task (t_[a-zA-Z0-9]+)/)?.[1];
  if (taskId === undefined) throw new Error(`${input.label} task create did not report its task id`);
  commands.push(
    requireExit(
      captureCommand({
        root: input.root,
        binary: input.binary,
        args: ['task', 'checkout', taskId, '--worker', worker],
        cwd: input.repo,
        env: input.env,
        executionAdapter: input.executionAdapter,
      }),
      0,
      `${input.label} task checkout`,
    ),
  );
  const listed = requireExit(
    captureCommand({
      root: input.root,
      binary: input.binary,
      args: ['task', 'list', '--json'],
      cwd: input.repo,
      env: input.env,
      executionAdapter: input.executionAdapter,
    }),
    0,
    `${input.label} task list`,
  );
  commands.push(listed);
  const rows = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
  const row = rows.find((value) => value.id === taskId);
  if (row?.title !== title || row.wish !== wish || row.status !== 'in_progress' || row.claimedBy !== worker) {
    throw new Error(`${input.label} seeded task did not round-trip through the exact binary`);
  }
  return {
    expected: { token, wish, taskId, title, status: 'in_progress', claimedBy: worker },
    commands,
  };
}

function stage(
  id: StageProjection['id'],
  projection: Omit<StageProjection, 'id' | 'command' | 'observation' | 'observationPath' | 'observationSha256'>,
  commands: CapturedCommand[],
): StageProjection {
  if (commands.length === 0) throw new Error(`${id} has no captured command observation`);
  const observation = { schemaVersion: 1 as const, commands };
  return {
    id,
    command: commands.map((command) => [command.executable, ...command.argv].join(' ')).join(' && '),
    ...projection,
    observationPath: `observations/${id}.json`,
    observationSha256: sha256Bytes(Buffer.from(serializeStageObservation(observation))),
    observation,
  };
}

function serializeStageObservation(observation: StageProjection['observation']): string {
  return `${JSON.stringify(observation, null, 2)}\n`;
}

function parseBoardFromMcp(stdout: string): BoardResult {
  const response = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((message) => message.id === 2);
  const result = response?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  if (result === undefined) throw new Error(`MCP board returned no response: ${stdout}`);
  return {
    pid: 0,
    isError: result.isError === true,
    payload: JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>,
  };
}

function directMcpEvidence(input: NativeMcpEvidenceInput): NativeMcpEvidence {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dogfood', version: '2' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
  ];
  const command = captureCommand({
    root: input.root,
    binary: input.candidateBinary,
    args: ['mcp'],
    cwd: input.requestedCwd,
    env: input.env,
    executionAdapter: input.executionAdapter,
    stdin: Buffer.from(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`),
  });
  requireExit(command, 0, `${input.tag} direct MCP`);
  const board = parseBoardFromMcp(command.stdout);
  const cwd = realpathSync(input.requestedCwd);
  return {
    requestedCwd: input.requestedCwd,
    effectiveCwd: cwd,
    cwdIdentity: command.cwdIdentity,
    controlCwd: cwd,
    controlCwdIdentity: command.cwdIdentity,
    childPid: command.pid,
    threadId: `local-${input.tag}-${command.pid}`,
    isError: board.isError,
    payload: board.payload,
    raw: {
      schemaVersion: 1,
      kind: 'verified-local-fixture-direct-mcp',
      command,
      payload: board.payload,
    },
  };
}

async function observeMcp(
  input: NativeMcpEvidenceInput,
  dependencies: DogfoodHarnessDependencies,
  evidenceKind: DogfoodEntryInput['evidenceKind'],
): Promise<NativeMcpEvidence> {
  if (dependencies.observeNativeMcp !== undefined) return dependencies.observeNativeMcp(input);
  if (evidenceKind === 'verified-local-fixture') return directMcpEvidence(input);
  const native = await import('./codex-native-mcp-evidence.js');
  return native.captureCodexNativeMcpEvidenceForDogfood(input);
}

function observedRepo(
  repo: string,
  expected: TaskIdentity & { token: string },
  board: NativeMcpEvidence,
): RepoObservation {
  if (board.isError) throw new Error(`seeded board failed: ${JSON.stringify(board.payload)}`);
  const tasks = board.payload.tasks;
  if (!Array.isArray(tasks) || tasks.length !== 1) throw new Error('seeded board must return exactly one task');
  const task = tasks[0] as Record<string, unknown>;
  const observed: TaskIdentity = {
    wish: String(task.wish),
    taskId: String(task.id),
    title: String(task.title),
    status: task.status as 'in_progress',
    claimedBy: String(task.claimedBy),
  };
  const expectedIdentity: TaskIdentity = {
    wish: expected.wish,
    taskId: expected.taskId,
    title: expected.title,
    status: expected.status,
    claimedBy: expected.claimedBy,
  };
  if (JSON.stringify(observed) !== JSON.stringify(expectedIdentity)) throw new Error('seeded task identity mismatch');
  if (
    board.effectiveCwd !== board.controlCwd ||
    board.cwdIdentity !== board.controlCwdIdentity ||
    board.effectiveCwd !== realpathSync(repo)
  ) {
    throw new Error('Codex-launched candidate MCP CWD differs from its control process');
  }
  return {
    root: repo,
    requestedCwd: board.requestedCwd,
    effectiveCwd: board.effectiveCwd,
    cwdIdentity: board.cwdIdentity,
    childPid: board.childPid,
    sentinel: { token: expected.token, expected: expectedIdentity, observed, boardCount: 1 },
  };
}

function nativeObservationCommand(
  evidence: NativeMcpEvidence,
  candidateBinary: string,
  candidateBinarySha256: string,
  executionAdapter?: string,
): CapturedCommand {
  const executable = executionAdapter ?? candidateBinary;
  return {
    executable,
    executableSha256: executionAdapter === undefined ? candidateBinarySha256 : sha256File(executionAdapter),
    candidateBinary,
    candidateBinarySha256,
    argv: ['mcpServer/tool/call', 'genie', 'genie_board', evidence.threadId],
    pid: evidence.childPid,
    requestedCwd: evidence.requestedCwd,
    cwdIdentity: evidence.cwdIdentity,
    exit: evidence.isError ? 1 : 0,
    stdout: JSON.stringify(evidence.raw),
    stderr: '',
  };
}

function copyRuntimeInput(root: string, label: string, path: string): string {
  const directory = join(root, 'runtime-inputs', label);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, basename(path));
  copyFileSync(path, target);
  if (sha256File(target) !== sha256File(path)) throw new Error(`runtime ${label} input copy digest drifted`);
  return realpathSync(target);
}

function parseDoctor(observation: CapturedCommand): Record<string, unknown> {
  const doctor = JSON.parse(observation.stdout) as Record<string, unknown>;
  const summary = doctor.integrationSummary as { codexPlugin?: { state?: unknown; deliveryComplete?: unknown } };
  if (
    doctor.ok !== true ||
    summary?.codexPlugin?.state !== 'current' ||
    summary.codexPlugin.deliveryComplete !== true
  ) {
    throw new Error(`candidate doctor did not report current: ${observation.stdout.slice(0, 500)}`);
  }
  return doctor;
}

function observeAssetConvergence(input: {
  root: string;
  candidate: VerifiedGeneration;
  candidateBinary: string;
  fakeCodex: string;
  repo: string;
  codexHome: string;
  env: Record<string, string>;
  executionAdapter?: string;
}): { commands: CapturedCommand[]; convergence: LifecycleResult['convergence'] } {
  const plugin = requireExit(
    captureCommand({
      root: input.root,
      binary: input.fakeCodex,
      args: ['plugin', 'list', '--json'],
      cwd: input.repo,
      env: input.env,
    }),
    0,
    'candidate Codex registration',
  );
  const version = requireExit(
    captureCommand({
      root: input.root,
      binary: input.candidateBinary,
      args: ['--version'],
      cwd: input.repo,
      env: input.env,
      executionAdapter: input.executionAdapter,
    }),
    0,
    'candidate binary version',
  );
  if (!version.stdout.includes(input.candidate.facts.version)) {
    throw new Error('candidate binary did not report the authenticated T generation');
  }
  const routePath = join(input.repo, '.codex', 'config.toml');
  const routeBytes = readFileSync(routePath, 'utf8');
  const routeCommand = routeBytes.match(/mcp_servers\.genie\.command\s*=\s*"([^"]+)"/)?.[1];
  if (
    routeCommand === undefined ||
    realpathSync(routeCommand) !== input.candidateBinary ||
    !routeBytes.includes('args = ["mcp"]') ||
    /\.cwd\s*=/.test(routeBytes)
  ) {
    throw new Error(`candidate project route did not converge to the exact stable facade: ${routeBytes}`);
  }
  const sourceRoles = join(input.candidate.releaseRoot, 'plugins', 'genie', 'codex-agents');
  const targetRoles = join(input.codexHome, 'agents');
  const roleNames = readdirSync(sourceRoles).filter((name) => name.endsWith('.toml'));
  const installedRoleNames = readdirSync(targetRoles).filter((name) => name.endsWith('.toml'));
  const reviewerSha256 = sha256File(join(sourceRoles, 'genie-reviewer.toml'));
  if (
    roleNames.length === 0 ||
    installedRoleNames.length !== roleNames.length ||
    sha256File(join(targetRoles, 'genie-reviewer.toml')) !== reviewerSha256
  ) {
    throw new Error('candidate role-agent convergence did not match the authenticated payload');
  }
  return {
    commands: [plugin, version],
    convergence: {
      route: { state: 'managed-project', command: routeCommand, cwdOverride: null },
      roles: {
        expectedCount: roleNames.length,
        observedCount: installedRoleNames.length,
        current: true,
        reviewerSha256,
      },
    },
  };
}

async function runLifecycle(
  root: string,
  input: DogfoodEntryInput,
  previous: VerifiedGeneration,
  candidate: VerifiedGeneration,
  dependencies: DogfoodHarnessDependencies,
): Promise<LifecycleResult> {
  const genieHome = join(root, 'genie-home');
  const codexHome = join(root, 'codex-home');
  const reposRoot = join(root, 'repos');
  const env = isolatedDogfoodEnv(root, {
    GENIE_HOME: genieHome,
    CODEX_HOME: codexHome,
    GENIE_RELEASE_DOGFOOD: '1',
    TERM: 'xterm',
  });
  const repoA = initRepo(join(reposRoot, 'a'), env);
  const repoB = initRepo(join(reposRoot, 'b'), env);
  mkdirSync(codexHome, { recursive: true });
  const { command: fakeCodex, stateDir } = installFakeCodex(root, previous, candidate, env);
  const configPath = join(codexHome, 'config.toml');
  const trustedProjects = [...new Set([repoA, realpathSync(repoA), repoB, realpathSync(repoB)])];
  writeFileSync(
    configPath,
    `[plugins."genie@automagik"]\nenabled = true\n${trustedProjects
      .map((path) => `[projects."${path}"]\ntrust_level = "trusted"\n`)
      .join('')}`,
  );

  const previousBinary = installGeneration(previous, genieHome);
  const previousCache = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', previous.facts.version);
  cpSync(previous.payloadPath, previousCache, { recursive: true });
  const seededA = seedSentinelWithCli({
    root,
    binary: previousBinary,
    executionAdapter: input.executionAdapter,
    repo: repoA,
    env,
    label: 'a',
    initialize: true,
  });
  const stages: StageProjection[] = [
    stage(
      'seed-repositories',
      {
        exit: 0,
        humanState: 'seeded',
        jsonState: 'seeded',
        activeVersion: previous.facts.version,
        trailer: null,
      },
      seededA.commands,
    ),
  ];
  const nVersion = requireExit(
    captureCommand({
      root,
      binary: previousBinary,
      args: ['--version'],
      cwd: repoA,
      env,
      executionAdapter: input.executionAdapter,
    }),
    0,
    'previous binary version',
  );
  const nPlugin = requireExit(
    captureCommand({ root, binary: fakeCodex, args: ['plugin', 'list', '--json'], cwd: repoA, env }),
    0,
    'previous Codex registration',
  );
  if (!nVersion.stdout.includes(previous.facts.version) || !nPlugin.stdout.includes(previous.facts.version)) {
    throw new Error('verified previous generation N was not the active parent');
  }
  stages.push(
    stage(
      'n-parent-active',
      {
        exit: 0,
        humanState: 'current',
        jsonState: 'current',
        activeVersion: previous.facts.version,
        trailer: null,
      },
      [nVersion, nPlugin],
    ),
  );

  const candidateBinary = installGeneration(candidate, genieHome);
  const request = {
    schemaVersion: 1,
    platformId: input.platformId,
    artifact: copyRuntimeInput(root, 'candidate-artifact', candidate.paths.artifact),
    manifest: copyRuntimeInput(root, 'candidate-manifest', candidate.paths.manifest),
    descriptor: copyRuntimeInput(root, 'candidate-descriptor', candidate.paths.identity),
    bundle: copyRuntimeInput(root, 'candidate-bundle', candidate.paths.bundle),
  };
  const repaired = requireExit(
    captureCommand({
      root,
      binary: candidateBinary,
      args: ['update', '--publish-local-delivery', JSON.stringify(request)],
      cwd: repoA,
      env,
      executionAdapter: input.executionAdapter,
      timeoutMs: 180_000,
    }),
    2,
    'candidate local delivery publication',
  );
  const repairTrailer = parseResultTrailer(`${repaired.stdout}\n${repaired.stderr}`);
  if (
    repairTrailer.code !== 'activation-pending' ||
    repairTrailer.deliveryComplete !== true ||
    readRegisteredVersion(stateDir) !== previous.facts.version
  ) {
    throw new Error('candidate repair did not preserve N until explicit activation consent');
  }
  stages.push(
    stage(
      't-delivery-repair',
      {
        exit: 2,
        humanState: 'activation-pending',
        jsonState: 'activation-pending',
        activeVersion: previous.facts.version,
        trailer: repairTrailer,
      },
      [repaired],
    ),
  );

  const activated = requireExit(
    capturePtySetup({
      root,
      binary: candidateBinary,
      cwd: repoA,
      env,
      executionAdapter: input.executionAdapter,
    }),
    0,
    'candidate real-PTY setup',
  );
  if (
    !/Activated Codex plugin/.test(`${activated.stdout}\n${activated.stderr}`) ||
    readRegisteredVersion(stateDir) !== candidate.facts.version
  ) {
    throw new Error('candidate setup did not activate the exact T generation');
  }
  stages.push(
    stage(
      'activation-consent',
      {
        exit: 0,
        humanState: 'activated',
        jsonState: 'current',
        activeVersion: candidate.facts.version,
        trailer: null,
      },
      [activated],
    ),
  );

  const converged = observeAssetConvergence({
    root,
    candidate,
    candidateBinary,
    fakeCodex,
    repo: repoA,
    codexHome,
    env,
    executionAdapter: input.executionAdapter,
  });
  stages.push(
    stage(
      'assets-converged',
      {
        exit: 0,
        humanState: 'current',
        jsonState: 'current',
        activeVersion: candidate.facts.version,
        trailer: null,
      },
      converged.commands,
    ),
  );

  const nativeInput = (tag: string, requestedCwd: string): NativeMcpEvidenceInput => ({
    tag,
    requestedCwd,
    candidateBinary,
    candidateBinarySha256: candidate.binarySha256,
    executionAdapter: input.executionAdapter,
    root,
    env,
  });
  const bBefore = await observeMcp(nativeInput('b-before-init', repoB), dependencies, input.evidenceKind);
  if (!bBefore.isError || bBefore.payload.error !== 'project-database-unavailable') {
    throw new Error('untouched B did not fail closed through real Codex before init');
  }
  if ('tasks' in bBefore.payload || 'counts' in bBefore.payload) throw new Error('untouched B returned an empty board');
  stages.push(
    stage(
      'untouched-b-before-init',
      {
        exit: 1,
        humanState: 'project-database-unavailable',
        jsonState: 'project-database-unavailable',
        activeVersion: candidate.facts.version,
        trailer: null,
      },
      [nativeObservationCommand(bBefore, candidateBinary, candidate.binarySha256, input.executionAdapter)],
    ),
  );

  const seededB = seedSentinelWithCli({
    root,
    binary: candidateBinary,
    executionAdapter: input.executionAdapter,
    repo: repoB,
    env,
    label: 'b',
    initialize: true,
  });
  const bAfterEvidence = await observeMcp(nativeInput('b-after-init', repoB), dependencies, input.evidenceKind);
  const bAfter = { ...observedRepo(repoB, seededB.expected, bAfterEvidence), routeState: 'managed-project' as const };
  stages.push(
    stage(
      'untouched-b-after-init',
      {
        exit: 0,
        humanState: 'current',
        jsonState: 'current',
        activeVersion: candidate.facts.version,
        trailer: null,
      },
      [
        ...seededB.commands,
        nativeObservationCommand(bAfterEvidence, candidateBinary, candidate.binarySha256, input.executionAdapter),
      ],
    ),
  );

  const aEvidence = await observeMcp(nativeInput('a-new-thread', repoA), dependencies, input.evidenceKind);
  const a = observedRepo(repoA, seededA.expected, aEvidence);
  if (a.sentinel.token === bAfter.sentinel.token) throw new Error('two-repo sentinels collided');
  if (JSON.stringify(a.sentinel.observed).includes(bAfter.sentinel.token)) throw new Error('B sentinel leaked into A');
  if (JSON.stringify(bAfter.sentinel.observed).includes(a.sentinel.token)) throw new Error('A sentinel leaked into B');
  stages.push(
    stage(
      'new-thread-sentinel',
      {
        exit: 0,
        humanState: 'current',
        jsonState: 'current',
        activeVersion: candidate.facts.version,
        trailer: null,
      },
      [nativeObservationCommand(aEvidence, candidateBinary, candidate.binarySha256, input.executionAdapter)],
    ),
  );

  const doctorObservation = requireExit(
    captureCommand({
      root,
      binary: candidateBinary,
      args: ['doctor', '--json'],
      cwd: repoA,
      env,
      executionAdapter: input.executionAdapter,
    }),
    0,
    'candidate doctor',
  );
  const doctor = parseDoctor(doctorObservation);
  stages.push(
    stage(
      'doctor-current',
      {
        exit: 0,
        humanState: 'current',
        jsonState: 'current',
        activeVersion: candidate.facts.version,
        trailer: null,
      },
      [doctorObservation],
    ),
  );

  const delivery = JSON.parse(readFileSync(join(genieHome, '.codex-plugin-delivery-record.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return {
    genieHome,
    delivery,
    doctor,
    stages,
    repositories: {
      cacheRoot: join(codexHome, 'plugins', 'cache', 'automagik', 'genie'),
      a,
      b: {
        root: repoB,
        beforeInit: {
          routeState: 'absent',
          fallbackUsed: false,
          result: 'project-database-unavailable',
          returnedTasks: 0,
        },
        afterInit: bAfter,
      },
    },
    convergence: converged.convergence,
  };
}

function buildManifest(
  input: DogfoodEntryInput,
  previous: VerifiedGeneration,
  candidate: VerifiedGeneration,
  lifecycle: LifecycleResult,
  repositories: Record<string, unknown>,
): Record<string, unknown> {
  const artifactEvidence = (generation: VerifiedGeneration) => ({
    version: generation.facts.version,
    channel: generation.facts.channel,
    platformId: generation.facts.platformId,
    platformTriple: generation.facts.platformTriple,
    releaseTag: generation.facts.releaseTag,
    releaseName: generation.facts.releaseName,
    manifestSha256: generation.manifestSha256,
    artifactSha256: generation.artifactSha256,
    binarySha256: generation.binarySha256,
    payloadSha256: generation.payloadSha256,
    evidenceDigest: generation.evidenceDigest,
    provenance: {
      kind: generation.evidence === null ? 'release-tarball' : 'delivery-evidence',
      repository: DELIVERY_EVIDENCE_REPOSITORY,
      predicateType:
        generation.evidence === null ? 'https://slsa.dev/provenance/v0.2' : DELIVERY_EVIDENCE_PREDICATE_TYPE,
      workflowIdentity:
        generation.evidence === null
          ? 'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0'
          : DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
      oidcIssuer: DELIVERY_EVIDENCE_OIDC_ISSUER,
      sourceCommit: generation.facts.sourceSha,
      controlCommit: generation.facts.controlSha,
      sourceBranch: generation.facts.sourceBranch,
      sourceCiRunId: generation.facts.sourceCiRunId,
      identitySha256: generation.identitySha256,
      bundleSha256: generation.bundleSha256,
    },
  });
  const logicalPaths = (label: 'previous' | 'candidate', paths: GenerationInputPaths) => ({
    artifact: `${label}/${basename(paths.artifact)}`,
    manifest: `${label}/${basename(paths.manifest)}`,
    identity: `${label}/${basename(paths.identity)}`,
    bundle: `${label}/${basename(paths.bundle)}`,
    identityKind: paths.identityKind,
  });
  return {
    kind: 'live-dogfood-evidence',
    schemaVersion: LIVE_DOGFOOD_SCHEMA_VERSION,
    entry: {
      id: `${candidate.facts.version}-${input.platformId}`,
      evidenceKind: input.evidenceKind,
      availability: 'verified',
      platformId: input.platformId,
      platformTriple: candidate.facts.platformTriple,
      artifactName: candidate.facts.releaseName,
      inputs: {
        previous: logicalPaths('previous', previous.paths),
        candidate: logicalPaths('candidate', candidate.paths),
      },
    },
    lifecycle: {
      previousVersion: previous.facts.version,
      candidateVersion: candidate.facts.version,
      channel: candidate.facts.channel,
      sourceCommit: candidate.facts.sourceSha,
      artifacts: {
        previous: artifactEvidence(previous),
        candidate: artifactEvidence(candidate),
      },
      delivery: {
        schemaVersion: lifecycle.delivery.schemaVersion,
        deliveryId: lifecycle.delivery.deliveryId,
        evidenceDigest: lifecycle.delivery.evidenceDigest,
        root: lifecycle.delivery.deliveryRoot,
        targetVersion: lifecycle.delivery.targetVersion,
        platformId: lifecycle.delivery.platformId,
        platformTriple: lifecycle.delivery.platformTriple,
        releaseTag: lifecycle.delivery.releaseTag,
        releaseName: lifecycle.delivery.releaseName,
        releaseManifestSha256: lifecycle.delivery.releaseManifestSha256,
        artifactSha256: lifecycle.delivery.artifactSha256,
        installedBinarySha256: lifecycle.delivery.installedBinarySha256,
        canonicalPayloadSha256: lifecycle.delivery.canonicalPayloadSha256,
      },
      convergence: lifecycle.convergence,
      stages: lifecycle.stages,
    },
    repositories,
  };
}

function renderEvidence(manifest: Record<string, unknown>, doctor: Record<string, unknown>): string {
  return [
    '# Codex dogfood matrix evidence',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
    '## Production doctor JSON',
    '',
    '```json',
    JSON.stringify(doctor, null, 2),
    '```',
    '',
  ].join('\n');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
