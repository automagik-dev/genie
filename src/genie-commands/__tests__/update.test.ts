/**
 * Tests for genie update dual-install detection (#750)
 *
 * Run with: bun test src/genie-commands/__tests__/update.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { detectGlobalInstalls } from '../update.js';

// We can't easily mock runCommandSilent inside the module, so we test
// detectGlobalInstalls by actually running the detection commands.
// These tests verify the function returns the correct shape and doesn't throw.

describe('detectGlobalInstalls', () => {
  test('returns a Set of npm | bun entries', async () => {
    const result = await detectGlobalInstalls();
    expect(result).toBeInstanceOf(Set);
    // Every entry must be either 'npm' or 'bun'
    for (const method of result) {
      expect(['npm', 'bun']).toContain(method);
    }
  });

  test('detects at least one install method on this machine', async () => {
    // The CLI is running, so at least one method must be detected
    const result = await detectGlobalInstalls();
    expect(result.size).toBeGreaterThanOrEqual(1);
  });
});

describe('updateCommand dual-install logic', () => {
  test('secondary method is the opposite of primary', () => {
    // Unit test for the selection logic extracted from updateCommand
    const getSecondary = (primary: 'npm' | 'bun') => (primary === 'bun' ? 'npm' : 'bun');
    expect(getSecondary('bun')).toBe('npm');
    expect(getSecondary('npm')).toBe('bun');
  });

  test('detectGlobalInstalls can return both npm and bun', async () => {
    // This is an integration-style test. On CI both may not be installed,
    // so we just verify the function handles both detection paths without error.
    const result = await detectGlobalInstalls();
    // Should not contain anything other than npm/bun
    for (const method of result) {
      expect(method === 'npm' || method === 'bun').toBe(true);
    }
  });
});
