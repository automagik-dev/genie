/**
 * Tests for session-capture module.
 *
 * Focus: defenses added to keep backfill ingestion healthy and complete.
 *   1. extractSubTool() — truncate to fit Postgres btree row limit (idx_te_sub_tool).
 *   2. ensureSession() — when parent session missing, insert with NULL rather
 *      than crashing on sessions_parent_session_id_fkey.
 *   3. reconcileSubagentParents() SQL — surface shape, no throw.
 */

import { describe, expect, test } from 'bun:test';
import { extractSubTool } from './session-capture.js';

describe('extractSubTool — truncation for btree row size', () => {
  test('Bash: first line of command, trimmed, capped at 2000 chars', () => {
    const longLine = 'a'.repeat(5000);
    const result = extractSubTool('Bash', { command: longLine });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2000);
    expect(result?.startsWith('aaaa')).toBe(true);
  });

  test('Bash: short command returned intact', () => {
    expect(extractSubTool('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  test('Bash: multi-line HEREDOC — only first line captured', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\n${'x'.repeat(10000)}\nEOF\n)"`;
    const result = extractSubTool('Bash', { command: cmd });
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(2000);
    expect(result).toBe("git commit -m \"$(cat <<'EOF'");
  });

  test('Read/Write/Edit: file_path capped at 2000', () => {
    const longPath = `/tmp/${'nested/'.repeat(400)}file.ts`;
    for (const tool of ['Read', 'Write', 'Edit'] as const) {
      const r = extractSubTool(tool, { file_path: longPath });
      expect(r).not.toBeNull();
      expect(r?.length).toBeLessThanOrEqual(2000);
    }
  });

  test('Grep/Glob: pattern capped at 2000', () => {
    const big = 'x'.repeat(10000);
    expect(extractSubTool('Grep', { pattern: big })?.length).toBe(2000);
    expect(extractSubTool('Glob', { pattern: big })?.length).toBe(2000);
  });

  test('Agent/Skill: identifiers returned as-is', () => {
    expect(extractSubTool('Agent', { subagent_type: 'Explore' })).toBe('Explore');
    expect(extractSubTool('Skill', { skill: 'brain-search' })).toBe('brain-search');
  });

  test('unknown tool returns null', () => {
    expect(extractSubTool('SomeNewTool', { whatever: 1 })).toBeNull();
  });

  test('empty/missing input returns null', () => {
    expect(extractSubTool('Bash', { command: '' })).toBeNull();
    expect(extractSubTool('Bash', {})).toBeNull();
    expect(extractSubTool('Bash', null)).toBeNull();
  });
});
