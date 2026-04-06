import { describe, expect, test } from 'bun:test';
import { migrateWorkspaceConfig, validateWorkspaceDefaults } from '../lib/workspace.js';

describe('migrateWorkspaceConfig', () => {
  test('flat shape with tmuxSocket migrates to tmux.socket', () => {
    const raw = { name: 'my-ws', tmuxSocket: 'genie' };
    const result = migrateWorkspaceConfig(raw);
    expect(result.tmux?.socket).toBe('genie');
    expect(result.agents).toBeDefined();
    expect(result.sdk).toBeDefined();
  });

  test('already-sectioned input is idempotent', () => {
    const raw = {
      name: 'my-ws',
      agents: { defaults: { model: 'sonnet' } },
      tmux: { socket: 'custom' },
      sdk: { maxTurns: 10 },
    };
    const result = migrateWorkspaceConfig(raw);
    expect(result.agents?.defaults?.model).toBe('sonnet');
    expect(result.tmux?.socket).toBe('custom');
    expect(result.sdk?.maxTurns).toBe(10);
  });

  test('missing sections added as empty objects', () => {
    const raw = { name: 'my-ws' };
    const result = migrateWorkspaceConfig(raw);
    expect(result.agents).toEqual({ defaults: {} });
    expect(result.tmux).toEqual({});
    expect(result.sdk).toEqual({});
  });

  test('no data loss: all original fields preserved', () => {
    const raw = { name: 'my-ws', pgUrl: 'postgres://localhost/genie', tmuxSocket: 'genie', daemonPid: 42 };
    const result = migrateWorkspaceConfig(raw);
    expect(result.name).toBe('my-ws');
    expect(result.pgUrl).toBe('postgres://localhost/genie');
    expect(result.daemonPid).toBe(42);
    // tmuxSocket still present (for backward compat), tmux.socket also set
    expect(result.tmuxSocket).toBe('genie');
    expect(result.tmux?.socket).toBe('genie');
  });

  test('flat tmuxSocket does not overwrite existing tmux section', () => {
    const raw = { name: 'my-ws', tmuxSocket: 'old', tmux: { socket: 'new' } };
    const result = migrateWorkspaceConfig(raw);
    expect(result.tmux?.socket).toBe('new');
  });

  test('agents.defaults preserved through migration', () => {
    const raw = { name: 'my-ws', agents: { defaults: { model: 'haiku', color: 'red' } } };
    const result = migrateWorkspaceConfig(raw);
    expect(result.agents?.defaults?.model).toBe('haiku');
    expect(result.agents?.defaults?.color).toBe('red');
  });
});

describe('validateWorkspaceDefaults', () => {
  test('valid defaults pass validation', () => {
    const config = migrateWorkspaceConfig({ name: 'ws', agents: { defaults: { model: 'sonnet' } } });
    expect(() => validateWorkspaceDefaults(config)).not.toThrow();
  });

  test('empty defaults pass validation', () => {
    const config = migrateWorkspaceConfig({ name: 'ws' });
    expect(() => validateWorkspaceDefaults(config)).not.toThrow();
  });

  test('invalid model type throws', () => {
    const config = migrateWorkspaceConfig({ name: 'ws', agents: { defaults: { model: 42 } } });
    expect(() => validateWorkspaceDefaults(config)).toThrow('Invalid agents.defaults');
  });

  test('unknown field in agents.defaults throws (strict)', () => {
    const config = migrateWorkspaceConfig({ name: 'ws', agents: { defaults: { bogus: 'value' } } });
    expect(() => validateWorkspaceDefaults(config)).toThrow('Invalid agents.defaults');
  });
});
