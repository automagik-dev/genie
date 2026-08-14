/**
 * The worktrees base `genie launch` used to materialize one git worktree per
 * wish group — the directory that marks pre-0.3 launch residue for the doctor
 * check.
 *
 * Relocated here from `src/term-commands/launch.ts` when that command was
 * deleted (spawn-context-contract#launch-removal). Post-drain
 * (spawn-context-contract#drain), the doctor check is retargeted: post-0.3
 * wish worktrees are remotty sessions (`<project>/.worktrees/<session>`) and
 * are never classified as launch residue. This base remains the legacy
 * detection authority — a worktree under it on a `wish/<slug>-<group>` branch
 * is the only thing doctor classifies as launch residue.
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
