/**
 * Update command - Update task properties (status, title, blockedBy)
 *
 * Usage:
 *   term update <task-id> --status <status>
 *   term update <task-id> --title <title>
 *   term update <task-id> --blocked-by <id1,id2,...>
 *   term update <task-id> --add-blocked-by <id>
 *
 * Status values: ready, in_progress, done, blocked
 */

import { getBackend } from '../lib/task-backend.js';

export interface UpdateOptions {
  status?: string;
  title?: string;
  blockedBy?: string;
  addBlockedBy?: string;
  json?: boolean;
}

const VALID_STATUSES = ['ready', 'in_progress', 'done', 'blocked'];

export async function updateCommand(
  taskId: string,
  options: UpdateOptions
): Promise<void> {
  try {
    const repoPath = process.cwd();
    const backend = getBackend(repoPath);

    // Validate at least one update option is provided
    // Note: empty string for blockedBy is valid (clears the list)
    if (
      options.status === undefined &&
      options.title === undefined &&
      options.blockedBy === undefined &&
      options.addBlockedBy === undefined
    ) {
      console.error('❌ No update options provided. Use --status, --title, --blocked-by, or --add-blocked-by');
      process.exit(1);
    }

    // Validate status if provided
    if (options.status && !VALID_STATUSES.includes(options.status)) {
      console.error(`❌ Invalid status "${options.status}". Valid values: ${VALID_STATUSES.join(', ')}`);
      process.exit(1);
    }

    // Check task exists
    const existing = await backend.get(taskId);
    if (!existing) {
      console.error(`❌ Task "${taskId}" not found.`);
      if (backend.kind === 'local') {
        console.error('   Check .genie/tasks.json');
      } else {
        console.error('   Run `bd list` to see available tasks.');
      }
      process.exit(1);
    }

    // Parse blocked-by options
    // Note: empty string clears the list (results in [])
    const blockedBy = options.blockedBy !== undefined
      ? options.blockedBy.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    const addBlockedBy = options.addBlockedBy !== undefined
      ? options.addBlockedBy.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    // Perform update
    const updated = await backend.update(taskId, {
      status: options.status,
      title: options.title,
      blockedBy,
      addBlockedBy,
    });

    if (!updated) {
      console.error(`❌ Failed to update task "${taskId}".`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    // Show what changed
    console.log(`✅ Updated ${taskId}`);

    const changes: string[] = [];
    if (options.status) {
      changes.push(`status: ${existing.status} → ${updated.status}`);
    }
    if (options.title) {
      changes.push(`title: "${existing.title}" → "${updated.title}"`);
    }
    if (blockedBy !== undefined) {
      changes.push(`blockedBy: [${(existing.blockedBy || []).join(', ')}] → [${(updated.blockedBy || []).join(', ')}]`);
    }
    if (addBlockedBy !== undefined) {
      changes.push(`blockedBy: added ${addBlockedBy.join(', ')} → [${(updated.blockedBy || []).join(', ')}]`);
    }

    for (const change of changes) {
      console.log(`   ${change}`);
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
