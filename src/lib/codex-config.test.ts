import { describe, expect, test } from 'bun:test';
import { OTEL_RELAY_PORT, getCodexConfigPath, isCodexConfigured } from './codex-config.js';

describe('OTEL_RELAY_PORT', () => {
  test('is a valid port number', () => {
    expect(OTEL_RELAY_PORT).toBe(14318);
  });
});

describe('getCodexConfigPath', () => {
  test('returns a path ending with config.toml', () => {
    const path = getCodexConfigPath();
    expect(path).toEndWith('config.toml');
    expect(path).toContain('.codex');
  });
});

describe('isCodexConfigured', () => {
  test('returns a boolean', () => {
    const result = isCodexConfigured();
    expect(typeof result).toBe('boolean');
  });
});
