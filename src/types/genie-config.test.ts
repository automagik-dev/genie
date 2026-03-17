import { describe, expect, test } from 'bun:test';
import {
  CouncilPresetSchema,
  GenieConfigSchema,
  ShortcutsConfigSchema,
  TerminalConfigSchema,
  WorkerProfileSchema,
} from './genie-config.js';

describe('GenieConfigSchema', () => {
  test('parses empty object with defaults', () => {
    const config = GenieConfigSchema.parse({});
    expect(config.version).toBe(2);
    expect(config.setupComplete).toBe(false);
    expect(config.promptMode).toBe('append');
    expect(config.autoMergeDev).toBe(false);
  });

  test('parses full config', () => {
    const config = GenieConfigSchema.parse({
      version: 2,
      setupComplete: true,
      updateChannel: 'next',
    });
    expect(config.setupComplete).toBe(true);
    expect(config.updateChannel).toBe('next');
  });
});

describe('TerminalConfigSchema', () => {
  test('provides default values', () => {
    const config = TerminalConfigSchema.parse({});
    expect(config.execTimeout).toBe(120000);
    expect(config.readLines).toBe(100);
  });
});

describe('ShortcutsConfigSchema', () => {
  test('provides default values', () => {
    const config = ShortcutsConfigSchema.parse({});
    expect(config.tmuxInstalled).toBe(false);
    expect(config.shellInstalled).toBe(false);
  });
});

describe('WorkerProfileSchema', () => {
  test('parses valid profile', () => {
    const profile = WorkerProfileSchema.parse({
      launcher: 'claude',
      claudeArgs: ['--model', 'opus'],
    });
    expect(profile.launcher).toBe('claude');
    expect(profile.claudeArgs).toEqual(['--model', 'opus']);
  });

  test('migrates legacy claudio launcher to claude', () => {
    const profile = WorkerProfileSchema.parse({
      launcher: 'claudio',
      claudeArgs: [],
    });
    expect(profile.launcher).toBe('claude');
  });
});

describe('CouncilPresetSchema', () => {
  test('parses preset with defaults', () => {
    const preset = CouncilPresetSchema.parse({
      left: 'opus',
      right: 'sonnet',
    });
    expect(preset.left).toBe('opus');
    expect(preset.right).toBe('sonnet');
    expect(preset.skill).toBe('council');
  });
});
