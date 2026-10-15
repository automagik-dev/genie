/**
 * Genie Bench — versioned boundary contracts.
 *
 * Every shape the bench engine and its sibling wishes bind to lives here. The
 * persisted documents (task manifest, harness configuration, eligibility pool,
 * capability report, event envelope) carry `schemaVersion: 1`; every object
 * schema is `.strict()`, so an unknown key is a refusal, never a silent pass.
 *
 * Unknown is null, never 0: no schema defaults a missing number, and a request
 * record may only claim a known zero when its `presence` entry says `observed`.
 */
import { z } from 'zod';

export const BENCH_SCHEMA_VERSION = 1;

export type Result<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export type Harness = 'omp' | 'claude-code' | 'codex' | 'deepseek' | 'hermes';
export type ArmId = 'zero-genie' | 'genie';
export type SourceKind = 'deepswe' | 'terminal-bench' | 'swe-atlas' | 'skillsbench';
export type ArtifactTransport = 'committed-patch' | 'directory' | 'answer';

export interface InstructionRef {
  /** Path inside the pinned source package. */
  path: string;
  sha256: string;
}

export interface EnvironmentSpec {
  kind: 'git-checkout' | 'source-container';
  repository: { url: string; commit: string } | null;
  image: { ref: string; digest: string } | null;
  /** Source-declared argv, run from the package dir. */
  provision: string[] | null;
  teardown: string[] | null;
  /** Source values verbatim; null = the source declares none. */
  resources: { cpus: number | null; memoryMb: number | null; network: string | null } | null;
  /** e.g. the checkout root or /app. */
  solverPath: string;
  artifactPath: string;
}

export interface VerifierInvocation {
  /** The source's own verifier argv. */
  command: string[];
  runsIn: 'host-outside-solver' | 'source-container-fresh';
  rewardFile: string | null;
  acceptWhen: 'binary-one' | 'source-declared';
  timeoutSec: number | null;
  judge: { model: string; settings: Record<string, string> } | null;
}

export interface TaskIdentity {
  source: SourceKind;
  sourceRevision: string;
  taskId: string;
  category: string;
  cluster: string;
  artifactTransport: ArtifactTransport;
  instruction: InstructionRef;
  environment: EnvironmentSpec;
  verifier: VerifierInvocation;
  verifierDigest: string;
  /** Operator-only verifier sanity input; never reaches a solver. */
  referenceSolution: InstructionRef | null;
  timeLimitSec: number | null;
}

/** What a solver may see: the task without its verifier or reference answer. */
export type SolverTask = Omit<TaskIdentity, 'verifier' | 'verifierDigest' | 'referenceSolution'>;

export const taskKey = (t: TaskIdentity): string => `${t.source}/${t.category}/${t.taskId}`;

export interface EvidenceRef {
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
}

export type Eligibility =
  | { status: 'eligible'; clearance: EvidenceRef[] }
  | { status: 'ineligible'; reason: string }
  | { status: 'unresolved'; blocker: string };

export interface PoolEntry {
  task: TaskIdentity;
  eligibility: Eligibility;
}

/** Keyed `<source>/<category>`. */
export type Quotas = Record<string, number>;

export interface ReplacementRecord {
  replaced: string;
  by: string;
  reason: string;
  recordedAt: string;
}

export interface TaskManifest {
  schemaVersion: 1;
  manifestId: string;
  poolDigest: string;
  quotas: Quotas;
  selected: TaskIdentity[];
  replacements: ReplacementRecord[];
  smoke: TaskIdentity[];
  frozenAt: string;
}

export interface TreatmentPin {
  contract: string;
  /** Resource path -> sha256. */
  resources: Record<string, string>;
}

export interface HarnessConfiguration {
  schemaVersion: 1;
  configId: string;
  harness: Harness;
  executable: string;
  requestedModel: string;
  requestedEffort: string;
  treatment: TreatmentPin | null;
  epoch: string;
  cohort: string;
}

