/**
 * Regression tests for `compareBackfillFiles` — the sort comparator that
 * controls backfill insert order.
 *
 * Context: the `sessions.parent_session_id` FK (migration 010) is not
 * DEFERRABLE. If a subagent row gets inserted before its parent row, the
 * insert fails with `sessions_parent_session_id_fkey` and the backfill
 * silently drops that file's data. Historically the sort was
 * `(a, b) => b.mtime - a.mtime`, which mixes parents and subagents — and
 * subagents tend to be newer than their parents, so they lose the race.
 *
 * These tests lock in the parent-first ordering so nobody reverts to a
 * pure-mtime comparator without failing CI first.
 */

import { describe, expect, test } from 'bun:test';
import { compareBackfillFiles } from '../session-backfill.js';

interface TestFile {
  id: string;
  isSubagent: boolean;
  mtime: number;
}

function sorted(files: TestFile[]): string[] {
  return [...files].sort(compareBackfillFiles).map((f) => f.id);
}

describe('compareBackfillFiles', () => {
  test('parents come before subagents regardless of mtime', () => {
    // Subagent is newer than parent — naive mtime sort would put it first.
    const files: TestFile[] = [
      { id: 'subagent-new', isSubagent: true, mtime: 2000 },
      { id: 'parent-old', isSubagent: false, mtime: 1000 },
    ];
    expect(sorted(files)).toEqual(['parent-old', 'subagent-new']);
  });

  test('within parents, newest first', () => {
    const files: TestFile[] = [
      { id: 'parent-old', isSubagent: false, mtime: 1000 },
      { id: 'parent-new', isSubagent: false, mtime: 3000 },
      { id: 'parent-mid', isSubagent: false, mtime: 2000 },
    ];
    expect(sorted(files)).toEqual(['parent-new', 'parent-mid', 'parent-old']);
  });

  test('within subagents, newest first', () => {
    const files: TestFile[] = [
      { id: 'sub-old', isSubagent: true, mtime: 1000 },
      { id: 'sub-new', isSubagent: true, mtime: 3000 },
      { id: 'sub-mid', isSubagent: true, mtime: 2000 },
    ];
    expect(sorted(files)).toEqual(['sub-new', 'sub-mid', 'sub-old']);
  });

  test('mixed set — all parents (newest first), then all subagents (newest first)', () => {
    const files: TestFile[] = [
      { id: 'sub-new', isSubagent: true, mtime: 4000 },
      { id: 'parent-old', isSubagent: false, mtime: 1000 },
      { id: 'sub-old', isSubagent: true, mtime: 2000 },
      { id: 'parent-new', isSubagent: false, mtime: 3000 },
    ];
    expect(sorted(files)).toEqual(['parent-new', 'parent-old', 'sub-new', 'sub-old']);
  });

  test('reproduces the original FK-violation scenario from prod logs', () => {
    // Simulate the real pattern: many subagents with recent mtimes and a
    // small number of parent sessions. Under the old sort they'd interleave;
    // under the new sort every parent lands before any subagent.
    const parents: TestFile[] = Array.from({ length: 4 }, (_, i) => ({
      id: `parent-${i}`,
      isSubagent: false,
      mtime: 1000 + i * 10,
    }));
    const subagents: TestFile[] = Array.from({ length: 20 }, (_, i) => ({
      id: `sub-${i}`,
      isSubagent: true,
      mtime: 5000 + i, // strictly newer than any parent
    }));
    const sortedIds = sorted([...subagents, ...parents]);

    // Assert: every parent appears before every subagent.
    const firstSubagentIdx = sortedIds.findIndex((id) => id.startsWith('sub-'));
    const lastParentIdx = sortedIds.map((id) => id.startsWith('parent-')).lastIndexOf(true);
    expect(lastParentIdx).toBeLessThan(firstSubagentIdx);
    expect(sortedIds.slice(0, 4).every((id) => id.startsWith('parent-'))).toBe(true);
    expect(sortedIds.slice(4).every((id) => id.startsWith('sub-'))).toBe(true);
  });

  test('stable on empty input', () => {
    expect(sorted([])).toEqual([]);
  });

  test('equal-mtime parents preserve relative order (comparator returns 0)', () => {
    const files: TestFile[] = [
      { id: 'a', isSubagent: false, mtime: 1000 },
      { id: 'b', isSubagent: false, mtime: 1000 },
    ];
    // Bun's sort is not guaranteed stable across implementations, but the
    // comparator MUST return 0 for equal mtimes in the same tier — verify that.
    expect(compareBackfillFiles(files[0], files[1])).toBe(0);
  });
});
