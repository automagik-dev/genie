import { describe, expect, test } from 'bun:test';
import { checkCommand } from './system-detect.js';

describe('checkCommand', () => {
  test('detects existing command (bun)', async () => {
    const result = await checkCommand('bun');
    expect(result.exists).toBe(true);
    expect(result.path).toBeDefined();
    expect(result.version).toBeDefined();
  });

  test('returns false for non-existent command', async () => {
    const result = await checkCommand('nonexistent_command_xyz_12345');
    expect(result.exists).toBe(false);
  });

  test('detects git', async () => {
    const result = await checkCommand('git');
    expect(result.exists).toBe(true);
  });
});
