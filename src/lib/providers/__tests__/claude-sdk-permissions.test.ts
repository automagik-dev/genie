import { describe, expect, it } from 'bun:test';
import {
  PRESET_CHAT_ONLY,
  PRESET_FULL,
  PRESET_READ_ONLY,
  createPermissionGate,
  resolvePermissionConfig,
  resolvePreset,
  translateClaudeCodePermissions,
} from '../claude-sdk-permissions.js';

// NOTE: We intentionally avoid `import type` from @anthropic-ai/claude-agent-sdk here.
// Bun's test runner may resolve the real module even for type-only imports, poisoning the
// process-global mock.module cache used by claude-sdk.test.ts and claude-sdk-resume.test.ts.
// Instead we use inline structural types that match the SDK's shapes.

type HookInput = {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
};

type HookOutput = {
  hookSpecificOutput?: Record<string, unknown>;
};

/** Build a minimal PreToolUseHookInput for testing. */
function hookInput(toolName: string, toolInput: Record<string, unknown> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test',
    session_id: 'test',
    transcript_path: '',
    cwd: '',
  };
}

/** Call the gate with standard test args and return the result. */
async function callGate(
  gate: ReturnType<typeof createPermissionGate>,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<HookOutput> {
  return gate(hookInput(toolName, toolInput) as any, 'test', {
    signal: new AbortController().signal,
  }) as Promise<HookOutput>;
}

/** Extract permissionDecision from gate result. */
function decision(result: HookOutput): string {
  return (result.hookSpecificOutput as any).permissionDecision;
}

/** Extract permissionDecisionReason from gate result. */
function reason(result: HookOutput): string | undefined {
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

describe('translateClaudeCodePermissions', () => {
  it('extracts Bash() patterns into bashAllowPatterns as regex', () => {
    const result = translateClaudeCodePermissions({
      allow: ['Read', 'Grep', 'Bash(omni say *)'],
    });
    expect(result.allow).toContain('Read');
    expect(result.allow).toContain('Grep');
    expect(result.allow).toContain('Bash');
    expect(result.bashAllowPatterns).toBeDefined();
    expect(result.bashAllowPatterns!.length).toBe(1);
    // Should match "omni say hello"
    expect('omni say hello').toMatch(new RegExp(result.bashAllowPatterns![0]));
    // Should not match "rm -rf /"
    expect('rm -rf /').not.toMatch(new RegExp(result.bashAllowPatterns![0]));
  });

  it('handles multiple Bash() patterns', () => {
    const result = translateClaudeCodePermissions({
      allow: ['Bash(git *)', 'Bash(omni *)'],
    });
    expect(result.allow).toEqual(['Bash']);
    expect(result.bashAllowPatterns!.length).toBe(2);
    expect('git status').toMatch(new RegExp(result.bashAllowPatterns![0]));
    expect('omni send hi').toMatch(new RegExp(result.bashAllowPatterns![1]));
  });

  it('handles bare tool names without Bash() patterns', () => {
    const result = translateClaudeCodePermissions({
      allow: ['Read', 'Glob', 'Grep'],
    });
    expect(result.allow).toEqual(['Read', 'Glob', 'Grep']);
    expect(result.bashAllowPatterns).toBeUndefined();
  });

  it('handles bare Bash (no parentheses) as unrestricted', () => {
    const result = translateClaudeCodePermissions({
      allow: ['Read', 'Bash'],
    });
    expect(result.allow).toEqual(['Read', 'Bash']);
    expect(result.bashAllowPatterns).toBeUndefined();
  });

  it('defaults to wildcard allow when allow list is empty', () => {
    const result = translateClaudeCodePermissions({ allow: [] });
    expect(result.allow).toEqual(['*']);
  });

  it('defaults to wildcard allow when no allow provided', () => {
    const result = translateClaudeCodePermissions({});
    expect(result.allow).toEqual(['*']);
  });
});

describe('resolvePermissionConfig — Claude Code format detection', () => {
  it('detects Claude Code format with Bash() patterns and translates', () => {
    const result = resolvePermissionConfig({
      allow: ['Read', 'Bash(omni say *)'],
    });
    expect(result.allow).toContain('Read');
    expect(result.allow).toContain('Bash');
    expect(result.bashAllowPatterns).toBeDefined();
  });

  it('passes through legacy SDK format (with bashAllowPatterns) unchanged', () => {
    const result = resolvePermissionConfig({
      allow: ['Read', 'Bash'],
      bashAllowPatterns: ['^git\\s'],
    });
    expect(result.allow).toEqual(['Read', 'Bash']);
    expect(result.bashAllowPatterns).toEqual(['^git\\s']);
  });

  it('resolves preset even when other fields present', () => {
    const result = resolvePermissionConfig({
      preset: 'read-only',
      allow: ['Bash'],
    });
    expect(result).toBe(PRESET_READ_ONLY);
  });

  it('falls back to PRESET_FULL when no permissions', () => {
    expect(resolvePermissionConfig()).toBe(PRESET_FULL);
    expect(resolvePermissionConfig(undefined)).toBe(PRESET_FULL);
  });

  it('detects Claude Code format with deny field', () => {
    const result = resolvePermissionConfig({
      allow: ['Read', 'Glob'],
      deny: ['Write'],
    });
    // deny triggers CC format detection → translateClaudeCodePermissions
    expect(result.allow).toContain('Read');
    expect(result.allow).toContain('Glob');
  });
});
