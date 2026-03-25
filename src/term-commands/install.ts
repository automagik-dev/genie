/**
 * Install Command — `genie install <git-url>[@version]`
 *
 * Clones a git repository, detects/validates the manifest, registers in
 * app_store, and performs type-specific setup (cache regen, board creation, etc.).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import {
  getItemFromStore,
  regenerateAgentCache,
  registerItemInStore,
  removeItemFromStore,
} from '../lib/agent-cache.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { getConnection, isAvailable } from '../lib/db.js';
import { type GenieManifest, type StageConfig, detectManifest, validateManifest } from '../lib/manifest.js';

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const ITEMS_DIR = join(GENIE_HOME, 'items');

// ============================================================================
// URL parsing
// ============================================================================

interface ParsedUrl {
  url: string;
  version?: string;
  name: string;
}

/**
 * Parse a git install target like `github.com/user/repo@v1.2.0`
 * into its components.
 */
function parseInstallTarget(target: string): ParsedUrl {
  let url = target;
  let version: string | undefined;

  // Extract @version suffix
  const atIdx = url.lastIndexOf('@');
  if (atIdx > 0 && !url.slice(atIdx).includes('/')) {
    version = url.slice(atIdx + 1);
    url = url.slice(0, atIdx);
  }

  // Normalise bare github.com/user/repo → https://github.com/user/repo.git
  if (!url.startsWith('http') && !url.startsWith('git@') && !url.startsWith('ssh://')) {
    url = `https://${url}`;
  }
  if (url.startsWith('https://') && !url.endsWith('.git')) {
    url = `${url}.git`;
  }

  // Derive name from repo URL
  const name = basename(url, '.git');

  return { url, version, name };
}

// ============================================================================
// Git operations
// ============================================================================

