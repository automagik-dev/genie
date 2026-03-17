import { describe, expect, test } from 'bun:test';
import { shortcutsShowCommand } from './shortcuts.js';

describe('shortcutsShowCommand', () => {
  test('does not throw', async () => {
    // shortcutsShowCommand prints to console — just verify it doesn't crash
    await expect(shortcutsShowCommand()).resolves.toBeUndefined();
  });
});
