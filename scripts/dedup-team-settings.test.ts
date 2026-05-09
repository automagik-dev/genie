/**
 * Tests for `scripts/dedup-team-settings.ts`.
 *
 * Wish: spawn-compounding-defects, Group 3.
 *
 * Covers the four cases the wish's acceptance criteria call out:
 *   - 1× / 2× / 6× duplicates → reduce to one entry per event.
 *   - Drift collapse: multiple genie-shape entries with different
 *     command paths (the historical 65/82 bug case).
 *   - Non-genie hook entries are left untouched.
 *   - Marker write + idempotency (re-run is a no-op without --force).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupHooks, dedupTeamSettings, processSettingsFile } from './dedup-team-settings.js';

let workdir: string;
let teamsBase: string;
let markerBase: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'genie-dedup-team-settings-'));
  teamsBase = join(workdir, 'teams');
  markerBase = workdir;
  mkdirSync(teamsBase, { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ============================================================================
// Fixture builders
// ============================================================================

function writeTeam(team: string, settings: unknown): string {
  const dir = join(teamsBase, team);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  return path;
}

function genieHook(command: string, timeout = 15) {
  return { type: 'command', command, timeout };
}

function preToolUseDuplicates(n: number, command = 'genie hook dispatch') {
  // Builds n separate matcher entries each with one genie hook — the exact
  // shape the historical bug produced (one matcher entry per drifted inject).
  const matchers = [];
  for (let i = 0; i < n; i++) matchers.push({ matcher: '*', hooks: [genieHook(command)] });
  return matchers;
}

// ============================================================================
// dedupHooks — pure logic
// ============================================================================

describe('dedupHooks', () => {
  test('1× duplicate (single canonical entry) is unchanged', () => {
    const input = { PreToolUse: preToolUseDuplicates(1) };
    const out = dedupHooks(input);
    expect(out.changed).toBe(false);
    expect(out.entriesRemoved).toBe(0);
    expect(out.hooks.PreToolUse).toHaveLength(1);
  });

  test('2× exact-triplet duplicate collapses to one entry', () => {
    const input = { PreToolUse: preToolUseDuplicates(2) };
    const out = dedupHooks(input);
    expect(out.changed).toBe(true);
    expect(out.entriesRemoved).toBe(1);
    expect(out.hooks.PreToolUse).toHaveLength(1);
    expect(out.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('genie hook dispatch');
  });

  test('6× duplicate collapses to one entry (filing-host worst case)', () => {
    const input = { PreToolUse: preToolUseDuplicates(6) };
    const out = dedupHooks(input);
    expect(out.entriesRemoved).toBe(5);
    expect(out.hooks.PreToolUse).toHaveLength(1);
  });

  test('drift collapse: different command paths still reduce to one entry', () => {
    const input = {
      PreToolUse: [
        { matcher: '*', hooks: [genieHook("'/home/genie/.genie/bin/genie-hook'")] },
        { matcher: '*', hooks: [genieHook('genie hook dispatch')] },
        { matcher: '*', hooks: [genieHook('/old/path/genie-hook')] },
      ],
    };
    const out = dedupHooks(input);
    expect(out.changed).toBe(true);
    expect(out.entriesRemoved).toBe(2);
    expect(out.hooks.PreToolUse).toHaveLength(1);
    // The first surviving entry wins — the next inject normalizes to canonical.
    expect(out.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe("'/home/genie/.genie/bin/genie-hook'");
  });

  test('non-genie hooks are preserved verbatim alongside genie collapse', () => {
    const input = {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit', timeout: 5 }] },
        { matcher: '*', hooks: [genieHook('genie hook dispatch')] },
        { matcher: '*', hooks: [genieHook("'/home/genie/.genie/bin/genie-hook'")] },
      ],
    };
    const out = dedupHooks(input);
    // Non-genie matcher first, then the surviving genie matcher.
    expect(out.hooks.PreToolUse).toHaveLength(2);
    const nonGenie = out.hooks.PreToolUse?.[0];
    expect(nonGenie?.matcher).toBe('Bash');
    expect(nonGenie?.hooks?.[0]?.command).toBe('echo audit');
    const genie = out.hooks.PreToolUse?.[1];
    expect(genie?.matcher).toBe('*');
    expect(genie?.hooks).toHaveLength(1);
  });

  test('matcher entry with mixed genie + non-genie hooks splits cleanly', () => {
    const input = {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: 'echo audit', timeout: 5 }, // non-genie
            genieHook('genie hook dispatch'),
            genieHook("'/home/genie/.genie/bin/genie-hook'"),
          ],
        },
      ],
    };
    const out = dedupHooks(input);
    // Non-genie hook stays under its original matcher; genie collapses to one
    // appended matcher entry.
    expect(out.hooks.PreToolUse).toHaveLength(2);
    expect(out.hooks.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(out.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('echo audit');
    expect(out.hooks.PreToolUse?.[1]?.hooks).toHaveLength(1);
    expect(out.entriesRemoved).toBe(1); // 2 genie → 1
  });

  test('different events dedup independently', () => {
    const input = {
      PreToolUse: preToolUseDuplicates(3, 'genie hook dispatch'),
      PostToolUse: preToolUseDuplicates(2, "'/home/genie/.genie/bin/genie-hook'"),
      SessionStart: preToolUseDuplicates(1),
    };
    const out = dedupHooks(input);
    expect(out.hooks.PreToolUse).toHaveLength(1);
    expect(out.hooks.PostToolUse).toHaveLength(1);
    expect(out.hooks.SessionStart).toHaveLength(1);
    expect(out.entriesRemoved).toBe(2 + 1 + 0);
  });

  test('empty / undefined hooks input returns empty config', () => {
    expect(dedupHooks(undefined).changed).toBe(false);
    expect(dedupHooks({}).changed).toBe(false);
  });
});

// ============================================================================
// processSettingsFile — file I/O
// ============================================================================

describe('processSettingsFile', () => {
  test('--dry-run does not write to disk', () => {
    const file = writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    const before = readFileSync(file, 'utf-8');
    const r = processSettingsFile(file, /*apply*/ false, 'dirty');
    expect(r.status).toBe('modified');
    expect(r.entriesRemoved).toBe(2);
    const after = readFileSync(file, 'utf-8');
    expect(after).toBe(before);
  });

  test('--apply writes deduped JSON', () => {
    const file = writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    const r = processSettingsFile(file, /*apply*/ true, 'dirty');
    expect(r.status).toBe('modified');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  test('apply on already-clean file is a no-op write', () => {
    const file = writeTeam('clean', { hooks: { PreToolUse: preToolUseDuplicates(1) } });
    const before = readFileSync(file, 'utf-8');
    const r = processSettingsFile(file, true, 'clean');
    expect(r.status).toBe('unchanged');
    const after = readFileSync(file, 'utf-8');
    expect(after).toBe(before);
  });

  test('unparseable JSON is reported, not crashed on', () => {
    const dir = join(teamsBase, 'broken');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{not-json', 'utf-8');
    const r = processSettingsFile(file, true, 'broken');
    expect(r.status).toBe('unparseable');
  });

  test('preserves non-hook top-level keys', () => {
    const file = writeTeam('with-other-keys', {
      permissions: { allow: ['AskUserQuestion'] },
      hooks: { PreToolUse: preToolUseDuplicates(2) },
      customField: 42,
    });
    processSettingsFile(file, true, 'with-other-keys');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.permissions.allow).toEqual(['AskUserQuestion']);
    expect(parsed.customField).toBe(42);
  });
});

