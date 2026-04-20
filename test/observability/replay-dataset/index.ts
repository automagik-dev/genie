/**
 * Synthetic replay fixtures for the observability acid-test suite.
 *
 * Each `seed*` function INSERTs a deterministic sequence of typed events
 * directly into `genie_runtime_events` and `genie_runtime_events_audit` so
 * the matching SQL query in `docs/observability-acid-tests.sql` finds an
 * exactly known number of evidence rows and ignores the planted decoys.
 *
 * Direct INSERTs intentionally bypass `emit.ts` — the acid tests prove the
 * SQL queries reconstruct each pathology from raw rows alone, which is the
 * substrate's whole reason for existing. Schemas are honoured by mirroring
 * the closed-registry shape: `subject` carries the event type, `kind` is
 * 'system' (matches what emit.ts writes), and OTEL fields land both on the
 * dedicated columns and inside `data` with the `_`-prefix scaffold so the
 * COALESCE patterns in the SQL queries see them on either side.
 *
 * Audit-tier inserts must omit `chain_hash` — the trigger raises an
 * exception if a writer supplies one. Each pattern uses unique team_name /
 * agent / agent_id / entity_id values so cross-pattern interference is
 * impossible (the audit table cannot be cleaned between patterns under WORM).
 *
 * Wish: genie-serve-structured-observability, Group 7 deliverable #2.
 */

import { randomUUID } from 'node:crypto';

type Sql = Awaited<ReturnType<typeof import('../../../src/lib/db.js').getConnection>>;

export interface FixtureResult {
  /** The pattern id from `docs/observability-acid-tests.sql`. */
  patternId: string;
  /** Number of evidence rows the matching query is required to return. */
  expectedEvidenceCount: number;
  /** Trace id seeded by this fixture, useful for runbook-r1 cross-tests. */
  traceId?: string;
}

/** Common scaffold fields written into `data` so COALESCE in queries works. */
function scaffold(opts: {
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  duration_ms?: number;
  source_subsystem?: string;
  schema_version?: number;
  kind?: string;
  tier?: 'A' | 'B' | 'C' | 'audit' | 'debug';
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.trace_id) out._trace_id = opts.trace_id;
  if (opts.span_id) out._span_id = opts.span_id;
  if (opts.parent_span_id) out._parent_span_id = opts.parent_span_id;
  if (opts.severity) out._severity = opts.severity;
  if (opts.duration_ms !== undefined) out._duration_ms = opts.duration_ms;
  if (opts.source_subsystem) out._source_subsystem = opts.source_subsystem;
  if (opts.schema_version !== undefined) out._schema_version = opts.schema_version;
  if (opts.kind) out._kind = opts.kind;
  if (opts.tier) out._tier = opts.tier;
  return out;
}

interface InsertEventArgs {
  repo_path: string;
  subject: string;
  agent: string;
  team?: string | null;
  text?: string;
  data: Record<string, unknown>;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  duration_ms?: number;
  source_subsystem?: string;
  created_at?: Date;
  schema_version?: number;
}

async function insertEvent(sql: Sql, a: InsertEventArgs): Promise<void> {
  const merged = {
    ...a.data,
    ...scaffold({
      trace_id: a.trace_id ?? undefined,
      span_id: a.span_id ?? undefined,
      parent_span_id: a.parent_span_id ?? undefined,
      severity: a.severity,
      duration_ms: a.duration_ms,
      source_subsystem: a.source_subsystem,
      schema_version: a.schema_version,
      kind: 'system',
    }),
  };
  await sql`
    INSERT INTO genie_runtime_events
      (repo_path, subject, kind, source, agent, team, text, data,
       trace_id, span_id, parent_span_id, severity, schema_version,
       duration_ms, source_subsystem, created_at)
    VALUES
      (${a.repo_path}, ${a.subject}, 'system', 'sdk', ${a.agent}, ${a.team ?? null},
       ${a.text ?? a.subject}, ${sql.json(merged)},
       ${a.trace_id ?? null}, ${a.span_id ?? null}, ${a.parent_span_id ?? null},
       ${a.severity ?? null}, ${a.schema_version ?? 1},
       ${a.duration_ms ?? null}, ${a.source_subsystem ?? null},
       ${a.created_at ?? sql`now()`})
  `;
}

