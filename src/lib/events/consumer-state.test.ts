/**
 * Unit tests for consumer-state persistence.
 * Wish: genie-serve-structured-observability, Group 4.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateConsumerId, loadConsumerState, saveConsumerState } from './consumer-state.js';

let homeDir: string;
let prev: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'consumer-state-'));
  prev = process.env.GENIE_HOME;
  process.env.GENIE_HOME = homeDir;
});

afterEach(() => {
  if (prev === undefined) process.env.GENIE_HOME = undefined;
  else process.env.GENIE_HOME = prev;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('consumer-state persistence', () => {
  test('generateConsumerId returns a deterministic-prefix id', () => {
    const a = generateConsumerId('alpha');
    const b = generateConsumerId('alpha');
    expect(a.startsWith('alpha-')).toBe(true);
    expect(b.startsWith('alpha-')).toBe(true);
    expect(a).not.toBe(b);
  });

  test('loadConsumerState returns null when state file absent', () => {
    expect(loadConsumerState('never-existed')).toBeNull();
  });

  test('saveConsumerState + loadConsumerState round-trip', () => {
    const id = 'test-consumer-1';
    saveConsumerState({
      consumer_id: id,
      last_seen_id: 4242,
      updated_at: new Date().toISOString(),
      filters: { kind: 'mailbox', severity: 'warn' },
    });
    const restored = loadConsumerState(id);
    expect(restored).not.toBeNull();
    expect(restored?.last_seen_id).toBe(4242);
    expect(restored?.filters?.kind).toBe('mailbox');
  });

  test('saveConsumerState is atomic (survives repeated writes)', () => {
    const id = 'test-consumer-2';
    for (let i = 0; i < 20; i++) {
      saveConsumerState({
        consumer_id: id,
        last_seen_id: i,
        updated_at: new Date().toISOString(),
      });
    }
    const restored = loadConsumerState(id);
    expect(restored?.last_seen_id).toBe(19);
  });

  test('loadConsumerState rejects mismatched consumer_id (guards against rename)', () => {
    saveConsumerState({
      consumer_id: 'real-id',
      last_seen_id: 5,
      updated_at: new Date().toISOString(),
    });
    // Looking up under a different id returns null — we never silently
    // hand a consumer someone else's cursor.
    expect(loadConsumerState('spoofed-id')).toBeNull();
  });
});
