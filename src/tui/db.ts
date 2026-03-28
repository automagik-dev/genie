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

// subscribe() for LISTEN/NOTIFY events added by Group 3.