async function insertAudit(sql: Sql, a: InsertEventArgs): Promise<void> {
  const merged = {
    ...a.data,
    ...scaffold({
      trace_id: a.trace_id ?? undefined,
      span_id: a.span_id ?? undefined,
      parent_span_id: a.parent_span_id ?? undefined,
      severity: a.severity,
      source_subsystem: a.source_subsystem,
      schema_version: a.schema_version,
      kind: 'system',
      tier: 'audit',
    }),
  };
  await sql`
    INSERT INTO genie_runtime_events_audit
      (repo_path, subject, kind, source, agent, team, text, data,
       trace_id, span_id, severity, schema_version, source_subsystem, created_at)
    VALUES
      (${a.repo_path}, ${a.subject}, 'system', 'sdk', ${a.agent}, ${a.team ?? null},
       ${a.text ?? a.subject}, ${sql.json(merged)},
       ${a.trace_id ?? null}, ${a.span_id ?? null},
       ${a.severity ?? 'info'}, ${a.schema_version ?? 1},
       ${a.source_subsystem ?? null},
       ${a.created_at ?? sql`now()`})
  `;
}

// ---------------------------------------------------------------------------
// rot.1 — backfilled teams (audit team.create with no cli/wish span ±5min)
// ---------------------------------------------------------------------------

export async function seedRot1(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-rot1';

  // Evidence: backfilled team — audit row exists, no cli.command/wish.dispatch
  // shares the trace within ±5min.
  const orphanTrace = randomUUID();
  await insertAudit(sql, {
    repo_path,
    subject: 'team.create',
    agent: 'system',
    text: 'team.create',
    data: { team_name: 'acid-rot1-orphan', auto: true, member_count: 3 },
    trace_id: orphanTrace,
    source_subsystem: 'backfiller',
  });

  // Decoy: legitimate team — audit row + cli.command in the trace within ±5min.
  const legitTrace = randomUUID();
  const cliSpan = randomUUID();
  await insertAudit(sql, {
    repo_path,
    subject: 'team.create',
    agent: 'system',
    text: 'team.create',
    data: { team_name: 'acid-rot1-legit', auto: false, member_count: 2 },
    trace_id: legitTrace,
    source_subsystem: 'cli',
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'cli.command',
    agent: 'genie-cli',
    text: 'cli.command',
    data: { command: 'team', args: ['create', 'acid-rot1-legit'] },
    trace_id: legitTrace,
    span_id: cliSpan,
    severity: 'info',
    source_subsystem: 'cli',
  });

  return { patternId: 'rot.1.backfilled-teams-without-worktree', expectedEvidenceCount: 1, traceId: orphanTrace };
}

// ---------------------------------------------------------------------------
// rot.2 — team-ls/disband drift
// ---------------------------------------------------------------------------

export async function seedRot2(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-rot2';
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Evidence A: created, never disbanded.
  await insertAudit(sql, {
    repo_path,
    subject: 'team.create',
    agent: 'system',
    text: 'team.create',
    data: { team_name: 'acid-rot2-zombie' },
    created_at: t(-300),
  });

  // Decoy B: created then disbanded later.
  await insertAudit(sql, {
    repo_path,
    subject: 'team.create',
    agent: 'system',
    text: 'team.create',
    data: { team_name: 'acid-rot2-clean' },
    created_at: t(-200),
  });
  await insertAudit(sql, {
    repo_path,
    subject: 'team.disband',
    agent: 'system',
    text: 'team.disband',
    data: { team_name: 'acid-rot2-clean' },
    created_at: t(-180),
  });

  // Evidence C: re-created after a stale disband (last disband predates latest create).
  await insertAudit(sql, {
    repo_path,
    subject: 'team.disband',
    agent: 'system',
    text: 'team.disband',
    data: { team_name: 'acid-rot2-recreated' },
    created_at: t(-260),
  });
  await insertAudit(sql, {
    repo_path,
    subject: 'team.create',
    agent: 'system',
    text: 'team.create',
    data: { team_name: 'acid-rot2-recreated' },
    created_at: t(-100),
  });

  return { patternId: 'rot.2.team-ls-disband-drift', expectedEvidenceCount: 2 };
}

