/**
 * World B executor interface — TRANSITIONAL, targeted for removal.
 *
 * TODO(unified-executor-layer): Replace OmniSession with World A's Executor
 * type from lib/executor-types.ts. This requires the bridge's SessionEntry to
 * store an Executor row instead of OmniSession, and spawn() to return Executor.
 * Once done, IExecutor collapses into ExecutorProvider and this file is deleted.
 */

// SafePgCallFn relocated to lib/safe-pg-call.ts — re-export for back-compat.
export type { SafePgCallFn } from '../lib/safe-pg-call.js';

/** Opaque session handle returned by spawn(). TODO: replace with Executor from lib/executor-types. */
export interface OmniSession {
  id: string;
  agentName: string;
  chatId: string;
  tmuxSession: string;
  tmuxWindow: string;
  paneId: string;
  createdAt: number;
  lastActivityAt: number;
}

/** Inbound message from Omni via NATS. */
export interface OmniMessage {
  content: string;
  sender: string;
  instanceId: string;
  chatId: string;
  agent: string;
  timestamp?: string;
}

/** Pluggable executor backend for the Omni bridge. TODO: merge into ExecutorProvider. */
export interface IExecutor {
  spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<OmniSession>;
  deliver(session: OmniSession, message: OmniMessage): Promise<void>;
  shutdown(session: OmniSession): Promise<void>;
  isAlive(session: OmniSession): Promise<boolean>;
  setSafePgCall(fn: import('../lib/safe-pg-call.js').SafePgCallFn): void;
  /** Inject a nudge message into an active session (for turn timeout warnings). */
  injectNudge(session: OmniSession, text: string): Promise<void>;
}
