/**
 * Genie directory helpers
 *
 * For the "macro" repo (e.g. /home/genie/workspace/blanco), we want a git-tracked
 * .genie/ folder to hold living state.
 */

import { existsSync } from 'fs';
import { join } from 'path';

export const GENIE_DIR_NAME = '.genie';

/**
 * Returns repo-local .genie directory path.
 */
export function getRepoGenieDir(repoPath: string): string {
  return join(repoPath, GENIE_DIR_NAME);
}

/**
 * Heuristic: treat repo as "local-backend capable" if it has (or intends to have)
 * a tracked .genie/ directory.
 */
export function hasRepoGenieDir(repoPath: string): boolean {
  return existsSync(getRepoGenieDir(repoPath));
}
