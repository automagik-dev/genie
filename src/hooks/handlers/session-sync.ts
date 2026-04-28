/**
 * Session Sync Handler — PreToolUse (all tools) + UserPromptSubmit
 *
 * PTY-backed Claude sessions rotate their session_id whenever Claude Code
 * decides (resume, compaction, internal fork). The executor row created at
 * spawn keeps the ORIGINAL session_id, which means `genie resume` replays a
 * stale transcript against whatever `--resume <id>` Claude Code still
 * recognizes — the trace in task #6 showed this as the primary cause of
 * stale-resume bugs.
 *
 * This handler keeps `executors.claude_session_id` in sync with whatever
 * Claude Code is currently using by reading the live `payload.session_id`
 * from every hook invocation, and emits a `session.reconciled` audit event
 * whenever the stored UUID actually changes (loop 2 Gap 2).
 *
 * Priority: 35 (runs after runtime-emit so event-log still sees the old ID
 * if anyone later wants to reconstruct the rotation timeline).
 *
 * Must never throw — PreToolUse is a blocking event, so a crash would
 * deny the tool use.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HandlerResult, HookPayload } from '../types.js';

/**
 * Cache: executorId → last session_id we've reconciled.
 *
 * Mac-CPU fix E — the cache now has TWO layers: process-local (Map) +
 * disk-backed (~/.genie/cache/session-sync.json). Every `genie hook dispatch`
 * is a fresh `bun` fork, so the in-memory Map alone caches nothing across
 * forks. Disk-loading on first hit means a cold-start hook fork skips its
 * 3 DB round-trips (getAgentByName + getExecutor + audit) when the
 * (executorId, sessionId) pair is already-reconciled.
 *
 * Concurrency: writes are atomic (write-temp + rename). Two forks racing on
 * the rename can lose the loser's update for OTHER executor entries —
 * benign: worst case is occasional redundant DB syncs from later forks.
 */
const syncedSessions = new Map<string, string>();

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const DEFAULT_CACHE_FILE = join(GENIE_HOME, 'cache', 'session-sync.json');

let diskCacheLoaded = false;

function effectiveCacheFile(): string {
  // Test override — see _setCacheFileForTest.
  // biome-ignore lint/suspicious/noExplicitAny: test override
  const override = (globalThis as Record<string, any>).__GENIE_SESSION_SYNC_CACHE_FILE as string | null | undefined;
  return typeof override === 'string' && override.length > 0 ? override : DEFAULT_CACHE_FILE;
}

function loadDiskCache(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const cacheFile = effectiveCacheFile();
    if (!existsSync(cacheFile)) return;
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, string>;
    for (const [executorId, sessionId] of Object.entries(parsed)) {
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        syncedSessions.set(executorId, sessionId);
      }
    }
  } catch {
    // Corrupt or unreadable — fall back to empty cache (DB still authoritative).
  }
}

/**
 * Trim in-memory cache to MAX_CACHE_ENTRIES if it grows large. Removes the
 * oldest insertion-order entries (Map preserves insertion order). Bounded
 * size prevents the cache file from growing unboundedly across weeks of use.
 */
const MAX_CACHE_ENTRIES = 1000;
function trimCache(): void {
  while (syncedSessions.size > MAX_CACHE_ENTRIES) {
    const oldest = syncedSessions.keys().next().value;
    if (oldest === undefined) break;
    syncedSessions.delete(oldest);
  }
}

