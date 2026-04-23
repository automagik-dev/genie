#!/usr/bin/env bun
/**
 * reconcile-orphans — one-shot cleanup script for the turn-session contract.
 *
 * Wish: turn-session-contract (Group 7). Before the new reconciler ships
 * (Group 4) and before the default-flip lands (Group 8), the agents table
 * can contain rows whose tmux pane is long dead but whose state never
 * reached a terminal value. The legacy reconciler would happily resume
 * those rows, producing ghost loops.
 *
 * This script terminalizes orphans in a single one-shot pass. It is the
 * manual step wedged between Phase A (schema) and Phase B (default flip)
 * of the staged migration — see DESIGN.md D7.
 *
 * Candidate predicate (all must hold):
 *   • agents.state IS NOT NULL                    — skip identity-only rows
 *   • agents.state NOT IN (done,error,suspended)  — already-terminal rows are left alone
 *   • agents.last_state_change < now() - 1 hour   — never touch recently-active rows
 *   • pane is gone: pane_id is NULL, the empty
 *     string, 'inline', or !isPaneAlive(pane_id)  — live panes are spared
 *
 * Default mode is --dry-run. --apply writes, and requires the operator
 * to type `I UNDERSTAND` on stdin as an interlock.
 *
 * Each terminalized row emits `reconcile.terminalize` to audit_events
 * with {state_before, pane_id, reason} so the audit trail is complete.
 *
 * Idempotent: a second run finds zero candidates because the previous
 * run moved them all to state='error'.
 */

import { createInterface } from 'node:readline/promises';
import { type Sql, getConnection } from '../src/lib/db.js';
import { isPaneAlive as tmuxIsPaneAlive } from '../src/lib/tmux.js';

export type PaneAliveFn = (paneId: string) => Promise<boolean>;

export interface OrphanRow {
  id: string;
  state: string;
  paneId: string | null;
  lastStateChange: string;
}

export interface Candidate extends OrphanRow {
  action: 'terminalize';
  reason: string;
}

export interface ReconcileOptions {
  apply: boolean;
  /** Override for tests. Defaults to the real tmux probe. */
  isPaneAlive?: PaneAliveFn;
  /**
   * Provides the typed confirmation for --apply. Defaults to reading
   * from stdin. Tests can pass a pre-supplied string.
   */
  readConfirmation?: () => Promise<string>;
  /** Audit actor. Defaults to env GENIE_AGENT_NAME or 'reconcile-orphans'. */
  actor?: string;
  /** Optional logger. Defaults to console.log. */
  log?: (line: string) => void;
}

export interface ReconcileResult {
  mode: 'dry-run' | 'apply';
  candidates: Candidate[];
  terminalized: number;
  aborted: boolean;
}

const CONFIRMATION_PHRASE = 'I UNDERSTAND';
const TERMINAL_STATES = ['done', 'error', 'suspended'];
const DEAD_PANE_SENTINELS = new Set(['', 'inline']);

interface AgentQueryRow {
  id: string;
  state: string;
  pane_id: string | null;
  last_state_change: Date | string;
}

/**
 * Select agents rows matching the coarse predicates (state, age). The
 * finer pane-liveness check happens in TypeScript so we can stub it
 * cleanly from tests.
 */
