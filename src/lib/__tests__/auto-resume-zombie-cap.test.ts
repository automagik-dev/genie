/**
 * Regression tests for auto-resume zombie-cap bug.
 *
 * Root cause (tracer, HIGH confidence): the concurrency-cap filter in
 * `attemptAgentResume` counted NULL-state identity records and dead-pane
 * zombies toward `activeCount`, inflating it to 142 on an observed
 * machine (vs maxConcurrent=5). Every auto-resume attempt short-circuited
 * with `reason=concurrency_cap` BEFORE the counter increment, leaving
 * error-state agents stuck at 0/3 resume_attempts forever.
 *
 * Also covers:
 *   - Change #2: periodic resume sweep (startup-only retry was insufficient)
 *   - Change #3: `reconcileStaleSpawns` extended to flip idle+dead-pane
 *     rows to `error` (previously only handled `state='spawning'`).
 *
 * Structural parallel to zombie-spawns.test.ts, extended from `spawning`
 * to include `idle|working|permission|question` + NULL + dead-pane.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentState } from '../agent-registry.js';
import {
  type LogEntry,
  type SchedulerConfig,
  type SchedulerDeps,
  type WorkerInfo,
  attemptAgentResume,
  runAgentRecoveryPass,
} from '../scheduler-daemon.js';

// ---------------------------------------------------------------------------
// Helpers (mirrored from zombie-spawns.test.ts)
// ---------------------------------------------------------------------------

const defaultConfig: SchedulerConfig = {
  maxConcurrent: 5,
  pollIntervalMs: 30_000,
  maxJitterMs: 30_000,
  jitterThreshold: 3,
  heartbeatIntervalMs: 60_000,
  orphanCheckIntervalMs: 300_000,
  deadHeartbeatThreshold: 2,
  leaseRecoveryIntervalMs: 60_000,
};

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 'test-agent',
    paneId: '%42',
    state: 'error',
    claudeSessionId: 'session-abc',
    autoResume: true,
    resumeAttempts: 0,
    maxResumeAttempts: 3,
    ...overrides,
  };
}

function createMockSql() {
  const sql: any = (_strings: TemplateStringsArray, ..._values: unknown[]) => [];
  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql);
  sql.listen = async () => {};
  sql.end = async () => {};
  return sql;
}

function createMockDeps(overrides: Partial<SchedulerDeps> = {}) {
  const logs: LogEntry[] = [];
  const agentUpdates: { id: string; updates: Partial<Agent> }[] = [];
  const resumedIds: string[] = [];
  let idCounter = 0;

  const deps: SchedulerDeps = {
    getConnection: async () => createMockSql(),
    spawnCommand: async () => ({ pid: 12345 }),
    log: (entry) => logs.push(entry),
    generateId: () => `test-id-${++idCounter}`,
    now: () => new Date('2026-04-17T12:00:00Z'),
    sleep: async () => {},
    jitter: (maxMs) => Math.floor(maxMs / 2),
    isPaneAlive: async () => false,
    listWorkers: async () => [],
    countTmuxSessions: async () => 0,
    publishEvent: async () => {},
    resumeAgent: async (id) => {
      resumedIds.push(id);
      return true;
    },
    updateAgent: async (id, u) => {
      agentUpdates.push({ id, updates: u });
    },
    ...overrides,
  };

  return { deps, logs, agentUpdates, resumedIds };
}

// ---------------------------------------------------------------------------
// Change #1 — concurrency cap excludes NULL-state + dead-pane zombies
// ---------------------------------------------------------------------------

describe('Change #1: concurrency cap excludes NULL-state + dead-pane rows', () => {
  test('50 NULL-state + 30 dead-pane idle + 10 live working + 10 error yields activeCount=10', async () => {
    // Mirror of the live-production observation: inflated `workers` list
    // where only the 10 live-working rows should consume cap slots.
    const liveWorkers: WorkerInfo[] = [
      // 50 identity records with state=NULL (from findOrCreateAgent)
      ...Array.from({ length: 50 }, (_, i) =>
        makeWorker({
          id: `identity-${i}`,
          paneId: '',
          state: null as unknown as AgentState,
        }),
      ),
      // 30 dead-pane idle zombies (state='idle' but pane is dead)
      ...Array.from({ length: 30 }, (_, i) =>
        makeWorker({
          id: `zombie-${i}`,
          paneId: `%${1000 + i}`,
          state: 'idle',
        }),
      ),
      // 10 live-working agents (state='working', pane alive)
      ...Array.from({ length: 10 }, (_, i) =>
        makeWorker({
          id: `live-${i}`,
          paneId: `%${2000 + i}`,
          state: 'working',
        }),
      ),
      // 10 error-state agents (excluded by existing terminal-state filter)
      ...Array.from({ length: 10 }, (_, i) =>
        makeWorker({
          id: `error-${i}`,
          paneId: `%${3000 + i}`,
          state: 'error',
        }),
      ),
    ];

    // isPaneAlive returns true only for panes in 2000-2999 (the live ones)
    const { deps, logs } = createMockDeps({
      listWorkers: async () => liveWorkers,
      isPaneAlive: async (paneId: string) => {
        const num = Number.parseInt(paneId.slice(1), 10);
        return num >= 2000 && num < 3000;
      },
    });

    // Resume attempt with cap=5 — before the fix this would skip
    // (active=100, max=5). After the fix, activeCount=10 so the cap
    // DOES apply and we expect 'skipped' with active=10 (not 100).
    const agent = makeWorker({ id: 'needs-resume', state: 'error' });
    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('concurrency_cap');
    // Critical: active=10 proves NULL + dead-pane rows were excluded.
    // Pre-fix would have shown active=90 (50 NULL + 30 idle + 10 working).
    expect(skip?.active).toBe(10);
  });

  test('with 10 live-working rows and cap=20, resume proceeds', async () => {
    const liveWorkers: WorkerInfo[] = Array.from({ length: 10 }, (_, i) =>
      makeWorker({ id: `live-${i}`, paneId: `%${i}`, state: 'working' }),
    );
    const { deps, resumedIds } = createMockDeps({
      listWorkers: async () => liveWorkers,
      isPaneAlive: async () => true,
    });

    const cfg: SchedulerConfig = { ...defaultConfig, maxConcurrent: 20 };
    const agent = makeWorker({ id: 'new-agent', state: 'error' });
    const result = await attemptAgentResume(deps, cfg, agent);

    expect(result).toBe('resumed');
    expect(resumedIds).toContain('new-agent');
  });

  test('142-NULL scenario (production match): activeCount=0, resume proceeds', async () => {
    // Exact reproduction of felipe's machine: 83 NULL + 59 idle dead-pane
    // all excluded → activeCount=0 → resume is NOT blocked by cap.
    const workers: WorkerInfo[] = [
      ...Array.from({ length: 83 }, (_, i) =>
        makeWorker({ id: `null-${i}`, paneId: '', state: null as unknown as AgentState }),
      ),
      ...Array.from({ length: 59 }, (_, i) =>
        makeWorker({ id: `idle-dead-${i}`, paneId: `%${5000 + i}`, state: 'idle' }),
      ),
    ];
    const { deps, resumedIds } = createMockDeps({
      listWorkers: async () => workers,
      isPaneAlive: async () => false, // all panes dead
    });

    const agent = makeWorker({ id: 'felipe-stuck', state: 'error' });
    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('resumed');
    expect(resumedIds).toContain('felipe-stuck');
  });

  test('tmux-unreachable is conservative: counts unknown-liveness rows toward cap', async () => {
    // When isPaneAlive throws (tmux blip / transient failure), we must not
    // silently under-count active slots — otherwise we'd over-spawn during
    // a tmux outage. Verify the catch-block keeps the row in activeCount.
    const workers: WorkerInfo[] = Array.from({ length: 5 }, (_, i) =>
      makeWorker({ id: `working-${i}`, paneId: `%${i}`, state: 'working' }),
    );
    const { deps, logs } = createMockDeps({
      listWorkers: async () => workers,
      isPaneAlive: async () => {
        throw new Error('tmux unreachable');
      },
    });

    const agent = makeWorker({ id: 'overflow', state: 'error' });
    const result = await attemptAgentResume(deps, defaultConfig, agent);

    expect(result).toBe('skipped');
    const skip = logs.find((l) => l.event === 'agent_resume_skipped');
    expect(skip?.reason).toBe('concurrency_cap');
    expect(skip?.active).toBe(5);
  });

  test('synthetic paneIds (non-tmux) skip the liveness check', async () => {
    // Non-tmux transports use paneIds like 'sdk', 'inline', '' — those
    // don't match the %\d+ pattern and must NOT be subjected to
    // isPaneAlive (which is tmux-specific).
    const workers: WorkerInfo[] = [
      makeWorker({ id: 'sdk-worker', paneId: 'sdk', state: 'working' }),
      makeWorker({ id: 'inline-worker', paneId: 'inline', state: 'working' }),
    ];
    let paneCalls = 0;
    const { deps } = createMockDeps({
      listWorkers: async () => workers,
      isPaneAlive: async () => {
        paneCalls++;
        return false;
      },
    });

    const agent = makeWorker({ id: 'probe', state: 'error' });
    await attemptAgentResume(deps, defaultConfig, agent);

    // isPaneAlive should not be called for synthetic paneIds
    expect(paneCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Change #2 — periodic resume sweep (not just startup)
// ---------------------------------------------------------------------------

describe('Change #2: periodic resume sweep for error-state agents', () => {
  test('runAgentRecoveryPass is exported for periodic invocation', () => {
    // The fix requires this function to be callable from a setInterval tick,
    // so it must be exported from scheduler-daemon.
    expect(typeof runAgentRecoveryPass).toBe('function');
  });

  test('runAgentRecoveryPass does NOT resume error-state agents with dead panes (turn-aware default, Phase B)', async () => {
    // Post-G8 contract: with GENIE_RECONCILER_TURN_AWARE on by default,
    // only working/permission/question + dead-pane are resumed (D3).
    // `error` is terminal intent already — resuming would replay a
    // failed turn. See WISH turn-session-contract, C20.
    const workers: WorkerInfo[] = [
      makeWorker({ id: 'dead-error', paneId: '%99', state: 'error', claudeSessionId: 'sess-1' }),
      makeWorker({ id: 'finished', paneId: '%98', state: 'done', claudeSessionId: 'sess-2' }),
      makeWorker({ id: 'paused', paneId: '%97', state: 'suspended', claudeSessionId: 'sess-3' }),
    ];
    const { deps, resumedIds } = createMockDeps({
      listWorkers: async () => workers,
      isPaneAlive: async () => false,
    });

    await runAgentRecoveryPass(deps, 'daemon-test', defaultConfig);

    expect(resumedIds).not.toContain('dead-error');
    expect(resumedIds).not.toContain('finished');
    expect(resumedIds).not.toContain('paused');
  });

  test('legacy flag OFF: runAgentRecoveryPass still resumes error-state agents with dead panes', async () => {
    // Rollback path — operators can set GENIE_RECONCILER_TURN_AWARE=0 to
    // restore pre-Phase-B behavior if the turn-aware reconciler causes
    // incidents in production.
    const prev = process.env.GENIE_RECONCILER_TURN_AWARE;
    process.env.GENIE_RECONCILER_TURN_AWARE = '0';
    try {
      const workers: WorkerInfo[] = [
        makeWorker({ id: 'dead-error', paneId: '%99', state: 'error', claudeSessionId: 'sess-1' }),
        makeWorker({ id: 'finished', paneId: '%98', state: 'done', claudeSessionId: 'sess-2' }),
        makeWorker({ id: 'paused', paneId: '%97', state: 'suspended', claudeSessionId: 'sess-3' }),
      ];
      const { deps, resumedIds } = createMockDeps({
        listWorkers: async () => workers,
        isPaneAlive: async () => false,
      });

      await runAgentRecoveryPass(deps, 'daemon-test', defaultConfig);

      expect(resumedIds).toContain('dead-error');
      expect(resumedIds).not.toContain('finished');
      expect(resumedIds).not.toContain('paused');
    } finally {
      process.env.GENIE_RECONCILER_TURN_AWARE = prev;
    }
  });

  test('daemon startup wires the resume timer alongside lease recovery', () => {
    // Source-level assertion: the startAgentResumeTimer must exist and
    // be invoked in the daemon start flow. Without this, error-state
    // agents created after daemon startup never retry.
    const source = readFileSync(join(__dirname, '..', 'scheduler-daemon.ts'), 'utf-8');
    expect(source).toContain('startAgentResumeTimer');
    expect(source).toContain('agentResumeTimer = startAgentResumeTimer');
    // Timer must call runAgentRecoveryPass
    expect(source).toContain('await runAgentRecoveryPass(d, dId, cfg)');
    // And must be cleaned up on stop
    expect(source).toContain('if (agentResumeTimer)');
  });
});

// ---------------------------------------------------------------------------
// Change #3 — reconcileStaleSpawns GCs idle+dead-pane zombies
// ---------------------------------------------------------------------------

describe('Change #3: reconcileStaleSpawns GCs dead-pane zombies in active states', () => {
  test('source includes third-pass reconciliation for active states', () => {
    const source = readFileSync(join(__dirname, '..', 'agent-registry.ts'), 'utf-8');

    // Third pass selects active-state rows whose pane looks like a real
    // tmux pane. Those with dead panes are flipped to 'error'.
    expect(source).toContain("state IN ('idle', 'working', 'permission', 'question')");
    // Uses the Postgres regex operator to match tmux pane IDs
    expect(source).toContain("pane_id ~ '^%[0-9]+$'");
    // Audit event uses a distinct reason for debugging
    expect(source).toContain('dead_pane_zombie');
    // Still calls isPaneAlive for authoritative liveness check
    expect(source).toContain('isPaneAlive(row.pane_id)');
    // Preserves previous state in the audit payload for forensics
    expect(source).toContain('previous_state: prevState');
  });

  test('daemon periodic timer invokes reconcileStaleSpawns before resume pass', () => {
    // The GC must run BEFORE runAgentRecoveryPass so the resume attempts
    // see a clean worker set (zombies already flipped to 'error').
    const source = readFileSync(join(__dirname, '..', 'scheduler-daemon.ts'), 'utf-8');
    expect(source).toContain("import('./agent-registry.js')");
    expect(source).toContain('await reconcileStaleSpawns()');
    // Timer body must call the GC helper before the resume pass.
    const timerStart = source.indexOf('function startAgentResumeTimer');
    expect(timerStart).toBeGreaterThan(-1);
    const afterTimerStart = source.slice(timerStart);
    const nextFnIdx = afterTimerStart.slice(1).search(/\n\s{0,4}function\s/);
    const timerBody = nextFnIdx > 0 ? afterTimerStart.slice(0, nextFnIdx) : afterTimerStart;
    const reconcileIdx = timerBody.indexOf('reconcileDeadPaneZombies(d)');
    const resumeCallIdx = timerBody.indexOf('runAgentRecoveryPass(d, dId, cfg)');
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(resumeCallIdx).toBeGreaterThan(reconcileIdx);
  });

  test('third pass uses conditional UPDATE to avoid racing with live state changes', () => {
    // The UPDATE is guarded by `WHERE id = ? AND state = <previousState>`
    // so if another process transitioned the row between SELECT and UPDATE
    // (e.g. agent finished work, user resumed), we don't overwrite it.
    const source = readFileSync(join(__dirname, '..', 'agent-registry.ts'), 'utf-8');
    expect(source).toContain('WHERE id = ${row.id} AND state = ${prevState}');
  });
});

// ---------------------------------------------------------------------------
// Gap #2 regression — boot-mode terminal-executor check (turn-session-contract)
// ---------------------------------------------------------------------------

/**
 * Mock SQL that returns a closed executor for the isLegitimatelyClosed helper
 * lookup (agent_id → executor with closed_at set).
 */
