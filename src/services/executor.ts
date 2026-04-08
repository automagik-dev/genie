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

/** Transport-agnostic session handle returned by spawn(). */
export interface ExecutorSession {
  id: string;
  agentName: string;
  chatId: string;
  executorType: 'tmux' | 'sdk';
  createdAt: number;
  lastActivityAt: number;
  tmux?: { session: string; window: string; paneId: string };
  sdk?: { claudeSessionId?: string; executorId?: string };
}

/**
 * @deprecated Use `ExecutorSession` instead. Will be removed in a future release.
 */
export type OmniSession = ExecutorSession;

/** Inbound message from Omni via NATS. */
export interface OmniMessage {
  content: string;
  sender: string;
  instanceId: string;
  chatId: string;
  agent: string;
  timestamp?: string;
}

/** Callback for publishing NATS reply messages in-process (replaces subprocess fork). */
export type NatsPublishFn = (topic: string, payload: string) => void;

/** Pluggable executor backend for the Omni bridge. TODO: merge into ExecutorProvider. */
export interface IExecutor {
  spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<ExecutorSession>;
  deliver(session: ExecutorSession, message: OmniMessage): Promise<void>;
  shutdown(session: ExecutorSession): Promise<void>;
  isAlive(session: ExecutorSession): Promise<boolean>;
  setSafePgCall(fn: import('../lib/safe-pg-call.js').SafePgCallFn): void;
  /** Inject NATS publish function for in-process reply delivery. */
  setNatsPublish(fn: NatsPublishFn): void;
  /** Inject a nudge message into an active session (for turn timeout warnings). */
  injectNudge(session: ExecutorSession, text: string): Promise<void>;
}