export interface AttemptIdentity {
  experimentId: string;
  pairId: string;
  manifestId: string;
  taskKey: string;
  configId: string;
  arm: ArmId;
  repeat: number;
  attemptId: string;
  scheduledIndex: number;
  kind: 'smoke' | 'scored';
}

export type AttemptState =
  | 'registered'
  | 'running'
  | 'execution-stopped'
  | 'verified'
  | 'terminal-failure'
  | 'capture-sealed'
  | 'reconciled'
  | 'extraction-frozen';

/**
 * The design §5 chain: registered → running → execution-stopped →
 * (verified | terminal-failure) → capture-sealed → reconciled → extraction-frozen,
 * plus the pre-running exit registered → terminal-failure and the interrupted
 * exit running → terminal-failure. Nothing else is a legal edge.
 */
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = Object.freeze({
  registered: Object.freeze(['running', 'terminal-failure'] as const),
  running: Object.freeze(['execution-stopped', 'terminal-failure'] as const),
  'execution-stopped': Object.freeze(['verified', 'terminal-failure'] as const),
  verified: Object.freeze(['capture-sealed'] as const),
  'terminal-failure': Object.freeze(['capture-sealed'] as const),
  'capture-sealed': Object.freeze(['reconciled'] as const),
  reconciled: Object.freeze(['extraction-frozen'] as const),
  'extraction-frozen': Object.freeze([] as const),
});

export type Disposition =
  | 'accepted'
  | 'rejected'
  | 'timeout'
  | 'setup-failure'
  | 'provider-failure'
  | 'infra-failure'
  | 'interrupted'
  | 'abandoned';

export type Presence = 'observed' | 'absent' | 'unsupported';

export interface EventEnvelope {
  schemaVersion: 1;
  experimentId: string;
  pairId: string;
  manifestId: string;
  taskKey: string;
  attemptId: string;
  eventId: string;
  sourceKind: string;
  sourceInstance: string;
  sourceSeq: number;
  actorId: string | null;
  parentActorId: string | null;
  nativeSessionId: string | null;
  observedAt: string;
  monotonicNs: string | null;
  traceId: string | null;
  spanId: string | null;
  evidence: EvidenceRef[];
  availability: Record<string, Presence>;
  wish?: string;
  group?: string;
  phase?: string;
}

export interface NativeRequestRecord {
  requestId: string | null;
  responseId: string | null;
  revision: string;
  actorId: string;
  parentActorId: string | null;
  role: 'lead' | 'worker' | 'auxiliary';
  nativeSessionId: string | null;
  requestedModel: string | null;
  observedModel: string | null;
  effort: string | null;
  tokens: {
    input: number | null;
    cacheRead: number | null;
    cacheWriteTotal: number | null;
    cacheWrite5m: number | null;
    cacheWrite1h: number | null;
    output: number | null;
    reasoning: number | null;
  };
  reasoningIncludedInOutput: boolean | null;
  durationMs: number | null;
  failed: boolean | null;
  retryOf: string | null;
  /** Keyed by field path, e.g. `tokens.input`. */
  presence: Record<string, Presence>;
}

export type InputOrigin = 'human' | 'automated' | 'unknown';

export interface InputEvent {
  eventId: string;
  at: string;
  origin: InputOrigin;
  kind: 'initial-task' | 'approval' | 'message' | 'interrupt';
  evidence: EvidenceRef[];
  basis: string;
}

export const REQUIRED_CAPABILITIES: readonly string[] = Object.freeze([
  'launchVisible',
  'discoveryIsolated',
  'modelEffortResolved',
  'childAuxModelEffort',
  'settledSignal',
  'requestUsage',
  'inputOrigin',
  'artifactTransport',
  'environmentExecution',
]);

export interface CapabilityReport {
  schemaVersion: 1;
  harness: Harness;
  arm: ArmId;
  executable: { path: string; build: string | null; sha256: string };
  launchMechanism: string;
  discoveryRoots: string[];
  resolved: { model: string | null; effort: string | null };
  artifactTransport: ArtifactTransport;
  capabilities: Record<
    string,
    { status: 'proven' | 'unproven' | 'unsupported'; evidence: EvidenceRef[]; upstreamRequirement?: string }
  >;
  observedAt: string;
}

