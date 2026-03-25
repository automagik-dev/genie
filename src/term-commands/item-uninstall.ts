/**
 * Uninstall Command — `genie uninstall <name>`
 *
 * Removes a previously installed item: deregisters from app_store,
 * performs type-specific cleanup, and removes the cloned directory.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getItemFromStore, regenerateAgentCache, removeItemFromStore } from '../lib/agent-cache.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { getConnection, isAvailable } from '../lib/db.js';

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const ITEMS_DIR = join(GENIE_HOME, 'items');

// ============================================================================
// Type-specific deregistration
// ============================================================================

async function deregisterByType(itemType: string, name: string): Promise<void> {
  if (!(await isAvailable())) return;
  const sql = await getConnection();

  switch (itemType) {
    case 'agent':
      // Remove from legacy agents table too
      await sql`DELETE FROM agents WHERE id = ${`dir:${name}`}`.catch(() => {});
      await regenerateAgentCache();
      break;
    case 'board':
      await sql`DELETE FROM task_types WHERE id = ${name}`.catch(() => {});
      break;
    case 'workflow':
      await sql`DELETE FROM schedules WHERE id = ${`sched-${name}`}`.catch(() => {});
      break;
    case 'app':
      await sql`DELETE FROM installed_apps WHERE app_store_id IN (
        SELECT id FROM app_store WHERE name = ${name}
      )`.catch(() => {});
      break;
    case 'stack': {
      // Try to read manifest and uninstall sub-items
      const manifestPath = join(ITEMS_DIR, name, 'genie.yaml');
      if (existsSync(manifestPath)) {
        try {
          const yaml = await import('js-yaml');
          const raw = yaml.load(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
          const stack = raw.stack as { items?: Array<{ name: string; type: string }> } | undefined;
          if (stack?.items) {
            for (const item of stack.items) {
              await deregisterByType(item.type, item.name);
              await removeItemFromStore(item.name).catch(() => {});
            }
          }
        } catch {
          // Best effort
        }
      }
      break;
    }
  }
}

// ============================================================================
// Uninstall handler
// ============================================================================

async function handleUninstall(name: string): Promise<void> {
  const existing = await getItemFromStore(name).catch(() => null);
  if (!existing) {
    console.error(`Item "${name}" is not installed.`);
    process.exit(1);
  }

  const itemType = existing.item_type;

  // Type-specific deregistration
  await deregisterByType(itemType, name);

  // Remove from app_store
  await removeItemFromStore(name);

  // Remove cloned directory
  const installDir = join(ITEMS_DIR, name);
  if (existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
  }

  // Audit
  recordAuditEvent('item', name, 'item_uninstalled', getActor(), {
    type: itemType,
    version: existing.version,
  }).catch(() => {});

  console.log(`Uninstalled ${itemType} "${name}".`);
}

// ============================================================================
// Command registration
// ============================================================================

export function registerItemUninstallCommand(parent: Command): void {
  parent
    .command('uninstall <name>')
    .description('Remove an installed genie item')
    .action(async (name: string) => {
      try {
        await handleUninstall(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
