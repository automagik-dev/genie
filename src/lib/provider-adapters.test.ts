/**
 * Provider Adapters — Unit Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  type SpawnParams,
  buildClaudeCommand,
  buildCodexCommand,
  buildLaunchCommand,
  validateSpawnParams,
} from './provider-adapters.js';
import { CodexProvider } from './providers/codex.js';

const CODEX_PROMPT_TEST_DIR = '/tmp/genie-codex-prompts';
const CODEX_SOURCE_PROMPT_TEST_DIR = '/tmp/genie-codex-source-prompts';

function resetCodexPromptTestDirs(): void {
  const { rmSync } = require('node:fs') as typeof import('node:fs');
  rmSync(CODEX_PROMPT_TEST_DIR, { recursive: true, force: true });
  rmSync(CODEX_SOURCE_PROMPT_TEST_DIR, { recursive: true, force: true });
}

function writeCodexSourcePromptFile(name: string, content: string): string {
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(CODEX_SOURCE_PROMPT_TEST_DIR, { recursive: true });
  const path = join(CODEX_SOURCE_PROMPT_TEST_DIR, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function codexPromptPathFromCommand(command: string): string {
  const match = command.match(/"\$\(cat '([^']+)'\)"/);
  expect(match).toBeTruthy();
  return match![1];
}

function codexPromptContentFromCommand(command: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(codexPromptPathFromCommand(command), 'utf-8');
}

function extractShellFlagValue(command: string, flag: string): string | undefined {
  const flagIndex = command.indexOf(flag);
  if (flagIndex === -1) return undefined;

  let index = flagIndex + flag.length;
  while (command[index] === ' ') index++;

  if (command[index] !== "'") {
    const end = command.indexOf(' ', index);
    return command.slice(index, end === -1 ? undefined : end);
  }

  index++;
  let value = '';
  while (index < command.length) {
    if (command.slice(index, index + 4) === "'\\''") {
      value += "'";
      index += 4;
      continue;
    }
    if (command[index] === "'") return value;
    value += command[index];
    index++;
  }
  return undefined;
}

function extractClaudeSettings(command: string): Record<string, unknown> {
  const rawSettings = extractShellFlagValue(command, '--settings');
  if (!rawSettings) throw new Error(`Missing --settings in command: ${command}`);
  return JSON.parse(rawSettings) as Record<string, unknown>;
}

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

  it('preserves Claude permission fields through validation', () => {
    const result = validateSpawnParams({
      provider: 'claude',
      team: 'work',
      permissions: { allow: ['Read', 'Glob'], deny: ['Bash(rm *)'] },
      disallowedTools: ['Edit', 'Write'],
    });

    expect(result.permissions).toEqual({ allow: ['Read', 'Glob'], deny: ['Bash(rm *)'] });
    expect(result.disallowedTools).toEqual(['Edit', 'Write']);
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

  it('includes --permission-mode auto', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work', role: 'implementor' });
    expect(result.command).toContain('--permission-mode');
    expect(result.command).toContain("'auto'");
  });

  it('excludes --agent when no role specified', () => {
    const result = buildClaudeCommand({ provider: 'claude', team: 'work' });
    expect(result.command).toContain('--permission-mode');
    expect(result.command).not.toContain('--agent');
  });

  // Group 21 regression: --agent must use the resolved template name,
  // NOT the operator's --role override. Prevents phantom-spawn cascade
  // (custom name reaching Claude's template lookup → exit on missing
  // template → 14M watchdog `resume.missing_session` events / 7d).
  it('uses agentTemplate (not role) for --agent flag when both differ', () => {
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'custom-identity', // operator's --role override (registration name)
      agentTemplate: 'engineer', // resolved template (verified on disk)
    });
    expect(result.command).toContain("--agent 'engineer'");
    expect(result.command).not.toContain("--agent 'custom-identity'");
    // Identity-shaped fields preserve the role override
    expect(result.meta.role).toBe('custom-identity');
  });

  it('falls back to role for --agent when agentTemplate is unset', () => {
    // Backward compatibility: callers that bypass buildSpawnParams (legacy
    // paths) only set role. Behavior should match pre-Group-21 semantics.
    const result = buildClaudeCommand({
      provider: 'claude',
      team: 'work',
      role: 'engineer',
    });
    expect(result.command).toContain("--agent 'engineer'");
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

  describe('permissions forwarding', () => {
    it('includes permissions.allow in --settings JSON', () => {
      const result = buildClaudeCommand({
        provider: 'claude',
        team: 'work',
        role: 'sandboxed',
        permissions: { allow: ['Read', 'Glob'] },
      });

      const permissions = extractClaudeSettings(result.command).permissions as Record<string, unknown>;
      expect(permissions.allow).toEqual(['Read', 'Glob']);
      expect(permissions.deny).toBeUndefined();
    });

    it('includes permissions.allow and permissions.deny in --settings JSON', () => {
      const result = buildClaudeCommand({
        provider: 'claude',
        team: 'work',
        role: 'sandboxed',
        permissions: { allow: ['Read', 'Glob'], deny: ['Bash(rm *)'] },
      });

      const permissions = extractClaudeSettings(result.command).permissions as Record<string, unknown>;
      expect(permissions.allow).toEqual(['Read', 'Glob']);
      expect(permissions.deny).toEqual(['Bash(rm *)']);
    });

    it('preserves permissions through buildLaunchCommand validation', () => {
      const result = buildLaunchCommand({
        provider: 'claude',
        team: 'work',
        role: 'sandboxed',
        permissions: { allow: ['Read'], deny: ['Write'] },
      });

      const permissions = extractClaudeSettings(result.command).permissions as Record<string, unknown>;
      expect(permissions).toEqual({ allow: ['Read'], deny: ['Write'] });
    });

    it('emits one --disallowedTools flag per input tool in order', () => {
      const result = buildClaudeCommand({
        provider: 'claude',
        team: 'work',
        role: 'sandboxed',
        disallowedTools: ['Edit', 'Write', 'Agent'],
      });

      expect(result.command).toContain("--disallowedTools 'Edit' --disallowedTools 'Write' --disallowedTools 'Agent'");
    });

    it('omits permissions from --settings JSON when allow and deny are empty', () => {
      const result = buildClaudeCommand({
        provider: 'claude',
        team: 'work',
        role: 'sandboxed',
        permissions: { allow: [], deny: [] },
      });

      expect(extractClaudeSettings(result.command).permissions).toBeUndefined();
    });

    it('does not hardcode forbidden permission bypass flag literals', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { fileURLToPath } = require('node:url') as typeof import('node:url');
      const { dirname, join } = require('node:path') as typeof import('node:path');
      const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'provider-adapters.ts');
      const source = readFileSync(sourcePath, 'utf-8');

      expect(source).not.toMatch(/['"]--dangerously-skip-permissions['"]/);
      expect(source).not.toMatch(/['"]--permission-mode['"],\s*['"]bypassPermissions['"]/);
    });

    it('warns once when permissions.allow is paired with explicit bypassPermissions', () => {
      const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        buildClaudeCommand({
          provider: 'claude',
          team: 'work',
          role: 'sandboxed',
          permissions: { allow: ['Read'] },
          nativeTeam: {
            enabled: true,
            agentName: 'sandboxed',
            permissionMode: 'bypassPermissions',
          },
        });

        expect(stderrWrite).toHaveBeenCalledTimes(1);
        expect(stderrWrite.mock.calls[0][0]).toBe(
          'Warning: agent sandboxed declares permissions.allow but permissionMode is bypassPermissions — allow rules are advisory under bypass (deny still enforced).\n',
        );
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('does not warn when bypassPermissions has no allow rules to bypass', () => {
      const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        buildClaudeCommand({
          provider: 'claude',
          team: 'work',
          role: 'deny-only',
          permissions: { deny: ['Write'] },
          nativeTeam: {
            enabled: true,
            agentName: 'deny-only',
            permissionMode: 'bypassPermissions',
          },
        });

        expect(stderrWrite).not.toHaveBeenCalled();
      } finally {
        stderrWrite.mockRestore();
      }
    });
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
  beforeEach(() => {
    resetCodexPromptTestDirs();
  });
  afterAll(() => {
    (Bun as Record<string, unknown>).which = originalWhich;
    resetCodexPromptTestDirs();
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

  it('includes --model flag when model is set', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      skill: 'work',
      model: 'gpt-5-codex',
    });
    expect(result.command).toContain("--model 'gpt-5-codex'");
  });

  it('writes systemPromptFile content to a temp prompt file referenced by command', () => {
    const systemPromptFile = writeCodexSourcePromptFile('AGENTS.md', 'AGENTS instructions for Codex');
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      executorId: '11111111-2222-3333-4444-555555555555',
      systemPromptFile,
    });

    const promptPath = codexPromptPathFromCommand(result.command);
    expect(promptPath).toBe(`${CODEX_PROMPT_TEST_DIR}/11111111-2222-3333-4444-555555555555.txt`);
    expect(result.command).toContain(`"$(cat '${promptPath}')"`);
    expect(result.command).not.toContain(systemPromptFile);
    expect(codexPromptContentFromCommand(result.command)).toBe('AGENTS instructions for Codex');
  });

  it('writes inline systemPrompt to a temp prompt file', () => {
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      executorId: '22222222-2222-3333-4444-555555555555',
      systemPrompt: 'Inline system prompt for a built-in agent',
    });

    expect(codexPromptContentFromCommand(result.command)).toBe('Inline system prompt for a built-in agent');
    expect(result.command).not.toContain('Inline system prompt for a built-in agent');
  });

  it('consumes prompt-file extraArgs and strips them from the codex command', () => {
    const appendPromptFile = writeCodexSourcePromptFile('append.md', 'append prompt file');
    const systemPromptFile = writeCodexSourcePromptFile('system.md', 'system prompt file');
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      executorId: '33333333-2222-3333-4444-555555555555',
      extraArgs: [
        '--sandbox',
        'workspace-write',
        '--append-system-prompt-file',
        appendPromptFile,
        '--system-prompt-file',
        systemPromptFile,
      ],
    });

    expect(result.command).toContain('--sandbox');
    expect(result.command).toContain('workspace-write');
    expect(result.command).not.toContain('--append-system-prompt-file');
    expect(result.command).not.toContain('--system-prompt-file');
    expect(result.command).not.toContain(appendPromptFile);
    expect(result.command).not.toContain(systemPromptFile);
    expect(codexPromptContentFromCommand(result.command)).toBe('append prompt file\n\nsystem prompt file');
  });

  // Group 11 (codex-provider-parity): codex spawn must honor --prompt
  // (params.initialPrompt) as the worker's first user message, not
  // override it with the auto-generated "Genie worker. Team: X." string.
  it('honors initialPrompt via temp prompt file when provided (Group 11)', () => {
    const customPrompt = 'Implement Group 7 of security-install-download-guard wish';
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      role: 'sec-install-guard-codex',
      initialPrompt: customPrompt,
    });
    // Custom prompt is used verbatim via a temp file, not inline.
    expect(codexPromptContentFromCommand(result.command)).toBe(customPrompt);
    expect(result.command).not.toContain(customPrompt);
    // Auto-generated prompt is NOT used when initialPrompt is supplied
    expect(result.command).not.toContain('Genie worker. Team: work');
  });

  it('preserves initialPrompt newlines, quotes, and backticks in a temp file without inlining it', () => {
    const customPrompt =
      'Line 1 "quoted"\nLine 2 with `backticks`\nLine 3: $(echo should-not-run)\nSingle quote: \'ok\'';
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      executorId: '44444444-2222-3333-4444-555555555555',
      initialPrompt: customPrompt,
    });

    expect(codexPromptContentFromCommand(result.command)).toBe(customPrompt);
    expect(result.command).not.toContain(customPrompt);
  });

  it('falls back to auto-prompt when no prompt fields are set and writes no temp file', () => {
    // Backward compat: spawn-without-prompt produces the same auto-string
    // as before the Group 11 change.
    const result = buildCodexCommand({
      provider: 'codex',
      team: 'work',
      role: 'tester',
      skill: 'work',
    });
    expect(result.command).toContain('Genie worker. Team: work.');
    expect(result.command).toContain('Role: tester.');
    expect(result.command).not.toContain(CODEX_PROMPT_TEST_DIR);
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(CODEX_PROMPT_TEST_DIR)).toBe(false);
  });

  it('round-trips CodexProvider systemPromptFile and initialPrompt into the rendered command', () => {
    const systemPromptFile = writeCodexSourcePromptFile('provider-AGENTS.md', 'provider AGENTS content');
    const provider = new CodexProvider();
    const result = provider.buildSpawnCommand({
      agentId: 'agent-001',
      executorId: 'codex-provider-roundtrip',
      team: 'work',
      role: 'engineer',
      cwd: '/tmp',
      systemPromptFile,
      initialPrompt: 'Initial Omni turn prompt',
    });

    expect(result.command).toContain(`"$(cat '${CODEX_PROMPT_TEST_DIR}/codex-provider-roundtrip.txt')"`);
    expect(result.command).not.toContain(systemPromptFile);
    expect(result.command).not.toContain('Initial Omni turn prompt');
    expect(codexPromptContentFromCommand(result.command)).toBe('provider AGENTS content\n\nInitial Omni turn prompt');
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
