/**
 * Discover migrations: scan src/migrations/steps/ for files matching
 * `^\d{3}-.+\.(ts|js)$`. Filename = id (sans extension). Alphabetical
 * sort = strict apply order.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILE_PATTERN = /^(\d{3}-[a-z0-9-]+)\.(ts|js)$/;

export interface MigrationModule {
  id: string;
  description: string;
  check: (ctx: MigrationContext) => Promise<boolean>;
  apply: (ctx: MigrationContext) => Promise<void>;
  validate: (ctx: MigrationContext) => Promise<void>;
}

export interface MigrationContext {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  dryRun: boolean;
}

export interface DiscoveredMigration {
  id: string;
  filePath: string;
}

export function discoverMigrations(): DiscoveredMigration[] {
  const stepsDir = join(__dirname, 'steps');
  if (!existsSync(stepsDir)) return [];
  const files = readdirSync(stepsDir);
  const matched: DiscoveredMigration[] = [];
  for (const file of files) {
    const m = file.match(FILE_PATTERN);
    if (!m) continue;
    matched.push({ id: m[1], filePath: join(stepsDir, file) });
  }
  matched.sort((a, b) => a.id.localeCompare(b.id));
  return matched;
}

export async function loadMigrationModule(filePath: string): Promise<MigrationModule> {
  const mod = await import(filePath);
  if (typeof mod.id !== 'string' || typeof mod.description !== 'string') {
    throw new Error(`migration ${filePath}: missing id/description exports`);
  }
  if (typeof mod.check !== 'function' || typeof mod.apply !== 'function' || typeof mod.validate !== 'function') {
    throw new Error(`migration ${filePath}: missing check/apply/validate exports`);
  }
  return mod as MigrationModule;
}
