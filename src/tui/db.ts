/**
 * TUI data layer — PG queries (Bun.sql for boot) + LISTEN subscriptions.
 *
 * Stub for Group 2: exports loadAll() and subscribe() shells.
 * Group 3 will implement the actual queries and event subscriptions.
 */

import type { TuiData } from './types.js';

/**
 * Load all data needed for the TUI tree in parallel.
 * Uses Bun.sql for fast boot queries.
 */
export async function loadAll(): Promise<TuiData> {
  // Stub — Group 3 will implement actual PG queries
  return {
    orgs: [],
    projects: [],
    boards: [],
    columns: [],
    tasks: [],
    teams: [],
  };
}

export interface TuiSubscription {
  stop: () => Promise<void>;
}

/**
 * Subscribe to PG runtime events via followRuntimeEvents().
 * Calls onUpdate whenever relevant data changes.
 */
export async function subscribe(onUpdate: (data: TuiData) => void): Promise<TuiSubscription> {
  // Stub — Group 3 will wire up followRuntimeEvents()
  void onUpdate;
  return {
    stop: async () => {},
  };
}
