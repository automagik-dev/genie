/**
 * Migration tracking store — atomic read/write of ~/.genie/migrations.json.
 *
 * Records which migrations have been applied to this host, when, and from
 * which genie cli version. Used by the orchestrator to filter pending vs
 * already-applied. File-based (not PG) because migrations may need to RUN
 * before genie-serve / canonical pgserve are healthy.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export type MigrationStatus = 'APPLIED' | 'FAILED';

export interface MigrationRecord {
  id: string;
  status: MigrationStatus;
  appliedAt: string; // ISO timestamp
  appliedFrom: string; // genie cli version at apply time
  detail?: string; // FAILED reason or APPLIED note
}

interface StoreFile {
  applied: MigrationRecord[];
}

export function getStorePath(): string {
  return process.env.GENIE_MIGRATIONS_STORE || `${homedir()}/.genie/migrations.json`;
}

export function loadStore(): StoreFile {
  const p = getStorePath();
  if (!existsSync(p)) return { applied: [] };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.applied)) return { applied: [] };
    return parsed as StoreFile;
  } catch {
    return { applied: [] };
  }
}

/**
 * Atomic write: tmp file + rename so a crash mid-write never leaves
 * partial JSON on disk.
 */
export function saveStore(store: StoreFile): void {
  const p = getStorePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, p);
}

export function recordApplied(id: string, version: string, detail?: string): void {
  const store = loadStore();
  // Strip any prior FAILED record for this id; record APPLIED authoritatively.
  store.applied = store.applied.filter((r) => r.id !== id);
  store.applied.push({
    id,
    status: 'APPLIED',
    appliedAt: new Date().toISOString(),
    appliedFrom: version,
    detail,
  });
  saveStore(store);
}

export function recordFailed(id: string, version: string, reason: string): void {
  const store = loadStore();
  store.applied = store.applied.filter((r) => r.id !== id);
  store.applied.push({
    id,
    status: 'FAILED',
    appliedAt: new Date().toISOString(),
    appliedFrom: version,
    detail: reason,
  });
  saveStore(store);
}

export function getApplied(): Map<string, MigrationRecord> {
  const store = loadStore();
  return new Map(store.applied.map((r) => [r.id, r]));
}