/** Where the solver runs, from G9's provisioned environment. */
export type SolverTarget = { kind: 'host'; cwd: string } | { kind: 'container'; containerId: string; cwd: string };

export interface AdapterContext {
  root: string;
  attempt: AttemptIdentity;
  config: HarnessConfiguration;
  task: SolverTask;
  solver: SolverTarget;
  nativeHome: string;
}

export interface LaunchHandle {
  attemptId: string;
  session: string;
  startedMonotonicNs: string;
}

export interface SettledResult {
  settled: boolean;
  pendingActors: string[];
  basis: string;
}

export interface StopReceipt {
  reason: string;
  remainingActors: string[];
  usageUncertain: boolean;
  stoppedMonotonicNs: string;
}

export interface NativeAdapter {
  harness: Harness;
  preflight(ctx: AdapterContext): Promise<CapabilityReport>;
  launch(ctx: AdapterContext, prompt: string): Promise<LaunchHandle>;
  settled(h: LaunchHandle, signal: AbortSignal): Promise<SettledResult>;
  stop(h: LaunchHandle, reason: 'settled' | 'timeout' | 'interrupt'): Promise<StopReceipt>;
  collectArtifact(h: LaunchHandle, dest: string): Promise<EvidenceRef>;
}

export type AdapterMap = Partial<Record<Harness, NativeAdapter>>;

export interface MonotonicClock {
  nowNs(): bigint;
  wall(): string;
}

export const hostClock: MonotonicClock = {
  nowNs: () => process.hrtime.bigint(),
  wall: () => new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Schemas. Internal: callers go through the parse helpers, which return Result.
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECIMAL_NS = /^\d+$/;

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(SHA256_HEX, 'expected a lowercase sha256 hex digest');
const isoInstant = z.string().datetime({ offset: true });
/** A count or measure the source may not declare: null stays null, 0 stays 0. */
const nullableMeasure = z.number().nonnegative().nullable();
const schemaVersion = z.literal(BENCH_SCHEMA_VERSION);

const harnessSchema = z.enum(['omp', 'claude-code', 'codex', 'deepseek', 'hermes']);
const armSchema = z.enum(['zero-genie', 'genie']);
const sourceKindSchema = z.enum(['deepswe', 'terminal-bench', 'swe-atlas', 'skillsbench']);
const artifactTransportSchema = z.enum(['committed-patch', 'directory', 'answer']);
const presenceSchema = z.enum(['observed', 'absent', 'unsupported']);

const evidenceRefSchema = z
  .object({ kind: nonEmpty, path: nonEmpty, sha256, bytes: z.number().int().nonnegative() })
  .strict();

const instructionRefSchema = z.object({ path: nonEmpty, sha256 }).strict();

const environmentSpecSchema = z
  .object({
    kind: z.enum(['git-checkout', 'source-container']),
    repository: z.object({ url: nonEmpty, commit: nonEmpty }).strict().nullable(),
    image: z
      .object({ ref: nonEmpty, digest: z.string().regex(OCI_DIGEST, 'expected sha256:<64 hex>') })
      .strict()
      .nullable(),
    provision: z.array(z.string()).min(1).nullable(),
    teardown: z.array(z.string()).min(1).nullable(),
    resources: z
      .object({ cpus: nullableMeasure, memoryMb: nullableMeasure, network: z.string().nullable() })
      .strict()
      .nullable(),
    solverPath: nonEmpty,
    artifactPath: nonEmpty,
  })
  .strict();

const verifierInvocationSchema = z
  .object({
    command: z.array(z.string()).min(1),
    runsIn: z.enum(['host-outside-solver', 'source-container-fresh']),
    rewardFile: z.string().min(1).nullable(),
    acceptWhen: z.enum(['binary-one', 'source-declared']),
    timeoutSec: z.number().positive().nullable(),
    judge: z
      .object({ model: nonEmpty, settings: z.record(z.string()) })
      .strict()
      .nullable(),
  })
  .strict();

const taskIdentitySchema = z
  .object({
    source: sourceKindSchema,
    sourceRevision: nonEmpty,
    taskId: nonEmpty,
    category: nonEmpty,
    cluster: nonEmpty,
    artifactTransport: artifactTransportSchema,
    instruction: instructionRefSchema,
    environment: environmentSpecSchema,
    verifier: verifierInvocationSchema,
    verifierDigest: sha256,
    referenceSolution: instructionRefSchema.nullable(),
    timeLimitSec: z.number().positive().nullable(),
  })
  .strict();

const eligibilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('eligible'), clearance: z.array(evidenceRefSchema).min(1) }).strict(),
  z.object({ status: z.literal('ineligible'), reason: nonEmpty }).strict(),
  z.object({ status: z.literal('unresolved'), blocker: nonEmpty }).strict(),
]);

