/**
 * Update Command — `genie update <name>` or `genie update --all`
 *
 * Pulls the latest version (or a specific tag) of an installed item,
 * re-validates its manifest, and updates the app_store entry.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getItemFromStore, listItemsFromStore, regenerateAgentCache, updateItemInStore } from '../lib/agent-cache.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { getConnection, isAvailable } from '../lib/db.js';
import { type GenieManifest, detectManifest, validateManifest } from '../lib/manifest.js';

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const ITEMS_DIR = join(GENIE_HOME, 'items');

// ============================================================================
// Type-specific re-registration
// ============================================================================

async function reregisterByType(manifest: GenieManifest): Promise<void> {
  if (!(await isAvailable())) return;
  const sql = await getConnection();

  switch (manifest.type) {
    case 'agent':
      await regenerateAgentCache();
      break;
    case 'board':
      if (manifest.board?.stages) {
        const stages = manifest.board.stages.map((s, i) => ({
          id: crypto.randomUUID(),
          name: s.name,
          label: s.label ?? s.name,
          gate: s.gate,
          action: s.action ?? null,
          auto_advance: s.auto_advance ?? false,
          roles: s.roles ?? ['*'],
          color: s.color ?? '#94a3b8',
          parallel: false,
          on_fail: null,
          position: i,
          transitions: [],
        }));
        await sql`
          UPDATE task_types SET stages = ${sql.json(stages)}, updated_at = now()
          WHERE id = ${manifest.name}
        `.catch(() => {});
      }
      break;
    case 'workflow':
      if (manifest.workflow) {
        await sql`
          UPDATE schedules SET
            cron_expression = ${manifest.workflow.cron},
            timezone = ${manifest.workflow.timezone ?? 'UTC'},
            command = ${manifest.workflow.command},
            run_spec = ${sql.json(manifest.workflow.run_spec ?? {})},
            updated_at = now()
          WHERE id = ${`sched-${manifest.name}`}
        `.catch(() => {});
      }
      break;
  }
}

// ============================================================================
// Update handler
// ============================================================================

interface UpdateOptions {
  all?: boolean;
}

async function handleUpdateSingle(name: string, version?: string): Promise<boolean> {
  const existing = await getItemFromStore(name).catch(() => null);
  if (!existing) {
    console.error(`Item "${name}" is not installed.`);
    return false;
  }

  const installDir = existing.install_path ?? join(ITEMS_DIR, name);
  if (!existsSync(installDir)) {
    console.error(`Install directory not found: ${installDir}`);
    return false;
  }

  // Pull latest or checkout specific version
  try {
    if (version) {
      execSync(`git fetch --tags && git checkout ${version}`, {
        cwd: installDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
    } else {
      execSync('git pull --ff-only', {
        cwd: installDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
    }
  } catch (err) {
    console.error(`Git update failed for "${name}": ${(err as Error).message}`);
    return false;
  }

  // Re-detect and validate manifest
  const detection = await detectManifest(installDir);
  if ('error' in detection) {
    console.error(`Manifest detection failed after update: ${detection.error}`);
    return false;
  }

  const { manifest } = detection;
  const validation = validateManifest(manifest, installDir);
  for (const w of validation.warnings) {
    console.log(`  Warning: ${w}`);
  }
  if (!validation.valid) {
    console.error(`Validation failed after update:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
    return false;
  }

  // Update app_store
  await updateItemInStore(name, {
    version: manifest.version,
    description: manifest.description,
    manifest: manifest as unknown as Record<string, unknown>,
  });

  // Type-specific re-registration
  await reregisterByType(manifest);

  // Audit
  recordAuditEvent('item', name, 'item_updated', getActor(), {
    type: manifest.type,
    version: manifest.version,
    previousVersion: existing.version,
  }).catch(() => {});

  console.log(`Updated ${manifest.type} "${name}" → v${manifest.version}`);
  return true;
}

async function handleUpdate(nameOrVersion: string | undefined, options: UpdateOptions): Promise<void> {
  if (options.all) {
    const items = await listItemsFromStore();
    const gitItems = items.filter((i) => i.git_url);
    if (gitItems.length === 0) {
      console.log('No git-installed items to update.');
      return;
    }

    console.log(`Updating ${gitItems.length} item(s)...`);
    let updated = 0;
    for (const item of gitItems) {
      const ok = await handleUpdateSingle(item.name);
      if (ok) updated++;
    }
    console.log(`\n${updated}/${gitItems.length} items updated successfully.`);
    return;
  }

  if (!nameOrVersion) {
    console.error('Usage: genie update <name>[@version] or genie update --all');
    process.exit(1);
  }

  // Parse name@version
  let name = nameOrVersion;
  let version: string | undefined;
  const atIdx = name.lastIndexOf('@');
  if (atIdx > 0) {
    version = name.slice(atIdx + 1);
    name = name.slice(0, atIdx);
  }

  const ok = await handleUpdateSingle(name, version);
  if (!ok) process.exit(1);
}

// ============================================================================
// Command registration
// ============================================================================

export function registerItemUpdateCommand(parent: Command): void {
  parent
    .command('update [name]')
    .description('Update an installed item to the latest version or a specific tag')
    .option('--all', 'Update all git-installed items')
    .action(async (name: string | undefined, options: UpdateOptions) => {
      try {
        await handleUpdate(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
