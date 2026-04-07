/**
 * Tree Scanner — Recursive AGENTS.md discovery with .genieignore support.
 *
 * Walks a directory tree depth-first, yielding each AGENTS.md found.
 * Prunes ignored subtrees before descending using a gitignore-compatible
 * parser (the `ignore` npm package).
 *
 * Used by:
 *   - `genie init` (tree-wide agent discovery)
 *   - Future: pending-agents refresh scan
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ignore, { type Ignore } from 'ignore';

// ============================================================================
// Types
// ============================================================================

export interface ScannedAgent {
  /** Absolute path to the directory containing AGENTS.md. */
  path: string;
  /** Name of the directory (used as default agent name). */
  dirName: string;
  /** True if this directory contains .genie/agents/ with sub-agent dirs. */
  hasSubAgents: boolean;
  /** True if this is a sub-agent inside a parent's .genie/agents/ directory. */
  isSubAgent: boolean;
  /** Parent agent name if this is a sub-agent. */
  parentName?: string;
}

// ============================================================================
// .genieignore defaults
// ============================================================================

/**
 * Default .genieignore content — comprehensive patterns covering
 * node/python/rust/go/java build artifacts and common tool dirs.
 */
export const GENIEIGNORE_DEFAULTS = `node_modules
.git
.genie/worktrees
dist
build
vendor
.next
.nuxt
__pycache__
.venv
target
coverage
.cache
`;

// ============================================================================
// Ignore loader
// ============================================================================

/**
 * Load and parse a .genieignore file. Returns an `ignore` instance.
 * If the file doesn't exist, returns an instance with no rules (matches nothing).
 */
function loadIgnoreRules(ignoreFilePath: string): Ignore {
  const ig = ignore();
  if (existsSync(ignoreFilePath)) {
    const content = readFileSync(ignoreFilePath, 'utf-8');
    ig.add(content);
  }
  return ig;
}

// ============================================================================
// Scanner
// ============================================================================

/**
 * Recursively scan a directory tree for AGENTS.md files, respecting .genieignore.
 *
 * Yields a `ScannedAgent` for each AGENTS.md found. Walks depth-first and
 * prunes ignored subtrees before descending (so scanning a large repo with
 * proper .genieignore is fast).
 *
 * Does NOT descend into the workspace's own `agents/` directory — that directory
 * is managed by `agent-sync.ts` and contains already-imported agents.
 *
 * @param root - Absolute path to the workspace root
 * @param ignoreFilePath - Absolute path to .genieignore (defaults to `<root>/.genieignore`)
 */
export async function* scanForAgents(root: string, ignoreFilePath?: string): AsyncGenerator<ScannedAgent> {
  const ig = loadIgnoreRules(ignoreFilePath ?? join(root, '.genieignore'));

  // Always skip the workspace's canonical agents/ directory — those are already imported
  ig.add('agents');

  yield* walkDir(root, root, ig);
}

/**
 * Depth-first directory walker. Prunes ignored dirs before descending.
 */
function* walkDir(dir: string, root: string, ig: Ignore): Generator<ScannedAgent> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // unreadable directory — skip
  }

  for (const name of names) {
    const fullPath = join(dir, name);

    // Quick stat check — skip non-directories
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Compute path relative to root for ignore matching.
    // The ignore library expects forward-slash paths with trailing slash for dirs.
    const relPath = `${relative(root, fullPath)}/`;

    // Check if this directory should be ignored
    if (ig.ignores(relPath)) continue;

    // Check if this directory contains AGENTS.md
    const agentsMdPath = join(fullPath, 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      const hasSubAgents = hasSubAgentDirs(fullPath);
      yield {
        path: fullPath,
        dirName: name,
        hasSubAgents,
        isSubAgent: false,
      };

      // Also yield sub-agents if present
      if (hasSubAgents) {
        yield* scanSubAgents(fullPath, name);
      }
    }

    // Continue descending into this directory (depth-first)
    yield* walkDir(fullPath, root, ig);
  }
}

/**
 * Check if a directory has sub-agent directories under .genie/agents/.
 */
function hasSubAgentDirs(agentDir: string): boolean {
  const subAgentsDir = join(agentDir, '.genie', 'agents');
  if (!existsSync(subAgentsDir)) return false;

  try {
    const names = readdirSync(subAgentsDir);
    return names.some((name) => {
      const subPath = join(subAgentsDir, name);
      try {
        return statSync(subPath).isDirectory() && existsSync(join(subPath, 'AGENTS.md'));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Yield sub-agents found inside a parent agent's .genie/agents/ directory.
 */
function* scanSubAgents(parentDir: string, parentName: string): Generator<ScannedAgent> {
  const subAgentsDir = join(parentDir, '.genie', 'agents');
  if (!existsSync(subAgentsDir)) return;

  let names: string[];
  try {
    names = readdirSync(subAgentsDir);
  } catch {
    return;
  }

  for (const name of names) {
    const subDir = join(subAgentsDir, name);
    try {
      if (!statSync(subDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(subDir, 'AGENTS.md'))) continue;

    yield {
      path: subDir,
      dirName: name,
      hasSubAgents: false,
      isSubAgent: true,
      parentName,
    };
  }
}

/**
 * Collect all results from the async generator into an array.
 * Convenience helper for callers that don't need streaming.
 */
export async function scanForAgentsAll(root: string, ignoreFilePath?: string): Promise<ScannedAgent[]> {
  const results: ScannedAgent[] = [];
  for await (const agent of scanForAgents(root, ignoreFilePath)) {
    results.push(agent);
  }
  return results;
}