async function loadCandidateRows(sql: Sql): Promise<AgentQueryRow[]> {
  return sql<AgentQueryRow[]>`
    SELECT id, state, pane_id, last_state_change
    FROM agents
    WHERE state IS NOT NULL
      AND state NOT IN ('done', 'error', 'suspended')
      AND last_state_change < now() - interval '1 hour'
    ORDER BY last_state_change ASC
  `;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * Determine whether a row is orphan-eligible based on its pane. A row is
 * orphan when the pane is NULL, an inline sentinel, or not alive under tmux.
 * Returns a human-readable reason explaining why the row qualified.
 */
async function paneVerdict(paneId: string | null, alive: PaneAliveFn): Promise<{ orphan: boolean; reason: string }> {
  if (paneId === null) return { orphan: true, reason: 'pane_id IS NULL' };
  if (DEAD_PANE_SENTINELS.has(paneId)) return { orphan: true, reason: `pane_id='${paneId}'` };
  try {
    const ok = await alive(paneId);
    if (ok) return { orphan: false, reason: `pane_id=${paneId} is alive` };
    return { orphan: true, reason: `pane_id=${paneId} dead` };
  } catch (err) {
    // tmux server unreachable — be conservative, skip this row.
    const msg = err instanceof Error ? err.message : String(err);
    return { orphan: false, reason: `tmux unreachable: ${msg}` };
  }
}

export async function findOrphans(opts: { isPaneAlive?: PaneAliveFn } = {}): Promise<Candidate[]> {
  const alive = opts.isPaneAlive ?? tmuxIsPaneAlive;
  const sql = await getConnection();
  const rows = await loadCandidateRows(sql);
  const out: Candidate[] = [];
  for (const r of rows) {
    const verdict = await paneVerdict(r.pane_id, alive);
    if (!verdict.orphan) continue;
    out.push({
      id: r.id,
      state: r.state,
      paneId: r.pane_id,
      lastStateChange: toIso(r.last_state_change),
      action: 'terminalize',
      reason: verdict.reason,
    });
  }
  return out;
}

/**
 * Terminalize a set of candidates inside a single transaction per row.
 * We do one transaction per row (not one for the whole batch) so a
 * single failing row cannot block the rest — this matches the
 * "idempotent one-shot" contract.
 *
 * Returns the number of rows actually updated (skips rows that changed
 * state between the find and the apply step, which is the idempotency
 * guarantee).
 */
export async function terminalizeOrphans(candidates: Candidate[], actor: string): Promise<number> {
  const sql = await getConnection();
  let changed = 0;
  for (const c of candidates) {
    await sql.begin(async (tx: Sql) => {
      const rows = await tx<{ state: string | null }[]>`
        SELECT state FROM agents WHERE id = ${c.id} FOR UPDATE
      `;
      if (rows.length === 0) return;
      const current = rows[0].state;
      if (current === null || TERMINAL_STATES.includes(current)) {
        // Another writer terminalized between find and apply — idempotent skip.
        return;
      }
      await tx`
        UPDATE agents
        SET state = 'error',
            last_state_change = now()
        WHERE id = ${c.id}
      `;
      await tx`
        INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
        VALUES (
          'agent',
          ${c.id},
          'reconcile.terminalize',
          ${actor},
          ${tx.json({ state_before: current, pane_id: c.paneId, reason: c.reason })}
        )
      `;
      changed += 1;
    });
  }
  return changed;
}

function formatTable(candidates: Candidate[]): string {
  if (candidates.length === 0) return '(no orphans)';
  const header = ['id', 'state', 'pane_id', 'last_state_change', 'action'];
  const rows = candidates.map((c) => [c.id, c.state, c.paneId ?? '∅', c.lastStateChange, `${c.action} (${c.reason})`]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

async function readStdinLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const line = await rl.question(`Type "${CONFIRMATION_PHRASE}" to continue: `);
  rl.close();
  return line;
}

export async function run(opts: ReconcileOptions): Promise<ReconcileResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const actor = opts.actor ?? process.env.GENIE_AGENT_NAME ?? 'reconcile-orphans';
  const candidates = await findOrphans({ isPaneAlive: opts.isPaneAlive });

  log(`reconcile-orphans: ${candidates.length} orphan candidate(s)`);
  log(formatTable(candidates));

  if (!opts.apply) {
    log('');
    log('Mode: --dry-run. Re-run with --apply to terminalize these rows.');
    return { mode: 'dry-run', candidates, terminalized: 0, aborted: false };
  }

  if (candidates.length === 0) {
    log('');
    log('Nothing to apply.');
    return { mode: 'apply', candidates, terminalized: 0, aborted: false };
  }

  const readConfirmation = opts.readConfirmation ?? readStdinLine;
  const typed = (await readConfirmation()).trim();
  if (typed !== CONFIRMATION_PHRASE) {
    log('');
    log(`Aborted: confirmation mismatch (expected exact "${CONFIRMATION_PHRASE}").`);
    return { mode: 'apply', candidates, terminalized: 0, aborted: true };
  }

  const terminalized = await terminalizeOrphans(candidates, actor);
  log('');
  log(`reconcile-orphans: terminalized ${terminalized}/${candidates.length} row(s).`);
  return { mode: 'apply', candidates, terminalized, aborted: false };
}

// ============================================================================
// CLI entry — flags-before-positionals, defensive parsing.
// ============================================================================

export function parseCliArgs(argv: string[]): { apply: boolean; help: boolean; unknown: string[] } {
  let apply = false;
  let help = false;
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--help' || arg === '-h') help = true;
    else unknown.push(arg);
  }
  return { apply, help, unknown };
}

const HELP = `Usage: bun run scripts/reconcile-orphans.ts [--dry-run|--apply]

  --dry-run   Print candidates without writing (default).
  --apply     Terminalize orphans after typed confirmation.

Terminalizes agents rows whose tmux pane is dead and whose state has
been idle for > 1 hour. Idempotent. See scripts/reconcile-orphans.ts
header for the full predicate.`;

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.unknown.length > 0) {
    console.error(`reconcile-orphans: unknown arg(s): ${args.unknown.join(', ')}`);
    console.error(HELP);
    process.exit(2);
  }
  try {
    const result = await run({ apply: args.apply });
    if (result.aborted) process.exit(1);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`reconcile-orphans: ${msg}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
