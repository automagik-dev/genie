import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexDir, resolvePiExtensionsDir, resolvePiHome } from './genie-home.js';

describe('resolveCodexDir', () => {
  test('honors a non-empty override', () => {
    expect(resolveCodexDir({ CODEX_HOME: '/tmp/custom-codex' } as NodeJS.ProcessEnv, '/home/test')).toBe(
      '/tmp/custom-codex',
    );
  });

  test('empty and whitespace-only overrides fall back instead of becoming cwd-relative', () => {
    expect(resolveCodexDir({ CODEX_HOME: '' } as NodeJS.ProcessEnv, '/home/test')).toBe(join('/home/test', '.codex'));
    expect(resolveCodexDir({ CODEX_HOME: '   ' } as NodeJS.ProcessEnv, '/home/test')).toBe(
      join('/home/test', '.codex'),
    );
  });
});

describe('resolvePiHome', () => {
  test('defaults to ~/.pi', () => {
    expect(resolvePiHome({}, '/home/test')).toBe(join('/home/test', '.pi'));
  });

  test('honors the legacy $PI_HOME alias when non-empty', () => {
    expect(resolvePiHome({ PI_HOME: '/custom/pi' } as NodeJS.ProcessEnv, '/home/test')).toBe('/custom/pi');
  });

  test('empty and whitespace-only $PI_HOME overrides fall back', () => {
    expect(resolvePiHome({ PI_HOME: '' } as NodeJS.ProcessEnv, '/home/test')).toBe(join('/home/test', '.pi'));
    expect(resolvePiHome({ PI_HOME: '   ' } as NodeJS.ProcessEnv, '/home/test')).toBe(join('/home/test', '.pi'));
  });
});

describe('resolvePiExtensionsDir', () => {
  test('defaults to <piHome>/agent/extensions', () => {
    expect(resolvePiExtensionsDir({}, join('/home/test', '.pi'))).toBe(
      join('/home/test', '.pi', 'agent', 'extensions'),
    );
  });

  test('piHome derives from the legacy $PI_HOME alias when not passed explicitly', () => {
    expect(resolvePiExtensionsDir({ PI_HOME: '/custom/pi' } as NodeJS.ProcessEnv)).toBe(
      join('/custom/pi', 'agent', 'extensions'),
    );
  });

  test('$PI_CODING_AGENT_DIR (pi real override) wins over any piHome', () => {
    expect(
      resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: '/relocated/agent' } as NodeJS.ProcessEnv, join('/ignored', 'pi')),
    ).toBe(join('/relocated', 'agent', 'extensions'));
  });

  test('$PI_CODING_AGENT_DIR is tilde-expanded exactly like pi expands it', () => {
    expect(resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: '~' } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), 'extensions'),
    );
    expect(resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: '~/relocated/agent' } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), 'relocated', 'agent', 'extensions'),
    );
  });

  test('empty or whitespace-only $PI_CODING_AGENT_DIR falls back to <piHome>/agent', () => {
    expect(resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: '' } as NodeJS.ProcessEnv, join('/home/test', '.pi'))).toBe(
      join('/home/test', '.pi', 'agent', 'extensions'),
    );
    expect(resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: '   ' } as NodeJS.ProcessEnv, join('/home/test', '.pi'))).toBe(
      join('/home/test', '.pi', 'agent', 'extensions'),
    );
    expect(resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: '  ', PI_HOME: '/custom/pi' } as NodeJS.ProcessEnv)).toBe(
      join('/custom/pi', 'agent', 'extensions'),
    );
  });
});