function createMockSqlWithTerminalExecutor(currentExecutorId: string) {
  const sql: any = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join(' ');
    if (query.includes('current_executor_id') && query.includes('FROM agents')) {
      return [{ current_executor_id: currentExecutorId }];
    }
    if (query.includes('FROM executors') && query.includes('closed_at')) {
      return [{ closed_at: new Date(), outcome: 'done' }];
    }
    return [];
  };
  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql);
  sql.listen = async () => {};
  sql.end = async () => {};
  return sql;
}

describe('Gap #2 regression — boot-mode terminal-executor check (turn-session-contract)', () => {
  test('boot mode skips resume when current executor is already terminal', async () => {
    // Live-instance regression (2026-04-21): agent called `genie done`, executor
    // was marked terminal, daemon restarted, boot-mode reconciler resurrected the
    // agent anyway because D1/D3 rules were bypassed. Fix: check executor terminal
    // state before resuming in boot mode.
    const worker = makeWorker({
      id: 'dead-closed',
      paneId: '%50',
      state: 'spawning',
      claudeSessionId: 'sess-closed',
    });
    const { deps, resumedIds, logs } = createMockDeps({
      listWorkers: async () => [worker],
      isPaneAlive: async () => false,
      getConnection: async () => createMockSqlWithTerminalExecutor('exec-closed-1'),
    });

    await runAgentRecoveryPass(deps, 'daemon-boot-test', defaultConfig, 'boot');

    expect(resumedIds).not.toContain('dead-closed');
    const skipLog = logs.find((l) => l.event === 'agent_resume_skipped_boot_terminal');
    expect(skipLog).toBeDefined();
  });

  test('boot mode still resumes when executor is open (legitimate mid-turn crash recovery)', async () => {
    // No regression to the legitimate recovery path — if the executor is still
    // open (closed_at IS NULL AND outcome IS NULL), boot-mode resume fires as
    // before. Default mock SQL returns empty rows → isLegitimatelyClosed=false.
    const worker = makeWorker({
      id: 'dead-open',
      paneId: '%51',
      state: 'spawning',
      claudeSessionId: 'sess-open',
    });
    const { deps, resumedIds } = createMockDeps({
      listWorkers: async () => [worker],
      isPaneAlive: async () => false,
    });

    await runAgentRecoveryPass(deps, 'daemon-boot-test', defaultConfig, 'boot');

    expect(resumedIds).toContain('dead-open');
  });

  test('sweep mode D1/D3 rules remain intact — state="spawning" + dead pane is skipped (no regression)', async () => {
    // Separate assertion: the Gap #2 fix only touches boot mode. In sweep mode,
    // state='spawning' falls through to the state-not-in-D3 skip at line 888 —
    // unchanged. This guards against accidental bleed between boot and sweep
    // branches during the fix.
    const worker = makeWorker({
      id: 'sweep-spawning',
      paneId: '%52',
      state: 'spawning',
      claudeSessionId: 'sess-sweep',
    });
    const { deps, resumedIds } = createMockDeps({
      listWorkers: async () => [worker],
      isPaneAlive: async () => false,
    });

    await runAgentRecoveryPass(deps, 'daemon-sweep-test', defaultConfig, 'sweep');

    expect(resumedIds).not.toContain('sweep-spawning');
  });
});
