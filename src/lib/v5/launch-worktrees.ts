/**
 * The worktrees base `genie launch` used to materialize one git worktree per
 * wish group — the directory the doctor launch-residue check still scans.
 *
 * Relocated here from `src/term-commands/launch.ts` when that command was
 * deleted (spawn-context-contract#launch-removal): the doctor residue check
 * keeps enumerating this base until the drain group retargets it, so the
 * resolution survives in a shared module instead of dying with the command.
 * `GENIE_WORKTREES_DIR` overrides, `<GENIE_HOME>/worktrees` is the default.
 */

import { join } from 'node:path';
import { genieHome } from '../workspace.js';

export interface LaunchWorktreesBaseDeps {
  /** Base directory launch worktrees live under. Defaults to `<GENIE_HOME>/worktrees`. */
  worktreesDir?: string;
}

/** Base dir for launch worktrees: explicit override, else `<GENIE_HOME>/worktrees`. */
export function resolveWorktreesBase(deps: LaunchWorktreesBaseDeps): string {
  return deps.worktreesDir ?? process.env.GENIE_WORKTREES_DIR ?? join(genieHome(), 'worktrees');
}
