/**
 * Next command - Auto-pick highest priority unblocked epic and output contextual prompt
 *
 * Usage:
 *   term next              - Pick top unblocked epic, output skill prompt
 *   term next <id>         - Pick specific item (bypass queue)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  listTasks,
  getTask,
  computePriorityScore,
  type LocalTask,
} from '../lib/local-tasks.js';

export interface NextOptions {
  json?: boolean;
}

/**
 * Determine the current state of an epic and suggest the next skill to run.
 */
function detectState(task: LocalTask, repoPath: string): { state: string; skill: string; detail: string } {
  const slug = extractSlug(task);

  const hasWish = existsSync(join(repoPath, '.genie', 'wishes', slug, 'wish.md'));
  const hasBrainstorm = existsSync(join(repoPath, '.genie', 'brainstorms', slug, 'design.md'));

  if (hasWish) {
    // Check wish status
    try {
      const wishPath = join(repoPath, '.genie', 'wishes', slug, 'wish.md');
      const content = readFileSync(wishPath, 'utf-8');
      const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/i);
      const status = statusMatch?.[1]?.toUpperCase() || 'DRAFT';

      if (status === 'DONE' || status === 'COMPLETE') {
        return { state: 'done', skill: '/review', detail: `Wish complete — run final review` };
      }
      if (status === 'IN_PROGRESS') {
        return { state: 'working', skill: '/work', detail: `Wish in progress — continue /work` };
      }
      // DRAFT or REVIEW
      return { state: 'wish-ready', skill: '/work', detail: `Wish exists — run /work to execute` };
    } catch {
      return { state: 'wish-ready', skill: '/work', detail: `Wish exists — run /work to execute` };
    }
  }

  if (hasBrainstorm) {
    return { state: 'brainstormed', skill: '/wish', detail: `Design exists — run /wish to plan` };
  }

  return { state: 'raw', skill: '/brainstorm', detail: `No brainstorm yet — run /brainstorm` };
}

/**
 * Extract a slug from task title or description.
 */
function extractSlug(task: LocalTask): string {
  // Check description for slug pattern
  const slugMatch = task.description?.match(/slug:\s*([a-z0-9-]+)/i);
  if (slugMatch) return slugMatch[1];

  // Slugify title
  return task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64);
}

export async function nextCommand(target?: string, options: NextOptions = {}): Promise<void> {
  const repoPath = process.cwd();

  let task: LocalTask | null = null;

  if (target) {
    // Manual override — pick specific item
    task = await getTask(repoPath, target);
    if (!task) {
      console.error(`❌ Task "${target}" not found.`);
      process.exit(1);
    }
  } else {
    // Auto-pick: get all tasks, filter to epics, pick top unblocked
    const allTasks = await listTasks(repoPath);
    const epics = allTasks.filter(t =>
      t.issueType === 'epic' &&
      t.status !== 'done' &&
      t.status !== 'in_progress'
    );

    if (epics.length === 0) {
      console.log('📭 No epics in the queue. Use `term feed "<idea>"` to add one.');
      return;
    }

    // listTasks already sorts by priority score
    task = epics[0];
  }

  const score = task.priorityScores ? computePriorityScore(task.priorityScores) : 0;
  const { state, skill, detail } = detectState(task, repoPath);

  if (options.json) {
    console.log(JSON.stringify({ id: task.id, title: task.title, score, state, skill, detail }, null, 2));
    return;
  }

  console.log(`\n🎯 Next: ${task.id} — "${task.title}"`);
  if (task.priorityScores) {
    const s = task.priorityScores;
    console.log(`   Score: ${score.toFixed(2)}/5.00 (B=${s.blocking} S=${s.stability} C=${s.crossImpact} Q=${s.quickWin} X=${s.complexityInverse})`);
  }
  console.log(`   State: ${state}`);
  console.log(`   → ${detail}`);
  console.log(`\n   Run: ${skill}`);
  console.log('');
}
