/**
 * Tests for transcript normalizer pipeline.
 * Run with: bun test src/lib/transcript-normalizer.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  groupCommandBlocks,
  groupToolBlocks,
  isCommandTool,
  normalizeTranscript,
  parseStructuredToolResult,
  stripWrappedShell,
  summarizeToolInput,
  summarizeToolResult,
} from './transcript-normalizer.js';
import type { NormalizerEntry, TranscriptBlock } from './transcript-types.js';

// ============================================================================
// Helpers
// ============================================================================

function ts(offset: number): string {
  return new Date(Date.UTC(2026, 2, 28, 10, 0, offset)).toISOString();
}

// ============================================================================
// isCommandTool
// ============================================================================

describe('isCommandTool', () => {
  test('detects known command tool names', () => {
    expect(isCommandTool('bash', {})).toBe(true);
    expect(isCommandTool('shell', {})).toBe(true);
    expect(isCommandTool('command_execution', {})).toBe(true);
    expect(isCommandTool('shellToolCall', {})).toBe(true);
  });

  test('rejects non-command tool names', () => {
    expect(isCommandTool('Read', {})).toBe(false);
    expect(isCommandTool('Edit', {})).toBe(false);
    expect(isCommandTool('Glob', {})).toBe(false);
  });

  test('detects command from string input', () => {
    expect(isCommandTool('unknown', 'bash -c "ls"')).toBe(true);
    expect(isCommandTool('unknown', 'hello world')).toBe(false);
  });

  test('detects command from record with command/cmd key', () => {
    expect(isCommandTool('unknown', { command: 'ls -la' })).toBe(true);
    expect(isCommandTool('unknown', { cmd: 'echo hi' })).toBe(true);
    expect(isCommandTool('unknown', { path: '/foo' })).toBe(false);
  });
});

// ============================================================================
// stripWrappedShell
// ============================================================================

describe('stripWrappedShell', () => {
  test('unwraps bash -lc "..."', () => {
    expect(stripWrappedShell('bash -lc "ls -la"')).toBe('ls -la');
  });

  test("unwraps /bin/zsh -lc '...'", () => {
    expect(stripWrappedShell("/bin/zsh -lc 'echo hello'")).toBe('echo hello');
  });

  test('passes through plain commands', () => {
    expect(stripWrappedShell('git status')).toBe('git status');
  });

  test('compacts whitespace', () => {
    expect(stripWrappedShell('  git   status  ')).toBe('git status');
  });
});

// ============================================================================
// summarizeToolInput
// ============================================================================

describe('summarizeToolInput', () => {
  test('summarizes string input', () => {
    expect(summarizeToolInput('Read', '/path/to/file.ts')).toBe('/path/to/file.ts');
  });

  test('summarizes command tool with record input', () => {
    const result = summarizeToolInput('bash', { command: 'bash -lc "npm test"' });
    expect(result).toBe('npm test');
  });

  test('summarizes record with file_path', () => {
    expect(summarizeToolInput('Read', { file_path: '/src/index.ts' })).toBe('/src/index.ts');
  });

  test('summarizes record with paths array', () => {
    const result = summarizeToolInput('multi', { paths: ['/a.ts', '/b.ts'] });
    expect(result).toContain('2 paths');
    expect(result).toContain('/a.ts');
  });

  test('summarizes empty record', () => {
    expect(summarizeToolInput('Read', {})).toBe('No Read input');
  });

  test('truncates long input in compact mode', () => {
    const longPath = `${'/very/long/path/'.repeat(10)}file.ts`;
    const result = summarizeToolInput('Read', longPath, 'compact');
    expect(result.length).toBeLessThanOrEqual(72);
    expect(result.endsWith('…')).toBe(true);
  });

  test('handles null/undefined input', () => {
    expect(summarizeToolInput('Read', null)).toBe('Inspect Read input');
    expect(summarizeToolInput('Read', undefined)).toBe('Inspect Read input');
  });
});

// ============================================================================
// parseStructuredToolResult
// ============================================================================

describe('parseStructuredToolResult', () => {
  test('returns null for undefined', () => {
    expect(parseStructuredToolResult(undefined)).toBeNull();
  });

  test('parses header + body', () => {
    const result = parseStructuredToolResult('command: ls\nstatus: completed\nexit_code: 0\n\nfile1\nfile2');
    expect(result).toEqual({
      command: 'ls',
      status: 'completed',
      exitCode: '0',
      body: 'file1\nfile2',
    });
  });

  test('parses header-only result', () => {
    const result = parseStructuredToolResult('status: completed');
    expect(result).toEqual({
      command: null,
      status: 'completed',
      exitCode: null,
      body: '',
    });
  });
});

// ============================================================================
// summarizeToolResult
// ============================================================================

describe('summarizeToolResult', () => {
  test('returns "Waiting for result" when no result and not error', () => {
    expect(summarizeToolResult(undefined, false)).toBe('Waiting for result');
  });

  test('returns "Tool failed" when no result and is error', () => {
    expect(summarizeToolResult(undefined, true)).toBe('Tool failed');
  });

  test('summarizes structured result body', () => {
    const result = summarizeToolResult('status: completed\n\nAll tests passed', false);
    expect(result).toBe('All tests passed');
  });

  test('summarizes plain text result', () => {
    expect(summarizeToolResult('hello world', false)).toBe('hello world');
  });

  test('returns Completed for structured completed status with no body', () => {
    expect(summarizeToolResult('status: completed', false)).toBe('Completed');
  });

  test('returns failure message for structured error', () => {
    expect(summarizeToolResult('status: failed\nexit_code: 1', true)).toBe('Failed with exit code 1');
  });
});

// ============================================================================
// normalizeTranscript — message merging
// ============================================================================

describe('normalizeTranscript — messages', () => {
  test('creates message blocks from assistant and user entries', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'user', ts: ts(0), text: 'Hello' },
      { kind: 'assistant', ts: ts(1), text: 'Hi there' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'message', role: 'user', text: 'Hello' });
    expect(blocks[1]).toMatchObject({ type: 'message', role: 'assistant', text: 'Hi there', streaming: false });
  });

  test('merges consecutive same-role messages', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'assistant', ts: ts(0), text: 'First' },
      { kind: 'assistant', ts: ts(1), text: 'Second' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'message', role: 'assistant', text: 'First\nSecond' });
  });

  test('does not merge different roles', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'user', ts: ts(0), text: 'Q' },
      { kind: 'assistant', ts: ts(1), text: 'A' },
      { kind: 'user', ts: ts(2), text: 'Q2' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(3);
  });

  test('sets streaming flag from delta entries', () => {
    const entries: NormalizerEntry[] = [{ kind: 'assistant', ts: ts(0), text: 'streaming...', delta: true }];
    const blocks = normalizeTranscript(entries, true);
    expect(blocks[0]).toMatchObject({ type: 'message', streaming: true });
  });

  test('streaming is false when normalizer streaming is false', () => {
    const entries: NormalizerEntry[] = [{ kind: 'assistant', ts: ts(0), text: 'not streaming', delta: true }];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks[0]).toMatchObject({ type: 'message', streaming: false });
  });
});

// ============================================================================
// normalizeTranscript — thinking
// ============================================================================

describe('normalizeTranscript — thinking', () => {
  test('creates thinking blocks', () => {
    const entries: NormalizerEntry[] = [{ kind: 'thinking', ts: ts(0), text: 'Let me think...' }];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'thinking', text: 'Let me think...' });
  });

  test('merges consecutive thinking entries', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'thinking', ts: ts(0), text: 'First thought' },
      { kind: 'thinking', ts: ts(1), text: 'Second thought' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'thinking', text: 'First thought\nSecond thought' });
  });
});

// ============================================================================
// normalizeTranscript — tool correlation
// ============================================================================

describe('normalizeTranscript — tool correlation', () => {
  test('correlates tool_call and tool_result by toolUseId', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'Read', input: { file_path: 'foo.ts' }, toolUseId: 'tu_1' },
      { kind: 'tool_result', ts: ts(1), toolUseId: 'tu_1', content: 'file contents', isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    // After grouping, the tool should be in a tool_group
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_group');
    if (blocks[0].type === 'tool_group') {
      expect(blocks[0].items).toHaveLength(1);
      expect(blocks[0].items[0]).toMatchObject({
        result: 'file contents',
        isError: false,
        status: 'completed',
      });
    }
  });

  test('creates standalone tool block for orphan tool_result', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_result', ts: ts(0), toolUseId: 'tu_orphan', content: 'result', isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_group');
    if (blocks[0].type === 'tool_group') {
      expect(blocks[0].items[0]).toMatchObject({ status: 'completed' });
    }
  });

  test('tool_result with isError sets error status', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'Read', input: {}, toolUseId: 'tu_err' },
      { kind: 'tool_result', ts: ts(1), toolUseId: 'tu_err', content: 'not found', isError: true },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'tool_group') {
      expect(blocks[0].items[0]).toMatchObject({ status: 'error', isError: true });
    }
  });
});

// ============================================================================
// normalizeTranscript — command grouping
// ============================================================================

describe('normalizeTranscript — command grouping', () => {
  test('groups consecutive bash tools into command_group', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'bash', input: { command: 'ls' }, toolUseId: 'c1' },
      { kind: 'tool_result', ts: ts(1), toolUseId: 'c1', content: 'file1', isError: false },
      { kind: 'tool_call', ts: ts(2), name: 'bash', input: { command: 'pwd' }, toolUseId: 'c2' },
      { kind: 'tool_result', ts: ts(3), toolUseId: 'c2', content: '/home', isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('command_group');
    if (blocks[0].type === 'command_group') {
      expect(blocks[0].items).toHaveLength(2);
      expect(blocks[0].items[0]).toMatchObject({ result: 'file1', status: 'completed' });
      expect(blocks[0].items[1]).toMatchObject({ result: '/home', status: 'completed' });
    }
  });

  test('keeps running command stdout inside command fold', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'command_execution', toolUseId: 'cmd_1', input: { command: 'ls -la' } },
      { kind: 'stdout', ts: ts(1), text: 'file-a\nfile-b' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'command_group',
      items: [{ result: 'file-a\nfile-b', status: 'running' }],
    });
  });

  test('does not group non-command tools as command_group', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'Read', input: { file_path: 'a.ts' }, toolUseId: 't1' },
      { kind: 'tool_result', ts: ts(1), toolUseId: 't1', content: 'contents', isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_group');
  });
});

// ============================================================================
// normalizeTranscript — tool grouping
// ============================================================================

describe('normalizeTranscript — tool grouping', () => {
  test('groups consecutive file-op tools into tool_group', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'Read', input: { file_path: 'a.ts' }, toolUseId: 't1' },
      { kind: 'tool_result', ts: ts(1), toolUseId: 't1', content: 'a', isError: false },
      { kind: 'tool_call', ts: ts(2), name: 'Edit', input: { file_path: 'a.ts' }, toolUseId: 't2' },
      { kind: 'tool_result', ts: ts(3), toolUseId: 't2', content: 'ok', isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_group');
    if (blocks[0].type === 'tool_group') {
      expect(blocks[0].items).toHaveLength(2);
    }
  });

  test('message between tools breaks the group', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'tool_call', ts: ts(0), name: 'Read', input: {}, toolUseId: 't1' },
      { kind: 'tool_result', ts: ts(1), toolUseId: 't1', content: 'a', isError: false },
      { kind: 'assistant', ts: ts(2), text: 'I found something' },
      { kind: 'tool_call', ts: ts(3), name: 'Read', input: {}, toolUseId: 't2' },
      { kind: 'tool_result', ts: ts(4), toolUseId: 't2', content: 'b', isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('tool_group');
    expect(blocks[1].type).toBe('message');
    expect(blocks[2].type).toBe('tool_group');
  });
});

// ============================================================================
// normalizeTranscript — events
// ============================================================================

describe('normalizeTranscript — events', () => {
  test('creates init event', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'init', ts: ts(0), model: 'claude-opus-4-20250514', sessionId: 'sess_123' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'event',
      label: 'init',
      tone: 'info',
    });
    if (blocks[0].type === 'event') {
      expect(blocks[0].text).toContain('claude-opus-4-20250514');
      expect(blocks[0].text).toContain('sess_123');
    }
  });

  test('creates result event', () => {
    const entries: NormalizerEntry[] = [
      {
        kind: 'result',
        ts: ts(0),
        text: 'Done',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        costUsd: 0.01,
        subtype: 'success',
        isError: false,
        errors: [],
      },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'event', label: 'result', tone: 'info', text: 'Done' });
  });

  test('error result sets error tone', () => {
    const entries: NormalizerEntry[] = [
      {
        kind: 'result',
        ts: ts(0),
        text: '',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: 'error',
        isError: true,
        errors: ['Something broke'],
      },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks[0]).toMatchObject({ type: 'event', tone: 'error', text: 'Something broke' });
  });
});

// ============================================================================
// normalizeTranscript — stderr
// ============================================================================

describe('normalizeTranscript — stderr', () => {
  test('groups consecutive stderr into stderr_group', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'stderr', ts: ts(0), text: 'warning 1' },
      { kind: 'stderr', ts: ts(1), text: 'warning 2' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('stderr_group');
    if (blocks[0].type === 'stderr_group') {
      expect(blocks[0].lines).toHaveLength(2);
    }
  });

  test('hides paperclip session resume stderr', () => {
    const entries: NormalizerEntry[] = [
      {
        kind: 'stderr',
        ts: ts(0),
        text: '[paperclip] Skipping saved session resume for task "X" because wake reason is issue_assigned.',
      },
      { kind: 'assistant', ts: ts(1), text: 'Working on it.' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'message', text: 'Working on it.' });
  });
});

// ============================================================================
// normalizeTranscript — system / activity
// ============================================================================

describe('normalizeTranscript — system / activity', () => {
  test('skips "turn started" system messages', () => {
    const entries: NormalizerEntry[] = [{ kind: 'system', ts: ts(0), text: 'turn started' }];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(0);
  });

  test('parses system activity started/completed', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'system', ts: ts(0), text: 'item started: code_review (id=act_1)' },
      { kind: 'system', ts: ts(1), text: 'item completed: code_review (id=act_1)' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'activity', status: 'completed', name: 'Code Review' });
  });

  test('creates warn event for non-activity system messages', () => {
    const entries: NormalizerEntry[] = [{ kind: 'system', ts: ts(0), text: 'some system info' }];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks[0]).toMatchObject({ type: 'event', label: 'system', tone: 'warn' });
  });
});

// ============================================================================
// normalizeTranscript — stdout fallback
// ============================================================================

describe('normalizeTranscript — stdout', () => {
  test('creates stdout block for orphan stdout entries', () => {
    const entries: NormalizerEntry[] = [{ kind: 'stdout', ts: ts(0), text: 'output line' }];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'stdout', text: 'output line' });
  });

  test('merges consecutive stdout blocks', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'stdout', ts: ts(0), text: 'line 1' },
      { kind: 'stdout', ts: ts(1), text: 'line 2' },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'stdout', text: 'line 1\nline 2' });
  });
});

// ============================================================================
// groupCommandBlocks / groupToolBlocks (unit)
// ============================================================================

describe('groupCommandBlocks', () => {
  test('collapses tool blocks with command names', () => {
    const blocks: TranscriptBlock[] = [
      { type: 'tool', ts: ts(0), name: 'Executing command', input: { command: 'ls' }, status: 'completed' },
      { type: 'tool', ts: ts(1), name: 'Executing command', input: { command: 'pwd' }, status: 'completed' },
    ];
    const result = groupCommandBlocks(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('command_group');
  });

  test('non-command tool stays as-is', () => {
    const blocks: TranscriptBlock[] = [
      { type: 'tool', ts: ts(0), name: 'Read', input: { file_path: 'x' }, status: 'completed' },
    ];
    const result = groupCommandBlocks(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool');
  });
});

describe('groupToolBlocks', () => {
  test('collapses non-command tool blocks', () => {
    const blocks: TranscriptBlock[] = [
      { type: 'tool', ts: ts(0), name: 'Read', input: {}, status: 'completed' },
      { type: 'tool', ts: ts(1), name: 'Edit', input: {}, status: 'completed' },
    ];
    const result = groupToolBlocks(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_group');
  });
});

// ============================================================================
// Full pipeline integration
// ============================================================================

describe('normalizeTranscript — full pipeline', () => {
  test('processes a realistic session', () => {
    const entries: NormalizerEntry[] = [
      { kind: 'init', ts: ts(0), model: 'claude-opus-4-20250514', sessionId: 's1' },
      { kind: 'user', ts: ts(1), text: 'Fix the bug in auth.ts' },
      { kind: 'thinking', ts: ts(2), text: 'Let me look at auth.ts' },
      { kind: 'tool_call', ts: ts(3), name: 'Read', input: { file_path: 'auth.ts' }, toolUseId: 't1' },
      { kind: 'tool_result', ts: ts(4), toolUseId: 't1', content: 'file contents here', isError: false },
      { kind: 'tool_call', ts: ts(5), name: 'Edit', input: { file_path: 'auth.ts' }, toolUseId: 't2' },
      { kind: 'tool_result', ts: ts(6), toolUseId: 't2', content: 'ok', isError: false },
      { kind: 'assistant', ts: ts(7), text: 'Fixed the bug. Let me run tests.' },
      { kind: 'tool_call', ts: ts(8), name: 'bash', input: { command: 'bun test' }, toolUseId: 't3' },
      { kind: 'tool_result', ts: ts(9), toolUseId: 't3', content: 'all tests pass', isError: false },
      { kind: 'assistant', ts: ts(10), text: 'All tests pass.' },
      {
        kind: 'result',
        ts: ts(11),
        text: 'Done',
        inputTokens: 500,
        outputTokens: 200,
        cachedTokens: 100,
        costUsd: 0.05,
        subtype: 'success',
        isError: false,
        errors: [],
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    // Expected: init event, user msg, thinking, tool_group(Read+Edit), assistant msg, command_group(bash), assistant msg, result event
    expect(blocks).toHaveLength(8);
    expect(blocks[0].type).toBe('event'); // init
    expect(blocks[1].type).toBe('message'); // user
    expect(blocks[2].type).toBe('thinking');
    expect(blocks[3].type).toBe('tool_group'); // Read + Edit
    if (blocks[3].type === 'tool_group') {
      expect(blocks[3].items).toHaveLength(2);
    }
    expect(blocks[4].type).toBe('message'); // assistant
    expect(blocks[5].type).toBe('command_group'); // bash
    if (blocks[5].type === 'command_group') {
      expect(blocks[5].items).toHaveLength(1);
    }
    expect(blocks[6].type).toBe('message'); // assistant
    expect(blocks[7].type).toBe('event'); // result
  });

  test('handles empty entries', () => {
    expect(normalizeTranscript([], false)).toEqual([]);
  });
});

// ============================================================================
// Performance
// ============================================================================

describe('performance', () => {
  test('normalizes 1000 rows in under 100ms', () => {
    const entries: NormalizerEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      const t = ts(i);
      if (i % 5 === 0) {
        entries.push({ kind: 'user', ts: t, text: `Question ${i}` });
      } else if (i % 5 === 1) {
        entries.push({ kind: 'thinking', ts: t, text: `Thinking about ${i}` });
      } else if (i % 5 === 2) {
        entries.push({
          kind: 'tool_call',
          ts: t,
          name: 'Read',
          input: { file_path: `file${i}.ts` },
          toolUseId: `tu_${i}`,
        });
      } else if (i % 5 === 3) {
        entries.push({ kind: 'tool_result', ts: t, toolUseId: `tu_${i - 1}`, content: `content ${i}`, isError: false });
      } else {
        entries.push({ kind: 'assistant', ts: t, text: `Response ${i}` });
      }
    }

    const start = performance.now();
    const blocks = normalizeTranscript(entries, false);
    const elapsed = performance.now() - start;

    expect(blocks.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
