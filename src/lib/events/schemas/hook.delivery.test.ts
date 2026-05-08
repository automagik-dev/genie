/**
 * Tests for hook.delivery schema — closes #1492.
 *
 * The strict schema previously did not list `event` as a valid key. After
 * #1485 (hookify-perf-foundation) shipped `runHandler()` stamping
 * `event: payload.hook_event_name` on every span, the strict-mode parser
 * rejected every emission with `unrecognized key 'event'`, leaving the
 * `hook_perf_baseline` view empty regardless of dispatch activity.
 */

import { describe, expect, test } from 'bun:test';
import { schema } from './hook.delivery.js';

describe('hook.delivery schema (closes #1492)', () => {
  test('accepts payload WITH the new event key (post-#1485 emitter shape)', () => {
    const result = schema.safeParse({
      hook_name: 'session-sync-tool',
      agent_id: 'genie/dog-fooder-11eb',
      tool: 'Bash',
      event: 'PreToolUse',
      status: 'ok',
      duration_ms: 12,
    });
    expect(result.success).toBe(true);
  });

  test('still accepts payload WITHOUT the event key (backward compat)', () => {
    const result = schema.safeParse({
      hook_name: 'session-sync-tool',
      agent_id: 'genie/dog-fooder-11eb',
      tool: 'Bash',
      status: 'ok',
      duration_ms: 12,
    });
    expect(result.success).toBe(true);
  });

  test('accepts tool-less hook events (UserPromptSubmit, Stop) with event but no tool', () => {
    const result = schema.safeParse({
      hook_name: 'session-sync-prompt',
      agent_id: 'genie/dog-fooder-11eb',
      event: 'UserPromptSubmit',
      status: 'ok',
      duration_ms: 8,
    });
    expect(result.success).toBe(true);
  });

  test('rejects unknown keys (strict mode preserved)', () => {
    const result = schema.safeParse({
      hook_name: 'session-sync-tool',
      agent_id: 'genie/dog-fooder-11eb',
      tool: 'Bash',
      event: 'PreToolUse',
      status: 'ok',
      duration_ms: 12,
      // Random extra key — should still be rejected
      mystery_field: 'value',
    });
    expect(result.success).toBe(false);
  });

  test('rejects oversized event names (>64 chars)', () => {
    const result = schema.safeParse({
      hook_name: 'session-sync-tool',
      agent_id: 'genie/dog-fooder-11eb',
      tool: 'Bash',
      event: 'A'.repeat(65),
      status: 'ok',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty event names', () => {
    const result = schema.safeParse({
      hook_name: 'session-sync-tool',
      agent_id: 'genie/dog-fooder-11eb',
      tool: 'Bash',
      event: '',
      status: 'ok',
    });
    expect(result.success).toBe(false);
  });
});
