/**
 * Codex state detector — pattern matching unit tests.
 *
 * Group 1 of codex-provider-parity wish.
 *
 * Run with: bun test src/lib/orchestrator/codex-state.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { detectCodexState, mapCodexToExecutorState } from './codex-state.js';

describe('detectCodexState', () => {
  describe('permission states', () => {
    test('matches "Press enter to confirm or esc to cancel"', () => {
      const tail = `
some output

Press enter to confirm or esc to cancel
`;
      const result = detectCodexState(tail);
      expect(result.type).toBe('permission');
      expect(result.detail).toContain('enter-or-esc');
    });

    test('matches "Would you like to run"', () => {
      const tail = `
• exec
Would you like to run this command?
`;
      const result = detectCodexState(tail);
      expect(result.type).toBe('permission');
    });
  });

  describe('working states', () => {
    test('matches spinner glyph ⠋', () => {
      const tail = '⠋ thinking...';
      const result = detectCodexState(tail);
      expect(result.type).toBe('working');
      expect(result.detail).toContain('spinner');
    });

    test('matches spinner glyph ◐', () => {
      const result = detectCodexState('processing ◐ stand by');
      expect(result.type).toBe('working');
    });

    test('matches "esc to interrupt" affordance', () => {
      const result = detectCodexState('working on response (esc to interrupt)');
      expect(result.type).toBe('working');
      expect(result.detail).toContain('esc-to-interrupt');
    });

    test('falls through to working when tail is non-empty but no recognizable signal', () => {
      const result = detectCodexState('plain text output with no markers');
      expect(result.type).toBe('working');
      expect(result.detail).toContain('between-turns');
    });

    test('working takes precedence over the prompt glyph', () => {
      // The `›` prompt placeholder can be visible WHILE codex is processing.
      // Spinner / esc-to-interrupt must win.
      const tail = `
› user input here
⠋ processing
`;
      const result = detectCodexState(tail);
      expect(result.type).toBe('working');
    });
  });

  describe('idle states', () => {
    test('matches `›` prompt at start of a line', () => {
      const tail = `
some response
›
gpt-5.3-codex · ~/path
`;
      const result = detectCodexState(tail);
      expect(result.type).toBe('idle');
      expect(result.detail).toContain('prompt');
    });

    test('matches `>` prompt at start of a line (ASCII fallback)', () => {
      const result = detectCodexState('output\n> \n');
      expect(result.type).toBe('idle');
    });

    test('idle requires the prompt at line start, not mid-content', () => {
      // A `›` mid-text shouldn't trigger idle.
      const result = detectCodexState('some text › with arrow inline');
      expect(result.type).toBe('working');
    });
  });

  describe('edge cases', () => {
    test('empty input returns unknown', () => {
      const result = detectCodexState('');
      expect(result.type).toBe('unknown');
    });

    test('whitespace-only input returns unknown', () => {
      const result = detectCodexState('   \n\n  \t  ');
      expect(result.type).toBe('unknown');
    });
  });
});

describe('mapCodexToExecutorState', () => {
  test('working -> working', () => {
    expect(mapCodexToExecutorState('working')).toBe('working');
  });
  test('idle -> idle', () => {
    expect(mapCodexToExecutorState('idle')).toBe('idle');
  });
  test('permission -> permission', () => {
    expect(mapCodexToExecutorState('permission')).toBe('permission');
  });
  test('unknown -> idle (graceful fallback)', () => {
    expect(mapCodexToExecutorState('unknown')).toBe('idle');
  });
});
