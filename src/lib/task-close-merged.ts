/**
 * Task Close-Merged — scan merged PRs and auto-advance matching genie tasks.
 *
 * Extracts wish slugs from PR bodies/branches, finds tasks with matching
 * wish_file fields, and moves them to the 'ship' stage.
 */

import { execSync } from 'node:child_process';
import { resolveRepoPath } from './wish-state.js';

// ============================================================================
// Types
// ============================================================================

export interface MergedPR {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  mergedAt: string;
}

export interface PRSlugMatch {
  prNumber: number;
  slug: string;
  mergedAt: string;
}

export interface CloseMergedResult {
  closed: number;
  alreadyShipped: number;
  prsScanned: number;
  details: { taskSeq: number; taskTitle: string; prNumber: number; slug: string }[];
}

export interface CloseMergedOptions {
  since?: string;
  dryRun?: boolean;
  repo?: string;
  repoPath?: string;
}

// ============================================================================
// Wish Slug Extraction
// ============================================================================

/**
 * Extract wish slug from a PR body.
 * Matches patterns: `Wish: <slug>`, `wish: <slug>`, `slug: <slug>` (case-insensitive).
 */
export function extractSlugFromBody(body: string): string | null {
  if (!body) return null;
  const match = body.match(/(?:wish|slug):\s*(\S+)/i);
  return match ? match[1] : null;
}

/**
 * Extract wish slug from a branch name.
 * Matches conventional prefixes: feat/<slug>, fix/<slug>, chore/<slug>, etc.
 */
export function extractSlugFromBranch(branch: string): string | null {
  if (!branch) return null;
  const match = branch.match(/^(?:feat|fix|chore|docs|refactor|test|dream)\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Extract wish slug from a PR, trying body first, then branch name fallback.
 */
export function extractWishSlug(pr: MergedPR): string | null {
  return extractSlugFromBody(pr.body) ?? extractSlugFromBranch(pr.headRefName);
}

// ============================================================================
// PR Scanning
// ============================================================================

/**
 * Parse a duration string like '24h', '48h', '7d' into an ISO date string.
 */
export function parseSinceDate(since: string): string {
  const match = since.match(/^(\d+)([hd])$/);
  if (!match) throw new Error(`Invalid --since format: "${since}". Use e.g. "24h" or "7d".`);

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  if (unit === 'h') {
    now.setHours(now.getHours() - amount);
  } else {
    now.setDate(now.getDate() - amount);
  }

  return now.toISOString();
}

/**
 * Fetch recently merged PRs from the current repo's GitHub remote.
 */
export function fetchMergedPRs(since: string, repo?: string): MergedPR[] {
  const sinceDate = parseSinceDate(since);
  const repoFlag = repo ? `--repo ${repo}` : '';

  const cmd = `gh pr list --state merged --json number,title,body,headRefName,mergedAt --limit 100 ${repoFlag}`.trim();

  let output: string;
  try {
    output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch merged PRs: ${message}`);
  }

  const prs: MergedPR[] = JSON.parse(output);

  // Filter to PRs merged after the since date
  return prs.filter((pr) => new Date(pr.mergedAt) >= new Date(sinceDate));
}

/**
 * Extract wish slugs from a list of merged PRs.
 */
export function matchPRsToSlugs(prs: MergedPR[]): PRSlugMatch[] {
  const matches: PRSlugMatch[] = [];
  for (const pr of prs) {
    const slug = extractWishSlug(pr);
    if (slug) {
      matches.push({ prNumber: pr.number, slug, mergedAt: pr.mergedAt });
    }
  }
  return matches;
}

// ============================================================================
// Task Matching + Auto-Close
// ============================================================================

/**
 * Find and close tasks matching merged PR wish slugs.
 *
 * For each slug, queries tasks where wish_file contains the slug,
 * skips tasks already in 'ship' stage, and moves the rest to 'ship'.
 */
export async function closeMergedTasks(options: CloseMergedOptions = {}): Promise<CloseMergedResult> {
  const { since = '24h', dryRun = false, repo, repoPath } = options;

  // Lazy import to avoid circular deps (same pattern as task.ts)
  const ts = await import('./task-service.js');

  // Step 1: Fetch merged PRs
  const prs = fetchMergedPRs(since, repo);

  // Step 2: Extract wish slugs
  const slugMatches = matchPRsToSlugs(prs);

  const result: CloseMergedResult = {
    closed: 0,
    alreadyShipped: 0,
    prsScanned: prs.length,
    details: [],
  };

  if (slugMatches.length === 0) return result;

  // Step 3: For each slug, find matching tasks
  const actor = { actorType: 'local' as const, actorId: process.env.GENIE_AGENT_NAME ?? 'cli' };
  const processedTaskIds = new Set<string>();

  for (const { prNumber, slug } of slugMatches) {
    // Query tasks where wish_file contains the slug
    const tasks = await findTasksByWishSlug(slug, repoPath);

    for (const task of tasks) {
      // Skip duplicates (same task matched by multiple PRs)
      if (processedTaskIds.has(task.id)) continue;
      processedTaskIds.add(task.id);

      // Skip tasks already in ship stage
      if (task.stage === 'ship') {
        result.alreadyShipped++;
        continue;
      }

      if (!dryRun) {
        await ts.moveTask(task.id, 'ship', actor, undefined, task.repoPath);
        await ts.commentOnTask(task.id, actor, `Auto-closed: PR #${prNumber} merged to dev`, task.repoPath);
      }

      result.closed++;
      result.details.push({
        taskSeq: task.seq,
        taskTitle: task.title,
        prNumber,
        slug,
      });
    }
  }

  return result;
}

/**
 * Find tasks whose wish_file contains the given slug.
 */
async function findTasksByWishSlug(
  slug: string,
  repoPath?: string,
): Promise<{ id: string; seq: number; title: string; stage: string; repoPath: string }[]> {
  const { getConnection } = await import('./db.js');
  const sql = await getConnection();

  const repo = repoPath ?? resolveRepoPath();
  const pattern = `%${slug}%`;

  const rows = await sql`
    SELECT id, seq, title, stage, repo_path
    FROM tasks
    WHERE repo_path = ${repo}
      AND wish_file LIKE ${pattern}
    ORDER BY seq
  `;

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    seq: r.seq as number,
    title: r.title as string,
    stage: r.stage as string,
    repoPath: r.repo_path as string,
  }));
}
