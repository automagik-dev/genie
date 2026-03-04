/**
 * Update command - Update task properties (status, title, blockedBy)
 *
 * Usage:
 *   genie task update <task-id> --status <status>
 *   genie task update <task-id> --title <title>
 *   genie task update <task-id> --blocked-by <id1,id2,...>
 *   genie task update <task-id> --add-blocked-by <id>
 *
 * Status values: ready, in_progress, done, blocked
 */

import { type TaskSummary, getBackend } from '../lib/task-backend.js';

export interface UpdateOptions {
  status?: string;
  title?: string;
  blockedBy?: string;
  addBlockedBy?: string;
  json?: boolean;
}

const VALID_STATUSES = ['ready', 'in_progress', 'done', 'blocked'];

function validateUpdateOptions(options: UpdateOptions): void {
  if (
    options.status === undefined &&
    options.title === undefined &&
    options.blockedBy === undefined &&
    options.addBlockedBy === undefined
  ) {
    console.error('❌ No update options provided. Use --status, --title, --blocked-by, or --add-blocked-by');
    process.exit(1);
  }

  if (options.status && !VALID_STATUSES.includes(options.status)) {
    console.error(`❌ Invalid status "${options.status}". Valid values: ${VALID_STATUSES.join(', ')}`);
    process.exit(1);
  }
}

function printUpdateSummary(
  taskId: string,
  existing: TaskSummary,
  updated: TaskSummary,
  options: UpdateOptions,
  blockedBy?: string[],
  addBlockedBy?: string[],
): void {
  console.log(`✅ Updated ${taskId}`);
  const changes: string[] = [];
  if (options.status) changes.push(`status: ${existing.status} → ${updated.status}`);
  if (options.title) changes.push(`title: "${existing.title}" → "${updated.title}"`);
  if (blockedBy !== undefined)
    changes.push(`blockedBy: [${(existing.blockedBy || []).join(', ')}] → [${(updated.blockedBy || []).join(', ')}]`);
  if (addBlockedBy !== undefined)
    changes.push(`blockedBy: added ${addBlockedBy.join(', ')} → [${(updated.blockedBy || []).join(', ')}]`);
  for (const change of changes) console.log(`   ${change}`);
}

function parseCommaList(value: string | undefined): string[] | undefined {
  return value !== undefined
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

export async function updateCommand(taskId: string, options: UpdateOptions): Promise<void> {
  try {
    validateUpdateOptions(options);

    const repoPath = process.cwd();
    const backend = getBackend(repoPath);

    const existing = await backend.get(taskId);
    if (!existing) {
      console.error(`❌ Task "${taskId}" not found.`);
      console.error(
        backend.kind === 'local' ? '   Check .genie/tasks.json' : '   Run `bd list` to see available tasks.',
      );
      process.exit(1);
    }

    const blockedBy = parseCommaList(options.blockedBy);
    const addBlockedBy = parseCommaList(options.addBlockedBy);

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

    printUpdateSummary(taskId, existing, updated, options, blockedBy, addBlockedBy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}