const poolEntrySchema = z.object({ task: taskIdentitySchema, eligibility: eligibilitySchema }).strict();

/** The pool file is a versioned document; `parsePool` returns its entries. */
const poolDocumentSchema = z.object({ schemaVersion, entries: z.array(poolEntrySchema) }).strict();

const quotasSchema = z.record(
  z.string().regex(/^(deepswe|terminal-bench|swe-atlas|skillsbench)\/.+$/, 'expected a <source>/<category> key'),
  z.number().int().nonnegative(),
);

const replacementRecordSchema = z
  .object({ replaced: nonEmpty, by: nonEmpty, reason: nonEmpty, recordedAt: isoInstant })
  .strict();

const taskManifestSchema = z
  .object({
    schemaVersion,
    manifestId: nonEmpty,
    poolDigest: sha256,
    quotas: quotasSchema,
    selected: z.array(taskIdentitySchema),
    replacements: z.array(replacementRecordSchema),
    smoke: z.array(taskIdentitySchema),
    frozenAt: isoInstant,
  })
  .strict();

const treatmentPinSchema = z.object({ contract: nonEmpty, resources: z.record(nonEmpty, sha256) }).strict();

const harnessConfigurationSchema = z
  .object({
    schemaVersion,
    configId: nonEmpty,
    harness: harnessSchema,
    executable: nonEmpty,
    requestedModel: nonEmpty,
    requestedEffort: nonEmpty,
    treatment: treatmentPinSchema.nullable(),
    epoch: nonEmpty,
    cohort: nonEmpty,
  })
  .strict();

const eventEnvelopeSchema = z
  .object({
    schemaVersion,
    experimentId: nonEmpty,
    pairId: nonEmpty,
    manifestId: nonEmpty,
    taskKey: nonEmpty,
    attemptId: nonEmpty,
    eventId: nonEmpty,
    sourceKind: nonEmpty,
    sourceInstance: nonEmpty,
    sourceSeq: z.number().int().nonnegative(),
    actorId: z.string().nullable(),
    parentActorId: z.string().nullable(),
    nativeSessionId: z.string().nullable(),
    observedAt: isoInstant,
    monotonicNs: z.string().regex(DECIMAL_NS, 'expected a decimal nanosecond count').nullable(),
    traceId: z.string().nullable(),
    spanId: z.string().nullable(),
    evidence: z.array(evidenceRefSchema),
    availability: z.record(presenceSchema),
    wish: z.string().optional(),
    group: z.string().optional(),
    phase: z.string().optional(),
  })
  .strict();

const tokenCount = z.number().int().nonnegative().nullable();

