/**
 * Issue #1304 — auto-resume telemetry emission shape contract.
 *
 * Verifies that the exact payload shapes the scheduler and the manual CLI
 * resume path emit via `emitEvent` parse cleanly against the registered Zod
 * schemas. Schema violations in production would fire silently as
 * `schema.violation` meta events, leaving the telemetry gap unclosed — this
 * test traps that regression at build time.
 */

import { describe, expect, test } from 'bun:test';
import { getEntry } from '../events/registry.js';

type AttemptedPayload = {
  entity_id: string;
  attempt_number: number;
  state_before: string;
  state_after: string;
  trigger: 'scheduler' | 'manual' | 'boot';
  last_error?: string;
};

type FailedPayload = AttemptedPayload & { exhausted: boolean };

describe('agent.resume.* schema contract (issue #1304)', () => {
  test('scheduler-triggered attempted payload parses', () => {
    const payload: AttemptedPayload = {
      entity_id: 'engineer-alpha',
      attempt_number: 2,
      state_before: 'error',
      state_after: 'error',
      trigger: 'scheduler',
    };
    const entry = getEntry('agent.resume.attempted')!;
    expect(entry.kind).toBe('event');
    expect(entry.schema.safeParse(payload).success).toBe(true);
  });

  test('manual-triggered attempted payload parses', () => {
    const payload: AttemptedPayload = {
      entity_id: 'qa-bravo',
      attempt_number: 1,
      state_before: 'suspended',
      state_after: 'suspended',
      trigger: 'manual',
    };
    expect(getEntry('agent.resume.attempted')!.schema.safeParse(payload).success).toBe(true);
  });

  test('succeeded payload records the spawning transition', () => {
    const payload: AttemptedPayload = {
      entity_id: 'engineer-alpha',
      attempt_number: 1,
      state_before: 'error',
      state_after: 'spawning',
      trigger: 'scheduler',
    };
    expect(getEntry('agent.resume.succeeded')!.schema.safeParse(payload).success).toBe(true);
  });

  test('failed payload requires the exhausted flag', () => {
    const entry = getEntry('agent.resume.failed')!;
    const withoutExhausted = {
      entity_id: 'engineer-alpha',
      attempt_number: 3,
      state_before: 'error',
      state_after: 'error',
      trigger: 'scheduler' as const,
      last_error: 'spawn failed: tmux session not found',
    };
    expect(entry.schema.safeParse(withoutExhausted).success).toBe(false);

    const complete: FailedPayload = { ...withoutExhausted, exhausted: true };
    expect(entry.schema.safeParse(complete).success).toBe(true);
  });

  test('last_error longer than 500 chars is rejected (caller must truncate)', () => {
    const long = 'x'.repeat(501);
    const entry = getEntry('agent.resume.failed')!;
    const result = entry.schema.safeParse({
      entity_id: 'engineer-alpha',
      attempt_number: 1,
      state_before: 'error',
      state_after: 'error',
      trigger: 'scheduler',
      last_error: long,
      exhausted: false,
    });
    expect(result.success).toBe(false);
  });

  test('entity_id is hashed at parse time (tier-A PII protection)', () => {
    const entry = getEntry('agent.resume.attempted')!;
    const parsed = entry.schema.parse({
      entity_id: 'engineer-alpha',
      attempt_number: 1,
      state_before: 'error',
      state_after: 'error',
      trigger: 'scheduler',
    }) as Record<string, unknown>;
    expect(parsed.entity_id).not.toBe('engineer-alpha');
    expect(String(parsed.entity_id)).toContain('tier-a:agent:');
  });

  test('unknown AgentState values are not allowed — caller must map to "unknown"', () => {
    const entry = getEntry('agent.resume.attempted')!;
    const result = entry.schema.safeParse({
      entity_id: 'engineer-alpha',
      attempt_number: 1,
      state_before: 'nonexistent-state',
      state_after: 'error',
      trigger: 'scheduler',
    });
    expect(result.success).toBe(false);
  });

  test('"unknown" is an allowed state fallback', () => {
    const entry = getEntry('agent.resume.attempted')!;
    const result = entry.schema.safeParse({
      entity_id: 'engineer-alpha',
      attempt_number: 1,
      state_before: 'unknown',
      state_after: 'unknown',
      trigger: 'scheduler',
    });
    expect(result.success).toBe(true);
  });
});
