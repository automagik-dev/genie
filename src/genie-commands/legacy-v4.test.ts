/**
 * Tests for the v4 legacy manifest + detection + cleanup.
 *
 * Every call passes an explicit fixture `home` (and usually `genieHome`) —
 * never the real home dir. The real machine running these tests may hold a
 * genuine v4 rules file; the module defaults must never leak into a test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  V4_LEGACY_MANIFEST,
  cleanupV4,
  detectV4HomeResidue,
  detectV4Install,
  orchestrationRulesPath,
  v4PluginCacheRoot,
} from './legacy-v4.js';

const V4_RULES_CONTENT = [
  '# Genie CLI — Agent Orchestration',
  '',
  'genie team create <name> --repo <path> --wish <slug>  # Launch autonomous team',
  'NEVER use `Agent` to spawn agents — use `genie spawn` instead.',
  '',
].join('\n');

const USER_RULES_CONTENT = '# My own personal rules\n\nAlways be excellent to each other.\n';

let home: string;
let genieHome: string;
let savedGenieHomeEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'genie-v4-home-'));
  genieHome = join(home, '.genie');
  savedGenieHomeEnv = process.env.GENIE_HOME;
  // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
  delete process.env.GENIE_HOME;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
  if (savedGenieHomeEnv === undefined) delete process.env.GENIE_HOME;
  else process.env.GENIE_HOME = savedGenieHomeEnv;
});

function writeRulesFile(content: string): string {
  const path = orchestrationRulesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeCacheVersion(
  plugin: string,
  version: string,
  opts: { orphaned?: boolean; payload?: string[] } = {},
): string {
  const dir = join(home, '.claude', 'plugins', 'cache', 'automagik', plugin, version);
  mkdirSync(dir, { recursive: true });
  if (opts.orphaned) writeFileSync(join(dir, V4_LEGACY_MANIFEST.orphanMarkerFile), '2026-06-01T00:00:00Z\n', 'utf-8');
  for (const file of opts.payload ?? []) {
    const filePath = join(dir, file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `payload ${file}\n`, 'utf-8');
  }
  return dir;
}

function listRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('detectV4Install', () => {
  test('clean home reports no relics', () => {
    const report = detectV4Install(home);
    expect(report.rulesFile.status).toBe('absent');
    expect(report.cacheDirs).toHaveLength(0);
    expect(report.hasRelics).toBe(false);
  });

  test('reports marker-matched rules and 4.* cache dirs with orphan flags', () => {
    writeRulesFile(V4_RULES_CONTENT);
    makeCacheVersion('genie', '4.260421.17', { orphaned: true, payload: ['plugin.json'] });
    makeCacheVersion('genie', '4.260500.1', { orphaned: false, payload: ['plugin.json'] });
    makeCacheVersion('genie', '5.260704.1', { orphaned: false, payload: ['plugin.json'] });

    const report = detectV4Install(home);
    expect(report.rulesFile.status).toBe('v4-markers');
    expect(report.hasRelics).toBe(true);
    const byVersion = Object.fromEntries(report.cacheDirs.map((d) => [d.version, d.orphaned]));
    expect(byVersion).toEqual({ '4.260421.17': true, '4.260500.1': false });
  });
});

describe('cleanupV4 — rules file', () => {
  test('marker-matched rules file is backed up then removed', () => {
    const rulesPath = writeRulesFile(V4_RULES_CONTENT);

    const result = cleanupV4({ home, genieHome });

    expect(existsSync(rulesPath)).toBe(false);
    expect(result.noOp).toBe(false);
    expect(result.actions.map((a) => a.kind)).toEqual(['removed-rules']);

    // Backup preserves the home-relative structure and the exact content.
    expect(result.backupDir).not.toBeNull();
    const backupFile = join(result.backupDir as string, '.claude', 'rules', 'genie-orchestration.md');
    expect(readFileSync(backupFile, 'utf-8')).toBe(V4_RULES_CONTENT);
    expect((result.backupDir as string).startsWith(join(genieHome, 'state-backups', 'v4-cleanup-'))).toBe(true);

    // Removal is logged to the append-only cleanup log.
    expect(result.logFile).toBe(join(genieHome, 'logs', 'v4-cleanup.log'));
    const log = readFileSync(result.logFile as string, 'utf-8');
    expect(log).toContain('removed-rules');
    expect(log).toContain(rulesPath);
  });

  test('user-modified rules file is kept and warned', () => {
    const rulesPath = writeRulesFile(USER_RULES_CONTENT);

    const result = cleanupV4({ home, genieHome });

    expect(existsSync(rulesPath)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(USER_RULES_CONTENT);
    expect(result.actions.map((a) => a.kind)).toEqual(['kept-rules-user-modified']);
    expect(result.backupDir).toBeNull(); // nothing removed → nothing backed up
    const log = readFileSync(result.logFile as string, 'utf-8');
    expect(log).toContain('kept-rules-user-modified');
  });

  test('non-genie files in the rules dir are never touched', () => {
    writeRulesFile(V4_RULES_CONTENT);
    const rulesDir = dirname(orchestrationRulesPath(home));
    const otherRule = join(rulesDir, 'my-own-rule.md');
    writeFileSync(otherRule, '# mine\n', 'utf-8');
    const unrelated = join(home, '.claude', 'CLAUDE.md');
    writeFileSync(unrelated, '# user memory\n', 'utf-8');
    // Hook registrations are audit-only in v1: settings.json is never modified,
    // even when it mentions genie commands.
    const settingsPath = join(home, '.claude', 'settings.json');
    const settingsContent = '{\n  "hooks": [{ "command": "genie hook dispatch" }]\n}\n';
    writeFileSync(settingsPath, settingsContent, 'utf-8');

    const result = cleanupV4({ home, genieHome });

    expect(existsSync(otherRule)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(settingsContent);
    expect(existsSync(orchestrationRulesPath(home))).toBe(false);
    // The backup contains ONLY the genie-installed file.
    expect(listRecursive(result.backupDir as string)).toEqual(['.claude/rules/genie-orchestration.md']);
  });
});

describe('cleanupV4 — failure paths', () => {
  test('backup failure keeps the relic: no delete without a completed backup', () => {
    const rulesPath = writeRulesFile(V4_RULES_CONTENT);
    // Block backup-dir creation: `state-backups` pre-exists as a FILE, so the
    // recursive mkdir inside backupFile throws before any unlink can happen.
    mkdirSync(genieHome, { recursive: true });
    writeFileSync(join(genieHome, 'state-backups'), 'not a directory\n', 'utf-8');

    const result = cleanupV4({ home, genieHome });

    expect(existsSync(rulesPath)).toBe(true); // relic survives — backup comes first
    expect(readFileSync(rulesPath, 'utf-8')).toBe(V4_RULES_CONTENT);
    expect(result.actions.map((a) => a.kind)).toEqual(['error']);
    expect(result.backupDir).toBeNull();
    // The failure is still logged (logs dir is independently writable here).
    expect(readFileSync(result.logFile as string, 'utf-8')).toContain('error');
  });

  test('unwritable genieHome degrades gracefully: no throw, relic kept, actions reported', () => {
    const rulesPath = writeRulesFile(V4_RULES_CONTENT);
    // genieHome itself is a FILE: both the backup dir and the logs dir are unwritable.
    writeFileSync(genieHome, 'not a directory\n', 'utf-8');

    const result = cleanupV4({ home, genieHome });

    expect(existsSync(rulesPath)).toBe(true);
    expect(result.actions.map((a) => a.kind)).toEqual(['error']);
    expect(result.backupDir).toBeNull();
    expect(result.logFile).toBeNull(); // log write failed → warned on stderr, not thrown
  });
});

describe('cleanupV4 — plugin cache', () => {
  test('removes only orphan-marked 4.* dirs under automagik/genie', () => {
    const orphaned = makeCacheVersion('genie', '4.260421.17', {
      orphaned: true,
      payload: ['plugin.json', 'scripts/run.sh'],
    });
    const live4 = makeCacheVersion('genie', '4.260500.1', { orphaned: false, payload: ['plugin.json'] });
    const v5 = makeCacheVersion('genie', '5.260704.1', { orphaned: true, payload: ['plugin.json'] });
    const otherPlugin = makeCacheVersion('other-plugin', '4.0.0', { orphaned: true, payload: ['plugin.json'] });

    const result = cleanupV4({ home, genieHome });

    expect(existsSync(orphaned)).toBe(false);
    expect(existsSync(live4)).toBe(true);
    expect(existsSync(v5)).toBe(true);
    expect(existsSync(otherPlugin)).toBe(true);

    const kinds = result.actions.map((a) => `${a.kind}:${a.path}`).sort();
    expect(kinds).toEqual([`kept-cache-unmarked:${live4}`, `removed-cache:${orphaned}`].sort());
    // Neither the v5 dir nor the foreign plugin ever enters the report.
    expect(result.report.cacheDirs.map((d) => d.path).sort()).toEqual([orphaned, live4].sort());

    // A manifest listing (not the payload) is backed up for the removed dir.
    const manifestPath = join(result.backupDir as string, 'cache-manifests', 'genie-4.260421.17.txt');
    const manifest = readFileSync(manifestPath, 'utf-8');
    expect(manifest).toContain('plugin.json');
    expect(manifest).toContain('scripts/run.sh');
    expect(manifest).toContain(orphaned);
  });
});

describe('cleanupV4 — idempotency', () => {
  test('clean machine is a strict no-op: nothing written anywhere', () => {
    const result = cleanupV4({ home, genieHome });

    expect(result.noOp).toBe(true);
    expect(result.actions).toHaveLength(0);
    expect(result.backupDir).toBeNull();
    expect(result.logFile).toBeNull();
    expect(existsSync(join(genieHome, 'state-backups'))).toBe(false);
    expect(existsSync(join(genieHome, 'logs'))).toBe(false);
  });

  test('second run after a cleanup is a no-op', () => {
    writeRulesFile(V4_RULES_CONTENT);
    makeCacheVersion('genie', '4.260421.17', { orphaned: true, payload: ['plugin.json'] });

    const first = cleanupV4({ home, genieHome });
    expect(first.noOp).toBe(false);
    expect(first.actions.map((a) => a.kind).sort()).toEqual(['removed-cache', 'removed-rules']);
    const logAfterFirst = readFileSync(first.logFile as string, 'utf-8');
    const backupsAfterFirst = readdirSync(join(genieHome, 'state-backups'));
    expect(backupsAfterFirst).toHaveLength(1);

    const second = cleanupV4({ home, genieHome });
    expect(second.noOp).toBe(true);
    expect(second.actions).toHaveLength(0);
    expect(second.backupDir).toBeNull();
    // No new backup dir, no new log lines.
    expect(readdirSync(join(genieHome, 'state-backups'))).toEqual(backupsAfterFirst);
    expect(readFileSync(first.logFile as string, 'utf-8')).toBe(logAfterFirst);
  });

  test('genieHome falls back to $GENIE_HOME when not passed', () => {
    const envGenieHome = join(home, 'relocated-genie-home');
    process.env.GENIE_HOME = envGenieHome;
    writeRulesFile(V4_RULES_CONTENT);

    const result = cleanupV4({ home });

    expect((result.backupDir as string).startsWith(join(envGenieHome, 'state-backups'))).toBe(true);
    expect(result.logFile).toBe(join(envGenieHome, 'logs', 'v4-cleanup.log'));
  });
});

describe('shared manifest — no duplicated legacy-path literals', () => {
  test('path helpers compose from the manifest segments', () => {
    expect(orchestrationRulesPath('/fixture')).toBe(join('/fixture', '.claude', 'rules', 'genie-orchestration.md'));
    expect(v4PluginCacheRoot('/fixture')).toBe(join('/fixture', '.claude', 'plugins', 'cache', 'automagik', 'genie'));
  });

  test('uninstall.ts imports the manifest and never restates the rules path', () => {
    const source = readFileSync(join(import.meta.dir, 'uninstall.ts'), 'utf-8');
    expect(source).toContain("from './legacy-v4.js'");
    expect(source).not.toContain('genie-orchestration.md');
  });

  test('install.sh hands off to `genie install` and never restates the rules path', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'install.sh'), 'utf-8');
    expect(source).toContain('"$LOCAL_BIN/genie" install');
    expect(source).not.toContain('genie-orchestration.md');
  });
});

// ============================================================================
// Genie-home residue (wish v4-home-residue-doctor)
// ============================================================================

/** Seed a genie home with manifest residue AND known-live files. */
function seedResidueHome(): { residue: string[]; live: string[] } {
  mkdirSync(join(genieHome, 'relay', 'nested'), { recursive: true });
  mkdirSync(join(genieHome, 'logs'), { recursive: true });
  mkdirSync(join(genieHome, 'bin'), { recursive: true });
  writeFileSync(join(genieHome, 'serve.pid'), '12345\n', 'utf-8');
  writeFileSync(join(genieHome, 'hook-fallback.log'), 'x'.repeat(2048), 'utf-8');
  writeFileSync(join(genieHome, '.role-cutover-abc123.json'), '{}', 'utf-8');
  writeFileSync(join(genieHome, 'relay', 'nested', 'payload.txt'), 'relay payload\n', 'utf-8');
  writeFileSync(join(genieHome, 'logs', 'scheduler.log'), '{"level":"error"}\n', 'utf-8');
  const live = [
    join(genieHome, 'genie.db'),
    join(genieHome, 'config.json'),
    join(genieHome, 'bin', 'genie'),
    join(genieHome, 'logs', 'update-diagnostics.json'),
    join(genieHome, 'tmux.conf.bak'), // KNOWN LIVE per constraint: tmux*/tui-* stay
    join(genieHome, 'role-cutover-other.txt'), // near-miss for the glob
  ];
  for (const f of live) writeFileSync(f, `live ${f}\n`, 'utf-8');
  return {
    residue: [
      join(genieHome, 'serve.pid'),
      join(genieHome, 'hook-fallback.log'),
      join(genieHome, '.role-cutover-abc123.json'),
      join(genieHome, 'relay'),
      join(genieHome, 'logs', 'scheduler.log'),
    ],
    live,
  };
}

