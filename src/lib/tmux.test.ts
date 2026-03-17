import { describe, expect, test } from 'bun:test';
import { isPaneAlive } from './tmux.js';

describe('isPaneAlive', () => {
  test('returns false for empty pane ID', async () => {
    expect(await isPaneAlive('')).toBe(false);
  });

  test('returns false for inline transport', async () => {
    expect(await isPaneAlive('inline')).toBe(false);
  });

  test('returns false for invalid pane ID format', async () => {
    expect(await isPaneAlive('not-a-pane')).toBe(false);
    expect(await isPaneAlive('123')).toBe(false);
    expect(await isPaneAlive('%abc')).toBe(false);
  });

  test('returns false for non-existent pane', async () => {
    // %999999 is very unlikely to exist
    expect(await isPaneAlive('%999999')).toBe(false);
  });
});