function cloneRepo(url: string, dest: string, options: { shallow?: boolean; version?: string }): void {
  const args = ['git', 'clone'];
  if (options.shallow !== false) args.push('--depth', '1');
  if (options.version) args.push('--branch', options.version);
  args.push(url, dest);

  execSync(args.join(' '), { stdio: 'pipe', timeout: 120_000 });
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// Type-specific registration
// ============================================================================

async function registerByType(manifest: GenieManifest, installPath: string): Promise<void> {
  switch (manifest.type) {
    case 'agent':
      await regenerateAgentCache();
      break;
    case 'board':
      await registerBoard(manifest);
      break;
    case 'workflow':
      await registerWorkflow(manifest);
      break;
    case 'stack':
      await installStack(manifest, installPath);
      break;
    // skill, app, template, hook — no extra registration needed beyond app_store
  }
}

async function registerBoard(manifest: GenieManifest): Promise<void> {
  if (!manifest.board?.stages) return;
  if (!(await isAvailable())) return;

  const sql = await getConnection();
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
    INSERT INTO task_types (id, name, description, stages, is_builtin)
    VALUES (
      ${manifest.name},
      ${manifest.name},
      ${manifest.description ?? null},
      ${sql.json(stages)},
      false
    )
    ON CONFLICT (id) DO UPDATE SET
      stages = EXCLUDED.stages,
      description = EXCLUDED.description,
      updated_at = now()
  `;
}

async function registerWorkflow(manifest: GenieManifest): Promise<void> {
  if (!manifest.workflow) return;
  if (!(await isAvailable())) return;

  const sql = await getConnection();
  const wf = manifest.workflow;

  await sql`
    INSERT INTO schedules (id, name, cron_expression, timezone, command, run_spec, status)
    VALUES (
      ${`sched-${manifest.name}`},
      ${manifest.name},
      ${wf.cron},
      ${wf.timezone ?? 'UTC'},
      ${wf.command},
      ${sql.json(wf.run_spec ?? {})},
      'active'
    )
    ON CONFLICT (id) DO UPDATE SET
      cron_expression = EXCLUDED.cron_expression,
      timezone = EXCLUDED.timezone,
      command = EXCLUDED.command,
      run_spec = EXCLUDED.run_spec,
      updated_at = now()
  `;
}

async function handleInlineStackItem(
  item: import('../lib/manifest.js').StackItem,
  version: string,
  tx: Awaited<ReturnType<typeof getConnection>>,
): Promise<void> {
  if (item.type === 'board' && item.config) {
    await registerBoard({
      name: item.name,
      type: 'board',
      version,
      board: { stages: (item.config.stages ?? []) as StageConfig[] },
    });
  } else if (item.type === 'workflow' && item.config) {
    await registerWorkflow({
      name: item.name,
      type: 'workflow',
      version,
      workflow: item.config as unknown as NonNullable<GenieManifest['workflow']>,
    });
  }
  await tx`
    INSERT INTO app_store (name, item_type, version, manifest)
    VALUES (${item.name}, ${item.type}, ${version}, ${tx.json(item.config ?? {})})
    ON CONFLICT (name) DO NOTHING
  `;
}

async function handleExternalStackItem(
  item: import('../lib/manifest.js').StackItem,
  tx: Awaited<ReturnType<typeof getConnection>>,
): Promise<string> {
  const parsed = parseInstallTarget(item.source!);
  const itemDir = join(ITEMS_DIR, parsed.name);
  mkdirSync(ITEMS_DIR, { recursive: true });
  cloneRepo(parsed.url, itemDir, { version: parsed.version });

  const detection = await detectManifest(itemDir);
  if ('error' in detection) {
    throw new Error(`Stack item "${item.name}" (${item.source}): ${detection.error}`);
  }
  const validation = validateManifest(detection.manifest, itemDir);
  if (!validation.valid) {
    throw new Error(`Stack item "${item.name}" validation failed: ${validation.errors.join(', ')}`);
  }

  await tx`
    INSERT INTO app_store (name, item_type, version, git_url, install_path, manifest)
    VALUES (
      ${detection.manifest.name}, ${detection.manifest.type}, ${detection.manifest.version},
      ${item.source}, ${itemDir}, ${tx.json(detection.manifest)}
    )
    ON CONFLICT (name) DO NOTHING
  `;
  await registerByType(detection.manifest, itemDir);
  return parsed.name;
}

async function installStack(manifest: GenieManifest, _installPath: string): Promise<void> {
  if (!manifest.stack?.items) return;
  if (!(await isAvailable())) return;

  const sql = await getConnection();
  const installed: string[] = [];

  try {
    await sql.begin(async (tx: typeof sql) => {
      for (const item of manifest.stack!.items) {
        if (item.inline) {
          await handleInlineStackItem(item, manifest.version, tx);
          installed.push(item.name);
        } else if (item.source) {
          const name = await handleExternalStackItem(item, tx);
          installed.push(name);
        }
      }
    });
  } catch (err) {
    // Rollback: clean up cloned dirs
    for (const name of installed) {
      cleanupDir(join(ITEMS_DIR, name));
      await removeItemFromStore(name).catch(() => {});
    }
    throw err;
  }
}

// ============================================================================
// Install command
// ============================================================================

interface InstallOptions {
  force?: boolean;
  full?: boolean;
}

async function handleInstall(target: string, options: InstallOptions): Promise<void> {
  const parsed = parseInstallTarget(target);
  const installDir = join(ITEMS_DIR, parsed.name);

  // Check for name conflict
  const existing = await getItemFromStore(parsed.name).catch(() => null);
  if (existing && !options.force) {
    console.error(`Item "${parsed.name}" is already installed. Use --force to override.`);
    process.exit(1);
  }
  if (existing && options.force) {
    await removeItemFromStore(parsed.name).catch(() => {});
    cleanupDir(installDir);
  }

  // Clone
  mkdirSync(ITEMS_DIR, { recursive: true });
  console.log(`Cloning ${parsed.url}${parsed.version ? ` @ ${parsed.version}` : ''}...`);
  try {
    cloneRepo(parsed.url, installDir, { shallow: !options.full, version: parsed.version });
  } catch (err) {
    cleanupDir(installDir);
    console.error(`Clone failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Detect manifest
  const detection = await detectManifest(installDir);
  if ('error' in detection) {
    cleanupDir(installDir);
    console.error(`Manifest detection failed: ${detection.error}`);
    process.exit(1);
  }

  const { manifest, source } = detection;
  console.log(`Detected ${manifest.type} manifest from ${source}`);

  // Validate
  const validation = validateManifest(manifest, installDir);
  for (const w of validation.warnings) {
    console.log(`  Warning: ${w}`);
  }
  if (!validation.valid) {
    cleanupDir(installDir);
    console.error(`Validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }

  // Register in app_store
  try {
    await registerItemInStore({
      name: manifest.name,
      itemType: manifest.type,
      version: manifest.version,
      description: manifest.description,
      authorName: manifest.author?.name,
      authorUrl: manifest.author?.url,
      gitUrl: parsed.url,
      installPath: installDir,
      manifest: manifest as unknown as Record<string, unknown>,
      tags: manifest.tags,
      category: manifest.category,
      license: manifest.license,
      dependencies: manifest.dependencies,
    });
  } catch (err) {
    cleanupDir(installDir);
    console.error(`Registration failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Type-specific registration
  await registerByType(manifest, installDir);

  // Audit
  recordAuditEvent('item', manifest.name, 'item_installed', getActor(), {
    type: manifest.type,
    version: manifest.version,
    source: parsed.url,
    manifestSource: source,
  }).catch(() => {});

  console.log(`\nInstalled ${manifest.type} "${manifest.name}" v${manifest.version}`);
  console.log(`  Source: ${parsed.url}`);
  console.log(`  Path: ${installDir}`);
}

// ============================================================================
// Command registration
// ============================================================================

export function registerInstallCommand(program: Command): void {
  program
    .command('install <target>')
    .description('Install a genie item from a git URL (e.g. github.com/user/repo[@version])')
    .option('--force', 'Override existing item with same name')
    .option('--full', 'Full git clone instead of shallow')
    .action(async (target: string, options: InstallOptions) => {
      try {
        await handleInstall(target, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
