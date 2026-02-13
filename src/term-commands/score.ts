/**
 * Score command - View and update priority scores, trigger Sofia validation
 *
 * Usage:
 *   term score <id>                           - Display scores
 *   term score <id> --set blocking=5,quickWin=1  - Update specific dimensions
 *   term score <id> --sofia                   - Trigger Sofia validation (via sessions_send)
 */

import {
  getTask,
  updateTask,
  computePriorityScore,
  type PriorityScores,
} from '../lib/local-tasks.js';

export interface ScoreOptions {
  set?: string;
  sofia?: boolean;
  json?: boolean;
}

const DIMENSION_LABELS: Record<keyof PriorityScores, string> = {
  blocking: 'Blocking     (0.30)',
  stability: 'Stability    (0.25)',
  crossImpact: 'Cross-impact (0.20)',
  quickWin: 'Quick-win    (0.15)',
  complexityInverse: 'Complexity⁻¹ (0.10)',
};

function renderBar(value: number, max: number = 5): string {
  const filled = Math.round(value);
  return '█'.repeat(filled) + '░'.repeat(max - filled);
}

export async function scoreCommand(taskId: string, options: ScoreOptions = {}): Promise<void> {
  const repoPath = process.cwd();
  const task = await getTask(repoPath, taskId);

  if (!task) {
    console.error(`❌ Task "${taskId}" not found.`);
    process.exit(1);
  }

  // Handle --set: update scores
  if (options.set) {
    const currentScores: PriorityScores = task.priorityScores || {
      blocking: 3, stability: 3, crossImpact: 3, quickWin: 3, complexityInverse: 3,
    };

    const pairs = options.set.split(',');
    for (const pair of pairs) {
      const [key, valStr] = pair.split('=');
      const trimmedKey = key?.trim();
      const value = Number(valStr?.trim());

      if (!trimmedKey || !(trimmedKey in currentScores)) {
        console.error(`❌ Unknown dimension: "${trimmedKey}". Valid: ${Object.keys(currentScores).join(', ')}`);
        process.exit(1);
      }
      if (isNaN(value) || value < 0 || value > 5) {
        console.error(`❌ Score for "${trimmedKey}" must be 0-5 (got ${valStr})`);
        process.exit(1);
      }
      (currentScores as any)[trimmedKey] = value;
    }

    await updateTask(repoPath, taskId, { priorityScores: currentScores });
    task.priorityScores = currentScores;
    console.log(`✅ Scores updated for ${taskId}`);
  }

  // Handle --sofia: trigger validation
  if (options.sofia) {
    console.log(`📡 Sofia validation not yet connected (requires sessions_send integration).`);
    console.log(`   Manual workaround: ask Sofia to validate these scores.`);
  }

  // Display scores
  if (!task.priorityScores) {
    console.log(`\n📊 ${taskId} — "${task.title}"`);
    console.log(`   No scores set. Use --set to add: term score ${taskId} --set blocking=4,quickWin=5`);
    return;
  }

  const scores = task.priorityScores;
  const total = computePriorityScore(scores);

  if (options.json) {
    console.log(JSON.stringify({ id: taskId, title: task.title, scores, priorityScore: total }, null, 2));
    return;
  }

  console.log(`\n📊 ${taskId} — "${task.title}"`);
  console.log(`   PriorityScore: ${total.toFixed(2)}/5.00\n`);

  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const value = (scores as any)[key] as number;
    console.log(`   ${label}  ${renderBar(value)} ${value}/5`);
  }

  console.log('');
}