// ---------------------------------------------------------------------------
// rot.3 — ghost anchors (agent.lifecycle without session.id.written within 10min)
// ---------------------------------------------------------------------------

export async function seedRot3(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-rot3';

  // Evidence: ghost — lifecycle but no session.
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-rot3-ghost',
    text: 'agent.lifecycle',
    data: { agent_id: 'acid-rot3-ghost', executor: 'claude-code' },
    trace_id: randomUUID(),
    span_id: randomUUID(),
    severity: 'info',
  });

  // Decoy: anchored — lifecycle paired with session.id.written within 10min.
  const anchored = 'acid-rot3-anchored';
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: anchored,
    text: 'agent.lifecycle',
    data: { agent_id: anchored, executor: 'claude-code' },
    trace_id: randomUUID(),
    span_id: randomUUID(),
    severity: 'info',
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'session.id.written',
    agent: anchored,
    text: 'session.id.written',
    data: { agent_id: anchored, executor: 'claude-code', origin: 'spawn', before: {}, after: { session_id: 'x' } },
    severity: 'info',
  });

  return { patternId: 'rot.3.ghost-anchors-no-session', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// rot.4 — duplicate custom-name anchors
// ---------------------------------------------------------------------------

export async function seedRot4(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-rot4';

  // Two collision groups (each → one evidence row).
  const collisionA = 'acid-rot4-collide-A';
  const collisionC = 'acid-rot4-collide-C';
  for (let i = 0; i < 2; i++) {
    await insertEvent(sql, {
      repo_path,
      subject: 'agent.lifecycle',
      agent: `${collisionA}-pid${i}`,
      data: { agent_id: collisionA, executor: 'claude-code' },
      trace_id: randomUUID(),
      span_id: randomUUID(),
    });
  }
  for (let i = 0; i < 3; i++) {
    await insertEvent(sql, {
      repo_path,
      subject: 'agent.lifecycle',
      agent: `${collisionC}-pid${i}`,
      data: { agent_id: collisionC, executor: 'claude-code' },
      trace_id: randomUUID(),
      span_id: randomUUID(),
    });
  }

  // Decoy: a unique agent_id never collides.
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-rot4-unique-pid0',
    data: { agent_id: 'acid-rot4-unique', executor: 'claude-code' },
    trace_id: randomUUID(),
    span_id: randomUUID(),
  });

  return { patternId: 'rot.4.duplicate-custom-name-anchors', expectedEvidenceCount: 2 };
}

// ---------------------------------------------------------------------------
// rot.5 — zombie team-lead polling after disband
// ---------------------------------------------------------------------------

export async function seedRot5(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-rot5';
  const team = 'acid-rot5-team';
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Disband the team in the audit log.
  await insertAudit(sql, {
    repo_path,
    subject: 'team.disband',
    agent: 'system',
    text: 'team.disband',
    data: { team_name: team },
    created_at: t(-600),
  });

  // Two evidence rows: hook.delivery + mailbox.delivery from a team-lead AFTER
  // disband + 60s grace.
  await insertEvent(sql, {
    repo_path,
    subject: 'hook.delivery',
    agent: `${team}-team-lead`,
    team,
    data: { hook_name: 'PostToolUse', status: 'ok' },
    severity: 'info',
    source_subsystem: 'team-lead',
    created_at: t(-300),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'mailbox.delivery',
    agent: `${team}-team-lead`,
    team,
    data: { from: 'team-lead', to: 'engineer', channel: 'tmux', outcome: 'delivered' },
    severity: 'info',
    source_subsystem: 'team-lead',
    created_at: t(-200),
  });

  // Decoy: an executor.write inside the disband+60s grace window — must NOT
  // count.
  await insertEvent(sql, {
    repo_path,
    subject: 'executor.write',
    agent: `${team}-team-lead`,
    team,
    data: { table: 'agents' },
    severity: 'info',
    source_subsystem: 'team-lead',
    created_at: t(-580),
  });

  // Decoy: an event for a team that was NEVER disbanded.
  await insertEvent(sql, {
    repo_path,
    subject: 'mailbox.delivery',
    agent: 'acid-rot5-other-team-lead',
    team: 'acid-rot5-other',
    data: { from: 'team-lead', to: 'engineer', channel: 'tmux' },
    severity: 'info',
    source_subsystem: 'team-lead',
  });

  return { patternId: 'rot.5.zombie-team-lead-polling', expectedEvidenceCount: 2 };
}

