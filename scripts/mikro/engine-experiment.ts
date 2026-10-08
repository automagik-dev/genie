#!/usr/bin/env bun
/**
 * Frozen, serial experiment through the real Genie caller. No fixture overlays, model substitutes,
 * resume/resampling or alternate scorer. --preflight is non-inference; --report-only only analyzes
 * an already complete cohort after independent native receipts have landed.
 * Profile/manifest schemas below are the executable operator contract; all paths are absolute.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { type RunResult, gitProbeEnv, runAgent, untrustedConfig } from './call';
import {
  fileSha256,
  immutableJson,
  inside,
  safeFailureMessage,
  sha256,
  verifySeals,
} from './engine-experiment-runtime.mjs';
import { type Score, scoreAnswer } from './score';
import { MIKRO_CONFIG_FILES } from './trusted-source';

const absolute = z.string().refine(isAbsolute, 'absolute path required');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const arm = z.enum(['rlm-unpatched', 'rlm-patched', 'pi']);
const sealSchema = z
  .object({
    path: absolute,
    kind: z.enum(['file', 'directory', 'absent']),
    sha256: digest.nullable(),
  })
  .strict()
  .refine((seal) => (seal.kind === 'absent') === (seal.sha256 === null), 'absence/hash mismatch');
const fileSealSchema = z.object({ path: absolute, kind: z.literal('file'), sha256: digest }).strict();
const provenanceSchema = z
  .object({
    sourceCommit: commit,
    version: z.string().min(1),
    dependencies: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0),
    rates: z
      .object({
        kind: z.literal('sdk-nominal-estimate-not-invoice'),
        source: z.string().min(1),
        evidence: z.array(sealSchema).min(1),
        notes: z.string().min(1),
      })
      .strict(),
    confounds: z.array(z.string().min(1)).min(1),
  })
  .strict();
const profileSchema = z
  .object({
    version: z.literal(1),
    generation: z.enum(['old', 'new']),
    engine: z.enum(['rlm', 'pi']),
    artifactRoot: absolute,
    configRoot: absolute,
    agentsDir: absolute,
    homeRoot: absolute,
    receiptRoot: absolute,
    runtimePath: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
    baseUrl: z.string().url(),
    effectiveConfigSha256: digest,
    credential: z
      .object({ envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), keyFile: absolute })
      .strict()
      .nullable(),
    requestOptions: z
      .object({ serviceTier: z.literal('fast') })
      .strict()
      .optional(),
    seals: z.array(sealSchema).min(1),
    provenance: provenanceSchema,
  })
  .strict();
const cellSchema = z
  .object({ id, fixtureId: id, modelId: id, arm, rep: z.union([z.literal(0), z.literal(1), z.literal(2)]) })
  .strict();
const bindingSchema = z
  .object({
    fixtureId: id,
    modelId: id,
    arm,
    profilePath: absolute,
    profileSha256: digest,
    launcherDir: absolute,
    launcherSha256: digest,
    callerAgentsDir: absolute,
  })
  .strict();
const candidateSchema = z
  .object({
    id,
    requested: z.enum(['GLM 5.3', 'GPT-6 Luna fast', 'GLM 5.3-flash', 'Xiaomi MiMo 2.6']),
    status: z.enum(['available', 'excluded']),
    advertisedId: z.string().nullable(),
    catalog: sealSchema.nullable(),
    capability: sealSchema.nullable(),
    reason: z.string().min(1),
  })
  .strict();
const fixtureSchema = z
  .object({
    id,
    dir: absolute,
    commonDir: absolute,
    workingTreeSha256: digest,
  })
  .strict();
const smokeIds = [
  'canonical-rlm',
  'canonical-pi',
  'provider-failure',
  'repl-timeout',
  'cap-final',
  'citation-security',
  'pi-containment',
  'juice-configured',
  'native-workflow',
];
// Native remains its own observer input. Preserve every field while binding the resources it can mutate.
const nativeCellBindingSchema = z
  .object({
    id,
    cwd: absolute,
    gitCommonDir: absolute,
    runRoot: absolute,
    args: z.record(z.string(), z.unknown()),
    offloadLedgerRoots: z.array(absolute),
    launch: z.object({ offloadReceiptRoot: absolute, seals: z.array(sealSchema) }).passthrough(),
    remotePolicy: z.object({ roots: z.array(absolute).optional() }).passthrough(),
  })
  .passthrough();
const nativeWorkflowBindingSchema = z
  .object({
    receiptPath: absolute,
    smokeReceiptPath: absolute,
    runtime: z.object({ root: absolute }).passthrough(),
    loader: z.object({ root: absolute }).passthrough(),
    smoke: nativeCellBindingSchema,
    cells: z.array(nativeCellBindingSchema).length(18),
    report: z.object({ ledgerHome: absolute }).passthrough().optional(),
  })
  .passthrough();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: id,
    frozenAt: z.string().datetime(),
    outputRoot: absolute,
    node: z.object({ path: absolute, sha256: digest, version: z.literal('v26.7.0') }).strict(),
    fixtureRegistration: sealSchema,
    protectedRoots: z.array(absolute).min(3),
    method: z
      .object({
        agent: z.literal('wish-context'),
        reps: z.literal(3),
        concurrency: z.literal(1),
        boundary: z.literal('none'),
        facts: z.literal(false),
        phoenix: z.literal(false),
        outerRetries: z.literal(1),
        maxIterations: z.literal(16),
        maxCostUsd: z.literal(0.3),
        maxDepth: z.literal(0),
        timeoutMs: z.literal(600000),
      })
      .strict(),
    harnessSeals: z.array(sealSchema).min(1),
    fixtures: z.array(fixtureSchema).length(4),
    candidates: z.array(candidateSchema).length(4),
    bindings: z.array(bindingSchema).min(12),
    cells: z.array(cellSchema).min(36),
    smokes: z.array(z.object({ id, receipt: sealSchema }).strict()).min(smokeIds.length),
    workflow: nativeWorkflowBindingSchema.extend({ nativeManifest: fileSealSchema }),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
type Cell = z.infer<typeof cellSchema>;
type Profile = z.infer<typeof profileSchema>;
type Seal = z.infer<typeof sealSchema>;
const registeredFixtureSchema = z.object({
  id,
  repository: z.enum(['genie', 'brain']),
  sourceCommit: commit,
  parentCommit: commit,
  evaluationCommit: commit,
  evaluationTree: commit,
  sourceTree: commit,
  prompt: z.string().min(1),
  truth: z.array(z.object({ path: z.string().min(1), new: z.boolean(), expectedEvidence: z.boolean() })).min(1),
});
type Fixture = z.infer<typeof registeredFixtureSchema>;
const registrationSchema = z.object({ version: z.literal(1), fixtures: z.array(registeredFixtureSchema).length(4) });
const runtimeReceiptSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    sessionId: z.string(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    failed: z.boolean(),
    costKind: z.literal('sdk-nominal-estimate-not-invoice'),
    binding: z
      .object({
        profileSha256: digest,
        effectiveConfigSha256: digest,
        provider: z.string(),
        model: z.string(),
        api: z.string(),
        node: absolute,
        nodeVersion: z.literal('v26.7.0'),
        artifactRoot: absolute,
        engine: z.enum(['rlm', 'pi']),
        generation: z.enum(['old', 'new']),
      })
      .passthrough(),
    observed: z
      .object({
        kind: z.enum(['returned', 'thrown']),
        iterations: z.number().int().nonnegative().nullable(),
        budgetHit: z.string().nullable().optional(),
        usageComplete: z.boolean(),
        usage: z
          .object({
            inputTokens: z.number().finite().nonnegative(),
            outputTokens: z.number().finite().nonnegative(),
            totalCost: z.number().finite().nonnegative(),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough()
      .nullable(),
    tierEvents: z
      .array(z.object({ requested: z.literal('fast'), served: z.string().nullable(), model: z.string().nullable() }))
      .optional(),
  })
  .passthrough();
type RuntimeReceipt = z.infer<typeof runtimeReceiptSchema>;
interface CellRecord {
  cell: Cell;
  result: RunResult | null;
  error: string | null;
  receipts: RuntimeReceipt[];
  receiptProblems: string[];
  verified: boolean;
  score: Score | null;
  expectedCitationCoverage: number;
  elapsedMs: number;
  sdkNominalKnownSubtotalUsd: number | null;
  sdkNominalTotalUsd: number | null;
  roundedFooterKnownSubtotalUsd: number | null;
  pathClassification: {
    kind: 'existing' | 'new';
    expected: string[];
    predicted: string[];
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    exact: boolean;
  }[];
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function sameSet(actual: string[], expected: string[], label: string) {
  requireThat(
    new Set(actual).size === actual.length &&
      actual.length === expected.length &&
      actual.every((value) => expected.includes(value)),
    `${label}: missing, duplicated or extra frozen member`,
  );
}
function git(dir: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', dir, ...args], { env: gitProbeEnv(), stdout: 'pipe', stderr: 'pipe' });
  requireThat(result.exitCode === 0, `fixture git probe failed: ${args[0]}`);
  return result.stdout.toString().trim();
}
export function workingTreeSha256(dir: string): string {
  // Freeze the complete physical parent, excluding only root Git administration.
  // Checkout symlinks are link text, never executable-dependency seals or target reads.
  const hash = createHash('sha256');
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === dir && name === '.git') continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      const rel = relative(dir, path);
      if (stat.isSymbolicLink()) {
        hash.update(`${JSON.stringify([rel, 'symlink', readlinkSync(path)])}\n`);
      } else if (stat.isDirectory()) {
        hash.update(`${JSON.stringify([rel, 'directory'])}\n`);
        walk(path);
      } else {
        requireThat(stat.isFile(), `irregular fixture entry: ${path}`);
        hash.update(`${JSON.stringify([rel, 'file', fileSha256(path)])}\n`);
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}
function sealPresent(seals: Seal[], path: string, kind?: Seal['kind']) {
  requireThat(
    seals.some((seal) => seal.path === path && (!kind || seal.kind === kind)),
    `required provenance seal: ${path}`,
  );
}
function profileFor(manifest: Manifest, cell: Pick<Cell, 'fixtureId' | 'modelId' | 'arm'>) {
  const binding = manifest.bindings.find(
    (row) => row.fixtureId === cell.fixtureId && row.modelId === cell.modelId && row.arm === cell.arm,
  );
  requireThat(binding, `missing runtime binding: ${cell.fixtureId}/${cell.modelId}/${cell.arm}`);
  requireThat(fileSha256(binding.profilePath) === binding.profileSha256, 'frozen profile changed');
  return { binding, profile: profileSchema.parse(json(binding.profilePath)) };
}
function fixtureFor(manifest: Manifest, cell: Cell, fixtures: Fixture[]) {
  const target = manifest.fixtures.find((fixture) => fixture.id === cell.fixtureId);
  const fixture = fixtures.find((row) => row.id === cell.fixtureId);
  requireThat(target && fixture, `missing fixture ${cell.fixtureId}`);
  return { target, fixture };
}
function validateFixture(manifest: Manifest, target: Manifest['fixtures'][number], fixture: Fixture) {
  const dir = realpathSync(target.dir);
  requireThat(!manifest.protectedRoots.some((root) => inside(root, dir)), 'fixture belongs to a protected repository');
  const common = realpathSync(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  requireThat(
    common === realpathSync(target.commonDir) && !manifest.protectedRoots.some((root) => inside(root, common)),
    'fixture must have its own complete git/common directory',
  );
  requireThat(!existsSync(join(common, 'objects/info/alternates')), 'fixture may not borrow protected objects');
  requireThat(git(dir, ['rev-parse', '--is-shallow-repository']) === 'false', 'fixture must retain complete history');
  requireThat(git(dir, ['rev-parse', 'HEAD']) === fixture.evaluationCommit, 'fixture HEAD changed');
  requireThat(git(dir, ['rev-parse', 'HEAD^{tree}']) === fixture.evaluationTree, 'parent evaluation tree changed');
  requireThat(
    git(dir, ['rev-parse', `${fixture.sourceCommit}^{tree}`]) === fixture.sourceTree,
    'source tree provenance changed',
  );
  requireThat(
    git(dir, ['rev-parse', `${fixture.sourceCommit}^`]) === fixture.parentCommit,
    'source/parent relation changed',
  );
  requireThat(workingTreeSha256(dir) === target.workingTreeSha256, 'physical parent checkout changed');
  requireThat(!git(dir, ['status', '--porcelain', '--untracked-files=all']), 'fixture must remain clean');
  for (const truth of fixture.truth) {
    let present = true;
    try {
      lstatSync(join(dir, truth.path));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') present = false;
      else throw error;
    }
    requireThat(present !== truth.new, `truth/physical parent mismatch: ${truth.path}`);
  }
}
function validateSmoke(path: string, expectedId: string, frozenAt: string) {
  const smoke = z
    .object({
      id: z.string(),
      ok: z.literal(true),
      scored: z.literal(false),
      completedAt: z.string().datetime(),
      command: z.array(z.string()).min(1),
      exitCode: z.literal(0),
      evidence: z.array(sealSchema).min(1),
    })
    .parse(json(path));
  requireThat(
    smoke.id === expectedId && Date.parse(smoke.completedAt) <= Date.parse(frozenAt),
    `smoke not frozen before outcomes: ${expectedId}`,
  );
  verifySeals(smoke.evidence);
}
function canonicalBindingPath(path: string) {
  const target = resolve(path);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, target));
}

export function validateNativeManifestBinding(
  manifest: Pick<Manifest, 'workflow' | 'outputRoot' | 'protectedRoots' | 'fixtures' | 'harnessSeals'>,
  engineManifestPath: string,
) {
  const { nativeManifest, ...workflow } = manifest.workflow;
  fileSealSchema.parse(nativeManifest);
  verifySeals([nativeManifest]);
  const path = realpathSync(nativeManifest.path);
  requireThat(path !== canonicalBindingPath(engineManifestPath), 'native input must be independent of engine input');
  const cells = [workflow.smoke, ...workflow.cells];
  const roots = [
    manifest.outputRoot,
    ...manifest.protectedRoots,
    ...manifest.fixtures.flatMap((fixture) => [fixture.dir, fixture.commonDir]),
    workflow.runtime.root,
    workflow.loader.root,
    ...(workflow.report ? [workflow.report.ledgerHome] : []),
    ...manifest.harnessSeals.filter((seal) => seal.kind === 'directory').map((seal) => seal.path),
    ...cells.flatMap((cell) => [
      cell.cwd,
      cell.gitCommonDir,
      cell.runRoot,
      cell.launch.offloadReceiptRoot,
      ...cell.offloadLedgerRoots,
      ...(cell.remotePolicy.roots ?? []),
      ...cell.launch.seals.filter((seal) => seal.kind === 'directory').map((seal) => seal.path),
    ]),
  ];
  requireThat(
    !roots.some((root) => inside(canonicalBindingPath(root), path)),
    'native input cannot belong to mutable/protected resources or recursively sealed trees',
  );
  requireThat(
    ![workflow.receiptPath, workflow.smokeReceiptPath].some((receipt) => canonicalBindingPath(receipt) === path),
    'native input cannot be a native output artifact',
  );
  sameSet(
    cells.map((cell) => cell.id),
    [...new Set(cells.map((cell) => cell.id))],
    'native smoke/cell ids',
  );
  const decoded = z.object({ workflow: nativeWorkflowBindingSchema }).parse(json(path));
  requireThat(
    isDeepStrictEqual(decoded.workflow, workflow),
    'independent native workflow differs from frozen engine workflow resources/arguments/controls',
  );
  return nativeManifest;
}

function preflight(manifest: Manifest, engineManifestPath: string): Fixture[] {
  requireThat(Date.parse(manifest.frozenAt) <= Date.now(), 'future freeze timestamp');
  for (const root of [
    '/home/genie/workspace/repos/genie',
    '/home/genie/workspace/repos/brain',
    '/home/genie/workspace/repos/mikro',
    '/home/genie/.mikro/mikro',
  ]) {
    requireThat(manifest.protectedRoots.includes(root), `missing protected original: ${root}`);
  }
  verifySeals([manifest.fixtureRegistration, ...manifest.harnessSeals]);
  validateNativeManifestBinding(manifest, engineManifestPath);
  requireThat(manifest.fixtureRegistration.kind === 'file', 'fixture registration must be a file');
  const fixtures = registrationSchema.parse(json(manifest.fixtureRegistration.path)).fixtures;
  sameSet(
    fixtures.map((fixture) => fixture.id),
    ['genie-existing', 'brain-existing', 'brain-new-directory', 'genie-new-directory'],
    'registered fixtures',
  );
  sameSet(
    manifest.fixtures.map((fixture) => fixture.id),
    fixtures.map((fixture) => fixture.id),
    'target fixtures',
  );
  const commonDirs = manifest.fixtures.map((fixture) => realpathSync(fixture.commonDir));
  requireThat(
    new Set(commonDirs).size === manifest.fixtures.length,
    'each fixture requires an independent git/common directory',
  );
  sameSet(
    manifest.candidates.map((candidate) => candidate.requested),
    ['GLM 5.3', 'GPT-6 Luna fast', 'GLM 5.3-flash', 'Xiaomi MiMo 2.6'],
    'candidate declarations',
  );
  sameSet(
    manifest.candidates.map((candidate) => candidate.id),
    [...new Set(manifest.candidates.map((candidate) => candidate.id))],
    'candidate ids',
  );
  requireThat(
    !manifest.candidates.some((candidate) => candidate.id === 'flash-control'),
    'candidate/control identity collision',
  );
  for (const name of [
    'engine-experiment.ts',
    'engine-experiment-runtime.mjs',
    'call.ts',
    'schemas.ts',
    'score.ts',
    'trusted-source.ts',
  ]) {
    sealPresent(manifest.harnessSeals, join(dirname(fileURLToPath(import.meta.url)), name), 'file');
  }
  const scriptsRoot = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptsRoot, '..', '..');
  sealPresent(manifest.harnessSeals, scriptsRoot, 'directory');
  for (const path of [process.execPath, join(repoRoot, 'package.json'), join(repoRoot, 'bun.lock')]) {
    sealPresent(manifest.harnessSeals, path, 'file');
  }
  sealPresent(manifest.harnessSeals, join(repoRoot, 'node_modules/zod'), 'directory');
  requireThat(fileSha256(manifest.node.path) === manifest.node.sha256, 'Node executable changed');
  const node = Bun.spawnSync([manifest.node.path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  requireThat(
    node.exitCode === 0 && node.stdout.toString().trim() === manifest.node.version,
    'wrong actual Node runtime',
  );
  for (const expected of smokeIds) {
    const smoke = manifest.smokes.find((row) => row.id === expected);
    requireThat(smoke && smoke.receipt.kind === 'file', `missing required actual smoke: ${expected}`);
    verifySeals([smoke.receipt]);
    validateSmoke(smoke.receipt.path, expected, manifest.frozenAt);
  }
  const candidateLiteral: Record<string, string> = {
    'GLM 5.3': 'glm-5.3-juiced',
    'GPT-6 Luna fast': 'gpt-6-luna',
    'GLM 5.3-flash': 'glm-5.3-flash-juiced',
    'Xiaomi MiMo 2.6': 'mimo-v2.6-flash',
  };
  for (const candidate of manifest.candidates) {
    if (candidate.status === 'excluded') continue;
    requireThat(
      candidate.advertisedId === candidateLiteral[candidate.requested] &&
        candidate.catalog?.kind === 'file' &&
        candidate.capability?.kind === 'file',
      `candidate capability/catalog missing: ${candidate.id}`,
    );
    verifySeals([candidate.catalog, candidate.capability]);
    const catalog = z
      .object({
        version: z.literal(1),
        project: z.string().min(1),
        keyAlias: z.string().min(1),
        keyEpoch: z.string().min(1),
        url: z.string().url(),
        fetchedAt: z.string().datetime(),
        contentSha256: digest,
        models: z.array(z.object({ id: z.string(), ownedBy: z.string().nullable() })),
      })
      .parse(json(candidate.catalog.path));
    requireThat(
      Date.parse(catalog.fetchedAt) <= Date.parse(manifest.frozenAt) &&
        catalog.contentSha256 === sha256(JSON.stringify(catalog.models)),
      'catalog identity/hash must be frozen before outcomes',
    );
    requireThat(
      catalog.models.some((model) => model.id === candidate.advertisedId),
      'requested literal absent from authenticated catalog',
    );
    validateSmoke(candidate.capability.path, `candidate-${candidate.id}`, manifest.frozenAt);
    if (candidate.requested === 'GPT-6 Luna fast') {
      const capability = z
        .object({ requestedTier: z.literal('fast'), servedTier: z.literal('fast') })
        .parse(json(candidate.capability.path));
      requireThat(capability.servedTier === capability.requestedTier, 'fast capability was not actually served');
    }
  }
  const expectedCells: string[] = [];
  const expectedBindings: string[] = [];
  const models = [
    'flash-control',
    ...manifest.candidates.filter((candidate) => candidate.status === 'available').map((candidate) => candidate.id),
  ];
  for (const fixture of fixtures)
    for (const model of models)
      for (const selectedArm of model === 'flash-control' ? arm.options : (['rlm-patched', 'pi'] as const)) {
        expectedBindings.push(`${fixture.id}/${model}/${selectedArm}`);
        for (const rep of [0, 1, 2]) expectedCells.push(`${fixture.id}/${model}/${selectedArm}/${rep}`);
      }
  sameSet(
    manifest.cells.map((cell) => `${cell.fixtureId}/${cell.modelId}/${cell.arm}/${cell.rep}`),
    expectedCells,
    'required cohort cells',
  );
  sameSet(
    manifest.cells.map((cell) => cell.id),
    [...new Set(manifest.cells.map((cell) => cell.id))],
    'cell IDs',
  );
  sameSet(
    manifest.bindings.map((binding) => `${binding.fixtureId}/${binding.modelId}/${binding.arm}`),
    expectedBindings,
    'runtime bindings',
  );
  for (const target of manifest.fixtures) {
    const fixture = fixtures.find((row) => row.id === target.id);
    requireThat(fixture, 'missing fixture');
    validateFixture(manifest, target, fixture);
  }
  for (const binding of manifest.bindings) {
    const { profile } = profileFor(manifest, binding);
    requireThat(
      profile.artifactRoot === (binding.arm === 'rlm-unpatched' ? '/home/genie/.mikro/mikro' : join(repoRoot, 'mikro')),
      'arm must bind the selected immutable old/current integrated physical artifact',
    );
    const expectedEngine = binding.arm === 'pi' ? 'pi' : 'rlm';
    requireThat(
      profile.engine === expectedEngine && profile.generation === (binding.arm === 'rlm-unpatched' ? 'old' : 'new'),
      'arm/runtime mismatch',
    );
    requireThat(
      profile.provenance.sourceCommit && profile.provenance.confounds.length,
      'source/dependency/provider confounds required',
    );
    verifySeals([...profile.seals, ...profile.provenance.rates.evidence]);
    for (const path of [
      join(profile.artifactRoot, 'dist'),
      join(profile.artifactRoot, 'src'),
      join(profile.artifactRoot, 'node_modules'),
      join(profile.artifactRoot, 'python'),
      join(profile.configRoot, '.mikro'),
      profile.agentsDir,
    ])
      sealPresent(profile.seals, path, 'directory');
    for (const path of [join(profile.artifactRoot, 'package.json'), join(profile.artifactRoot, 'package-lock.json')])
      sealPresent(profile.seals, path, 'file');
    const sdkVersions =
      profile.generation === 'old'
        ? { '@earendil-works/pi-ai': '0.80.10' }
        : {
            '@earendil-works/pi-ai': '1.0.2',
            '@earendil-works/pi-coding-agent': '1.0.2',
            '@earendil-works/pi-agent-core': '1.0.2',
            typebox: '1.3.27',
          };
    for (const [dependency, expected] of Object.entries(sdkVersions)) {
      requireThat(
        profile.provenance.dependencies[dependency] === expected,
        `missing actual dependency provenance: ${dependency}`,
      );
      const installed = z
        .object({ version: z.string() })
        .parse(json(join(profile.artifactRoot, 'node_modules', dependency, 'package.json')));
      requireThat(installed.version === expected, `installed dependency/version mismatch: ${dependency}`);
    }
    sealPresent(profile.seals, join(profile.homeRoot, '.mikro/settings.json'));
    requireThat(
      profile.seals.some((seal) => seal.path === binding.callerAgentsDir && seal.kind === 'directory'),
      'caller agent pack must be sealed',
    );
    const target = manifest.fixtures.find((fixture) => fixture.id === binding.fixtureId);
    requireThat(target, 'binding fixture missing');
    for (const external of [
      profile.configRoot,
      profile.agentsDir,
      profile.homeRoot,
      binding.callerAgentsDir,
      manifest.outputRoot,
    ]) {
      requireThat(!inside(target.dir, external), 'external config/agents/output may not overlay target truth');
    }
    const trustRoot = resolve(binding.callerAgentsDir, '..', '..');
    requireThat(
      realpathSync(profile.configRoot) !== realpathSync(trustRoot),
      'runtime config root must be separate from canonical caller accounting root',
    );
    requireThat(
      !manifest.protectedRoots.some((root) => inside(root, realpathSync(trustRoot))),
      'canonical caller accounting may not write into protected originals',
    );
    for (const seal of profile.seals.filter((seal) => seal.kind === 'directory')) {
      requireThat(
        !inside(seal.path, join(trustRoot, '.mikro/runs')) && !inside(seal.path, manifest.outputRoot),
        'mutable receipts/ledger may not sit inside sealed source/config directories',
      );
    }
    for (const rel of MIKRO_CONFIG_FILES) sealPresent(profile.seals, join(trustRoot, rel));
    requireThat(!untrustedConfig(target.dir, trustRoot), 'canonical historical-config trust comparison refused');
    requireThat(fileSha256(join(binding.launcherDir, 'mikro')) === binding.launcherSha256, 'PATH launcher changed');
    requireThat(
      profile.runtimePath.split(':')[0] === binding.launcherDir,
      'profile private PATH does not bind selected launcher',
    );
    sealPresent(profile.seals, binding.launcherDir, 'directory');
    const runtimeCheck = Bun.spawnSync([join(binding.launcherDir, 'mikro'), '--check'], {
      env: { PATH: profile.runtimePath, HOME: profile.homeRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    requireThat(
      runtimeCheck.exitCode === 0,
      `actual exported runtime/config controls refused: ${binding.fixtureId}/${binding.modelId}/${binding.arm}`,
    );
    const actualBinding = runtimeReceiptSchema.shape.binding.parse(JSON.parse(runtimeCheck.stdout.toString()));
    requireThat(
      actualBinding.node === realpathSync(manifest.node.path) &&
        actualBinding.profileSha256 === binding.profileSha256 &&
        actualBinding.effectiveConfigSha256 === profile.effectiveConfigSha256 &&
        actualBinding.artifactRoot === profile.artifactRoot &&
        actualBinding.engine === profile.engine &&
        actualBinding.generation === profile.generation &&
        actualBinding.model === profile.model &&
        actualBinding.provider === profile.provider,
      'private PATH launcher selects a different actual runtime',
    );
    if (binding.modelId === 'flash-control') {
      requireThat(
        profile.model === 'deepseek-flash' &&
          profile.provider === (binding.arm === 'rlm-unpatched' ? 'deepseek-api' : 'deepseek') &&
          !profile.requestOptions,
        'Flash control mapping changed or private Flash substituted',
      );
    } else {
      const candidate = manifest.candidates.find((row) => row.id === binding.modelId);
      requireThat(
        candidate?.status === 'available' && profile.model === candidate.advertisedId,
        'candidate profile does not bind advertisement',
      );
      requireThat(
        (candidate.requested === 'GPT-6 Luna fast') === Boolean(profile.requestOptions),
        'Luna fast request option mismatch',
      );
    }
    if (binding.arm === 'pi') {
      const matched = profileFor(manifest, { ...binding, arm: 'rlm-patched' }).profile;
      requireThat(
        matched.effectiveConfigSha256 === profile.effectiveConfigSha256 &&
          matched.provenance.sourceCommit === profile.provenance.sourceCommit &&
          JSON.stringify(matched.provenance.dependencies) === JSON.stringify(profile.provenance.dependencies) &&
          JSON.stringify(matched.requestOptions) === JSON.stringify(profile.requestOptions),
        'post-upgrade RLM/Pi controls differ',
      );
    }
  }
  return fixtures;
}

function collectReceipts(
  path: string,
  result: RunResult | null,
  profile: Profile,
  profileHash: string,
  nodePath: string,
) {
  const receipts: RuntimeReceipt[] = [];
  const problems: string[] = [];
  const started = existsSync(path) ? readdirSync(path).filter((name) => name.endsWith('.started.json')) : [];
  for (const name of started) {
    const completed = join(path, name.replace('.started.json', '.result.json'));
    if (!existsSync(completed)) {
      problems.push(`unfinished runtime attempt: ${name}`);
      continue;
    }
    try {
      const receipt = runtimeReceiptSchema.parse(json(completed));
      requireThat(
        receipt.binding.profileSha256 === profileHash &&
          receipt.binding.effectiveConfigSha256 === profile.effectiveConfigSha256 &&
          receipt.binding.model === profile.model &&
          receipt.binding.provider === profile.provider &&
          receipt.binding.api === profile.api &&
          receipt.binding.node === realpathSync(nodePath) &&
          receipt.binding.artifactRoot === profile.artifactRoot &&
          receipt.binding.engine === profile.engine &&
          receipt.binding.generation === profile.generation,
        'attempt binding changed',
      );
      receipts.push(receipt);
      if (profile.requestOptions)
        requireThat(
          receipt.tierEvents?.length && receipt.tierEvents.every((tier) => tier.served === 'fast'),
          'fast tier absent or standard fallback served',
        );
    } catch (error) {
      problems.push(error instanceof Error ? error.message : 'invalid runtime receipt');
    }
  }
  receipts.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!result || started.length !== result.attempts.length || receipts.length !== result.attempts.length) {
    problems.push('canonical attempts and real runtime receipts do not reconcile');
  }
  if (result && receipts.length === result.attempts.length) {
    for (let index = 0; index < receipts.length; index++) {
      const footerSession = result.attempts[index].footer?.sessionId;
      if (footerSession && footerSession !== receipts[index].sessionId)
        problems.push('canonical footer/runtime session does not reconcile');
    }
  }
  const results = existsSync(path) ? readdirSync(path).filter((name) => name.endsWith('.result.json')) : [];
  if (results.length !== started.length) problems.push('orphan/duplicate runtime result receipt');
  return { receipts, problems };
}

async function runCell(manifest: Manifest, fixtures: Fixture[], cell: Cell): Promise<CellRecord> {
  const { profile, binding } = profileFor(manifest, cell);
  const { target, fixture } = fixtureFor(manifest, cell, fixtures);
  validateFixture(manifest, target, fixture);
  const receiptsDir = join(manifest.outputRoot, 'sdk', cell.id);
  requireThat(
    inside(profile.receiptRoot, receiptsDir) && receiptsDir !== profile.receiptRoot,
    'runtime receipt path is not owned',
  );
  mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
  process.env.PATH = profile.runtimePath;
  process.env.HOME = profile.homeRoot;
  process.env.MIKRO_EXPERIMENT_RECEIPT_DIR = receiptsDir;
  for (const key of Object.keys(process.env))
    if (key.startsWith('MIKRO_') && key !== 'MIKRO_EXPERIMENT_RECEIPT_DIR') delete process.env[key];
  let result: RunResult | null = null;
  let error: string | null = null;
  const started = Date.now();
  try {
    result = await runAgent({
      agent: 'wish-context',
      prompt: fixture.prompt,
      engine: profile.engine,
      dir: target.dir,
      cwd: resolve(binding.callerAgentsDir, '..', '..'),
      agentsDir: binding.callerAgentsDir,
      genieHome: join(manifest.outputRoot, 'caller-state', cell.id),
      timeoutMs: 600000,
      retries: 1,
      boundary: 'none',
      phoenix: false,
      ledger: true,
      tags: {
        experiment: manifest.experimentId,
        cell: cell.id,
        arm: cell.arm,
        modelCell: cell.modelId,
        fixture: cell.fixtureId,
        rep: String(cell.rep),
      },
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'canonical caller threw';
  }
  const elapsedMs = Date.now() - started;
  const { receipts, problems } = collectReceipts(
    receiptsDir,
    result,
    profile,
    binding.profileSha256,
    manifest.node.path,
  );
  try {
    validateFixture(manifest, target, fixture);
  } catch (caught) {
    problems.push(caught instanceof Error ? caught.message : 'parent truth changed');
  }
  const verified = Boolean(result?.ok && !error && !problems.length);
  const finalCitations = result?.attempts.at(-1)?.citations ?? [];
  const truth = {
    files: fixture.truth.filter((entry) => !entry.new).map((entry) => entry.path),
    newFiles: fixture.truth.filter((entry) => entry.new).map((entry) => entry.path),
  };
  const score = scoreAnswer(
    'wish-context',
    verified ? result?.answer : undefined,
    truth,
    verified ? finalCitations : [],
  );
  const expected = fixture.truth.filter((entry) => entry.expectedEvidence);
  const covered = expected.filter(
    (entry) =>
      verified && finalCitations.some((cite) => cite.ok && !cite.proposal && cite.path.split(':')[0] === entry.path),
  );
  const costs = receipts.flatMap((receipt) => (receipt.observed?.usage ? [receipt.observed.usage.totalCost] : []));
  const subtotal = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const complete =
    result &&
    !problems.length &&
    receipts.length === result.attempts.length &&
    receipts.every((receipt) => receipt.observed?.usage && receipt.observed.usageComplete);
  const footers = result?.attempts.flatMap((attempt) => (attempt.footer ? [attempt.footer.cost] : [])) ?? [];
  const planned = z
    .object({ plan: z.object({ files: z.array(z.object({ path: z.string(), reason: z.string() })) }) })
    .safeParse(result?.answer);
  const pathClassification = (['existing', 'new'] as const).map((kind) => {
    const expectedPaths = kind === 'new' ? truth.newFiles : truth.files;
    const predicted =
      verified && planned.success
        ? [
            ...new Set(
              planned.data.plan.files
                .filter((file) => file.reason.startsWith('NEW:') === (kind === 'new'))
                .map((file) => file.path.replace(/^\.\//, '').split(':')[0]),
            ),
          ]
        : [];
    const truePositives = predicted.filter((path) => expectedPaths.includes(path)).length;
    return {
      kind,
      expected: expectedPaths,
      predicted,
      truePositives,
      falsePositives: predicted.length - truePositives,
      falseNegatives: expectedPaths.length - truePositives,
      exact: verified && truePositives === expectedPaths.length && predicted.length === expectedPaths.length,
    };
  });
  return {
    cell,
    result,
    error,
    receipts,
    receiptProblems: problems,
    verified,
    score,
    pathClassification,
    expectedCitationCoverage: expected.length ? covered.length / expected.length : 0,
    elapsedMs,
    sdkNominalKnownSubtotalUsd: subtotal,
    sdkNominalTotalUsd: complete ? subtotal : null,
    roundedFooterKnownSubtotalUsd: footers.length ? footers.reduce((a, b) => a + b, 0) : null,
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function mean(values: (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => typeof value === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}
function stats(records: CellRecord[]) {
  const successes = records.filter((record) => record.verified);
  const attempts = records.flatMap((record) => record.result?.attempts ?? []);
  const latency = (rows: CellRecord[]) => ({
    p50Ms: percentile(
      rows.map((row) => row.elapsedMs),
      0.5,
    ),
    p90Ms: percentile(
      rows.map((row) => row.elapsedMs),
      0.9,
    ),
  });
  const scores = (rows: CellRecord[]) => ({
    filesPrecision: mean(rows.map((row) => row.score?.filesPrecision)),
    filesRecall: mean(rows.map((row) => row.score?.filesRecall)),
    newFilesPrecision: mean(rows.map((row) => row.score?.newFilesPrecision)),
    newFilesRecall: mean(rows.map((row) => row.score?.newFilesRecall)),
    expectedCitationCoverage: mean(rows.map((row) => row.expectedCitationCoverage)),
  });
  const complete = records.length > 0 && records.every((record) => record.sdkNominalTotalUsd !== null);
  const total = complete ? records.reduce((sum, record) => sum + (record.sdkNominalTotalUsd ?? 0), 0) : null;
  const capKnown = attempts.filter((attempt) => attempt.footer !== null);
  const sdkAttempts = records.flatMap((record) => record.receipts);
  const modelCallCounts = sdkAttempts.map((receipt) => {
    const count = receipt.observed?.usage?.llmCalls;
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
  });
  const completeModelCallCounts =
    complete && sdkAttempts.length === attempts.length && modelCallCounts.every((count) => count !== null);
  const modelCallsTotal = completeModelCallCounts
    ? modelCallCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
    : null;
  return {
    runs: records.length,
    firstVerifiedSuccesses: records.filter((record) => record.verified && record.result?.attempts[0]?.ok).length,
    verifiedSuccesses: successes.length,
    failures: records.length - successes.length,
    rescuedRetries: successes.filter((record) => record.result && record.result.attempts.length > 1).length,
    knownCanonicalAttempts: attempts.length,
    totalCanonicalAttempts: records.every((record) => record.result !== null) ? attempts.length : null,
    logicalRunsWithoutCanonicalAttemptHistory: records.filter((record) => record.result === null).length,
    reportedModelCallsTotal: modelCallsTotal,
    modelCallCountCoverage: attempts.length
      ? modelCallCounts.filter((count) => count !== null).length / attempts.length
      : null,
    sdkNominalCostPerReportedModelCallUsd: total !== null && modelCallsTotal ? total / modelCallsTotal : null,
    allRunLatency: latency(records),
    successOnlyLatency: latency(successes),
    allAttemptLatency: {
      p50Ms: percentile(
        attempts.map((attempt) => attempt.elapsedMs),
        0.5,
      ),
      p90Ms: percentile(
        attempts.map((attempt) => attempt.elapsedMs),
        0.9,
      ),
    },
    allRunScoresFailurePenalized: scores(records),
    successOnlyScores: scores(successes),
    sdkNominalTotalUsd: total,
    gatewayInvoiceUsd: null,
    costKind: 'sdk-nominal-estimate-not-invoice',
    sdkNominalCostPerVerifiedSuccessUsd: total !== null && successes.length ? total / successes.length : null,
    runCostCoverage: records.length
      ? records.filter((record) => record.sdkNominalTotalUsd !== null).length / records.length
      : null,
    attemptCostCoverage: attempts.length
      ? records
          .flatMap((record) => record.receipts)
          .filter((receipt) => receipt.observed?.usage && receipt.observed.usageComplete).length / attempts.length
      : null,
    observedSdkNominalSubtotalUsd: records.some((record) => record.sdkNominalKnownSubtotalUsd !== null)
      ? records.reduce((sum, record) => sum + (record.sdkNominalKnownSubtotalUsd ?? 0), 0)
      : null,
    attemptCapShare: capKnown.length
      ? capKnown.filter(
          (attempt) => attempt.footer && (attempt.footer.budgetHit !== null || attempt.footer.iterations >= 16),
        ).length / capKnown.length
      : null,
    capStatusCoverage: attempts.length ? capKnown.length / attempts.length : null,
    citationValidityAllAttempts: {
      observed: attempts.flatMap((attempt) => attempt.citations).filter((cite) => !cite.proposal).length,
      valid: attempts.flatMap((attempt) => attempt.citations).filter((cite) => !cite.proposal && cite.ok).length,
      invalid: attempts.flatMap((attempt) => attempt.citations).filter((cite) => !cite.proposal && !cite.ok).length,
    },
    exactExistingPathSuccesses: records.filter((record) =>
      record.pathClassification.some((paths) => paths.kind === 'existing' && paths.exact),
    ).length,
    exactNewPathSuccesses: records.filter((record) =>
      record.pathClassification.some((paths) => paths.kind === 'new' && paths.exact),
    ).length,
    backendAttemptCosts: records.flatMap((record) =>
      record.receipts.map((receipt) => ({
        cell: record.cell.id,
        sessionId: receipt.sessionId,
        observedSdkNominalSubtotalUsd: receipt.observed?.usage?.totalCost ?? null,
        sdkNominalTotalUsd: receipt.observed?.usageComplete ? (receipt.observed.usage?.totalCost ?? null) : null,
        privateInvoiceUsd: null,
        usage: receipt.observed?.usage ?? null,
      })),
    ),
    failureErrors: records
      .filter((record) => !record.verified)
      .map((record) => ({
        cell: record.cell.id,
        error: record.error,
        receiptProblems: record.receiptProblems,
        attempts:
          record.result?.attempts.map((attempt) => ({ attempt: attempt.attempt, errors: attempt.errors })) ?? [],
      })),
  };
}
function nativeComparison(manifest: Manifest) {
  const workflow = z
    .object({ receiptPath: absolute, cells: z.array(z.object({ id: z.string() })).length(18) })
    .safeParse(manifest.workflow);
  if (!workflow.success || !existsSync(workflow.data.receiptPath))
    return { complete: false, blockers: ['native comparison receipt missing'] };
  const receipt = z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('native-workflow-comparison'),
      manifestSha256: digest,
      complete: z.boolean(),
      expectedCells: z.literal(18),
      blockers: z.array(z.string()),
      smoke: z.object({ complete: z.boolean(), receiptPath: absolute }),
      cells: z
        .array(
          z.object({
            id: z.string(),
            complete: z.boolean(),
            receiptPath: absolute,
            runId: z.string().min(1).nullable(),
            parentSessionId: z.string().min(1).nullable(),
          }),
        )
        .length(18),
    })
    .safeParse(json(workflow.data.receiptPath));
  if (!receipt.success) return { complete: false, blockers: ['invalid native comparison receipt'] };
  verifySeals([manifest.workflow.nativeManifest]);
  const sameCells = receipt.data.cells.every((cell) => workflow.data.cells.some((frozen) => frozen.id === cell.id));
  const complete =
    receipt.data.complete &&
    receipt.data.smoke.complete &&
    existsSync(receipt.data.smoke.receiptPath) &&
    !receipt.data.blockers.length &&
    receipt.data.manifestSha256 === manifest.workflow.nativeManifest.sha256 &&
    sameCells &&
    receipt.data.cells.every(
      (cell) => cell.complete && cell.runId && cell.parentSessionId && existsSync(cell.receiptPath),
    ) &&
    new Set(receipt.data.cells.map((cell) => cell.id)).size === 18;
  return {
    complete,
    blockers: complete
      ? []
      : [...receipt.data.blockers, 'native identity, smoke or required cell coverage is incomplete'],
    receiptPath: workflow.data.receiptPath,
    nativeManifest: manifest.workflow.nativeManifest,
    sha256: fileSha256(workflow.data.receiptPath),
  };
}
export function engineAccountingBlockers(
  records: readonly {
    cell: { id: string };
    receiptProblems: readonly string[];
    sdkNominalTotalUsd: number | null;
  }[],
) {
  return records.flatMap((record) => [
    ...record.receiptProblems.map((problem) => `${record.cell.id}: ${problem}`),
    ...(record.sdkNominalTotalUsd === null ? [`${record.cell.id}: SDK nominal accounting coverage incomplete`] : []),
  ]);
}

function report(manifest: Manifest, records: CellRecord[], fixtures: Fixture[]) {
  sameSet(
    records.map((record) => record.cell.id),
    manifest.cells.map((cell) => cell.id),
    'persisted run cells',
  );
  const groups = [...new Set(records.map((record) => `${record.cell.modelId}/${record.cell.arm}`))].map((key) => ({
    key,
    ...stats(records.filter((record) => `${record.cell.modelId}/${record.cell.arm}` === key)),
  }));
  const matched = [
    ...new Set(
      records.map(
        (record) =>
          `${fixtures.find((fixture) => fixture.id === record.cell.fixtureId)?.repository}/${record.cell.modelId}`,
      ),
    ),
  ].map((key) => {
    const rows = records.filter(
      (record) =>
        `${fixtures.find((fixture) => fixture.id === record.cell.fixtureId)?.repository}/${record.cell.modelId}` ===
        key,
    );
    const rlm = rows.filter((record) => record.cell.arm === 'rlm-patched');
    const pi = rows.filter((record) => record.cell.arm === 'pi');
    const rlmStats = stats(rlm);
    const piStats = stats(pi);
    return {
      key,
      rlm: rlmStats,
      pi: piStats,
      parity: piStats.verifiedSuccesses >= rlmStats.verifiedSuccesses,
      latencyP50DeltaPiMinusRlmMs:
        piStats.allRunLatency.p50Ms !== null && rlmStats.allRunLatency.p50Ms !== null
          ? piStats.allRunLatency.p50Ms - rlmStats.allRunLatency.p50Ms
          : null,
      sdkNominalCostPerSuccessDeltaPiMinusRlmUsd:
        piStats.sdkNominalCostPerVerifiedSuccessUsd !== null && rlmStats.sdkNominalCostPerVerifiedSuccessUsd !== null
          ? piStats.sdkNominalCostPerVerifiedSuccessUsd - rlmStats.sdkNominalCostPerVerifiedSuccessUsd
          : null,
      pairedFixtures: [...new Set(rows.map((row) => row.cell.fixtureId))].map((fixtureId) => ({
        fixtureId,
        rlm: stats(rlm.filter((row) => row.cell.fixtureId === fixtureId)),
        pi: stats(pi.filter((row) => row.cell.fixtureId === fixtureId)),
      })),
    };
  });
  const dispersion = manifest.bindings.map((binding) => {
    const rows = records.filter(
      (record) =>
        record.cell.fixtureId === binding.fixtureId &&
        record.cell.modelId === binding.modelId &&
        record.cell.arm === binding.arm,
    );
    return {
      fixtureId: binding.fixtureId,
      modelId: binding.modelId,
      arm: binding.arm,
      reps: rows.map((row) => ({
        rep: row.cell.rep,
        verified: row.verified,
        elapsedMs: row.elapsedMs,
        sdkNominalTotalUsd: row.sdkNominalTotalUsd,
      })),
      latencyRangeMs: rows.length
        ? Math.max(...rows.map((row) => row.elapsedMs)) - Math.min(...rows.map((row) => row.elapsedMs))
        : null,
      sdkNominalCostRangeUsd:
        rows.length && rows.every((row) => row.sdkNominalTotalUsd !== null)
          ? Math.max(...rows.map((row) => row.sdkNominalTotalUsd ?? 0)) -
            Math.min(...rows.map((row) => row.sdkNominalTotalUsd ?? 0))
          : null,
    };
  });
  const native = nativeComparison(manifest);
  const blockers = engineAccountingBlockers(records);
  if (!native.complete) blockers.push(...native.blockers);
  const parity = matched.every((cell) => cell.parity);
  return {
    schemaVersion: 1,
    experimentId: manifest.experimentId,
    generatedAt: new Date().toISOString(),
    complete: !blockers.length,
    blockers,
    all: stats(records),
    groups,
    matched,
    dispersion,
    native,
    candidates: manifest.candidates,
    parity,
    recommendation: null,
    defaultEngine: 'rlm',
    tiesRetain: 'rlm',
    selection: !native.complete
      ? 'no recommendation: native comparison incomplete'
      : !parity
        ? 'no recommendation: below per-repository/model verified-success parity'
        : 'no automatic recommendation: independent security/workflow review and small-sample uncertainty remain required',
    billingLimitations: [
      'SDK nominal estimates are not private invoices.',
      'Rounded footer USD is never exact billed usage.',
      'Missing or partial attempt totals remain null.',
      'Keeper aggregates and native inherited usage are never added.',
      'Backend-return coverage is SDK nominal coverage, not proof of complete provider billing for hidden transport attempts.',
    ],
  };
}

async function cli(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      'Usage: bun scripts/mikro/engine-experiment.ts --manifest FILE [--preflight | --report-only]\n' +
        '--preflight validates frozen files, parent repositories, exact cells, smokes and actual exported runtime controls; no inference.\n' +
        'The default executes the entire frozen cohort once, serially, through canonical runAgent.\n' +
        '--report-only analyzes sealed complete engine records after native receipts land; it never dispatches.\n',
    );
    return;
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    requireThat(['--manifest', '--preflight', '--report-only', '--cell'].includes(flag), `unknown option: ${flag}`);
    if (flag === '--manifest' || flag === '--cell') {
      requireThat(argv[index + 1] && !argv[index + 1].startsWith('--'), `missing value: ${flag}`);
      index++;
    }
  }
  requireThat(
    !(argv.includes('--preflight') && argv.includes('--report-only')),
    'choose preflight or report-only, not both',
  );
  requireThat(
    !argv.includes('--cell') || (!argv.includes('--preflight') && !argv.includes('--report-only')),
    'private dispatch cannot be combined with analysis/preflight',
  );
  const manifestIndex = argv.indexOf('--manifest');
  requireThat(manifestIndex >= 0 && argv[manifestIndex + 1], '--manifest <absolute-or-relative-file> required');
  const manifestPath = resolve(argv[manifestIndex + 1]);
  const manifest = manifestSchema.parse(json(manifestPath));
  const cellIndex = argv.indexOf('--cell');
  const fixtures =
    cellIndex >= 0
      ? registrationSchema.parse(json(manifest.fixtureRegistration.path)).fixtures
      : preflight(manifest, manifestPath);
  if (argv.includes('--preflight')) {
    process.stdout.write(`${JSON.stringify({ ok: true, cells: manifest.cells.length, inference: false })}\n`);
    return;
  }
  if (cellIndex >= 0) {
    const cell = manifest.cells.find((row) => row.id === argv[cellIndex + 1]);
    requireThat(cell, 'unknown frozen cell');
    requireThat(
      manifestPath === join(manifest.outputRoot, 'manifest.json') &&
        existsSync(join(manifest.outputRoot, 'registration.json')) &&
        existsSync(join(manifest.outputRoot, 'dispatch', `${cell.id}.json`)) &&
        !existsSync(join(manifest.outputRoot, 'runs', `${cell.id}.json`)),
      'private cell requires a frozen one-shot dispatch',
    );
    verifySeals([manifest.fixtureRegistration, ...manifest.harnessSeals, ...profileFor(manifest, cell).profile.seals]);
    validateNativeManifestBinding(manifest, manifestPath);
    const record = await runCell(manifest, fixtures, cell);
    immutableJson(join(manifest.outputRoot, 'runs', `${cell.id}.json`), record);
    return;
  }
  const reportOnly = argv.includes('--report-only');
  const frozenPath = join(manifest.outputRoot, 'manifest.json');
  if (!reportOnly) {
    requireThat(
      !existsSync(manifest.outputRoot),
      'output already exists: no resampling, rerun or implicit resume permitted',
    );
    requireThat(
      !manifest.protectedRoots.some((root) => inside(root, manifest.outputRoot)),
      'output is inside a protected repository',
    );
    mkdirSync(join(manifest.outputRoot, 'runs'), { recursive: true, mode: 0o700 });
    immutableJson(frozenPath, manifest);
    immutableJson(join(manifest.outputRoot, 'registration.json'), {
      manifestSha256: fileSha256(frozenPath),
      callerRuntime: { executable: process.execPath, sha256: fileSha256(process.execPath), version: Bun.version },
      suppliedManifestSha256: fileSha256(manifestPath),
      nativeManifest: manifest.workflow.nativeManifest,
      frozenAt: manifest.frozenAt,
      registeredAt: new Date().toISOString(),
      cells: manifest.cells,
      concurrency: 1,
      footerPricePrecision: 'rounded',
      privateInvoiceCoverage: 'unknown',
    });
    for (const cell of manifest.cells) {
      const childStarted = Date.now();
      mkdirSync(join(manifest.outputRoot, 'dispatch'), { recursive: true, mode: 0o700 });
      immutableJson(join(manifest.outputRoot, 'dispatch', `${cell.id}.json`), {
        cell,
        manifestSha256: fileSha256(frozenPath),
        startedAt: new Date(childStarted).toISOString(),
      });
      // A fresh canonical caller process binds PATH-version caching to one actual arm.
      let exitCode: number | null = null;
      let stderr = '';
      let dispatchError: string | null = null;
      try {
        const child = Bun.spawn(
          [process.execPath, fileURLToPath(import.meta.url), '--manifest', frozenPath, '--cell', cell.id],
          {
            env: gitProbeEnv(process.env, ['MIKRO_FACTS']),
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
      } catch (error) {
        dispatchError = safeFailureMessage(error);
      }
      const path = join(manifest.outputRoot, 'runs', `${cell.id}.json`);
      if (exitCode !== 0 || !existsSync(path)) {
        // Preserve this failed logical cell; never silently dispatch it a second time.
        if (!existsSync(path))
          immutableJson(path, {
            cell,
            result: null,
            error: 'canonical child failed before durable run record',
            receipts: [],
            receiptProblems: ['child exit or missing run artifact'],
            verified: false,
            score: scoreAnswer(
              'wish-context',
              undefined,
              {
                files: fixtures
                  .find((fixture) => fixture.id === cell.fixtureId)
                  ?.truth.filter((entry) => !entry.new)
                  .map((entry) => entry.path),
                newFiles: fixtures
                  .find((fixture) => fixture.id === cell.fixtureId)
                  ?.truth.filter((entry) => entry.new)
                  .map((entry) => entry.path),
              },
              [],
            ),
            pathClassification: [],
            expectedCitationCoverage: 0,
            elapsedMs: Date.now() - childStarted,
            sdkNominalKnownSubtotalUsd: null,
            sdkNominalTotalUsd: null,
            roundedFooterKnownSubtotalUsd: null,
            childExitCode: exitCode,
            dispatchError,
            stderrSha256: sha256(stderr),
          });
      }
    }
    const runSeals = manifest.cells.map((cell) => ({
      path: join(manifest.outputRoot, 'runs', `${cell.id}.json`),
      kind: 'file' as const,
      sha256: fileSha256(join(manifest.outputRoot, 'runs', `${cell.id}.json`)),
    }));
    const sdkSeals = manifest.cells.flatMap((cell) => {
      const path = join(manifest.outputRoot, 'sdk', cell.id);
      return existsSync(path)
        ? readdirSync(path).map((name) => ({
            path: join(path, name),
            kind: 'file' as const,
            sha256: fileSha256(join(path, name)),
          }))
        : [];
    });
    immutableJson(join(manifest.outputRoot, 'cohort.json'), {
      manifestSha256: fileSha256(frozenPath),
      runs: runSeals,
      sdkReceipts: sdkSeals,
    });
  } else
    requireThat(
      fileSha256(frozenPath) === sha256(`${JSON.stringify(manifest, null, 2)}\n`),
      'analysis manifest differs from frozen cohort',
    );
  const cohort = z
    .object({ manifestSha256: digest, runs: z.array(sealSchema), sdkReceipts: z.array(sealSchema) })
    .parse(json(join(manifest.outputRoot, 'cohort.json')));
  requireThat(cohort.manifestSha256 === fileSha256(frozenPath), 'cohort/manifest identity changed');
  sameSet(
    cohort.runs.map((seal) => seal.path),
    manifest.cells.map((cell) => join(manifest.outputRoot, 'runs', `${cell.id}.json`)),
    'sealed run records',
  );
  verifySeals([...cohort.runs, ...cohort.sdkReceipts]);
  const records = manifest.cells.map((cell) => {
    const path = join(manifest.outputRoot, 'runs', `${cell.id}.json`);
    requireThat(existsSync(path), `missing required run cell: ${cell.id}`);
    // These are our immutable records, not outside-controlled provider packets.
    const record = json(path) as CellRecord;
    requireThat(JSON.stringify(record.cell) === JSON.stringify(cell), 'outcome-dependent cell substitution');
    return record;
  });
  const summary = report(manifest, records, fixtures);
  const reportPath = join(manifest.outputRoot, reportOnly ? `report-${Date.now()}.json` : 'report.json');
  immutableJson(reportPath, summary);
  process.stdout.write(
    `${JSON.stringify({ reportPath, complete: summary.complete, runs: records.length, blockers: summary.blockers })}\n`,
  );
  if (!summary.complete) process.exitCode = 1;
}

if (import.meta.main)
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`engine experiment: ${safeFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