describe('detectV4HomeResidue', () => {
  test('absent genie home → no residue', () => {
    expect(detectV4HomeResidue(genieHome)).toHaveLength(0);
  });

  test('detects exactly the manifest residue, never live files', () => {
    const { residue } = seedResidueHome();
    const found = detectV4HomeResidue(genieHome);
    expect(found.map((r) => r.path).sort()).toEqual([...residue].sort());
    // per-relic metadata: sizes populated, dir flagged as dir
    const relay = found.find((r) => r.relPath === 'relay');
    expect(relay?.kind).toBe('dir');
    expect(relay?.sizeBytes).toBeGreaterThan(0);
    expect(found.find((r) => r.relPath === 'hook-fallback.log')?.sizeBytes).toBe(2048);
    for (const r of found) expect(r.evidence.length).toBeGreaterThan(0);
  });

  test('kind mismatch is kept: `state` existing as a FILE is not ours', () => {
    mkdirSync(genieHome, { recursive: true });
    writeFileSync(join(genieHome, 'state'), 'not a dir\n', 'utf-8');
    expect(detectV4HomeResidue(genieHome)).toHaveLength(0);
  });

  test('symlinked residue name is skipped — never follows a link', () => {
    const outside = join(home, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'precious.txt'), 'keep me\n', 'utf-8');
    mkdirSync(genieHome, { recursive: true });
    symlinkSync(outside, join(genieHome, 'model-a'));
    expect(detectV4HomeResidue(genieHome)).toHaveLength(0);
    cleanupV4({ home, genieHome });
    expect(readFileSync(join(outside, 'precious.txt'), 'utf-8')).toBe('keep me\n');
  });
});

