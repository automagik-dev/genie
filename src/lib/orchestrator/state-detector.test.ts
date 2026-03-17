import { describe, expect, test } from 'bun:test';
import { detectState } from './state-detector.js';

describe('detectState', () => {
  test('detects permission requests', () => {
    const state = detectState('Allow bash command? [Y/n]');
    expect(state.type).toBe('permission');
    expect(state.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('detects error state', () => {
    const state = detectState('Error: module not found');
    expect(state.type).toBe('error');
    expect(state.detail).toContain('module not found');
  });

  test('detects tool use', () => {
    const state = detectState('Running command: bun test');
    expect(state.type).toBe('tool_use');
  });

  test('detects working state', () => {
    const state = detectState('Thinking...');
    expect(state.type).toBe('working');
  });

  test('detects completion state', () => {
    const state = detectState('✓ Successfully created file');
    expect(state.type).toBe('complete');
  });

  test('detects idle state', () => {
    const state = detectState('\n\n\n>\n');
    expect(state.type).toBe('idle');
  });

  test('detects idle with prompt ending', () => {
    const state = detectState('some output\n>');
    expect(state.type).toBe('idle');
  });

  test('returns unknown for ambiguous output', () => {
    const state = detectState('some random text that does not match any pattern');
    expect(state.type).toBe('unknown');
  });

  test('detects question with numbered options', () => {
    const output = 'Select an option:\n❯ 1. Option A\n  2. Option B\n  3. Option C';
    const state = detectState(output);
    expect(state.type).toBe('question');
    expect(state.options).toBeDefined();
  });

  test('detects plan approval question', () => {
    const state = detectState('Would you like to proceed?');
    expect(state.type).toBe('question');
    expect(state.detail).toBe('plan_approval');
  });

  test('detects yes/no question', () => {
    const output = 'Continue? [Y/n]';
    const state = detectState(output);
    // Could be question or permission depending on context
    expect(['question', 'permission']).toContain(state.type);
  });

  test('respects linesToAnalyze option', () => {
    const lines = Array(100).fill('some output').join('\n');
    const state = detectState(`${lines}\n>`, { linesToAnalyze: 5 });
    // With only 5 lines analyzed, should see the idle prompt at the end
    expect(state.type).toBe('idle');
  });

  test('handles ANSI escape codes in input', () => {
    const state = detectState('\x1B[31mError: bad thing\x1B[0m');
    expect(state.type).toBe('error');
  });

  test('detects API errors', () => {
    const state = detectState('API error: rate limit exceeded');
    expect(state.type).toBe('error');
  });

  test('detects file permission', () => {
    const state = detectState('Allow Edit file.ts? [Y/n]');
    expect(state.type).toBe('permission');
  });

  test('provides timestamp in result', () => {
    const before = Date.now();
    const state = detectState('some output');
    expect(state.timestamp).toBeGreaterThanOrEqual(before);
    expect(state.timestamp).toBeLessThanOrEqual(Date.now());
  });

  test('includes raw output', () => {
    const state = detectState('hello world');
    expect(state.rawOutput).toContain('hello world');
  });
});
