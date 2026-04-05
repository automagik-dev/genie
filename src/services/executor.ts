/**
 * IExecutor — Executor interface for the Omni bridge.
 *
 * Simpler than the internal ExecutorProvider: this interface is what
 * the NATS bridge uses to spawn/manage agent sessions per chat.
 * Claude Code tmux is the first implementation. Claude SDK (1 process,
 * N chats) is the scaling path.
 *
 * The executor is stateless — Genie (omni-bridge) manages session
 * lifecycle, idle timeouts, and concurrency limits. The executor
 * just runs agents.
 */

import type { Sql } from '../lib/db.js';

// ============================================================================
// Types
// ============================================================================

/** Opaque session handle returned by spawn(). */
export interface OmniSession {
  /** Unique session key (typically `${agentName}:${chatId}`). */
  id: string;
  /** Agent name (from genie directory). */
  agentName: string;
  /** Chat ID from Omni (WhatsApp thread). */
  chatId: string;
  /** Tmux session name hosting this window. */
  tmuxSession: string;
  /** Tmux window name. */
  tmuxWindow: string;
  /** Tmux pane ID (e.g., "%5"). */
  paneId: string;
  /** Timestamp of session creation. */
  createdAt: number;
  /** Timestamp of last message delivered. */
  lastActivityAt: number;
}

/** Inbound message from Omni via NATS. */
export interface OmniMessage {
  content: string;
  sender: string;
  /** Omni instance ID. */
  instanceId: string;
  /** Chat/thread ID. */
  chatId: string;
  /** Agent role to route to. */
  agent: string;
  /** ISO timestamp. */
  timestamp?: string;
}

/**
 * Bound `safePgCall` injected by the bridge into each executor after construction.
 *
 * Mirror of `OmniBridge#safePgCall` — declared here as a structural type so
 * executors can call it without importing `OmniBridge` (avoids a circular
 * dependency between the bridge and its own executors). Tests pass a plain
 * function; production wires `bridge.safePgCall.bind(bridge)`.
 */
export type SafePgCallFn = <T>(
  op: string,
  fn: (sql: Sql) => Promise<T>,
  fallback: T,
  ctx?: { executorId?: string; chatId?: string },
) => Promise<T>;

// ============================================================================
// Interface
// ============================================================================

/**
 * IExecutor — pluggable executor backend for the Omni bridge.
 *
 * Each executor type handles reply routing its own way but always
 * publishes to `omni.reply.{instance}.{chat_id}`.
 */
export interface IExecutor {
  /** Spawn an agent session for a chat. */
  spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<OmniSession>;

  /** Deliver a message to an already-running session. */
  deliver(session: OmniSession, message: OmniMessage): Promise<void>;

  /** Shut down a session (kill tmux window). */
  shutdown(session: OmniSession): Promise<void>;

  /** Check if a session is still alive. */
  isAlive(session: OmniSession): Promise<boolean>;

  /**
   * Inject the bridge's `safePgCall` helper. Called by `OmniBridge#start()`
   * after the PG probe so that World A registry writes are guarded by the
   * same pgAvailable / connection-loss logic as the rest of the bridge.
   */
  setSafePgCall(fn: SafePgCallFn): void;
}
