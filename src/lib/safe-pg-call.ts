/**
 * SafePgCallFn — Structural type for the bridge's PG-guarded call pattern.
 *
 * Extracted from services/executor.ts so that lib/ modules (audit-events,
 * sdk-session-capture) can reference it without a cross-layer import.
 */

import type { Sql } from './db.js';

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
