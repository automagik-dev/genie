/**
 * Executor Registry — CRUD for ephemeral executor process records.
 *
 * Executors are the runtime counterpart to agents: one agent can have many
 * executors over its lifetime, but only one is "current" at any time.
 * State lives here; agent identity is in agent-registry.
 */

import { randomUUID } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordAuditEvent } from './audit.js';
import { type Sql, getConnection } from './db.js';
import {
  type Executor,
  type ExecutorRow,
  type ExecutorState,
  type TransportType,
  rowToExecutor,
} from './executor-types.js';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateExecutorOpts {
  /** Pre-generated executor ID. If omitted, a UUID is generated. */
  id?: string;
  pid?: number | null;
  tmuxSession?: string | null;
  tmuxPaneId?: string | null;
  tmuxWindow?: string | null;
  tmuxWindowId?: string | null;
  claudeSessionId?: string | null;
  state?: ExecutorState;
  metadata?: Record<string, unknown>;
  worktree?: string | null;
  repoPath?: string | null;
  paneColor?: string | null;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create an executor record and return it.
 * Does NOT set agent.current_executor_id — caller should use
 * agent-registry.setCurrentExecutor() after creation.
 */
export async function createExecutor(
  agentId: string,
  provider: ProviderName,
  transport: TransportType,
  opts: CreateExecutorOpts = {},
): Promise<Executor> {
  const sql = await getConnection();
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();

  const rows = await sql<ExecutorRow[]>`
    INSERT INTO executors (
      id, agent_id, provider, transport, pid,
      tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
      claude_session_id, state, metadata, worktree, repo_path, pane_color,
      started_at
    ) VALUES (
      ${id}, ${agentId}, ${provider}, ${transport}, ${opts.pid ?? null},
      ${opts.tmuxSession ?? null}, ${opts.tmuxPaneId ?? null},
      ${opts.tmuxWindow ?? null}, ${opts.tmuxWindowId ?? null},
      ${opts.claudeSessionId ?? null}, ${opts.state ?? 'spawning'},
      ${sql.json(opts.metadata ?? {})}, ${opts.worktree ?? null},
      ${opts.repoPath ?? null}, ${opts.paneColor ?? null},
      ${now}
    ) RETURNING *
  `;

  return rowToExecutor(rows[0]);
}

/**
 * Atomically create an executor and set it as the agent's current executor.
 * Both operations happen in a single SQL transaction to prevent orphaned records.
 */
export async function createAndLinkExecutor(
  agentId: string,
  provider: ProviderName,
  transport: TransportType,
  opts: CreateExecutorOpts = {},
): Promise<Executor> {
  const sql = await getConnection();
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();

  return sql.begin(async (tx: Sql) => {
    const rows = await tx<ExecutorRow[]>`
      INSERT INTO executors (
        id, agent_id, provider, transport, pid,
        tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
        claude_session_id, state, metadata, worktree, repo_path, pane_color,
        started_at
      ) VALUES (
        ${id}, ${agentId}, ${provider}, ${transport}, ${opts.pid ?? null},
        ${opts.tmuxSession ?? null}, ${opts.tmuxPaneId ?? null},
        ${opts.tmuxWindow ?? null}, ${opts.tmuxWindowId ?? null},
        ${opts.claudeSessionId ?? null}, ${opts.state ?? 'spawning'},
        ${tx.json((opts.metadata ?? {}) as import('postgres').JSONValue)}, ${opts.worktree ?? null},
        ${opts.repoPath ?? null}, ${opts.paneColor ?? null},
        ${now}
      ) RETURNING *
    `;

    await tx`UPDATE agents SET current_executor_id = ${id} WHERE id = ${agentId}`;

    return rowToExecutor(rows[0]);
  });
}

/** Get an executor by ID. */
export async function getExecutor(id: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`SELECT * FROM executors WHERE id = ${id}`;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Get the current executor for an agent (via agents.current_executor_id). */
export async function getCurrentExecutor(agentId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT e.* FROM executors e
    JOIN agents a ON a.current_executor_id = e.id
    WHERE a.id = ${agentId}
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Update executor state with audit trail. */
export async function updateExecutorState(id: string, state: ExecutorState): Promise<void> {
  const sql = await getConnection();
  const updates: Record<string, unknown> = { state };
  if (state === 'terminated' || state === 'done' || state === 'error') {
    updates.ended_at = new Date().toISOString();
  }
  await sql`UPDATE executors SET ${sql(updates)} WHERE id = ${id}`;

  recordAuditEvent('executor', id, 'state_changed', process.env.GENIE_AGENT_NAME ?? 'cli', {
    state,
  }).catch(() => {});

  // Emit a dedicated ready event when executor reaches 'running' state
  if (state === 'running') {
    recordAuditEvent('executor', id, 'executor.ready', process.env.GENIE_AGENT_NAME ?? 'cli', {
      state,
      readiness_source: 'state_transition',
    }).catch(() => {});
  }
}

/** Terminate an executor: set state='terminated', ended_at=now(). */
export async function terminateExecutor(id: string): Promise<void> {
  const sql = await getConnection();
  const now = new Date().toISOString();
  await sql`
    UPDATE executors
    SET state = 'terminated', ended_at = ${now}
    WHERE id = ${id} AND state NOT IN ('terminated', 'done')
  `;

  recordAuditEvent('executor', id, 'terminated', process.env.GENIE_AGENT_NAME ?? 'cli').catch(() => {});
}

/**
 * Terminate the active executor for an agent and null the FK.
 * Used by the concurrent executor guard before spawning a new one.
 */
export async function terminateActiveExecutor(agentId: string): Promise<void> {
  const sql = await getConnection();

  // Get current executor ID
  const agentRows = await sql`SELECT current_executor_id FROM agents WHERE id = ${agentId}`;
  if (agentRows.length === 0 || !agentRows[0].current_executor_id) return;

  const executorId = agentRows[0].current_executor_id;

  // Terminate the executor
  await terminateExecutor(executorId);

  // Atomic null — only if still pointing to the same executor (prevents race with concurrent spawns)
  await sql`UPDATE agents SET current_executor_id = NULL WHERE id = ${agentId} AND current_executor_id = ${executorId}`;
}

/** List executors, optionally filtered by agent ID and/or metadata source. */
export async function listExecutors(agentId?: string, source?: string): Promise<Executor[]> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors
    WHERE true
    ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
    ${source ? sql`AND metadata->>'source' = ${source}` : sql``}
    ORDER BY started_at DESC
  `;
  return rows.map(rowToExecutor);
}

/** Find executor by tmux pane ID. */
export async function findExecutorByPane(paneId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const normalized = paneId.startsWith('%') ? paneId : `%${paneId}`;
  const rows = await sql<ExecutorRow[]>`SELECT * FROM executors WHERE tmux_pane_id = ${normalized}`;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Find executor by Claude session ID. */
export async function findExecutorBySession(claudeSessionId: string): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors WHERE claude_session_id = ${claudeSessionId} LIMIT 1
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/**
 * Find the latest live executor matching omni metadata.
 * Used for lazy resume: on bridge restart, look up an existing executor
 * for this agent + chat combination so we can reuse its Claude session.
 * Uses the `executors_omni_lookup` partial index (migration 026).
 */
export async function findLatestByMetadata(filter: {
  agentId: string;
  source: string;
  chatId: string;
}): Promise<Executor | null> {
  const sql = await getConnection();
  const rows = await sql<ExecutorRow[]>`
    SELECT * FROM executors
    WHERE agent_id = ${filter.agentId}
      AND metadata->>'source' = ${filter.source}
      AND metadata->>'chat_id' = ${filter.chatId}
      AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows.length > 0 ? rowToExecutor(rows[0]) : null;
}

/** Relink an existing executor to an agent (set current_executor_id FK). */
export async function relinkExecutorToAgent(executorId: string, agentId: string): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE agents SET current_executor_id = ${executorId} WHERE id = ${agentId}`;
}

/** Update the Claude session ID on an executor row. */
export async function updateClaudeSessionId(executorId: string, sessionId: string): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE executors SET claude_session_id = ${sessionId} WHERE id = ${executorId}`;
}

/**
 * Sanitize a filesystem path the same way Claude Code encodes its
 * `~/.claude/projects/<encoded-cwd>/` directory names: every non-alphanumeric
 * char becomes `-`. Kept in this module so the JSONL-fallback below has no
 * cross-module dependency for hotfix scope.
 */
function sanitizeCwdForProjects(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Read the head of a Claude Code session JSONL and pluck the `customTitle`
 * marker. Returns null on parse error, missing file, or no marker. The marker
 * is what teammate sessions set (e.g., `"customTitle": "genie-genie"`) and is
 * the only durable identity link between an agent and its on-disk session.
 */
async function readJsonlCustomTitle(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf-8', 0, bytesRead);
    for (const line of head.split('\n').slice(0, 10)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { customTitle?: unknown; type?: unknown };
        if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
          return entry.customTitle;
        }
      } catch {
        // Ignore malformed lines and keep scanning the head.
      }
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
  return null;
}

/**
 * Resolve the most-recent on-disk Claude session UUID for an agent identified
 * by its `repoPath` (cwd) and optional `customName` (e.g. `"genie-genie"` for
 * the genie teammate of the genie team). The scanner walks
 * `~/.claude/projects/<sanitize(cwd)>/*.jsonl`, optionally filters by the
 * `customTitle` header line, and returns the UUID of the newest matching
 * file. Returns null if no JSONL matches.
 *
 * This is the last-resort recovery path for the bug where `getResumeSessionId`
 * returns `no_executor` after the reconciler nullified `agents.current_executor_id`
 * (e.g., post-host-crash when the executor row got archived) — even though the
 * conversation JSONL is still on disk and `claude --resume <uuid>` would work
 * on it. Without this fallback, every reboot strands teammate work.
 */
export const _resumeJsonlScannerDeps: {
  /** Override for tests — set to null to use the real fs scan. */
  scanForSession: ((cwd: string, customName?: string | null) => Promise<string | null>) | null;
} = { scanForSession: null };

async function defaultScanForSession(cwd: string, customName?: string | null): Promise<string | null> {
  const projectDir = join(homedir(), '.claude', 'projects', sanitizeCwdForProjects(cwd));
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;

  // Stat all candidates in parallel so we can sort by mtime.
  const stats = await Promise.all(
    jsonls.map(async (name) => {
      const full = join(projectDir, name);
      try {
        const s = await stat(full);
        return { name, full, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = stats
    .filter((x): x is { name: string; full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  for (const candidate of sorted) {
    if (customName) {
      const title = await readJsonlCustomTitle(candidate.full);
      if (title !== customName) continue;
    }
    return candidate.name.replace(/\.jsonl$/, '');
  }
  return null;
}

/**
 * Single-reader chokepoint for every resume decision.
 *
 * Joins `agents.current_executor_id → executors.claude_session_id` and emits
 * one of three audit events:
 *   - `resume.found` when a session UUID is available for reuse via the DB path.
 *   - `resume.recovered_via_jsonl` when DB lookup misses but the on-disk JSONL
 *     for the agent's cwd yields a usable session UUID — last-resort recovery
 *     after reconciler-driven `current_executor_id` nullification (the
 *     post-host-crash scenario where the executor row got archived).
 *   - `resume.missing_session` when neither path turns up a session (with
 *     `reason` tagged so operators can tell `no_executor` from `null_session`).
 *
 * Returning `null` is load-bearing: callers that did NOT explicitly request a
 * resume (e.g., fresh spawns) treat `null` as "no prior session → start
 * clean". Callers that DID request a resume should throw a
 * `MissingResumeSessionError` on `null` (see Group 6).
 */
type ResumeRow = {
  executor_id: string | null;
  claude_session_id: string | null;
  repo_path: string | null;
  custom_name: string | null;
};

/**
 * Try the JSONL on-disk fallback for an agent whose DB resume read missed.
 * Returns the recovered session UUID if a matching JSONL is found, or null
 * if no cwd is known or no JSONL matches. Emits `resume.recovered_via_jsonl`
 * on hit.
 */
async function tryJsonlFallback(agentId: string, row: ResumeRow | null, actor: string): Promise<string | null> {
  const cwd = row?.repo_path ?? null;
  if (!cwd) return null;

  const scanner = _resumeJsonlScannerDeps.scanForSession ?? defaultScanForSession;
  const recoveredSessionId = await scanner(cwd, row?.custom_name ?? null);
  if (!recoveredSessionId) return null;

  const reason = row && row.executor_id !== null ? 'null_session' : 'no_executor';
  await recordAuditEvent('agent', agentId, 'resume.recovered_via_jsonl', actor, {
    sessionId: recoveredSessionId,
    executorId: row?.executor_id ?? null,
    cwd,
    customName: row?.custom_name ?? null,
    recoveredFrom: reason,
  });
  return recoveredSessionId;
}

/** Emit the appropriate `resume.missing_session` event when both DB and JSONL miss. */
async function emitMissingSession(agentId: string, row: ResumeRow | null, actor: string): Promise<void> {
  if (row === null || row.executor_id === null) {
    await recordAuditEvent('agent', agentId, 'resume.missing_session', actor, {
      reason: 'no_executor',
    });
    return;
  }
  await recordAuditEvent('agent', agentId, 'resume.missing_session', actor, {
    reason: 'null_session',
    executorId: row.executor_id,
  });
}

export async function getResumeSessionId(agentId: string): Promise<string | null> {
  const sql = await getConnection();
  const rows = await sql<ResumeRow[]>`
    SELECT a.current_executor_id AS executor_id,
           e.claude_session_id,
           a.repo_path,
           a.custom_name
    FROM agents a
    LEFT JOIN executors e ON e.id = a.current_executor_id
    WHERE a.id = ${agentId}
  `;

  const actor = process.env.GENIE_AGENT_NAME ?? 'cli';
  const row = rows[0] ?? null;

  // DB happy path: current executor has a session id.
  if (row && row.executor_id !== null && row.claude_session_id) {
    await recordAuditEvent('agent', agentId, 'resume.found', actor, {
      executorId: row.executor_id,
      sessionId: row.claude_session_id,
    });
    return row.claude_session_id;
  }

  // DB miss — try JSONL fallback when we know the agent's cwd. Reconciler
  // crashes routinely null out `current_executor_id` after pane death, but
  // the conversation JSONL on disk is the durable artifact that
  // `claude --resume <uuid>` actually replays from.
  const recovered = await tryJsonlFallback(agentId, row, actor);
  if (recovered) return recovered;

  // Final miss — no DB session, no JSONL on disk.
  await emitMissingSession(agentId, row, actor);
  return null;
}

/**
 * Record that the provider rejected a resume attempt for a session we believed
 * was live (e.g., Claude CLI refuses the `--resume <uuid>`). Callers invoke
 * this after a failed resume so operators can see the rejection in the audit
 * stream and correlate it with the originating `resume.found` event.
 */
export async function recordResumeProviderRejected(agentId: string, sessionId: string, reason: string): Promise<void> {
  await recordAuditEvent('agent', agentId, 'resume.provider_rejected', process.env.GENIE_AGENT_NAME ?? 'cli', {
    sessionId,
    reason,
  });
}

/**
 * Return an agent's current executor state iff it is live, else null.
 *
 * Used by `genie ls` to determine liveness for non-tmux transports (SDK, omni,
 * process) where `isPaneAlive` cannot apply — these agents carry synthetic pane
 * IDs like 'sdk' or '' that do not match tmux's `%N` format. The `executors.state`
 * column is the authoritative signal, updated by each transport's own heartbeat
 * (e.g., claude-sdk updates it on every message). Returning the state — not just
 * a boolean — lets the caller display it directly without a second query; the
 * cached `agents.state` column is stale for non-tmux transports.
 *
 * Treats `spawning|running|working|idle|permission|question` as live;
 * `done|error|terminated` and missing rows return null.
 */
export async function getLiveExecutorState(agentId: string): Promise<ExecutorState | null> {
  const sql = await getConnection();
  const rows = await sql<{ state: ExecutorState }[]>`
    SELECT e.state FROM executors e
    JOIN agents a ON a.current_executor_id = e.id
    WHERE a.id = ${agentId}
      AND e.state IN ('spawning', 'running', 'working', 'idle', 'permission', 'question')
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].state : null;
}

/** Boolean convenience wrapper around {@link getLiveExecutorState}. */
export async function isExecutorAlive(agentId: string): Promise<boolean> {
  return (await getLiveExecutorState(agentId)) !== null;
}

/**
 * Transport-aware liveness check for a worker row.
 *
 * Dispatches on paneId shape:
 *   - tmux pane (`%N`) → `isPaneAliveFn(paneId)` (authoritative for tmux)
 *   - synthetic id (`sdk`, `inline`, `''`, etc.) → `isExecutorAliveFn(agentId)`
 *     which consults `executors.state` — the live signal for non-tmux transports.
 *
 * Unifies the five parallel call-sites that previously called `isPaneAlive`
 * blindly (PR #1167 + this sweep). Mirrors the `%\d+` regex-guard pattern from
 * `scheduler-daemon.ts:countActiveWorkers` and
 * `term-commands/agents.ts:resolveWorkerLiveness`.
 *
 * Test injection: both `isPaneAliveFn` and `isExecutorAliveFn` are overridable
 * so unit tests can exercise the branch logic without real tmux or PG.
 */
export async function resolveWorkerLivenessByTransport(
  worker: { id: string; paneId: string },
  opts?: {
    isPaneAliveFn?: (paneId: string) => Promise<boolean>;
    isExecutorAliveFn?: (agentId: string) => Promise<boolean>;
  },
): Promise<boolean> {
  if (/^%\d+$/.test(worker.paneId)) {
    const fn =
      opts?.isPaneAliveFn ??
      (async (pane: string) => {
        const { isPaneAlive } = await import('./tmux.js');
        return isPaneAlive(pane);
      });
    return fn(worker.paneId);
  }
  const fn = opts?.isExecutorAliveFn ?? isExecutorAlive;
  return fn(worker.id);
}
