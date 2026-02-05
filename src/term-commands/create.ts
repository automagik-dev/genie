/**
 * Create command - Create a task.
 *
 * - In repos with beads (bd), creates a beads issue (bd-123)
 * - In repos with a tracked .genie/ (macro repo like blanco), creates a local wish task (wish-42)
 */

import { getBackend } from '../lib/task-backend.js';
import { linkTask, wishExists } from '../lib/wish-tasks.js';

export interface CreateOptions {
  description?: string;
  parent?: string;
  wish?: string;
  json?: boolean;
}

export async function createCommand(
  title: string,
  options: CreateOptions = {}
): Promise<void> {
  const repoPath = process.cwd();
  const backend = getBackend(repoPath);

  try {
    const task = await backend.create(title, {
      description: options.description,
      parent: options.parent,
    });

    // Link to wish if specified
    if (options.wish) {
      if (await wishExists(repoPath, options.wish)) {
        await linkTask(repoPath, options.wish, task.id, title);
        console.log(`✅ Created ${task.id} and linked to wish "${options.wish}"`);
      } else {
        console.log(`✅ Created ${task.id}`);
        console.warn(`⚠️  Wish "${options.wish}" not found - task not linked`);
      }
    } else if (options.json) {
      const full = await backend.get(task.id);
      console.log(JSON.stringify(full || task, null, 2));
      return;
    } else {
      console.log(`Created: ${task.id} - "${task.title}" (${backend.kind})`);
    }

    if (options.parent) console.log(`   Blocked by: ${options.parent}`);

    if (!options.json) {
      console.log(`\nNext steps:`);
      console.log(`   term work ${task.id}           - Start working on it`);
      console.log(`   term spawn brainstorm -t ${task.id}  - Plan with brainstorm skill`);

      if (backend.kind === 'beads') {
        console.log(`   bd show ${task.id}             - View details`);
      } else {
        console.log(`   (Local tasks live in .genie/tasks.json)`);
      }
    }
  } catch (error: any) {
    console.error(`Failed to create task: ${error.message || String(error)}`);
    process.exit(1);
  }
}
