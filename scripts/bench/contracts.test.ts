import { describe, expect, test } from 'bun:test';
import { ADAPTERS } from './adapters';
import {
  ATTEMPT_TRANSITIONS,
  type AdapterContext,
  type AttemptState,
  BENCH_SCHEMA_VERSION,
  REQUIRED_CAPABILITIES,
  type Result,
  type SolverTask,
  type TaskIdentity,
  hostClock,
  parseCapabilityReport,
  parseConfiguration,
  parseEventEnvelope,
  parseManifest,
  parseNativeRequestRecord,
  parsePool,
  taskKey,
} from './contracts';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

type Json = Record<string, unknown>;

/** A deep, JSON-faithful copy: what a file round-trip would hand back. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function task(): Json {
  return {
    source: 'deepswe',
    sourceRevision: 'rev-1',
    taskId: 'actionlint-action-pinning-lint',
    category: 'lint',
    cluster: 'actionlint',
    artifactTransport: 'committed-patch',
    instruction: { path: 'tasks/actionlint/instruction.md', sha256: HEX_A },
    environment: {
      kind: 'git-checkout',
      repository: { url: 'https://example.invalid/actionlint.git', commit: 'c0ffee' },
      image: null,
      provision: null,
      teardown: null,
      resources: { cpus: null, memoryMb: 0, network: null },
      solverPath: '.',
      artifactPath: 'patch.diff',
    },
    verifier: {
      command: ['bash', 'verify.sh'],
      runsIn: 'host-outside-solver',
      rewardFile: null,
      acceptWhen: 'binary-one',
      timeoutSec: null,
      judge: null,
    },
    verifierDigest: HEX_B,
    referenceSolution: null,
    timeLimitSec: null,
  };
}

function manifest(): Json {
  return {
    schemaVersion: 1,
    manifestId: 'public-pilot',
    poolDigest: HEX_A,
    quotas: { 'deepswe/lint': 1 },
    selected: [task()],
    replacements: [{ replaced: 'a/b/c', by: 'a/b/d', reason: 'ineligible', recordedAt: '2026-10-14T00:00:00Z' }],
    smoke: [],
    frozenAt: '2026-10-14T00:00:00Z',
  };
}

function configuration(): Json {
  return {
    schemaVersion: 1,
    configId: 'omp-sol-medium',
    harness: 'omp',
    executable: 'omp',
    requestedModel: 'model',
    requestedEffort: 'medium',
    treatment: null,
    epoch: 'e1',
    cohort: 'c1',
  };
}

function pool(): Json {
  return {
    schemaVersion: 1,
    entries: [
      {
        task: task(),
        eligibility: { status: 'eligible', clearance: [{ kind: 'license', path: 'l.txt', sha256: HEX_A, bytes: 0 }] },
      },
      { task: { ...task(), taskId: 'other' }, eligibility: { status: 'unresolved', blocker: 'HOLD' } },
    ],
  };
}

function capabilityReport(): Json {
  const capabilities: Json = {};
  for (const name of REQUIRED_CAPABILITIES) capabilities[name] = { status: 'proven', evidence: [] };
  return {
    schemaVersion: 1,
    harness: 'omp',
    arm: 'zero-genie',
    executable: { path: '/opt/omp', build: null, sha256: HEX_A },
    launchMechanism: 'tmux-pty',
    discoveryRoots: ['/tmp/home'],
    resolved: { model: null, effort: null },
    artifactTransport: 'committed-patch',
    capabilities,
    observedAt: '2026-10-14T00:00:00Z',
  };
}

function envelope(): Json {
  return {
    schemaVersion: 1,
    experimentId: 'x',
    pairId: 'p',
    manifestId: 'm',
    taskKey: 'deepswe/lint/t',
    attemptId: 'a',
    eventId: 'e',
    sourceKind: 'omp-session',
    sourceInstance: 's',
    sourceSeq: 0,
    actorId: null,
    parentActorId: null,
    nativeSessionId: null,
    observedAt: '2026-10-14T00:00:00Z',
    monotonicNs: '0',
    traceId: null,
    spanId: null,
    evidence: [],
    availability: { tokens: 'unsupported' },
  };
}

function request(): Json {
  return {
    requestId: 'r1',
    responseId: null,
    revision: 'v1',
    actorId: 'lead',
    parentActorId: null,
    role: 'lead',
    nativeSessionId: null,
    requestedModel: 'model',
    observedModel: null,
    effort: null,
    tokens: {
      input: 0,
      cacheRead: null,
      cacheWriteTotal: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      output: 12,
      reasoning: null,
    },
    reasoningIncludedInOutput: null,
    durationMs: null,
    failed: false,
    retryOf: null,
    presence: { 'tokens.input': 'observed', 'tokens.output': 'observed', 'tokens.cacheRead': 'absent' },
  };
}

function expectRefused<T>(result: Result<T>, fieldPath: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues.some((issue) => issue.startsWith(`${fieldPath}:`))).toBe(true);
}

const PARSERS: ReadonlyArray<[string, (raw: unknown) => Result<unknown>, () => Json]> = [
  ['parseManifest', parseManifest, manifest],
  ['parseConfiguration', parseConfiguration, configuration],
  ['parsePool', parsePool, pool],
  ['parseCapabilityReport', parseCapabilityReport, capabilityReport],
  ['parseEventEnvelope', parseEventEnvelope, envelope],
];

describe('versioned documents', () => {
  test('BENCH_SCHEMA_VERSION is 1', () => {
    expect(BENCH_SCHEMA_VERSION).toBe(1);
  });

  for (const [name, parse, build] of PARSERS) {
    test(`${name} accepts a valid document`, () => {
      expect(parse(build()).ok).toBe(true);
    });

    test(`${name} refuses an unknown top-level key, naming it`, () => {
      expectRefused(parse({ ...build(), extra: true }), 'extra');
    });

    test(`${name} refuses a wrong schemaVersion, naming the field`, () => {
      expectRefused(parse({ ...build(), schemaVersion: 2 }), 'schemaVersion');
      expectRefused(parse({ ...build(), schemaVersion: '1' }), 'schemaVersion');
    });

    test(`${name} refuses non-object input without throwing`, () => {
      expect(parse(null).ok).toBe(false);
      expect(parse('nope').ok).toBe(false);
    });
  }

  test('a nested unknown key is refused with its full path', () => {
    const doc = manifest();
    const selected = doc.selected as Json[];
    (selected[0].environment as Json).extra = 1;
    expectRefused(parseManifest(doc), 'selected.0.environment.extra');
  });

  test('parsePool returns the entries and refuses an unknown key inside one', () => {
    const parsed = parsePool(pool());
    expect(parsed.ok && parsed.value.length).toBe(2);
    const doc = pool();
    ((doc.entries as Json[])[1].eligibility as Json).note = 'x';
    expectRefused(parsePool(doc), 'entries.1.eligibility.note');
  });

  test('parseConfiguration refuses a treatment resource that is not a sha256', () => {
    expectRefused(
      parseConfiguration({ ...configuration(), treatment: { contract: 'c', resources: { 'a.md': 'short' } } }),
      'treatment.resources.a.md',
    );
  });

  test('parseCapabilityReport refuses a missing required capability and an unsupported one with no requirement', () => {
    const missing = capabilityReport();
    (missing.capabilities as Json).settledSignal = undefined;
    expectRefused(parseCapabilityReport(roundTrip(missing)), 'capabilities.settledSignal');
    const unsupported = capabilityReport();
    (unsupported.capabilities as Json).settledSignal = { status: 'unsupported', evidence: [] };
    expectRefused(parseCapabilityReport(unsupported), 'capabilities.settledSignal.upstreamRequirement');
  });
});

describe('TaskIdentity', () => {
  test('taskKey is <source>/<category>/<taskId>', () => {
    const parsed = parseManifest(manifest());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(taskKey(parsed.value.selected[0])).toBe('deepswe/lint/actionlint-action-pinning-lint');
  });

  const withTask = (mutate: (t: Json) => void): Json => {
    const doc = manifest();
    mutate((doc.selected as Json[])[0]);
    return doc;
  };

  test('refused without instruction.sha256', () => {
    const doc = withTask((t) => {
      t.instruction = { path: 'tasks/actionlint/instruction.md' };
    });
    expectRefused(parseManifest(doc), 'selected.0.instruction.sha256');
  });

  test('refused without environment', () => {
    const doc = withTask((t) => {
      t.environment = undefined;
    });
    expectRefused(parseManifest(roundTrip(doc)), 'selected.0.environment');
  });

  test('refused without verifier.command', () => {
    const doc = withTask((t) => {
      t.verifier = { ...(t.verifier as Json), command: undefined };
    });
    expectRefused(parseManifest(roundTrip(doc)), 'selected.0.verifier.command');
  });

  test('environment.resources round-trips source values unchanged, null included', () => {
    const inner = parseManifest(roundTrip(manifest()));
    expect(inner.ok).toBe(true);
    if (inner.ok) {
      expect(inner.value.selected[0].environment.resources).toEqual({ cpus: null, memoryMb: 0, network: null });
    }
    const whole = parseManifest(
      roundTrip(
        withTask((t) => {
          (t.environment as Json).resources = null;
        }),
      ),
    );
    expect(whole.ok).toBe(true);
    if (whole.ok) expect(whole.value.selected[0].environment.resources).toBeNull();
  });

  test('SolverTask carries no verifier, verifierDigest or referenceSolution (type level)', () => {
    type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
    const noVerifier: HasKey<SolverTask, 'verifier'> = false;
    const noDigest: HasKey<SolverTask, 'verifierDigest'> = false;
    const noReference: HasKey<SolverTask, 'referenceSolution'> = false;
    const contextTaskHasNoVerifier: HasKey<AdapterContext['task'], 'verifier'> = false;
    const identityHasVerifier: HasKey<TaskIdentity, 'verifier'> = true;
    // @ts-expect-error SolverTask must not expose the verifier
    const leaked: SolverTask['verifier'] = undefined;
    expect([noVerifier, noDigest, noReference, contextTaskHasNoVerifier, identityHasVerifier, leaked]).toEqual([
      false,
      false,
      false,
      false,
      true,
      undefined,
    ]);
  });
});

describe('unknown is null, never 0', () => {
  test('null and 0 survive a JSON round trip without coercion', () => {
    const doc = manifest();
    const parsed = parseManifest(roundTrip(doc));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.selected[0].timeLimitSec).toBeNull();
      expect(parsed.value.selected[0].verifier.timeoutSec).toBeNull();
      expect(parsed.value.selected[0].environment.resources?.cpus).toBeNull();
      expect(parsed.value.selected[0].environment.resources?.memoryMb).toBe(0);
    }

    const record = parseNativeRequestRecord(roundTrip(request()));
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.value.tokens.input).toBe(0);
      expect(record.value.tokens.cacheRead).toBeNull();
      expect(record.value.tokens.reasoning).toBeNull();
      expect(record.value.durationMs).toBeNull();
    }
  });

  test('a missing token count is refused rather than defaulted to 0', () => {
    const raw = request();
    (raw.tokens as Json).reasoning = undefined;
    expectRefused(parseNativeRequestRecord(roundTrip(raw)), 'tokens.reasoning');
  });

  test('a known zero with no presence basis is refused', () => {
    const raw = request();
    raw.presence = { 'tokens.output': 'observed' };
    expectRefused(parseNativeRequestRecord(raw), 'tokens.input');
  });

  test('a token 0 whose presence entry is not observed is refused', () => {
    for (const basis of ['absent', 'unsupported']) {
      const raw = request();
      raw.presence = { ...(raw.presence as Json), 'tokens.input': basis };
      expectRefused(parseNativeRequestRecord(raw), 'tokens.input');
    }
  });

  test('a request record refuses an unknown key', () => {
    expectRefused(parseNativeRequestRecord({ ...request(), cost: 0 }), 'cost');
    expectRefused(
      parseNativeRequestRecord({ ...request(), tokens: { ...(request().tokens as Json), total: 1 } }),
      'tokens.total',
    );
  });
});

describe('ATTEMPT_TRANSITIONS', () => {
  const STATES: readonly AttemptState[] = [
    'registered',
    'running',
    'execution-stopped',
    'verified',
    'terminal-failure',
    'capture-sealed',
    'reconciled',
    'extraction-frozen',
  ];

  /** The design §5 chain plus the pre-running and interrupted exits — and nothing else. */
  const LEGAL = new Set([
    'registered>running',
    'running>execution-stopped',
    'execution-stopped>verified',
    'execution-stopped>terminal-failure',
    'verified>capture-sealed',
    'terminal-failure>capture-sealed',
    'capture-sealed>reconciled',
    'reconciled>extraction-frozen',
    'registered>terminal-failure',
    'running>terminal-failure',
  ]);

  test('covers exactly the 8 attempt states', () => {
    expect(Object.keys(ATTEMPT_TRANSITIONS).sort()).toEqual([...STATES].sort());
  });

  test('all 64 ordered pairs: chain edges admitted, every other pair refused', () => {
    let checked = 0;
    for (const from of STATES) {
      for (const to of STATES) {
        const admitted = ATTEMPT_TRANSITIONS[from].includes(to);
        expect({ edge: `${from}>${to}`, admitted }).toEqual({
          edge: `${from}>${to}`,
          admitted: LEGAL.has(`${from}>${to}`),
        });
        checked += 1;
      }
    }
    expect(checked).toBe(64);
  });

  test('extraction-frozen is terminal and the table is frozen', () => {
    expect(ATTEMPT_TRANSITIONS['extraction-frozen']).toEqual([]);
    expect(Object.isFrozen(ATTEMPT_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(ATTEMPT_TRANSITIONS.registered)).toBe(true);
  });
});

describe('capabilities, adapters and clock', () => {
  test('REQUIRED_CAPABILITIES names the nine preflight capabilities', () => {
    for (const name of [
      'launchVisible',
      'discoveryIsolated',
      'modelEffortResolved',
      'childAuxModelEffort',
      'settledSignal',
      'requestUsage',
      'inputOrigin',
      'artifactTransport',
      'environmentExecution',
    ]) {
      expect(REQUIRED_CAPABILITIES).toContain(name);
    }
  });

  test('the adapter map registers the omp adapter', () => {
    expect(Object.keys(ADAPTERS)).toEqual(['omp']);
    expect(ADAPTERS.omp?.harness).toBe('omp');
  });

  test('hostClock is monotonic and reports ISO wall time', () => {
    const first = hostClock.nowNs();
    const second = hostClock.nowNs();
    expect(second >= first).toBe(true);
    expect(Number.isNaN(Date.parse(hostClock.wall()))).toBe(false);
  });
});
