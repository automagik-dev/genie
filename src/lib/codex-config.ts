/** Codex configuration migration helpers. Genie does not use OTel as a health signal. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCodexDir } from './genie-home.js';

export const DEAD_GENIE_OTEL_EXPORTER =
  'exporter = { otlp-http = { endpoint = "http://127.0.0.1:14318/v1/traces", protocol = "binary" } }';

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCodexDir(env);
}

export function getCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCodexHome(env), 'config.toml');
}

export interface CodexConfigMigration {
  status: 'changed' | 'unchanged' | 'error';
  backupPath?: string;
  error?: string;
}

/** Remove only Genie's exact obsolete loopback exporter line and back up first. */
export function migrateDeadGenieOtel(configPath = getCodexConfigPath(), now = new Date()): CodexConfigMigration {
  if (!existsSync(configPath)) return { status: 'unchanged' };
  try {
    const original = readFileSync(configPath, 'utf8');
    const lines = original.split(/(?<=\n)/);
    const kept = lines.filter((line) => line.trimEnd() !== DEAD_GENIE_OTEL_EXPORTER);
    if (kept.length === lines.length) return { status: 'unchanged' };

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const backupPath = `${configPath}.genie-backup-${stamp}`;
    mkdirSync(dirname(configPath), { recursive: true });
    copyFileSync(configPath, backupPath);
    writeFileSync(configPath, kept.join(''), 'utf8');
    return { status: 'changed', backupPath };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