// ============================================================================
// dedupTeamSettings — top-level scan + marker
// ============================================================================

describe('dedupTeamSettings', () => {
  test('scans every team in the base dir, reports per-file outcomes', () => {
    writeTeam('dirty-1', { hooks: { PreToolUse: preToolUseDuplicates(2) } });
    writeTeam('dirty-2', { hooks: { PreToolUse: preToolUseDuplicates(7) } });
    writeTeam('clean', { hooks: { PreToolUse: preToolUseDuplicates(1) } });
    writeTeam('no-hooks', { permissions: { allow: ['Bash'] } });

    const r = dedupTeamSettings({ apply: false, baseDir: teamsBase, markerBaseDir: markerBase });

    expect(r.filesScanned).toBe(4);
    expect(r.filesModified).toBe(2);
    expect(r.entriesRemoved).toBe(1 + 6);

    const byTeam = new Map(r.results.map((x) => [x.team, x]));
    expect(byTeam.get('dirty-1')?.status).toBe('modified');
    expect(byTeam.get('dirty-2')?.status).toBe('modified');
    expect(byTeam.get('clean')?.status).toBe('unchanged');
    expect(byTeam.get('no-hooks')?.status).toBe('no-hooks-key');
  });

  test('skips _archive/ and dotfile dirs', () => {
    writeTeam('_archive', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    writeTeam('.hidden', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    writeTeam('real', { hooks: { PreToolUse: preToolUseDuplicates(2) } });
    const r = dedupTeamSettings({ apply: false, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(r.filesScanned).toBe(1);
    expect(r.results[0].team).toBe('real');
  });

  test('--dry-run does not write the marker', () => {
    writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    dedupTeamSettings({ apply: false, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(existsSync(join(markerBase, '.genie', 'state', 'dedup-1710.done'))).toBe(false);
  });

  test('--apply writes the marker even when nothing changed', () => {
    writeTeam('clean', { hooks: { PreToolUse: preToolUseDuplicates(1) } });
    dedupTeamSettings({ apply: true, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(existsSync(join(markerBase, '.genie', 'state', 'dedup-1710.done'))).toBe(true);
  });

  test('re-run with marker present skips scan (idempotency)', () => {
    writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    const first = dedupTeamSettings({ apply: true, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(first.filesModified).toBe(1);
    expect(first.skippedDueToMarker).toBe(false);

    // Re-pollute the file (simulate drift after migration).
    writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(3) } });
    const second = dedupTeamSettings({ apply: true, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(second.skippedDueToMarker).toBe(true);
    expect(second.filesScanned).toBe(0);
    // File is left as-is — re-pollution is the inject path's job to fix.
    const parsed = JSON.parse(readFileSync(join(teamsBase, 'dirty', 'settings.json'), 'utf-8'));
    expect(parsed.hooks.PreToolUse).toHaveLength(3);
  });

  test('--force re-runs even with marker present', () => {
    writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(2) } });
    dedupTeamSettings({ apply: true, baseDir: teamsBase, markerBaseDir: markerBase });
    writeTeam('dirty', { hooks: { PreToolUse: preToolUseDuplicates(4) } });
    const r = dedupTeamSettings({ apply: true, force: true, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(r.skippedDueToMarker).toBe(false);
    expect(r.filesModified).toBe(1);
    expect(r.entriesRemoved).toBe(3);
  });

  test('--force on a clean host is a zero-count no-op', () => {
    writeTeam('clean', { hooks: { PreToolUse: preToolUseDuplicates(1) } });
    dedupTeamSettings({ apply: true, baseDir: teamsBase, markerBaseDir: markerBase });
    const r = dedupTeamSettings({ apply: true, force: true, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(r.filesScanned).toBe(1);
    expect(r.filesModified).toBe(0);
    expect(r.entriesRemoved).toBe(0);
  });

  test('handles missing teams base directory gracefully', () => {
    rmSync(teamsBase, { recursive: true, force: true });
    const r = dedupTeamSettings({ apply: false, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(r.filesScanned).toBe(0);
    expect(r.results).toEqual([]);
  });
});

// ============================================================================
// Filing-host distribution smoke — exercise the wish's specific fixture shape.
// ============================================================================

describe('filing-host distribution', () => {
  test('matches the wish-cited 7×/6× distribution and zeroes duplicates', () => {
    // Top of the filing-host distribution per #1710: unify-genie 7×, wish-cmd-v2 6×.
    writeTeam('unify-genie', {
      hooks: {
        PreToolUse: [
          ...preToolUseDuplicates(4, "'/home/genie/.genie/bin/genie-hook'"),
          ...preToolUseDuplicates(3, 'genie hook dispatch'),
        ],
      },
    });
    writeTeam('wish-cmd-v2', {
      hooks: {
        PreToolUse: [
          ...preToolUseDuplicates(3, "'/home/genie/.genie/bin/genie-hook'"),
          ...preToolUseDuplicates(3, 'genie hook dispatch'),
        ],
      },
    });

    const r = dedupTeamSettings({ apply: true, baseDir: teamsBase, markerBaseDir: markerBase });
    expect(r.filesModified).toBe(2);
    expect(r.entriesRemoved).toBe(6 + 5);

    const a = JSON.parse(readFileSync(join(teamsBase, 'unify-genie', 'settings.json'), 'utf-8'));
    const b = JSON.parse(readFileSync(join(teamsBase, 'wish-cmd-v2', 'settings.json'), 'utf-8'));
    expect(a.hooks.PreToolUse).toHaveLength(1);
    expect(b.hooks.PreToolUse).toHaveLength(1);
  });
});
