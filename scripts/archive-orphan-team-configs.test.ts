/**
 * Tests for `scripts/archive-orphan-team-configs.ts`.
 *
 * The classification logic is pure — feed it a tmpdir tree and assert
 * that we mark dirs as `has-config` / `active` / `stale` correctly,
 * and that the actual archive step moves only `stale` entries.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOrphanTeamConfigs, classifyTeamDir } from './archive-orphan-team-configs.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'genie-archive-orphans-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function makeTeam(
  name: string,
  opts: { config?: boolean; inboxes?: { name: string; size: number; ageHours?: number }[] } = {},
): string {
  const teamDir = join(workdir, name);
  mkdirSync(teamDir, { recursive: true });
  if (opts.config) {
    writeFileSync(join(teamDir, 'config.json'), JSON.stringify({ name, members: [] }));
  }
  if (opts.inboxes) {
    const inboxesDir = join(teamDir, 'inboxes');
    mkdirSync(inboxesDir);
    for (const f of opts.inboxes) {
      const path = join(inboxesDir, f.name);
      writeFileSync(path, 'x'.repeat(Math.max(f.size, 0)));
      if (typeof f.ageHours === 'number') {
        const past = Date.now() - f.ageHours * 60 * 60 * 1000;
        // bun:test runs node — fs.utimesSync converts ms→s.
        const fs = require('node:fs') as typeof import('node:fs');
        fs.utimesSync(path, past / 1000, past / 1000);
      }
    }
  }
  return teamDir;
}

describe('classifyTeamDir', () => {
  test('returns has-config when config.json exists', () => {
    const dir = makeTeam('happy-team', { config: true });
    expect(classifyTeamDir(dir)).toBe('has-config');
  });

  test('returns stale when no inboxes dir', () => {
    const dir = makeTeam('empty-team');
    expect(classifyTeamDir(dir)).toBe('stale');
  });

  test('returns stale when inboxes dir is empty', () => {
    const dir = makeTeam('inbox-empty', { inboxes: [] });
    expect(classifyTeamDir(dir)).toBe('stale');
  });

  test('returns stale when inbox files are empty (size <= 2 bytes)', () => {
    const dir = makeTeam('only-empty-inboxes', {
      inboxes: [
        { name: 'a.json', size: 0 },
        { name: 'b.json', size: 2 },
      ],
    });
    expect(classifyTeamDir(dir)).toBe('stale');
  });

  test('returns stale when inbox files are old (> 24h)', () => {
    const dir = makeTeam('old-inboxes', { inboxes: [{ name: 'a.json', size: 100, ageHours: 48 }] });
    expect(classifyTeamDir(dir)).toBe('stale');
  });

  test('returns active when at least one inbox is recent and non-empty', () => {
    const dir = makeTeam('felipe-scout', { inboxes: [{ name: 'leader.json', size: 200, ageHours: 1 }] });
    expect(classifyTeamDir(dir)).toBe('active');
  });
});

describe('archiveOrphanTeamConfigs', () => {
  test('moves stale orphans to _archive/, leaves config-having and active alone', () => {
    makeTeam('happy-team', { config: true });
    makeTeam('felipe-scout', { inboxes: [{ name: 'leader.json', size: 200, ageHours: 1 }] });
    makeTeam('qa-moak-001', { inboxes: [{ name: 'leader.json', size: 0, ageHours: 0 }] });
    makeTeam('qa-moak-002');

    const decisions = archiveOrphanTeamConfigs({ baseDir: workdir });

    const byTeam = new Map(decisions.map((d) => [d.team, d]));
    expect(byTeam.get('happy-team')?.classification).toBe('has-config');
    expect(byTeam.get('felipe-scout')?.classification).toBe('active');
    expect(byTeam.get('qa-moak-001')?.classification).toBe('stale');
    expect(byTeam.get('qa-moak-002')?.classification).toBe('stale');

    // qa-moak-* dirs are gone from the live root, present under _archive/
    expect(existsSync(join(workdir, 'qa-moak-001'))).toBe(false);
    expect(existsSync(join(workdir, 'qa-moak-002'))).toBe(false);
    expect(existsSync(join(workdir, '_archive'))).toBe(true);

    // Active and config-having entries are left in place.
    expect(existsSync(join(workdir, 'felipe-scout'))).toBe(true);
    expect(existsSync(join(workdir, 'happy-team'))).toBe(true);
  });

  test('--dry-run does not mutate the filesystem', () => {
    makeTeam('qa-moak-stale');
    const decisions = archiveOrphanTeamConfigs({ baseDir: workdir, dryRun: true });
    expect(decisions[0].classification).toBe('stale');
    expect(decisions[0].archivedTo).toBeUndefined();
    expect(existsSync(join(workdir, 'qa-moak-stale'))).toBe(true);
  });

  test('skips _archive itself on subsequent runs (idempotency)', () => {
    makeTeam('qa-moak-stale');
    archiveOrphanTeamConfigs({ baseDir: workdir });
    const second = archiveOrphanTeamConfigs({ baseDir: workdir });
    // Nothing left at the live layer to classify; the archived dir is skipped.
    expect(second.length).toBe(0);
  });
});
