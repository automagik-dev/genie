import { describe, expect, test } from 'bun:test';
import { buildSdkConfig, validateRepoPath } from './dir.js';

describe('validateRepoPath', () => {
  test('accepts absolute paths', () => {
    expect(() => validateRepoPath('/home/user/project')).not.toThrow();
    expect(() => validateRepoPath('/tmp/repo')).not.toThrow();
  });

  test('accepts home-relative paths', () => {
    expect(() => validateRepoPath('~/projects/app')).not.toThrow();
    expect(() => validateRepoPath('~/repo')).not.toThrow();
  });

  test('accepts dot-relative paths', () => {
    expect(() => validateRepoPath('./local-repo')).not.toThrow();
    expect(() => validateRepoPath('../sibling-repo')).not.toThrow();
  });

  test('rejects bare words', () => {
    expect(() => validateRepoPath('genie')).toThrow(/Invalid --repo value/);
    expect(() => validateRepoPath('my-project')).toThrow(/Invalid --repo value/);
  });

  test('rejects URLs', () => {
    expect(() => validateRepoPath('https://github.com/org/repo')).toThrow(/Invalid --repo value/);
  });

  test('rejects git SSH URLs', () => {
    expect(() => validateRepoPath('git@github.com:org/repo.git')).toThrow(/Invalid --repo value/);
  });
});

