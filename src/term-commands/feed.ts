/**
 * Feed command - Add epic-type beads to the priority queue.
 *
 * Creates a bead with issue_type="epic" and priority scoring metadata.
 * Epics represent high-level work items that can be broken down into tasks.
 *
 * Usage:
 *   term feed "emoji rlhf"                     # Create epic with default scores
 *   term feed "emoji rlhf" --link path/to/wish  # Create epic linked to a file
 *
 * Priority scoring (all default to 3/5):
 *   blocking         (0.30) - How many things does this unblock?
 *   stability        (0.25) - Does the current state cause failures?
 *   crossImpact      (0.20) - How many repos/agents benefit?
 *   quickWin         (0.15) - Can it ship in one session?
 *   complexityInverse (0.10) - Simple = higher score
 */

import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface FeedOptions {
  link?: string;
  json?: boolean;
}

interface PriorityScores {
  blocking: number;
  stability: number;
  crossImpact: number;
  quickWin: number;
  complexityInverse: number;
}

interface EpicMetadata {
  scores: PriorityScores;
  priorityScore: number;
}

interface BeadIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  issue_type: string;
  owner?: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  metadata?: EpicMetadata;
  external_ref?: string;
  labels?: string[];
}

// ============================================================================
// Scoring
// ============================================================================

const WEIGHTS = {
  blocking: 0.30,
  stability: 0.25,
  crossImpact: 0.20,
  quickWin: 0.15,
  complexityInverse: 0.10,
} as const;

const DEFAULT_SCORE = 3;

function defaultScores(): PriorityScores {
  return {
    blocking: DEFAULT_SCORE,
    stability: DEFAULT_SCORE,
    crossImpact: DEFAULT_SCORE,
    quickWin: DEFAULT_SCORE,
    complexityInverse: DEFAULT_SCORE,
  };
}

function computePriorityScore(scores: PriorityScores): number {
  const raw =
    scores.blocking * WEIGHTS.blocking +
    scores.stability * WEIGHTS.stability +
    scores.crossImpact * WEIGHTS.crossImpact +
    scores.quickWin * WEIGHTS.quickWin +
    scores.complexityInverse * WEIGHTS.complexityInverse;

  // Round to 2 decimal places
  return Math.round(raw * 100) / 100;
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Get the issue prefix from the beads config or repo name.
 * Reads .beads/config.yaml for issue-prefix, falls back to repo directory name.
 */
function getIssuePrefix(beadsDir: string): string {
  try {
    const configPath = join(beadsDir, 'config.yaml');
    const config = require('fs').readFileSync(configPath, 'utf-8');
    // Look for uncommented issue-prefix line
    const match = config.match(/^issue-prefix:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  } catch {
    // Fall through to repo name detection
  }

  // Detect from existing issues
  try {
    const issuesPath = join(beadsDir, 'issues.jsonl');
    const content = require('fs').readFileSync(issuesPath, 'utf-8');
    const firstLine = content.split('\n').find((l: string) => l.trim());
    if (firstLine) {
      const issue = JSON.parse(firstLine);
      const dashIdx = issue.id.lastIndexOf('-');
      if (dashIdx > 0) {
        return issue.id.substring(0, dashIdx);
      }
    }
  } catch {
    // Fall through
  }

  // Fallback: derive from git repo name
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return require('path').basename(toplevel).replace(/[^a-zA-Z0-9-]/g, '');
  } catch {
    return 'bd';
  }
}

/**
 * Generate a unique short ID suffix (3 chars, base36).
 * Checks existing IDs to avoid collisions.
 */
function generateShortId(existingIds: Set<string>, prefix: string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = randomBytes(2);
    const suffix = ((bytes[0] << 8) | bytes[1]).toString(36).slice(0, 3).padStart(3, '0');
    const candidate = `${prefix}-${suffix}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  // Fallback: use more bytes
  const suffix = randomBytes(4).toString('hex').slice(0, 4);
  return `${prefix}-${suffix}`;
}

// ============================================================================
// JSONL Operations
// ============================================================================

/**
 * Find the .beads directory, searching up from cwd.
 * If inside a worktree, look in the main repo.
 */
function findBeadsDir(startPath: string): string | null {
  // Try git common dir first (for worktrees)
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: startPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    let mainRepo: string;
    if (commonDir === '.git') {
      mainRepo = startPath;
    } else if (commonDir.endsWith('/.git') || commonDir.endsWith('\\.git')) {
      mainRepo = commonDir.slice(0, -5);
    } else {
      mainRepo = dirname(commonDir);
    }

    const beadsPath = join(mainRepo, '.beads');
    try {
      require('fs').accessSync(beadsPath);
      return beadsPath;
    } catch {
      // Fall through
    }
  } catch {
    // Not in a git repo, search manually
  }

  // Walk up looking for .beads/
  let current = startPath;
  for (let i = 0; i < 10; i++) {
    const candidate = join(current, '.beads');
    try {
      require('fs').accessSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return null;
}

async function loadExistingIds(issuesPath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const content = await readFile(issuesPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const issue = JSON.parse(line);
        if (issue.id) ids.add(issue.id);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist yet
  }
  return ids;
}

async function appendIssue(issuesPath: string, issue: BeadIssue): Promise<void> {
  const line = JSON.stringify(issue) + '\n';
  // Ensure the file exists
  try {
    await access(issuesPath);
  } catch {
    await mkdir(dirname(issuesPath), { recursive: true });
  }
  // Append atomically
  const existing = await readFile(issuesPath, 'utf-8').catch(() => '');
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  await writeFile(issuesPath, existing + (needsNewline ? '\n' : '') + line);
}

// ============================================================================
// Feed Command
// ============================================================================

export async function feedCommand(
  title: string,
  options: FeedOptions = {}
): Promise<void> {
  const cwd = process.cwd();

  // Find .beads directory
  const beadsDir = findBeadsDir(cwd);
  if (!beadsDir) {
    console.error('❌ No .beads directory found. Run `bd init` or create .beads/ manually.');
    process.exit(1);
  }

  const issuesPath = join(beadsDir, 'issues.jsonl');

  // Load existing IDs for collision avoidance
  const existingIds = await loadExistingIds(issuesPath);

  // Generate ID
  const prefix = getIssuePrefix(beadsDir);
  const id = generateShortId(existingIds, prefix);

  // Compute scores
  const scores = defaultScores();
  const priorityScore = computePriorityScore(scores);

  // Build metadata
  const metadata: EpicMetadata = { scores, priorityScore };

  // Build the issue
  const now = new Date().toISOString();
  const issue: BeadIssue = {
    id,
    title,
    status: 'open',
    priority: 1,
    issue_type: 'epic',
    created_at: now,
    created_by: 'genie-cli',
    updated_at: now,
    metadata,
  };

  // Handle --link
  if (options.link) {
    const linkPath = resolve(cwd, options.link);
    issue.external_ref = linkPath;
  }

  // Write to JSONL
  await appendIssue(issuesPath, issue);

  // Output
  if (options.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(`🎯 Epic created: ${id}`);
  console.log(`   Title: "${title}"`);
  console.log(`   Priority Score: ${priorityScore}`);
  console.log(`   Scores: blocking=${scores.blocking} stability=${scores.stability} crossImpact=${scores.crossImpact} quickWin=${scores.quickWin} complexity⁻¹=${scores.complexityInverse}`);
  if (issue.external_ref) {
    console.log(`   Linked: ${issue.external_ref}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log(`   term feed score ${id}        — Adjust priority scores`);
  console.log(`   term feed ls                 — List all epics by priority`);
  console.log(`   term work ${id}              — Start working on it`);
}
