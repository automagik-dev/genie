/**
 * Feed command - Ingest a new backlog item as a scored epic
 *
 * Usage:
 *   term feed "<title>"                             - Create epic with default scores (all 3/5)
 *   term feed "<title>" --scores '{"blocking":5}'   - Override specific dimensions
 *   term feed "<title>" --slug <slug>               - Custom slug (default: slugified title)
 */

import { existsSync } from 'fs';
import { join } from 'path';
import {
  createWishTask,
  ensureTasksFile,
  updateTask,
  computePriorityScore,
  type PriorityScores,
} from '../lib/local-tasks.js';
import { getRepoGenieDir } from '../lib/genie-dir.js';

export interface FeedOptions {
  scores?: string;
  slug?: string;
}

/** Convert a title to a URL-safe slug: lowercase, hyphens, no special chars */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')  // strip special chars
    .replace(/[\s_]+/g, '-')        // spaces/underscores → hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
}

const DEFAULT_SCORES: PriorityScores = {
  blocking: 3,
  stability: 3,
  crossImpact: 3,
  quickWin: 3,
  complexityInverse: 3,
};

export async function feedCommand(
  title: string,
  options: FeedOptions = {},
): Promise<void> {
  const repoPath = process.cwd();
  const slug = options.slug || slugify(title);

  // Parse --scores JSON override
  let overrides: Partial<PriorityScores> = {};
  if (options.scores) {
    try {
      overrides = JSON.parse(options.scores);
      // Validate keys
      const validKeys = new Set<string>([
        'blocking', 'stability', 'crossImpact', 'quickWin', 'complexityInverse',
      ]);
      for (const key of Object.keys(overrides)) {
        if (!validKeys.has(key)) {
          console.error(`❌ Unknown score dimension: "${key}"`);
          console.error(`   Valid: ${[...validKeys].join(', ')}`);
          process.exit(1);
        }
        const val = (overrides as Record<string, unknown>)[key];
        if (typeof val !== 'number' || val < 0 || val > 5) {
          console.error(`❌ Score "${key}" must be a number 0-5, got: ${val}`);
          process.exit(1);
        }
      }
    } catch (err: any) {
      if (err.message?.includes('Unknown score') || err.message?.includes('must be a number')) {
        throw err; // re-throw our own validation errors
      }
      console.error(`❌ Invalid --scores JSON: ${err.message}`);
      process.exit(1);
    }
  }

  const scores: PriorityScores = { ...DEFAULT_SCORES, ...overrides };

  // Ensure tasks file exists
  await ensureTasksFile(repoPath);

  // Create the task
  const task = await createWishTask(repoPath, title);

  // Update with priority scores and epic type
  const updated = await updateTask(repoPath, task.id, {
    priorityScores: scores,
    issueType: 'epic',
  });

  if (!updated) {
    console.error(`❌ Failed to update task ${task.id} with scores`);
    process.exit(1);
  }

  // Compute priority
  const priority = computePriorityScore(scores);

  // Check for existing brainstorm/wish artifacts
  const genieDir = getRepoGenieDir(repoPath);
  const designPath = join(genieDir, 'brainstorms', slug, 'design.md');
  const wishPath = join(genieDir, 'wishes', slug, 'wish.md');
  const hasDesign = existsSync(designPath);
  const hasWish = existsSync(wishPath);

  // Output
  console.log(`🍽️  Fed: ${updated.id} — "${title}"`);
  console.log(`   Type:     epic`);
  console.log(`   Slug:     ${slug}`);
  console.log(`   Priority: ${priority.toFixed(2)} / 5.00`);
  console.log(`   Scores:   blocking=${scores.blocking} stability=${scores.stability} cross=${scores.crossImpact} quick=${scores.quickWin} complexity⁻¹=${scores.complexityInverse}`);

  if (hasDesign) console.log(`   📋 Design: .genie/brainstorms/${slug}/design.md`);
  if (hasWish) console.log(`   📝 Wish:   .genie/wishes/${slug}/wish.md`);
  if (!hasDesign && !hasWish) console.log(`   💡 No design or wish yet — run: term brainstorm -p "${slug}"`);

  console.log('');
  console.log(`Next steps:`);
  console.log(`   term task ls                 - See priority queue`);
  console.log(`   term work ${updated.id}           - Start working on it`);
}
