/**
 * Codex Inbox Deliver Handler — UserPromptSubmit (codex provider only)
 *
 * When a codex agent starts a turn, codex fires `UserPromptSubmit` through
 * the genie hook bridge (configured per-host by `injectCodexHooks` in
 * src/hooks/codex-inject.ts). This handler reads the agent's pending mailbox
 * rows from PostgreSQL, marks them read, and returns the rendered channel
 * envelopes as `additionalContext` so codex injects them into the model
 * input for that turn.
 *
 * This replaces tmux send-keys for engineer-driven codex sends — the hook
 * fires before every turn, so any message persisted to the mailbox between
 * turns surfaces on the next turn without polling, file watchers, or pane
 * injection (the equivalent of native-team inbox JSON files for claude).
 *
 * Resolution:
 *   - agent name from `GENIE_AGENT_NAME` (set by spawn) or payload.teammate_name
 *   - team from `GENIE_TEAM` or payload.team_name
 *   - lookup in `agents` table with provider === 'codex'; non-codex agents skip
 *   - mailbox query uses every key the agent might be addressed by (id, role,
 *     custom_name) to match how `mailbox.send` writes `to_worker` (varies by
 *     delivery path — see `src/lib/protocol-router.ts`).
 *
 * Timeout: 500ms hard cap on the read-only PG lookup. Codex's hook timeout is
 * 15s, but we want sub-second so a slow DB never stalls a turn — bail with
 * empty additionalContext on timeout (no delivery this turn, message stays
 * unread, next turn retries). The timeout never races the mark-read write; once
 * we start mutating mailbox rows we wait for the result and return the context
 * in the same turn.
 *
 * Mark-read semantics: marked read BEFORE returning. If the mark fails, we
 * bail with no delivery (better to miss a turn than double-inject after a
 * partial PG failure). The same row never delivers twice because the next
 * `UserPromptSubmit` reads `read = false` only.
 *
 * Priority: 25 — runs after `runtime-emit-user-prompt` (30) and before
 * `session-sync-prompt` (35). Ordering is cosmetic for additionalContext
 * (handlers are independent), but earlier priorities should not depend on
 * the mailbox state.
 */

import { formatEnvelope } from '../../lib/channel-envelope.js';
import type { MailboxMessage } from '../../lib/mailbox.js';
import { readEnvAgentId, readEnvAgentName } from '../env-identity.js';
import type { HandlerResult, HookPayload } from '../types.js';

/** Hard timeout for the PG query — codex hook budget is 15s; we want sub-second. */
const QUERY_TIMEOUT_MS = 500;

/**
 * Minimal agent shape required for routing — keeps the dep contract narrow
 * so tests can inject plain objects without faking the full Agent type.
 */
export interface CodexAgentRef {
  id: string;
  role?: string;
  customName?: string;
  repoPath: string;
  provider?: string;
}

type FindCodexAgentFn = (name: string, team?: string) => Promise<CodexAgentRef | null>;
type FetchUnreadFn = (repoPath: string, workerKeys: string[]) => Promise<MailboxMessage[]>;
type MarkReadBatchFn = (messageIds: string[]) => Promise<number>;

interface PendingDelivery {
  unread: MailboxMessage[];
  markReadBatch: MarkReadBatchFn;
}

/**
 * Overridable deps for testing (mirrors the session-sync pattern). When left
 * null, the handler lazy-imports the real modules at call time.
 */
export const _deps: {
  findCodexAgent: FindCodexAgentFn | null;
  fetchUnread: FetchUnreadFn | null;
  markReadBatch: MarkReadBatchFn | null;
} = {
  findCodexAgent: null,
  fetchUnread: null,
  markReadBatch: null,
};

async function resolveDeps(): Promise<{
  findCodexAgent: FindCodexAgentFn;
  fetchUnread: FetchUnreadFn;
  markReadBatch: MarkReadBatchFn;
}> {
  return {
    findCodexAgent: _deps.findCodexAgent ?? defaultFindCodexAgent,
    fetchUnread: _deps.fetchUnread ?? defaultFetchUnread,
    markReadBatch: _deps.markReadBatch ?? defaultMarkReadBatch,
  };
}