describe('buildSdkConfig', () => {
  test('returns undefined when no sdk flags are set', () => {
    expect(buildSdkConfig({})).toBeUndefined();
  });

  test('parses --sdk-tools as comma-separated list', () => {
    const result = buildSdkConfig({ sdkTools: 'Read,Glob,Grep' });
    expect(result).toBeDefined();
    expect(result!.tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('parses --sdk-allowed-tools', () => {
    const result = buildSdkConfig({ sdkAllowedTools: 'Read,Glob' });
    expect(result!.allowedTools).toEqual(['Read', 'Glob']);
  });

  test('parses --sdk-disallowed-tools', () => {
    const result = buildSdkConfig({ sdkDisallowedTools: 'Bash,Write' });
    expect(result!.disallowedTools).toEqual(['Bash', 'Write']);
  });

  test('parses --sdk-max-turns as a number', () => {
    const result = buildSdkConfig({ sdkMaxTurns: '10' });
    expect(result!.maxTurns).toBe(10);
  });

  test('parses --sdk-max-budget as a number', () => {
    const result = buildSdkConfig({ sdkMaxBudget: '5.50' });
    expect(result!.maxBudgetUsd).toBe(5.5);
  });

  test('parses --sdk-effort level', () => {
    const result = buildSdkConfig({ sdkEffort: 'high' });
    expect(result!.effort).toBe('high');
  });

  test('parses --sdk-permission-mode', () => {
    const result = buildSdkConfig({ sdkPermissionMode: 'acceptEdits' });
    expect(result!.permissionMode).toBe('acceptEdits');
  });

  describe('thinking config parsing', () => {
    test('parses "adaptive"', () => {
      const result = buildSdkConfig({ sdkThinking: 'adaptive' });
      expect(result!.thinking).toEqual({ type: 'adaptive' });
    });

    test('parses "disabled"', () => {
      const result = buildSdkConfig({ sdkThinking: 'disabled' });
      expect(result!.thinking).toEqual({ type: 'disabled' });
    });

    test('parses "enabled:4000"', () => {
      const result = buildSdkConfig({ sdkThinking: 'enabled:4000' });
      expect(result!.thinking).toEqual({ type: 'enabled', budgetTokens: 4000 });
    });

    test('parses "enabled" without budget', () => {
      const result = buildSdkConfig({ sdkThinking: 'enabled' });
      expect(result!.thinking).toEqual({ type: 'enabled' });
    });
  });

  test('parses --sdk-persist-session true', () => {
    const result = buildSdkConfig({ sdkPersistSession: true });
    expect(result!.persistSession).toBe(true);
  });

  test('handles --no-sdk-persist-session as false', () => {
    const result = buildSdkConfig({ sdkPersistSession: false });
    expect(result!.persistSession).toBe(false);
  });

  test('parses boolean flags', () => {
    const result = buildSdkConfig({
      sdkFileCheckpointing: true,
      sdkStreamPartial: true,
      sdkHookEvents: true,
      sdkPromptSuggestions: true,
      sdkProgressSummaries: true,
      sdkSandbox: true,
    });
    expect(result!.enableFileCheckpointing).toBe(true);
    expect(result!.includePartialMessages).toBe(true);
    expect(result!.includeHookEvents).toBe(true);
    expect(result!.promptSuggestions).toBe(true);
    expect(result!.agentProgressSummaries).toBe(true);
    expect(result!.sandbox).toEqual({ enabled: true });
  });

  test('parses --sdk-betas', () => {
    const result = buildSdkConfig({ sdkBetas: 'context-1m-2025-08-07' });
    expect(result!.betas).toEqual(['context-1m-2025-08-07']);
  });

  test('parses --sdk-system-prompt', () => {
    const result = buildSdkConfig({ sdkSystemPrompt: 'You are a helpful agent.' });
    expect(result!.systemPrompt).toBe('You are a helpful agent.');
  });

  test('parses --sdk-agent', () => {
    const result = buildSdkConfig({ sdkAgent: 'my-agent' });
    expect(result!.agent).toBe('my-agent');
  });

  test('parses --sdk-output-format as schema ref', () => {
    const result = buildSdkConfig({ sdkOutputFormat: '/path/to/schema.json' });
    expect(result!.outputFormat).toEqual({
      type: 'json_schema',
      schema: { $ref: '/path/to/schema.json' },
    });
  });

  describe('MCP server parsing', () => {
    test('parses "name:command:arg1,arg2"', () => {
      const result = buildSdkConfig({ sdkMcpServer: ['github:npx:-y,@mcp/github'] });
      expect(result!.mcpServers).toEqual({
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@mcp/github'],
        },
      });
    });

    test('parses multiple servers', () => {
      const result = buildSdkConfig({
        sdkMcpServer: ['github:npx:-y,@mcp/github', 'sqlite:sqlite-mcp:db.sqlite'],
      });
      expect(result!.mcpServers).toBeDefined();
      expect(Object.keys(result!.mcpServers!)).toHaveLength(2);
      expect(result!.mcpServers!.github).toBeDefined();
      expect(result!.mcpServers!.sqlite).toBeDefined();
    });

    test('handles server with no args', () => {
      const result = buildSdkConfig({ sdkMcpServer: ['myserver:mycommand:'] });
      expect(result!.mcpServers!.myserver).toEqual({
        type: 'stdio',
        command: 'mycommand',
        args: [],
      });
    });
  });

  test('parses --sdk-plugin as repeatable paths', () => {
    const result = buildSdkConfig({ sdkPlugin: ['/path/to/plugin1', '/path/to/plugin2'] });
    expect(result!.plugins).toEqual([
      { type: 'local', path: '/path/to/plugin1' },
      { type: 'local', path: '/path/to/plugin2' },
    ]);
  });

  test('parses --sdk-subagent definitions', () => {
    const subDef = JSON.stringify({ description: 'Helper', prompt: 'You help.' });
    const result = buildSdkConfig({ sdkSubagent: [`helper:${subDef}`] });
    expect(result!.agents).toBeDefined();
    expect(result!.agents!.helper).toEqual({ description: 'Helper', prompt: 'You help.' });
  });

  test('combines multiple flags into a single config', () => {
    const result = buildSdkConfig({
      sdkPermissionMode: 'acceptEdits',
      sdkTools: 'Read,Glob',
      sdkMaxBudget: '5',
      sdkEffort: 'high',
    });
    expect(result).toEqual({
      permissionMode: 'acceptEdits',
      tools: ['Read', 'Glob'],
      maxBudgetUsd: 5,
      effort: 'high',
    });
  });
});
