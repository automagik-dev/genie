import { describe, expect, it } from 'bun:test';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import {
  PRESET_CHAT_ONLY,
  PRESET_FULL,
  PRESET_READ_ONLY,
  createPermissionGate,
  resolvePreset,
} from '../claude-sdk-permissions.js';

/** Build a minimal PreToolUseHookInput for testing. */
function hookInput(toolName: string, toolInput: Record<string, unknown> = {}): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test',
    session_id: 'test',
    transcript_path: '',
    cwd: '',
  } as PreToolUseHookInput;
}

/** Call the gate with standard test args and return the result. */
async function callGate(
  gate: ReturnType<typeof createPermissionGate>,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<SyncHookJSONOutput> {
  return gate(hookInput(toolName, toolInput), 'test', {
    signal: new AbortController().signal,
  }) as Promise<SyncHookJSONOutput>;
}

/** Extract permissionDecision from gate result. */
function decision(result: SyncHookJSONOutput): string {
  return (result.hookSpecificOutput as any).permissionDecision;
}

/** Extract permissionDecisionReason from gate result. */
function reason(result: SyncHookJSONOutput): string | undefined {
  return (result.hookSpecificOutput as any).permissionDecisionReason;
}

describe('Permission Presets', () => {
  it('PRESET_FULL allows everything via wildcard', () => {
    expect(PRESET_FULL.allow).toEqual(['*']);
  });

  it('PRESET_READ_ONLY allows Read/Glob/Grep/WebFetch only', () => {
    expect(PRESET_READ_ONLY.allow).toEqual(['Read', 'Glob', 'Grep', 'WebFetch']);
  });

  it('PRESET_CHAT_ONLY allows SendMessage/Read only', () => {
    expect(PRESET_CHAT_ONLY.allow).toEqual(['SendMessage', 'Read']);
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
      expect(decision(await callGate(gate, 'Bash'))).toBe('allow');
      expect(decision(await callGate(gate, 'Edit'))).toBe('allow');
      expect(decision(await callGate(gate, 'Write'))).toBe('allow');
      expect(decision(await callGate(gate, 'Agent'))).toBe('allow');
    });
  });

  describe('PRESET_READ_ONLY gate', () => {
    it('allows Read, Glob, Grep, WebFetch', async () => {
      const gate = createPermissionGate(PRESET_READ_ONLY);
      for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch']) {
        expect(decision(await callGate(gate, tool))).toBe('allow');
      }
    });

    it('denies Bash, Edit, Write, Agent (not in allow list)', async () => {
      const gate = createPermissionGate(PRESET_READ_ONLY);
      for (const tool of ['Bash', 'Edit', 'Write', 'Agent']) {
        expect(decision(await callGate(gate, tool))).toBe('deny');
      }
    });
  });

  describe('PRESET_CHAT_ONLY gate', () => {
    it('allows SendMessage, Read', async () => {
      const gate = createPermissionGate(PRESET_CHAT_ONLY);
      expect(decision(await callGate(gate, 'SendMessage'))).toBe('allow');
      expect(decision(await callGate(gate, 'Read'))).toBe('allow');
    });

    it('denies everything else', async () => {
      const gate = createPermissionGate(PRESET_CHAT_ONLY);
      for (const tool of ['Bash', 'Edit', 'Write', 'Agent', 'Glob', 'Grep']) {
        expect(decision(await callGate(gate, tool))).toBe('deny');
      }
    });
  });

  describe('custom allow list', () => {
    it('allows tools in list', async () => {
      const gate = createPermissionGate({ allow: ['Read', 'Bash'] });
      expect(decision(await callGate(gate, 'Read'))).toBe('allow');
      expect(decision(await callGate(gate, 'Bash'))).toBe('allow');
    });

    it('denies tools not in list', async () => {
      const gate = createPermissionGate({ allow: ['Read', 'Bash'] });
      const result = await callGate(gate, 'Write');
      expect(decision(result)).toBe('deny');
      expect(reason(result)).toContain('not allowed');
    });
  });

  describe('Bash command pattern inspection', () => {
    it('allows when command matches an allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git\\s'],
      });
      const result = await callGate(gate, 'Bash', { command: 'git status' });
      expect(decision(result)).toBe('allow');
    });

    it('denies when command matches no allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git\\s'],
      });
      const result = await callGate(gate, 'Bash', { command: 'npm install' });
      expect(decision(result)).toBe('deny');
    });

    it('denies shell metacharacters unless full match on allow pattern', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git status$'],
      });

      // Compound command with && — should deny because full command does not match
      const result = await callGate(gate, 'Bash', { command: 'git status && rm -rf /' });
      expect(decision(result)).toBe('deny');
    });

    it('allows shell metacharacter command when full match succeeds', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git status && git diff$'],
      });
      const result = await callGate(gate, 'Bash', { command: 'git status && git diff' });
      expect(decision(result)).toBe('allow');
    });

    it('allows Bash with no patterns configured (tool-level allow is sufficient)', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
      });
      const result = await callGate(gate, 'Bash', { command: 'anything' });
      expect(decision(result)).toBe('allow');
    });
  });

  describe('edge cases — empty/missing bash command', () => {
    it('denies Bash with empty command string when patterns are configured', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git\\s'],
      });
      const result = await callGate(gate, 'Bash', { command: '' });
      expect(decision(result)).toBe('deny');
    });

    it('denies Bash with undefined command when patterns are configured', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git\\s'],
      });
      const result = await callGate(gate, 'Bash', {});
      expect(decision(result)).toBe('deny');
    });

    it('denies Bash with non-string command (number) when patterns are configured', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^git\\s'],
      });
      const result = await callGate(gate, 'Bash', { command: 42 });
      expect(decision(result)).toBe('deny');
    });
  });

  describe('edge cases — wildcard allow', () => {
    it('wildcard allows everything including Bash', async () => {
      const gate = createPermissionGate({ allow: ['*'] });
      expect(decision(await callGate(gate, 'Bash', { command: 'rm -rf /' }))).toBe('allow');
      expect(decision(await callGate(gate, 'Edit'))).toBe('allow');
      expect(decision(await callGate(gate, 'Write'))).toBe('allow');
    });
  });

  describe('edge cases — invalid regex in patterns', () => {
    it('falls back to substring match when allow pattern is invalid regex', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['git status [ok'],
      });
      // Invalid regex → substring match
      const result = await callGate(gate, 'Bash', { command: 'git status [ok' });
      expect(decision(result)).toBe('allow');
    });
  });

  describe('edge cases — deny message content', () => {
    it('deny reason includes tool name for non-allowed tool', async () => {
      const gate = createPermissionGate({ allow: ['Read'] });
      const result = await callGate(gate, 'Agent');
      expect(decision(result)).toBe('deny');
      expect(reason(result)).toContain('Agent');
      expect(reason(result)).toContain('not allowed');
    });

    it('deny reason includes command for bash pattern mismatch', async () => {
      const gate = createPermissionGate({
        allow: ['Bash'],
        bashAllowPatterns: ['^echo\\s'],
      });
      const result = await callGate(gate, 'Bash', { command: 'curl http://example.com' });
      expect(decision(result)).toBe('deny');
      expect(reason(result)).toContain('curl');
    });
  });
});