const nativeRequestRecordSchema = z
  .object({
    requestId: z.string().nullable(),
    responseId: z.string().nullable(),
    revision: nonEmpty,
    actorId: nonEmpty,
    parentActorId: z.string().nullable(),
    role: z.enum(['lead', 'worker', 'auxiliary']),
    nativeSessionId: z.string().nullable(),
    requestedModel: z.string().nullable(),
    observedModel: z.string().nullable(),
    effort: z.string().nullable(),
    tokens: z
      .object({
        input: tokenCount,
        cacheRead: tokenCount,
        cacheWriteTotal: tokenCount,
        cacheWrite5m: tokenCount,
        cacheWrite1h: tokenCount,
        output: tokenCount,
        reasoning: tokenCount,
      })
      .strict(),
    reasoningIncludedInOutput: z.boolean().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    failed: z.boolean().nullable(),
    retryOf: z.string().nullable(),
    presence: z.record(presenceSchema),
  })
  .strict()
  .superRefine((record, ctx) => {
    for (const [field, value] of Object.entries(record.tokens)) {
      const key = `tokens.${field}`;
      const basis = record.presence[key];
      if (value === 0 && basis !== 'observed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokens', field],
          message: `a known zero needs presence["${key}"] = "observed" (got ${basis ?? 'no entry'})`,
        });
      } else if (value !== null && basis !== undefined && basis !== 'observed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokens', field],
          message: `a value contradicts presence["${key}"] = "${basis}"`,
        });
      }
    }
  });

const capabilityReportSchema = z
  .object({
    schemaVersion,
    harness: harnessSchema,
    arm: armSchema,
    executable: z.object({ path: nonEmpty, build: z.string().nullable(), sha256 }).strict(),
    launchMechanism: nonEmpty,
    discoveryRoots: z.array(nonEmpty),
    resolved: z.object({ model: z.string().nullable(), effort: z.string().nullable() }).strict(),
    artifactTransport: artifactTransportSchema,
    capabilities: z.record(
      z
        .object({
          status: z.enum(['proven', 'unproven', 'unsupported']),
          evidence: z.array(evidenceRefSchema),
          upstreamRequirement: nonEmpty.optional(),
        })
        .strict(),
    ),
    observedAt: isoInstant,
  })
  .strict()
  .superRefine((report, ctx) => {
    for (const name of REQUIRED_CAPABILITIES) {
      const entry = report.capabilities[name];
      if (entry === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', name],
          message: 'required capability not reported',
        });
      } else if (entry.status === 'unsupported' && entry.upstreamRequirement === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', name, 'upstreamRequirement'],
          message: 'an unsupported capability must name its upstream requirement',
        });
      }
    }
  });

/** One line per issue, each naming the offending field path. */
function formatIssues(error: z.ZodError): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const at = issue.path.map(String);
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) lines.push(`${[...at, key].join('.')}: unknown key`);
    } else {
      lines.push(`${at.length > 0 ? at.join('.') : '(root)'}: ${issue.message}`);
    }
  }
  return lines;
}

function toResult<T>(parsed: z.SafeParseReturnType<unknown, T>): Result<T> {
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}

export function parseManifest(raw: unknown): Result<TaskManifest> {
  return toResult<TaskManifest>(taskManifestSchema.safeParse(raw));
}

export function parseConfiguration(raw: unknown): Result<HarnessConfiguration> {
  return toResult<HarnessConfiguration>(harnessConfigurationSchema.safeParse(raw));
}

/** Parses a versioned pool document `{ schemaVersion: 1, entries: PoolEntry[] }`. */
export function parsePool(raw: unknown): Result<PoolEntry[]> {
  const parsed = toResult(poolDocumentSchema.safeParse(raw));
  return parsed.ok ? { ok: true, value: parsed.value.entries } : parsed;
}

export function parseCapabilityReport(raw: unknown): Result<CapabilityReport> {
  return toResult<CapabilityReport>(capabilityReportSchema.safeParse(raw));
}

export function parseEventEnvelope(raw: unknown): Result<EventEnvelope> {
  return toResult<EventEnvelope>(eventEnvelopeSchema.safeParse(raw));
}

export function parseNativeRequestRecord(raw: unknown): Result<NativeRequestRecord> {
  return toResult<NativeRequestRecord>(nativeRequestRecordSchema.safeParse(raw));
}
