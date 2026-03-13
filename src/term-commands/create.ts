/**
 * Create command - Create a task.
 *
 * Creates a local wish task in .genie/tasks.json.
 */

import { getBackend } from '../lib/task-backend.js';
import { linkTask, wishExists } from '../lib/wish-tasks.js';

export interface CreateOptions {
  description?: string;
  parent?: string;
  wish?: string;
  json?: boolean;
}

async function handleWishLink(repoPath: string, wish: string, taskId: string, title: string): Promise<void> {
  if (await wishExists(repoPath, wish)) {
    await linkTask(repoPath, wish, taskId, title);
    console.log(`✅ Created ${taskId} and linked to wish "${wish}"`);
  } else {
    console.log(`✅ Created ${taskId}`);
    console.warn(`⚠️  Wish "${wish}" not found - task not linked`);
  }
}

export async function createCommand(title: string, options: CreateOptions = {}): Promise<void> {
  const repoPath = process.cwd();
  const backend = getBackend(repoPath);

  try {
    const task = await backend.create(title, {
      description: options.description,
      parent: options.parent,
    });

    if (options.wish) {
      await handleWishLink(repoPath, options.wish, task.id, title);
    } else if (options.json) {
      const full = await backend.get(task.id);
      console.log(JSON.stringify(full || task, null, 2));
      return;
    } else {
      console.log(`Created: ${task.id} - "${task.title}" (${backend.kind})`);
    }

    if (options.parent) console.log(`   Blocked by: ${options.parent}`);

    if (!options.json) {
      console.log('\nNext steps:');
      console.log(`   genie work ${task.id}           - Start working on it`);
      console.log('   (Tasks live in .genie/tasks.json)');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to create task: ${message || String(error)}`);
    process.exit(1);
  }
}
