/**
 * genie orca — write genie's lifecycle onto the Orca workspace card, one way.
 *
 *   orca mirror --to <transition> [--verdict <verdict>] --evidence <text>
 *               [--worktree <selector>]
 *
 * One verb, because the map has to be code rather than four prose recipes, and
 * because the card must have exactly one writer. The transition → status map
 * and the comment format live in `../lib/orca-lifecycle-mirror.js` (pure, no
 * I/O); the spawn, the receipt and the `worktree show` read-back belong to the
 * closed adapter in `../lib/orca-orchestration-adapter.js`. This module is the
 * seam between them and nothing else.
 *
 * Nothing here reads Orca: a board status is never lifecycle truth, and there
 * is no verb that brings one back. The documents stay the record.
 *
 * Exit codes are the contract:
 *   0 — the write is proven (receipt identity plus the official read-back).
 *   1 — a typed adapter failure; stderr carries one JSON line naming the code,
 *       the phase, the retry safety and the recovery the adapter prescribes.
 *   2 — usage: a refused input, or a selector outside the adapter's grammar.
 */

import type { Command } from 'commander';
import {
  GENIE_TRANSITIONS,
  MirrorInputError,
  REVIEW_VERDICTS,
  mirrorTransition,
} from '../lib/orca-lifecycle-mirror.js';
import {
  OrcaAdapterError,
  type OrcaAdapterResponse,
  type OrcaOrchestrationAdapter,
  createOrcaOrchestrationAdapter,
} from '../lib/orca-orchestration-adapter.js';
import { printErr, printOut } from '../lib/term-output.js';

export interface MirrorCommandOptions {
  to: string;
  verdict?: string;
  evidence: string;
  worktree?: string;
}

export interface MirrorCommandDeps {
  /** The caller's clock as `YYYY-MM-DD`; production reads UTC. */
  today?: () => string;
  /** The adapter factory; production builds the real one. */
  createAdapter?: () => OrcaOrchestrationAdapter;
}

/** UTC, because a card comment is read by people in more than one timezone. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Exit codes: 0 a proven write, 1 a typed Orca failure, 2 the caller's own input. */
export type MirrorExitCode = 0 | 1 | 2;

function failUsage(reason: string): MirrorExitCode {
  printErr(`Error (genie orca mirror): ${reason}`);
  return 2;
}

/**
 * `invalid_argument` raised while VALIDATING is the caller's own input — a
 * selector outside the closed grammar — so it exits 2 with the reason, exactly
 * like a refused transition. Every other adapter failure is Orca's, and it
 * leaves as one machine-readable line so a coordinator can route it without
 * parsing prose.
 */
function failAdapter(error: OrcaAdapterError): MirrorExitCode {
  if (error.code === 'invalid_argument' && error.phase === 'validate') return failUsage(error.message);
  printErr(
    JSON.stringify({
      error: error.code,
      operation: error.operation,
      phase: error.phase,
      retrySafety: error.retrySafety,
      recovery: error.recovery,
      reason: error.message,
    }),
  );
  return 1;
}

/** The three card fields the caller needs to know which workspace was written. */
function describeWorktree(response: OrcaAdapterResponse): { id: unknown; displayName: unknown; branch: unknown } {
  const result = (response.result ?? {}) as { worktree?: Record<string, unknown> };
  const worktree = result.worktree ?? {};
  return {
    id: worktree.id ?? null,
    displayName: worktree.displayName ?? null,
    branch: worktree.branch ?? null,
  };
}

/**
 * Validate, write, print. One linear flow: the map refuses first and at zero
 * cost, then exactly one adapter call happens, then one JSON line describes what
 * the card now holds.
 */
export async function runMirror(options: MirrorCommandOptions, deps: MirrorCommandDeps = {}): Promise<MirrorExitCode> {
  let plan: { workspaceStatus: string; comment: string };
  try {
    plan = mirrorTransition({
      to: options.to,
      verdict: options.verdict,
      evidence: options.evidence,
      today: (deps.today ?? utcToday)(),
    });
  } catch (error) {
    if (error instanceof MirrorInputError) return failUsage(error.message);
    throw error;
  }
  try {
    const adapter = (deps.createAdapter ?? createOrcaOrchestrationAdapter)();
    const response = await adapter.execute({
      operation: 'worktree-set',
      worktree: options.worktree ?? 'current',
      workspaceStatus: plan.workspaceStatus,
      comment: plan.comment,
    });
    printOut(
      JSON.stringify({
        worktree: describeWorktree(response),
        workspaceStatus: plan.workspaceStatus,
        comment: plan.comment,
        receipt: response.receipt,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof OrcaAdapterError) return failAdapter(error);
    printErr(`Error (genie orca mirror): ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function registerOrcaCommands(program: Command): void {
  const orca = program.command('orca').description("Write genie's lifecycle onto the Orca workspace card (one-way)");
  orca
    .command('mirror')
    .description('Mirror one genie lifecycle transition onto the Orca workspace card')
    .requiredOption('--to <transition>', `Genie transition: ${GENIE_TRANSITIONS.join(' | ')}`)
    .option('--verdict <verdict>', `Review verdict, required by REVIEW only: ${REVIEW_VERDICTS.join(' | ')}`)
    .requiredOption('--evidence <text>', 'One line naming the proof (group, head SHA, gap count, gate, merge SHA)')
    .option(
      '--worktree <selector>',
      'current | active | id:<repoId>::<abs path> | path:<abs path> | branch:<ref> | name:<display name>',
      'current',
    )
    // Deliberately no `--json`: this verb has ONE output shape, one JSON line on
    // stdout, and an accepted-but-ignored flag is a promise that some other
    // spelling prints something else. A caller that wants a human line pipes it.
    .action(async (options: MirrorCommandOptions) => {
      // The seam returns the code; only the registered command touches process state.
      process.exitCode = await runMirror(options);
    });
}
