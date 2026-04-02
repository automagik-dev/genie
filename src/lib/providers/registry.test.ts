/**
 * Provider Registry — Unit Tests
 */

import { describe, expect, it } from 'bun:test';
import type { ExecutorProvider } from '../executor-types.js';
import { getProvider, listProviders, registerProvider } from './registry.js';

// ============================================================================
// Registry Tests
// ============================================================================

describe('Provider Registry', () => {
  it('resolves claude to ClaudeCodeProvider', () => {
    const provider = getProvider('claude');
    expect(provider).toBeDefined();
    expect(provider!.name).toBe('claude-code');
    expect(provider!.transport).toBe('tmux');
  });

  it('resolves codex to CodexProvider', () => {
    const provider = getProvider('codex');
    expect(provider).toBeDefined();
    expect(provider!.name).toBe('codex');
    expect(provider!.transport).toBe('api');
  });

  it('returns undefined for unknown provider', () => {
    const provider = getProvider('unknown' as any);
    expect(provider).toBeUndefined();
  });

  it('listProviders returns both providers', () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2);
    const names = providers.map((p) => p.name);
    expect(names).toContain('claude-code');
    expect(names).toContain('codex');
  });

  it('registerProvider overwrites existing provider', () => {
    const mock: ExecutorProvider = {
      name: 'codex',
      transport: 'process',
      buildSpawnCommand: () => ({ command: 'mock', provider: 'codex', meta: {} }),
      extractSession: async () => null,
      detectState: async () => 'idle',
      terminate: async () => {},
      canResume: () => false,
    };

    registerProvider(mock);
    const provider = getProvider('codex');
    expect(provider!.transport).toBe('process');

    // Restore original
    const { CodexProvider } = require('./codex.js');
    registerProvider(new CodexProvider());
    expect(getProvider('codex')!.transport).toBe('api');
  });

  it('claude provider supports resume', () => {
    const claude = getProvider('claude')!;
    expect(claude.canResume()).toBe(true);
    expect(typeof claude.buildResumeCommand).toBe('function');
  });

  it('codex provider does not support resume', () => {
    const codex = getProvider('codex')!;
    expect(codex.canResume()).toBe(false);
    expect(codex.buildResumeCommand).toBeUndefined();
  });
});