function persistDiskCache(): void {
  try {
    const cacheFile = effectiveCacheFile();
    mkdirSync(join(cacheFile, '..'), { recursive: true });
    trimCache();
    const obj = Object.fromEntries(syncedSessions);
    const tmp = `${cacheFile}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, cacheFile);
  } catch {
    // Best-effort — in-memory cache still works for the current process.
  }
}

/** Exposed for tests — clear in-memory cache + force disk reload on next call. */
export function _resetSyncedSessions(): void {
  syncedSessions.clear();
  diskCacheLoaded = false;
}

/** Exposed for tests — override the cache file path. Pass null to restore default. */
export function _setCacheFileForTest(path: string | null): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only writable cache path override
  (globalThis as Record<string, any>).__GENIE_SESSION_SYNC_CACHE_FILE = path;
}

type GetAgentByNameFn = (
  name: string,
  team: string,
) => Promise<{ id?: string; currentExecutorId?: string | null } | null>;
type GetExecutorFn = (id: string) => Promise<{ claudeSessionId?: string | null; state?: string | null } | null>;
type UpdateClaudeSessionIdFn = (executorId: string, sessionId: string) => Promise<void>;
type EmitAuditEventFn = (
  entityType: string,
  entityId: string,
  eventType: string,
  actor: string | null,
  details: Record<string, unknown>,
) => Promise<void>;

/**
 * Overridable deps for testing. When left null, the handler lazy-imports the
 * real modules at call time. Tests that want to assert on emitted audit
 * events install a mock `emitAuditEvent` (and peers) via these fields and
 * reset them in `afterEach`.
 */
export const _deps: {
  getAgentByName: GetAgentByNameFn | null;
  getExecutor: GetExecutorFn | null;
  updateClaudeSessionId: UpdateClaudeSessionIdFn | null;
  emitAuditEvent: EmitAuditEventFn | null;
} = {
  getAgentByName: null,
  getExecutor: null,
  updateClaudeSessionId: null,
  emitAuditEvent: null,
};

async function resolveDeps() {
  const [agentMod, execMod, audit] = await Promise.all([
    _deps.getAgentByName ? null : import('../../lib/agent-registry.js'),
    _deps.getExecutor && _deps.updateClaudeSessionId ? null : import('../../lib/executor-registry.js'),
    _deps.emitAuditEvent ? null : import('../../lib/audit.js'),
  ]);
  return {
    getAgentByName: _deps.getAgentByName ?? (agentMod as typeof import('../../lib/agent-registry.js')).getAgentByName,
    getExecutor: _deps.getExecutor ?? (execMod as typeof import('../../lib/executor-registry.js')).getExecutor,
    updateClaudeSessionId:
      _deps.updateClaudeSessionId ?? (execMod as typeof import('../../lib/executor-registry.js')).updateClaudeSessionId,
    emitAuditEvent: _deps.emitAuditEvent ?? (audit as typeof import('../../lib/audit.js')).recordAuditEvent,
  };
}

function shouldSkipSync(payload: HookPayload): { sessionId: string; agentName: string; teamName: string } | null {
  const sessionId = payload.session_id;
  if (!sessionId || typeof sessionId !== 'string') return null;

  const hasOverrides = Object.values(_deps).some((v) => v !== null);
  if (!hasOverrides && (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test')) return null;

  const agentName = process.env.GENIE_AGENT_NAME ?? (payload.teammate_name as string | undefined);
  const teamName = process.env.GENIE_TEAM ?? (payload.team_name as string | undefined);
  if (!agentName || !teamName) return null;

  return { sessionId, agentName, teamName };
}

/**
 * Executor states that mean "this row is frozen" — reached the end of its
 * lifecycle and is now a recovery anchor (the session UUID it stores is what
 * `claude --resume <uuid>` will replay). When session-sync sees the current
 * executor in one of these states AND the live `payload.session_id` differs
 * from what the row already holds, it MUST NOT overwrite — that destroys the
 * recovery anchor. This is the single bug that ate the genie/genie session
 * during the 2026-04-25 power-outage recovery: a manual re-link to a
 * terminated executor (holding the dormant UUID) was silently overwritten by
 * the next session-sync fire in the live process, replacing the dormant UUID
 * with the live one and orphaning the recovery anchor.
 */
const TERMINAL_EXECUTOR_STATES = new Set(['done', 'error', 'terminated']);

export async function sessionSync(payload: HookPayload): Promise<HandlerResult> {
  try {
    const ctx = shouldSkipSync(payload);
    if (!ctx) return;

    // Mac-CPU fix E — disk cache lookup happens BEFORE any DB call so a
    // cold-start hook fork can short-circuit on already-reconciled pairs
    // without touching PG (was 3 round-trips per hook fork before).
    loadDiskCache();

    const deps = await resolveDeps();
    const agent = await deps.getAgentByName(ctx.agentName, ctx.teamName);
    const executorId = agent?.currentExecutorId;
    if (!executorId) return;
    if (syncedSessions.get(executorId) === ctx.sessionId) return;

    const executor = await deps.getExecutor(executorId);
    if (!executor) return;

    const oldSessionId = executor.claudeSessionId ?? null;
    if (oldSessionId === ctx.sessionId) {
      syncedSessions.set(executorId, ctx.sessionId);
      persistDiskCache();
      return;
    }

    // Divergence detected. Two cases:
    //   1. First capture (oldSessionId === null) → write live session_id.
    //   2. Rotation while executor is still active (Claude Code rotates UUIDs
    //      on resume / compaction) → overwrite is the original purpose of
    //      this handler (`session.reconciled`).
    //   3. Stored session != live session AND the executor row is in a
    //      terminal state → the row is a frozen recovery anchor. Overwriting
    //      it destroys recovery information. Skip the write, emit a
    //      `session.divergence_preserved` audit event for visibility, and
    //      cache to suppress audit-event spam on subsequent hook fires.
    const isTerminal = TERMINAL_EXECUTOR_STATES.has(executor.state ?? '');
    if (oldSessionId !== null && isTerminal) {
      await deps.emitAuditEvent('executor', executorId, 'session.divergence_preserved', ctx.agentName, {
        stored_session_id: oldSessionId,
        live_session_id: ctx.sessionId,
        executor_state: executor.state ?? null,
        team: ctx.teamName,
        reason: 'terminal_executor_is_recovery_anchor',
      });
      syncedSessions.set(executorId, ctx.sessionId);
      persistDiskCache();
      return;
    }

    // First-capture or active-state rotation — safe to overwrite.
    await deps.updateClaudeSessionId(executorId, ctx.sessionId);
    await deps.emitAuditEvent('executor', executorId, 'session.reconciled', ctx.agentName, {
      old_session_id: oldSessionId,
      new_session_id: ctx.sessionId,
      team: ctx.teamName,
    });
    syncedSessions.set(executorId, ctx.sessionId);
    persistDiskCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[session-sync] ${msg}`);
  }
  return;
}
