/**
 * Consumer state persistence for the structured-observability transport.
 *
 * Each `genie events stream --follow` instance persists its cursor
 * (`last_seen_id`) to `<GENIE_HOME>/state/consumer-<consumer-id>.json`. On
 * reconnect we resume reading from that id so a PG restart does not produce
 * duplicate deliveries and no gap goes undetected.
 *
 * Wish: genie-serve-structured-observability, Group 4 — Consumer CLI + Transport.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConsumerState {
  consumer_id: string;
  last_seen_id: number;
  updated_at: string;
  filters?: {
    kind?: string;
    severity?: string;
    since?: string;
  };
}

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function stateDir(): string {
  return join(genieHome(), 'state');
}

function statePath(consumerId: string): string {
  return join(stateDir(), `consumer-${sanitizeId(consumerId)}.json`);
}

function sanitizeId(id: string): string {
  // File-system safe: only alphanum, dash, underscore.
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export function generateConsumerId(prefix = 'stream'): string {
  const uuid = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${uuid}`;
}

export function loadConsumerState(consumerId: string): ConsumerState | null {
  const path = statePath(consumerId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ConsumerState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.consumer_id !== 'string' || parsed.consumer_id !== consumerId) return null;
    if (typeof parsed.last_seen_id !== 'number' || !Number.isFinite(parsed.last_seen_id)) return null;
    return {
      consumer_id: parsed.consumer_id,
      last_seen_id: parsed.last_seen_id,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
      filters: parsed.filters,
    };
  } catch {
    return null;
  }
}

/**
 * Write state atomically. Uses a tmp-rename so a crashed mid-write never
 * leaves a truncated JSON file on disk.
 */
export function saveConsumerState(state: ConsumerState): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = statePath(state.consumer_id);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf-8');
  renameSync(tmp, target);
}
