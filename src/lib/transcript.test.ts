/**
 * Tests for transcript provider abstraction
 * Run with: bun test src/lib/transcript.test.ts
 */

import { describe, expect, test } from 'bun:test';
import type { TranscriptEntry } from './transcript.js';
import { applyFilter } from './transcript.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function makeEntry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    role: 'assistant',
    timestamp: '2026-03-19T10:00:00.000Z',
    text: 'test',
    provider: 'claude',
    raw: {},
    ...overrides,
  };
}

const entries: TranscriptEntry[] = [
  makeEntry({ role: 'user', timestamp: '2026-03-19T09:00:00.000Z', text: 'hello' }),
  makeEntry({ role: 'assistant', timestamp: '2026-03-19T09:01:00.000Z', text: 'hi there' }),
  makeEntry({
    role: 'tool_call',
    timestamp: '2026-03-19T09:02:00.000Z',
    text: 'Read: foo.ts',
    toolCall: { id: 'tc1', name: 'Read', input: { file_path: 'foo.ts' } },
  }),
  makeEntry({ role: 'assistant', timestamp: '2026-03-19T09:03:00.000Z', text: 'I read the file' }),
  makeEntry({ role: 'user', timestamp: '2026-03-19T10:00:00.000Z', text: 'now edit it' }),
  makeEntry({ role: 'tool_call', timestamp: '2026-03-19T10:01:00.000Z', text: 'Edit: foo.ts' }),
  makeEntry({ role: 'assistant', timestamp: '2026-03-19T10:02:00.000Z', text: 'done editing' }),
  makeEntry({ role: 'system', timestamp: '2026-03-19T10:03:00.000Z', text: 'session end' }),
];

// ============================================================================
// Tests
// ============================================================================

describe('applyFilter', () => {
  test('returns all entries when no filter', () => {
    expect(applyFilter(entries)).toEqual(entries);
    expect(applyFilter(entries, {})).toEqual(entries);
  });

  test('filters by role', () => {
    const result = applyFilter(entries, { roles: ['user'] });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.role === 'user')).toBe(true);
  });

  test('filters by multiple roles', () => {
    const result = applyFilter(entries, { roles: ['user', 'assistant'] });
    expect(result).toHaveLength(5);
    expect(result.every((e) => e.role === 'user' || e.role === 'assistant')).toBe(true);
  });

  test('filters by since timestamp', () => {
    const result = applyFilter(entries, { since: '2026-03-19T10:00:00.000Z' });
    expect(result).toHaveLength(4);
    expect(result[0].text).toBe('now edit it');
  });

  test('applies last N', () => {
    const result = applyFilter(entries, { last: 3 });
    expect(result).toHaveLength(3);
    // Last 3: tool_call(Edit), assistant(done editing), system(session end)
    expect(result[0].role).toBe('tool_call');
    expect(result[1].text).toBe('done editing');
    expect(result[2].text).toBe('session end');
  });

  test('applies filters in order: since → roles → last', () => {
    const result = applyFilter(entries, {
      since: '2026-03-19T09:01:00.000Z',
      roles: ['assistant'],
      last: 2,
    });
    // since filters to 7 entries (09:01+), roles to 3 assistants, last 2
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('I read the file');
    expect(result[1].text).toBe('done editing');
  });

  test('handles empty entries', () => {
    expect(applyFilter([], { roles: ['user'] })).toEqual([]);
  });

  test('last larger than array returns all', () => {
    const result = applyFilter(entries, { last: 100 });
    expect(result).toHaveLength(entries.length);
  });
});
