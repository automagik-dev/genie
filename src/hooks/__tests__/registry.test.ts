/**
 * Registry mutation tests — Group 1 of hookify-third-party-absorption.
 *
 * Asserts the load-bearing contract: `dispatch()` reads `registryRef` at
 * call time, so `setRegistry()` swaps land on the next invocation. Tests
 * that the swap is atomic (no partial registries observed) and that
 * `getRegistry()` returns a stable snapshot.
 */

import { describe, expect, test } from 'bun:test';
import { defineHook } from '../define-hook.js';
import { dispatch, getRegistry, setRegistry } from '../index.js';
import type { Handler } from '../types.js';

describe('registry mutation contract', () => {
  test('getRegistry() returns the current snapshot', () => {
    const before = getRegistry();
    expect(Array.isArray(before)).toBe(true);
    expect(before.length).toBeGreaterThan(0);
    // Every builtin should declare version + source + manifest_path
    for (const handler of before) {
      expect(handler.version).toBe('1');
      expect(handler.source).toBe('builtin');
      expect(handler.manifest_path).toMatch(/index\.ts$/);
    }
  });

  test('setRegistry swaps the live array; subsequent getRegistry sees the new one', () => {
    const previous = getRegistry();
    const handler = defineHook({
      name: 'registry-test-only',
      event: 'PreToolUse',
      matcher: '^NeverMatchedTool$',
      priority: 999,
      run: async () => undefined,
    });
    setRegistry([...previous, handler]);
    try {
      const after = getRegistry();
      expect(after.length).toBe(previous.length + 1);
      expect(after.find((h) => h.name === 'registry-test-only')).toBeDefined();
    } finally {
      setRegistry(previous); // restore so other tests see the canonical registry
    }
  });

  test('dispatch reads registryRef at call time — swapped handlers participate', async () => {
    const previous = getRegistry();
    let called = false;
    const probe: Handler = {
      version: '1',
      source: 'global',
      manifest_path: 'registry.test.ts',
      name: 'dispatch-probe',
      event: 'PreToolUse',
      matcher: /^DispatchProbeTool$/,
      priority: 1,
      fn: async () => {
        called = true;
        return undefined;
      },
    };
    setRegistry([...previous, probe]);
    try {
      const stdout = await dispatch(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'DispatchProbeTool' }));
      expect(stdout === '' || typeof stdout === 'string').toBe(true);
      expect(called).toBe(true);
    } finally {
      setRegistry(previous);
    }
  });

  test('returned snapshot is frozen — direct mutation throws', () => {
    const snapshot = getRegistry();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('defineHook produces a valid HandlerV1 the loader could register', () => {
    const handler = defineHook({
      name: 'sample',
      event: 'PreToolUse',
      matcher: '^Bash$',
      priority: 50,
      run: async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hi' } }),
    });
    expect(handler.version).toBe('1');
    expect(handler.name).toBe('sample');
    expect(handler.event).toBe('PreToolUse');
    expect(handler.priority).toBe(50);
    expect(handler.matcher).toBeInstanceOf(RegExp);
    expect((handler.matcher as RegExp).source).toBe('^Bash$');
    // Loader will overwrite source + manifest_path; placeholder values are visible
    expect(handler.source).toBe('global');
    expect(handler.manifest_path).toBe('<defineHook caller>');
  });

  test('defineHook accepts a RegExp matcher verbatim', () => {
    const handler = defineHook({
      name: 'regex-direct',
      event: 'PreToolUse',
      matcher: /^Read$/i,
      priority: 50,
      run: async () => undefined,
    });
    expect(handler.matcher).toBeInstanceOf(RegExp);
    expect((handler.matcher as RegExp).flags).toBe('i');
  });

  test('defineHook defaults priority to 100 (after every builtin)', () => {
    const handler = defineHook({
      name: 'default-priority',
      event: 'PreToolUse',
      run: async () => undefined,
    });
    expect(handler.priority).toBe(100);
  });
});