async function defaultFindCodexAgent(name: string, team?: string): Promise<CodexAgentRef | null> {
  // Wish retire-session-names-id-only G4: route the codex agent lookup
  // through the canonical resolver. The provider/team filters stay at this
  // call site (the resolver is provider-agnostic), but the name → id step
  // moves into agent-registry where audit + tier counters live.
  const registry = await import('../../lib/agent-registry.js');
  const id = await registry.resolveAgentId(name, team);
  if (!id) return null;
  const matched = await registry.get(id);
  if (!matched || matched.provider !== 'codex') return null;
  if (team && matched.team && matched.team !== team) return null;
  return {
    id: matched.id,
    role: matched.role,
    customName: matched.customName,
    repoPath: matched.repoPath,
    provider: matched.provider,
  };
}

async function defaultFetchUnread(repoPath: string, workerKeys: string[]): Promise<MailboxMessage[]> {
  const mailbox = await import('../../lib/mailbox.js');
  return mailbox.getUnread(repoPath, workerKeys);
}

async function defaultMarkReadBatch(messageIds: string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  const { getConnection } = await import('../../lib/db.js');
  const sql = await getConnection();
  const result = await sql`UPDATE mailbox SET read = true WHERE id = ANY(${messageIds}) RETURNING id`;
  return result.length;
}

/** Race a promise against a timer; resolves to `fallback` if the promise loses. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Build the union of identifiers a codex worker may be addressed by in mailbox. */
function workerKeysFor(agent: CodexAgentRef, fallback: string): string[] {
  const keys = new Set<string>();
  keys.add(agent.id);
  if (agent.role) keys.add(agent.role);
  if (agent.customName) keys.add(agent.customName);
  // Fallback covers the case where GENIE_AGENT_NAME was used to address the
  // worker but doesn't match any registry field (e.g., legacy bare-name rows
  // that the mailbox sender still references verbatim).
  keys.add(fallback);
  return [...keys].filter((k) => typeof k === 'string' && k.length > 0);
}

function resolveContext(payload: HookPayload): { agentName: string; teamName?: string } | null {
  const hasOverrides = Object.values(_deps).some((v) => v !== null);
  // In test envs (without explicit deps) the dispatcher must not block on PG.
  if (!hasOverrides && (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test')) return null;

  // Prefer GENIE_AGENT_ID (UUID) — `defaultFindCodexAgent` routes through
  // `resolveAgentId`, whose Tier 1 (exact id) short-circuits on a UUID input
  // without touching the customName/role fuzz tiers. Falls through to
  // GENIE_AGENT_NAME / payload.teammate_name when the env id is unset or
  // non-UUID.
  const agentName = readEnvAgentId() ?? readEnvAgentName() ?? (payload.teammate_name as string | undefined);
  if (!agentName) return null;
  const teamName = process.env.GENIE_TEAM ?? (payload.team_name as string | undefined);
  return { agentName, teamName };
}

/**
 * Read pending mailbox messages without mutating state. This promise may still
 * complete after `withTimeout` returns, so it must stay read-only.
 */
async function loadPendingMessages(agentName: string, teamName?: string): Promise<PendingDelivery | null> {
  const deps = await resolveDeps();
  const agent = await deps.findCodexAgent(agentName, teamName);
  if (!agent || agent.provider !== 'codex') return null;

  const keys = workerKeysFor(agent, agentName);
  const unread = await deps.fetchUnread(agent.repoPath, keys);
  if (unread.length === 0) return null;

  return { unread, markReadBatch: deps.markReadBatch };
}

/**
 * Mark the loaded rows read and render them into a single newline-joined block
 * of channel envelopes. Returns `null` when the mark-read guard fails.
 */
async function deliverPendingMessages(pending: PendingDelivery): Promise<string | null> {
  // Atomic batch mark-read BEFORE returning the body. Failure here means we
  // skip delivery this turn rather than risk double-injection on the next.
  const ids = pending.unread.map((m) => m.id);
  const updated = await pending.markReadBatch(ids);
  if (updated === 0) return null;

  const envelopes = pending.unread.map((m) =>
    formatEnvelope({ source: m.source, from: m.from, meta: m.meta, body: m.body }),
  );
  return envelopes.join('\n');
}

export async function codexInboxDeliver(payload: HookPayload): Promise<HandlerResult> {
  const ctx = resolveContext(payload);
  if (!ctx) return;

  try {
    const pending = await withTimeout(loadPendingMessages(ctx.agentName, ctx.teamName), QUERY_TIMEOUT_MS, null);
    if (!pending) return;

    const additionalContext = await deliverPendingMessages(pending);
    if (!additionalContext) return;

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[codex-inbox-deliver] ${msg}`);
    return;
  }
}