// ---------------------------------------------------------------------------
// rot.6 — orphan subagent cascade (child outlives finished parent)
// ---------------------------------------------------------------------------

export async function seedRot6(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-rot6';
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Evidence: parent has exit_reason set, child fires AFTER parent.
  const parentSpan = randomUUID();
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-rot6-parent',
    data: {
      agent_id: 'acid-rot6-parent',
      executor: 'claude-code',
      exit_reason: 'completed',
      duration_ms: 5_000,
    },
    span_id: parentSpan,
    severity: 'info',
    created_at: t(-120),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-rot6-orphan-child',
    data: { agent_id: 'acid-rot6-orphan-child', executor: 'claude-code' },
    parent_span_id: parentSpan,
    span_id: randomUUID(),
    severity: 'info',
    created_at: t(-30),
  });

  // Decoy: parent still running (no exit_reason) — child does NOT count.
  const liveParent = randomUUID();
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-rot6-live-parent',
    data: { agent_id: 'acid-rot6-live-parent', executor: 'claude-code' },
    span_id: liveParent,
    severity: 'info',
    created_at: t(-110),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-rot6-healthy-child',
    data: { agent_id: 'acid-rot6-healthy-child', executor: 'claude-code' },
    parent_span_id: liveParent,
    span_id: randomUUID(),
    severity: 'info',
    created_at: t(-20),
  });

  return { patternId: 'rot.6.orphan-subagent-cascade', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// dispatch.A — parser "review" false-match
// ---------------------------------------------------------------------------

export async function seedDispatchA(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-dispatch-a';

  // Evidence: group_name contains "review" but actor is engineer (false match).
  await insertEvent(sql, {
    repo_path,
    subject: 'wish.dispatch',
    agent: 'engineer-7',
    data: { wish_slug: 'acid-dispatch-a', group_name: 'reviewable-impl', actor: 'engineer-7', wave: 1 },
    severity: 'info',
  });

  // Decoy: review wave with reviewer actor → ok.
  await insertEvent(sql, {
    repo_path,
    subject: 'wish.dispatch',
    agent: 'reviewer-1',
    data: { wish_slug: 'acid-dispatch-a', group_name: 'review-pass', actor: 'reviewer-1', wave: 1 },
    severity: 'info',
  });

  // Decoy: non-review group → not selected.
  await insertEvent(sql, {
    repo_path,
    subject: 'wish.dispatch',
    agent: 'engineer-2',
    data: { wish_slug: 'acid-dispatch-a', group_name: 'implement', actor: 'engineer-2', wave: 0 },
    severity: 'info',
  });

  return { patternId: 'dispatch.A.parser-review-false-match', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// dispatch.B — reset doesn't clear wave state
// ---------------------------------------------------------------------------

export async function seedDispatchB(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-dispatch-b';
  const traceA = randomUUID();
  const traceB = randomUUID();
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Evidence: reset followed within 5 min by wish.dispatch wave=2 sharing trace.
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'wish-runner',
    data: {
      entity_kind: 'wish',
      entity_id: 'acid-dispatch-b-wish',
      from: 'in_progress',
      to: 'reset',
      actor: 'operator',
      before: {},
      after: {},
    },
    trace_id: traceA,
    severity: 'info',
    created_at: t(-200),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'wish.dispatch',
    agent: 'wish-runner',
    data: { wish_slug: 'acid-dispatch-b-wish', group_name: 'phase-2', actor: 'engineer', wave: 2 },
    trace_id: traceA,
    severity: 'info',
    created_at: t(-160),
  });

  // Decoy 1: reset followed by wave=0 dispatch (wave was actually cleared).
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'wish-runner',
    data: {
      entity_kind: 'wish',
      entity_id: 'acid-dispatch-b-clean',
      from: 'in_progress',
      to: 'reset',
      actor: 'operator',
      before: {},
      after: {},
    },
    trace_id: traceB,
    severity: 'info',
    created_at: t(-100),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'wish.dispatch',
    agent: 'wish-runner',
    data: { wish_slug: 'acid-dispatch-b-clean', group_name: 'phase-0', actor: 'engineer', wave: 0 },
    trace_id: traceB,
    severity: 'info',
    created_at: t(-80),
  });

  // Decoy 2: wave>0 dispatch outside the 5-minute window after a reset.
  const traceC = randomUUID();
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'wish-runner',
    data: {
      entity_kind: 'wish',
      entity_id: 'acid-dispatch-b-late',
      from: 'in_progress',
      to: 'reset',
      actor: 'operator',
      before: {},
      after: {},
    },
    trace_id: traceC,
    severity: 'info',
    created_at: t(-1200),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'wish.dispatch',
    agent: 'wish-runner',
    data: { wish_slug: 'acid-dispatch-b-late', group_name: 'phase-1', actor: 'engineer', wave: 1 },
    trace_id: traceC,
    severity: 'info',
    created_at: t(-30),
  });

  return { patternId: 'dispatch.B.reset-no-clear-wave-state', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// dispatch.C — pg-vs-cache status drift
// ---------------------------------------------------------------------------

export async function seedDispatchC(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-dispatch-c';
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Evidence: drift — first transition to=in_progress, second from=pending
  // (writer started from a stale snapshot).
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'task-engine',
    data: {
      entity_kind: 'task',
      entity_id: 'acid-dispatch-c-task',
      from: 'pending',
      to: 'in_progress',
      actor: 'pg-writer',
      before: {},
      after: {},
    },
    severity: 'info',
    created_at: t(-50),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'task-engine',
    data: {
      entity_kind: 'task',
      entity_id: 'acid-dispatch-c-task',
      from: 'pending',
      to: 'completed',
      actor: 'cache-writer',
      before: {},
      after: {},
    },
    severity: 'info',
    created_at: t(-20),
  });

  // Decoy: clean — second.from matches first.to.
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'task-engine',
    data: {
      entity_kind: 'task',
      entity_id: 'acid-dispatch-c-clean',
      from: 'pending',
      to: 'in_progress',
      actor: 'pg-writer',
      before: {},
      after: {},
    },
    severity: 'info',
    created_at: t(-40),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: 'task-engine',
    data: {
      entity_kind: 'task',
      entity_id: 'acid-dispatch-c-clean',
      from: 'in_progress',
      to: 'completed',
      actor: 'pg-writer',
      before: {},
      after: {},
    },
    severity: 'info',
    created_at: t(-15),
  });

  return { patternId: 'dispatch.C.pg-vs-cache-status-drift', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// dispatch.D — spawn bypass of the state machine
// ---------------------------------------------------------------------------

export async function seedDispatchD(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-dispatch-d';
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Evidence: lifecycle with no preceding state_transition for that worker
  // within ±5 minutes.
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: 'acid-dispatch-d-bypass',
    data: { agent_id: 'acid-dispatch-d-bypass', executor: 'claude-code' },
    severity: 'info',
    span_id: randomUUID(),
  });

  // Decoy: lifecycle preceded by a worker state_transition inside the window.
  const properAgent = 'acid-dispatch-d-proper';
  await insertEvent(sql, {
    repo_path,
    subject: 'state_transition',
    agent: properAgent,
    data: {
      entity_kind: 'worker',
      entity_id: properAgent,
      from: 'pending',
      to: 'spawning',
      actor: 'team-lead',
      before: {},
      after: {},
    },
    severity: 'info',
    created_at: t(-120),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: properAgent,
    data: { agent_id: properAgent, executor: 'claude-code' },
    severity: 'info',
    span_id: randomUUID(),
    created_at: t(-60),
  });

  return { patternId: 'dispatch.D.spawn-bypass-state-machine', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// dispatch.E — agent-ready timer mismeasure
// ---------------------------------------------------------------------------

export async function seedDispatchE(sql: Sql): Promise<FixtureResult> {
  const repo_path = 'acid-dispatch-e';
  const t = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

  // Evidence: lifecycle with duration_ms<100 but ≥3 hook.delivery within 60s.
  const liar = 'acid-dispatch-e-liar';
  const liarSpan = randomUUID();
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: liar,
    data: { agent_id: liar, executor: 'claude-code', duration_ms: 17 },
    span_id: liarSpan,
    severity: 'info',
    duration_ms: 17,
    created_at: t(-50),
  });
  for (let i = 0; i < 4; i++) {
    await insertEvent(sql, {
      repo_path,
      subject: 'hook.delivery',
      agent: liar,
      data: { hook_name: 'PostToolUse', status: 'ok' },
      severity: 'info',
      created_at: t(-50 + i + 1),
    });
  }

  // Decoy A: small duration but only 1 hook in window — should NOT count.
  const small = 'acid-dispatch-e-small';
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: small,
    data: { agent_id: small, executor: 'claude-code', duration_ms: 50 },
    span_id: randomUUID(),
    severity: 'info',
    duration_ms: 50,
    created_at: t(-40),
  });
  await insertEvent(sql, {
    repo_path,
    subject: 'hook.delivery',
    agent: small,
    data: { hook_name: 'PostToolUse', status: 'ok' },
    severity: 'info',
    created_at: t(-39),
  });

  // Decoy B: realistic long-duration lifecycle with many hooks → not flagged.
  const honest = 'acid-dispatch-e-honest';
  await insertEvent(sql, {
    repo_path,
    subject: 'agent.lifecycle',
    agent: honest,
    data: { agent_id: honest, executor: 'claude-code', duration_ms: 5_000 },
    span_id: randomUUID(),
    severity: 'info',
    duration_ms: 5_000,
    created_at: t(-30),
  });
  for (let i = 0; i < 5; i++) {
    await insertEvent(sql, {
      repo_path,
      subject: 'hook.delivery',
      agent: honest,
      data: { hook_name: 'PostToolUse', status: 'ok' },
      severity: 'info',
      created_at: t(-30 + i + 1),
    });
  }

  return { patternId: 'dispatch.E.agent-ready-timer-mismeasure', expectedEvidenceCount: 1 };
}

// ---------------------------------------------------------------------------
// All 11 fixtures, registered in canonical order.
// ---------------------------------------------------------------------------

export type Seeder = (sql: Sql) => Promise<FixtureResult>;

export const ALL_SEEDERS: ReadonlyArray<Seeder> = [
  seedRot1,
  seedRot2,
  seedRot3,
  seedRot4,
  seedRot5,
  seedRot6,
  seedDispatchA,
  seedDispatchB,
  seedDispatchC,
  seedDispatchD,
  seedDispatchE,
];

/** Repo-path namespace prefixes that the cleanup helper deletes. */
export const FIXTURE_REPO_PATH_PREFIX = 'acid-';

/**
 * Best-effort cleanup of the live event table — audit table is WORM and
 * cannot be deleted, but per-pattern unique team_name/agent ids ensure no
 * cross-pattern interference.
 */
export async function cleanupLiveEvents(sql: Sql): Promise<void> {
  await sql`DELETE FROM genie_runtime_events WHERE repo_path LIKE ${`${FIXTURE_REPO_PATH_PREFIX}%`}`;
}
