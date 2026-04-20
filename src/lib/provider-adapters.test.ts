/**
 * Provider Adapters — Unit Tests
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type SpawnParams,
  buildClaudeCommand,
  buildCodexCommand,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';

// ============================================================================
// Validation Tests (Group A)
// ============================================================================

describe('validateSpawnParams', () => {
  it('accepts valid claude params', () => {
    const params: SpawnParams = { provider: 'claude', team: 'work', role: 'implementor' };
    const result = validateSpawnParams(params);
    expect(result.provider).toBe('claude');
    expect(result.team).toBe('work');
    expect(result.role).toBe('implementor');
  });

  it('accepts valid codex params with skill', () => {
    const params: SpawnParams = { provider: 'codex', team: 'work', skill: 'work', role: 'tester' };
    const result = validateSpawnParams(params);
    expect(result.provider).toBe('codex');
    expect(result.skill).toBe('work');
  });

  it('rejects invalid provider', () => {
    expect(() => validateSpawnParams({ provider: 'gpt' as any, team: 'work' })).toThrow();
  });

  it('rejects empty team', () => {
    expect(() => validateSpawnParams({ provider: 'claude', team: '' })).toThrow();
  });

  it('accepts codex without skill', () => {
    const result = validateSpawnParams({ provider: 'codex', team: 'work' });
    expect(result.provider).toBe('codex');
  });

  it('allows claude without skill', () => {
    const params: SpawnParams = { provider: 'claude', team: 'work' };
    const result = validateSpawnParams(params);
    expect(result.provider).toBe('claude');
  });
});

// ============================================================================
// Claude Adapter Tests (Group C)
// ============================================================================

describe('buildClaudeCommand', () => {
  // Mock Bun.which to pretend claude is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' ? '/usr/local/bin/claude' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  it('builds command with --agent role', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).toContain('claude');
    expect(result.command).toContain('--agent');
    expect(result.command).toContain('implementor');
    expect(result.provider).toBe('claude');
    expect(result.meta.role).toBe('implementor');
  });

  it('includes --dangerously-skip-permissions', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).toContain('--dangerously-skip-permissions');
  });

  it('excludes --agent when no role specified', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work' });
    expect(result.command).toContain('--dangerously-skip-permissions');
    expect(result.command).not.toContain('--agent');
  });

  it('does not include hidden teammate flags', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).not.toContain('--teammate');
    expect(result.command).not.toContain('--internal');
  });

  it('forwards extra args', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      extraArgs: ['--dangerously-skip-permissions'],
    });
    expect(result.command).toContain('--dangerously-skip-permissions');
  });

  it('includes --model flag when model is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      model: 'opus',
    });
    expect(result.command).toContain("--model 'opus'");
  });

  it('includes --append-system-prompt-file by default when systemPromptFile is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).toContain('/path/to/AGENTS.md');
  });

  it('uses --system-prompt-file when promptMode is "system"', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      promptMode: 'system',
    });
    expect(result.command).toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });

  it('uses --append-system-prompt-file when promptMode is "append"', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPromptFile: '/path/to/AGENTS.md',
      promptMode: 'append',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).not.toContain("--system-prompt-file '/path");
  });

  it('does not include prompt file flags when neither systemPromptFile nor systemPrompt is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
    });
    expect(result.command).not.toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
  });

  it('writes systemPrompt to temp file and uses --append-system-prompt-file', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      systemPrompt: 'You are an implementor agent.',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    expect(result.command).toContain('/tmp/genie-prompts/implementor-');
    // Must NOT contain inline --append-system-prompt (without -file)
    expect(result.command).not.toMatch(/--append-system-prompt(?!-file)/);
  });

  it('writes systemPrompt to temp file with --system-prompt-file when promptMode is "system"', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      systemPrompt: 'You are an implementor agent.',
      promptMode: 'system',
    });
    expect(result.command).toContain('--system-prompt-file');
    expect(result.command).not.toContain('--append-system-prompt-file');
    expect(result.command).toContain('/tmp/genie-prompts/implementor-');
  });

  it('never emits inline --system-prompt or --append-system-prompt flags', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'tester',
      systemPrompt: 'Multi-line prompt\nwith ```code blocks```\nand special chars: $VAR "quotes"',
    });
    // Should use file-based flag
    expect(result.command).toContain('--append-system-prompt-file');
    // Must NOT contain inline prompt flags (without -file suffix)
    expect(result.command).not.toMatch(/--append-system-prompt(?!-file)/);
    expect(result.command).not.toMatch(/--system-prompt(?!-file)/);
  });

  it('uses "agent" as fallback role in temp file name when no role set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      systemPrompt: 'Some prompt',
    });
    expect(result.command).toContain('/tmp/genie-prompts/agent-');
    expect(result.command).toContain('--append-system-prompt-file');
  });

  it('merges systemPromptFile and systemPrompt into one temp file', () => {
    const fs = require('node:fs');
    const testFile = '/tmp/genie-prompts/test-agents.md';
    fs.mkdirSync('/tmp/genie-prompts', { recursive: true });
    fs.writeFileSync(testFile, 'User agent instructions');

    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'implementor',
      systemPromptFile: testFile,
      systemPrompt: 'Built-in prompt',
    });
    expect(result.command).toContain('--append-system-prompt-file');
    // Should reference the NEW temp file, not the original
    expect(result.command).toContain('/tmp/genie-prompts/implementor-');

    // Verify merged content
    const match = result.command.match(/\/tmp\/genie-prompts\/implementor-[^']+/);
    expect(match).toBeTruthy();
    const content = fs.readFileSync(match![0], 'utf-8');
    expect(content).toContain('User agent instructions');
    expect(content).toContain('Built-in prompt');
  });

  it('sets GENIE_WORKER=1 in env for spawn latency optimization (#712)', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.env).toBeDefined();
    expect(result.env!.GENIE_WORKER).toBe('1');
  });

  it('sets GENIE_WORKER=1 even without role or nativeTeam', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work' });
    expect(result.env).toBeDefined();
    expect(result.env!.GENIE_WORKER).toBe('1');
  });

  it('initialPrompt with quotes and newlines survives tmux split-window re-quoting (#776)', () => {
    const prompt =
      'Execute Group 1 of wish "db-cleanup".\n\nWhen done:\n1. Run: genie done db-cleanup#1\n2. Run: genie send \'Group 1 complete.\' --to team-lead';
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'engineer-1',
      initialPrompt: prompt,
    });

    // The command contains the prompt as a shell-escaped positional arg
    expect(result.command).toContain('claude');
    expect(result.command).toContain('engineer-1');

    // Simulate the tmux split-window re-quoting fix:
    // fullCommand is re-wrapped in single quotes for the outer shell → tmux → inner shell pipeline.
    const fullCommand = result.command;
    const reQuoted = fullCommand.replace(/'/g, "'\\''");

    // The re-quoted command round-trips through sh -c back to the original fullCommand.
    // This proves the outer shell → tmux → inner shell pipeline preserves the command.
    const { execSync } = require('node:child_process');
    const roundTripped = execSync(`printf '%s' '${reQuoted}'`, { encoding: 'utf-8' });
    expect(roundTripped).toBe(fullCommand);
  });
});

// ============================================================================
// Codex Adapter Tests (Group C)
// ============================================================================

describe('buildCodexCommand', () => {
  // Mock Bun.which to pretend codex is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'codex' ? '/usr/local/bin/codex' : typeof originalWhich === 'function' ? originalWhich(name) : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  it('builds command with positional prompt for skill', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work', role: 'tester' });
    expect(result.command).toContain('codex');
    expect(result.command).not.toContain('--instructions');
    expect(result.command).toContain('work');
    expect(result.provider).toBe('codex');
    expect(result.meta.skill).toBe('work');
    expect(result.meta.role).toBe('tester');
  });

  it('includes --yolo for autonomous execution', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.command).toContain('--yolo');
  });

  it('includes --no-alt-screen for tmux compatibility', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.command).toContain('--no-alt-screen');
  });

  it('builds command without skill', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work' });
    expect(result.command).toContain('codex');
    expect(result.command).toContain('Genie worker');
    expect(result.command).not.toContain('Skill:');
  });

  it('includes role in prompt', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work', role: 'tester' });
    expect(result.command).toContain('Role: tester');
  });

  it('does not depend on agent-name routing', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.command).not.toContain('--agent');
  });

  it('places prompt as last argument', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      skill: 'work',
      extraArgs: ['--model', 'o3'],
    });
    // Prompt (containing "Genie worker") should come after extra args
    const yoloIdx = result.command.indexOf('--yolo');
    const modelIdx = result.command.indexOf('--model');
    const promptIdx = result.command.indexOf('Genie worker');
    expect(yoloIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(promptIdx);
  });

  it('forwards extra args', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      skill: 'work',
      extraArgs: ['--model', 'o3'],
    });
    expect(result.command).toContain('--model');
    expect(result.command).toContain('o3');
  });
});

// ============================================================================
// Dispatch Tests (Group C)
// ============================================================================

describe('buildLaunchCommand', () => {
  // Mock Bun.which to pretend codex is installed (hasBinary check)
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'codex' || name === 'claude'
        ? `/usr/local/bin/${name}`
        : typeof originalWhich === 'function'
          ? originalWhich(name)
          : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  it('dispatches to claude adapter', () => {
    const result = buildLaunchCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.provider).toBe('claude');
    expect(result.command).toContain('claude');
  });

  it('dispatches to codex adapter', () => {
    const result = buildLaunchCommand({ provider: 'codex', team: 'work', skill: 'work' });
    expect(result.provider).toBe('codex');
    expect(result.command).toContain('codex');
  });

  it('rejects invalid provider before dispatch', () => {
    expect(() => buildLaunchCommand({ provider: 'invalid' as any, team: 'work' })).toThrow();
  });

  it('dispatches codex without skill', () => {
    const result = buildLaunchCommand({ provider: 'codex', team: 'work' });
    expect(result.provider).toBe('codex');
    expect(result.command).toContain('Genie worker');
  });
});

// ============================================================================
// OTel Env Injection Tests
// ============================================================================

describe('OTel env injection in buildClaudeCommand', () => {
  const originalWhich = (Bun as Record<string, unknown>).which;
  const savedOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' ? '/usr/local/bin/claude' : typeof originalWhich === 'function' ? originalWhich(name) : null;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined as unknown as string;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
    if (savedOtelEndpoint !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtelEndpoint;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined as unknown as string;
  });

  it('injects OTel env vars when otelPort is set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'test-team',
      role: 'engineer',
      otelPort: 19643,
    });
    expect(result.env).toBeDefined();
    expect(result.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(result.env?.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(result.env?.OTEL_METRICS_EXPORTER).toBe('otlp');
    expect(result.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json');
    expect(result.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:19643');
    expect(result.env?.OTEL_LOG_TOOL_DETAILS).toBe('1');
    expect(result.env?.OTEL_LOG_USER_PROMPTS).toBe('1');
  });

  it('includes OTEL_RESOURCE_ATTRIBUTES with agent context', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'test-team',
      role: 'engineer',
      otelPort: 19643,
      otelWishSlug: 'my-wish',
    });
    const attrs = result.env?.OTEL_RESOURCE_ATTRIBUTES ?? '';
    expect(attrs).toContain('agent.name=engineer');
    expect(attrs).toContain('team.name=test-team');
    expect(attrs).toContain('wish.slug=my-wish');
    expect(attrs).toContain('agent.role=engineer');
  });

  it('does not inject OTel env vars when otelPort is not set', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'test-team',
      role: 'engineer',
    });
    expect(result.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(result.env?.OTEL_LOGS_EXPORTER).toBeUndefined();
  });

  it('respects otelLogPrompts=false', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'test-team',
      role: 'engineer',
      otelPort: 19643,
      otelLogPrompts: false,
    });
    expect(result.env?.OTEL_LOG_USER_PROMPTS).toBeUndefined();
  });

  it('does not inject when OTEL_EXPORTER_OTLP_ENDPOINT already set', () => {
    const orig = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://some-other-collector:4318';
    try {
      const result = buildClaudeCommand({
        provider: 'claude',
        team: 'test-team',
        role: 'engineer',
        otelPort: 19643,
      });
      // Should not override user's existing OTEL_EXPORTER_OTLP_ENDPOINT
      expect(result.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    } finally {
      if (orig) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = orig;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = undefined;
    }
  });
});

// ============================================================================
// Turn-session env propagation (Group 3: GENIE_EXECUTOR_ID / GENIE_AGENT_ID)
// ============================================================================

describe('executor env propagation', () => {
  const originalWhich = (Bun as Record<string, unknown>).which;
  beforeAll(() => {
    (Bun as Record<string, unknown>).which = (name: string) =>
      name === 'claude' || name === 'codex'
        ? `/usr/local/bin/${name}`
        : typeof originalWhich === 'function'
          ? originalWhich(name)
          : null;
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
  });

  const execId = '11111111-2222-3333-4444-555555555555';
  const agentId = 'agent-abc-123';

  it('buildClaudeCommand sets GENIE_EXECUTOR_ID + GENIE_AGENT_ID when present', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'engineer',
      executorId: execId,
      agentId,
    });
    expect(result.env?.GENIE_EXECUTOR_ID).toBe(execId);
    expect(result.env?.GENIE_AGENT_ID).toBe(agentId);
  });

  it('buildClaudeCommand omits GENIE_EXECUTOR_ID when not passed', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'engineer' });
    expect(result.env?.GENIE_EXECUTOR_ID).toBeUndefined();
    expect(result.env?.GENIE_AGENT_ID).toBeUndefined();
  });

  it('buildCodexCommand sets GENIE_EXECUTOR_ID + GENIE_AGENT_ID when present', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      role: 'engineer',
      executorId: execId,
      agentId,
    });
    expect(result.env?.GENIE_EXECUTOR_ID).toBe(execId);
    expect(result.env?.GENIE_AGENT_ID).toBe(agentId);
  });

  it('buildCodexCommand omits GENIE_EXECUTOR_ID when no executor identity is provided', () => {
    const result = buildCodexCommand({ provider: 'codex', team: 'work' });
    expect(result.env?.GENIE_EXECUTOR_ID).toBeUndefined();
    expect(result.env?.GENIE_AGENT_ID).toBeUndefined();
  });

  it('validateSpawnParams preserves executorId and agentId fields', () => {
    const result = validateSpawnParams({
      provider: 'claude',
      team: 'work',
      executorId: execId,
      agentId,
    });
    expect(result.executorId).toBe(execId);
    expect(result.agentId).toBe(agentId);
  });

  it('validateSpawnParams rejects a non-UUID executorId', () => {
    expect(() => validateSpawnParams({ provider: 'claude', team: 'work', executorId: 'not-a-uuid' })).toThrow();
  });

  it('buildLaunchCommand (claude) forwards env through the top-level entry point', () => {
    const launch = buildLaunchCommand({
      provider: 'claude',
      team: 'work',
      role: 'engineer',
      executorId: execId,
      agentId,
    });
    expect(launch.env?.GENIE_EXECUTOR_ID).toBe(execId);
    expect(launch.env?.GENIE_AGENT_ID).toBe(agentId);
  });
});