describe('cleanupV4 — genie-home residue', () => {
  test('backs up full content, removes residue, leaves live files byte-identical', () => {
    const { residue, live } = seedResidueHome();
    const liveContents = live.map((f) => readFileSync(f, 'utf-8'));

    const result = cleanupV4({ home, genieHome });

    for (const path of residue) expect(existsSync(path)).toBe(false);
    live.forEach((f, i) => expect(readFileSync(f, 'utf-8')).toBe(liveContents[i]));

    // Full-content backup under <backupDir>/genie-home/<relPath>
    const backup = result.backupDir as string;
    expect(readFileSync(join(backup, 'genie-home', 'serve.pid'), 'utf-8')).toBe('12345\n');
    expect(readFileSync(join(backup, 'genie-home', 'relay', 'nested', 'payload.txt'), 'utf-8')).toBe('relay payload\n');
    expect(readFileSync(join(backup, 'genie-home', 'logs', 'scheduler.log'), 'utf-8')).toBe('{"level":"error"}\n');

    const kinds = result.actions.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'removed-home-residue')).toHaveLength(5);
    expect(result.homeResidue).toHaveLength(5);
    expect(readFileSync(result.logFile as string, 'utf-8')).toContain('removed-home-residue');
  });

  test('second run is a no-op', () => {
    seedResidueHome();
    const first = cleanupV4({ home, genieHome });
    expect(first.noOp).toBe(false);
    const second = cleanupV4({ home, genieHome });
    expect(second.noOp).toBe(true);
    expect(second.homeResidue).toHaveLength(0);
    expect(second.actions).toHaveLength(0);
  });
});
