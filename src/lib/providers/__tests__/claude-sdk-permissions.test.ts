import { describe, expect, it } from 'bun:test';
import {
  PRESET_CHAT_ONLY,
  PRESET_FULL,
  PRESET_READ_ONLY,
  createPermissionGate,
  resolvePreset,
} from '../claude-sdk-permissions.js';

/** Minimal valid options for the CanUseTool callback's third parameter. */
const opts = { signal: AbortSignal.abort(), toolUseID: 'test-tool-use-id' } as any;

describe('Permission Presets', () => {
  it('PRESET_FULL allows everything via wildcard', () => {
    expect(PRESET_FULL.allow).toEqual(['*']);
    expect(PRESET_FULL.deny).toEqual([]);
  });

  it('PRESET_READ_ONLY allows Read/Glob/Grep/WebFetch only', () => {
    expect(PRESET_READ_ONLY.allow).toEqual(['Read', 'Glob', 'Grep', 'WebFetch']);
    expect(PRESET_READ_ONLY.deny).toEqual([]);
  });

  it('PRESET_CHAT_ONLY allows SendMessage/Read only', () => {
    expect(PRESET_CHAT_ONLY.allow).toEqual(['SendMessage', 'Read']);
    expect(PRESET_CHAT_ONLY.deny).toEqual([]);
  });
});

describe('resolvePreset', () => {
  it('resolves "read-only" to PRESET_READ_ONLY', () => {
    expect(resolvePreset('read-only')).toBe(PRESET_READ_ONLY);
  });

  it('resolves "full" to PRESET_FULL', () => {
    expect(resolvePreset('full')).toBe(PRESET_FULL);
  });

  it('resolves "chat-only" to PRESET_CHAT_ONLY', () => {
    expect(resolvePreset('chat-only')).toBe(PRESET_CHAT_ONLY);
  });

  it('throws on unknown preset', () => {
    expect(() => resolvePreset('unknown')).toThrow('Unknown permission preset "unknown"');
  });
});

describe('createPermissionGate', () => {
  describe('PRESET_FULL gate', () => {
    it('allows any tool', async () => {
      const gate = createPermissionGate(PRESET_FULL);
      expect(await gate('Bash', {}, opts)).toEqual({ behavior: 'allow' });
      expect(await gate('Edit', {}, opts)).toEqual({ behavior: 'allow' });
      expect(await gate('Write', {}, opts)).toEqual({ behavior: 'allow' });
      expect(await gate('Agent', {}, opts)).toEqual({ behavior: 'allow' });
    });
  });

  describe('PRESET_READ_ONLY gate', () => {
    it('allows Read, Glob, Grep, WebFetch', async () => {
      const gate = createPermissionGate(PRESET_READ_ONLY);
      for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch']) {
        const result = await gate(tool, {}, opts);
        expect(result.behavior).toBe('allow');
      }
    });

    it('denies Bash, Edit, Write, Agent', async () => {
      const gate = createPermissionGate(PRESET_READ_ONLY);
      for (const tool of ['Bash', 'Edit', 'Write', 'Agent']) {
        const result = await gate(tool, {}, opts);
        expect(result.behavior).toBe('deny');
      }
    });
  });

  describe('PRESET_CHAT_ONLY gate', () => {
    it('allows SendMessage, Read', async () => {
      const gate = createPermissionGate(PRESET_CHAT_ONLY);
      expect((await gate('SendMessage', {}, opts)).behavior).toBe('allow');
      expect((await gate('Read', {}, opts)).behavior).toBe('allow');
    });

    it('denies everything else', async () => {
      const gate = createPermissionGate(PRESET_CHAT_ONLY);
      for (const tool of ['Bash', 'Edit', 'Write', 'Agent', 'Glob', 'Grep']) {
        expect((await gate(tool, {}, opts)).behavior).toBe('deny');
      }
    });
  });

  describe('custom allow list', () => {
    it('allows tools in list', async () => {
      const gate = createPermissionGate({ allow: ['Read', 'Bash'], deny: [] });
      expect((await gate('Read', {}, opts)).behavior).toBe('allow');
    });

    it('denies tools not in list', async () => {
      const gate = createPermissionGate({ allow: ['Read', 'Bash'], deny: [] });
      const result = await gate('Write', {}, opts);
      expect(result.behavior).toBe('deny');
    });
  });

  describe('deny list overrides allow', () => {
    it('denies a tool even if it is in the allow list', async () => {
      const gate = createPermissionGate({ allow: ['Read', 'Bash'], deny: ['Bash'] });
      const result = await gate('Bash', { command: 'ls' }, opts);
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('denied by permission config');
    });
  });

  describe('Bash command pattern inspection', () => {
    it('denies when command matches a deny pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
        bashAllowPatterns: ['.*'],
        bashDenyPatterns: ['rm -rf'],
      });
      const result = await gate('Bash', { command: 'rm -rf /' }, opts);
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('deny pattern');
    });

    it('allows when command matches an allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
        bashAllowPatterns: ['^git\\s'],
        bashDenyPatterns: [],
      });
      const result = await gate('Bash', { command: 'git status' }, opts);
      expect(result.behavior).toBe('allow');
    });

    it('denies when command matches no allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
        bashAllowPatterns: ['^git\\s'],
        bashDenyPatterns: [],
      });
      const result = await gate('Bash', { command: 'npm install' }, opts);
      expect(result.behavior).toBe('deny');
    });

    it('denies shell metacharacters unless full match on allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
        bashAllowPatterns: ['^git status$'],
        bashDenyPatterns: [],
      });

      // Compound command with && — should deny because full command does not match
      const result = await gate('Bash', { command: 'git status && rm -rf /' }, opts);
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('compound command');
    });

    it('allows shell metacharacter command when full match succeeds', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
        bashAllowPatterns: ['^git status && git diff$'],
        bashDenyPatterns: [],
      });
      const result = await gate('Bash', { command: 'git status && git diff' }, opts);
      expect(result.behavior).toBe('allow');
    });

    it('deny pattern wins over allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
        bashAllowPatterns: ['^git\\s'],
        bashDenyPatterns: ['git push --force'],
      });
      const result = await gate('Bash', { command: 'git push --force' }, opts);
      expect(result.behavior).toBe('deny');
    });

    it('allows Bash with no patterns configured (tool-level allow is sufficient)', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        deny: [],
      });
      const result = await gate('Bash', { command: 'anything' }, opts);
      expect(result.behavior).toBe('allow');
    });
  });
});
