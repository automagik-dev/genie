/**
 * Tests for `ensureServeReady`.
 *
 * Strategy: dependency-inject every external call so we can drive each
 * precondition × {auto-fix, refuse} branch without a live PG / systemd /
 * filesystem surface. The orchestrator's contract is:
 *
 *   - `ok=true`  iff every precondition resolves to `ok | fixed | skipped`.
 *   - `serve.precondition.fixed` audit emitted per `fixed` precondition.
 *   - `serve.precondition.refused` audit emitted per `refused` precondition.
 *   - The reporter prints one line per precondition + a fix command on refusal.
 *
 * The default-implementation `defaultScanTeamConfigOrphans` is exercised
 * separately because its only dependency is the filesystem — we drive it via
 * a tmpdir + CLAUDE_CONFIG_DIR override.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservabilityHealthReport } from '../../genie-commands/observability-health.js';
import {
  type EnsureServeReadyDeps,
  type PreconditionName,
  type TeamConfigOrphan,
  defaultArchiveStaleTeamConfigs,
  defaultScanTeamConfigOrphans,
  ensureServeReady,
  runDoctorMaintenance,
} from './ensure-ready.js';

// ============================================================================
// Helpers
// ============================================================================

function fakeHealth(overrides: Partial<ObservabilityHealthReport> = {}): ObservabilityHealthReport {
  return {
    partition_health: 'ok',
    partition_count: 3,
    next_rotation_at: '2026-04-27T00:00:00.000Z',
    oldest_partition: 'genie_runtime_events_p20260425',
    newest_partition: 'genie_runtime_events_p20260427',
    wide_emit_flag: 'off',
    watchdog: 'ok',
    watcher_metrics: 'ok',
    watcher_metric_details: [],
    spill_journal: 'empty',
    spill_path: '/tmp/spill.jsonl',
    ...overrides,
  };
}

interface RecordedAudit {
  eventType: 'serve.precondition.fixed' | 'serve.precondition.refused';
  name: PreconditionName;
  details: Record<string, unknown>;
}

function buildDeps(overrides: Partial<EnsureServeReadyDeps> = {}): {
  deps: EnsureServeReadyDeps;
  audits: RecordedAudit[];
  log: string[];
} {
  const audits: RecordedAudit[] = [];
  const log: string[] = [];
  const deps: EnsureServeReadyDeps = {
    collectHealth: async () => fakeHealth(),
    runPartitionMaintenance: async () => ({
      createdOrPresent: 3,
      dropped: 0,
      nextRotationAt: '2026-04-27T00:00:00.000Z',
    }),
    installWatchdog: async () => ({
      filesWritten: ['/etc/systemd/system/genie-watchdog.timer'],
      filesSkipped: [],
    }),
    measureBackfillDrift: async () => ({ driftPct: 0, detail: 'no drift' }),
    runBackfillSync: async () => ({ ranSync: true, driftPct: 0, detail: 'converged' }),
    listOrphanedZombies: async () => [],
    scanTeamConfigOrphans: () => ({ active: [], stale: [] }),
    archiveStaleTeamConfigs: () => [],
    recordAudit: async (eventType, name, details) => {
      audits.push({ eventType, name, details });
    },
    log: (line) => log.push(line),
    ...overrides,
  };
  return { deps, audits, log };
}

// ============================================================================
// Happy path
// ============================================================================

describe('ensureServeReady — happy path (boot)', () => {
  test('all preconditions ok → ok=true, no audit events, only boot-path entries reported', async () => {
    const { deps, audits, log } = buildDeps();
    const report = await ensureServeReady({ autoFix: true, deps });
    expect(report.ok).toBe(true);
    // Boot path is fast-only: partition + backfill + dead_pane_zombies.
    // Watchdog install and team-config orphan archive are doctor's job.
    expect(report.results.map((r) => r.name).sort()).toEqual(['backfill', 'dead_pane_zombies', 'partition']);
    expect(report.results.every((r) => r.status === 'ok')).toBe(true);
    expect(audits).toHaveLength(0);
    expect(log.length).toBeGreaterThanOrEqual(4);
  });

  test('does NOT call installWatchdog at boot (one-time install lives in doctor)', async () => {
    let installCalls = 0;
    const { deps } = buildDeps({
      collectHealth: async () => fakeHealth({ watchdog: 'warn' }),
      installWatchdog: async () => {
        installCalls++;
        return { filesWritten: [], filesSkipped: [] };
      },
    });
    await ensureServeReady({ autoFix: true, deps });
    expect(installCalls).toBe(0);
  });

  test('does NOT archive stale team-config orphans at boot', async () => {
    let archiveCalls = 0;
    const { deps } = buildDeps({
      scanTeamConfigOrphans: () => ({
        active: [],
        stale: [{ teamName: 'old', path: '/tmp/old', newestInboxMs: 1, hasContent: false }],
      }),
      archiveStaleTeamConfigs: () => {
        archiveCalls++;
        return [];
      },
    });
    await ensureServeReady({ autoFix: true, deps });
    expect(archiveCalls).toBe(0);
  });
});

// ============================================================================
// Partition precondition × auto-fix / refuse
// ============================================================================

describe('partition precondition', () => {
  test('partition_health=fail + autoFix=true → fixed, fixed audit emitted', async () => {
    let maintenanceCalls = 0;
    const { deps, audits } = buildDeps({
      collectHealth: async () => fakeHealth({ partition_health: 'fail' }),
      runPartitionMaintenance: async () => {
        maintenanceCalls++;
        return { createdOrPresent: 3, dropped: 1, nextRotationAt: '2026-04-27T00:00:00.000Z' };
      },
    });
    const report = await ensureServeReady({ autoFix: true, deps });
    const partition = report.results.find((r) => r.name === 'partition');
    expect(partition?.status).toBe('fixed');
    expect(maintenanceCalls).toBe(1);
    expect(audits.find((a) => a.name === 'partition')?.eventType).toBe('serve.precondition.fixed');
    expect(report.ok).toBe(true);
  });

  test('partition_health=fail + autoFix=false → refused with fix command, no maintenance call', async () => {
    let maintenanceCalls = 0;
    const { deps, audits } = buildDeps({
      collectHealth: async () => fakeHealth({ partition_health: 'fail' }),
      runPartitionMaintenance: async () => {
        maintenanceCalls++;
        return { createdOrPresent: 0, dropped: 0, nextRotationAt: null };
      },
    });
    const report = await ensureServeReady({ autoFix: false, deps });
    const partition = report.results.find((r) => r.name === 'partition');
    expect(partition?.status).toBe('refused');
    expect(partition?.fixCommand).toContain('genie doctor --observability');
    expect(maintenanceCalls).toBe(0);
    expect(report.ok).toBe(false);
    expect(audits.find((a) => a.name === 'partition')?.eventType).toBe('serve.precondition.refused');
  });

  test('partition_health=unknown (pg offline) → skipped, not refused', async () => {
    const { deps } = buildDeps({
      collectHealth: async () => fakeHealth({ partition_health: 'unknown' }),
    });
    const report = await ensureServeReady({ autoFix: false, deps });
    expect(report.results.find((r) => r.name === 'partition')?.status).toBe('skipped');
    // Skipped doesn't fail boot under --no-fix — the user is told via the report.
    expect(report.ok).toBe(true);
  });
});

// ============================================================================
// Watchdog precondition — only ever runs in doctor maintenance, never boot
// ============================================================================

describe('runDoctorMaintenance — watchdog precondition', () => {
  test('watchdog warn → fixed via installWatchdog', async () => {
    let installCalls = 0;
    const { deps, audits } = buildDeps({
      collectHealth: async () => fakeHealth({ watchdog: 'warn', watchdog_detail: 'units missing' }),
      installWatchdog: async () => {
        installCalls++;
        return { filesWritten: ['/etc/systemd/system/genie-watchdog.timer'], filesSkipped: [] };
      },
    });
    const report = await runDoctorMaintenance({ deps, silent: true });
    expect(installCalls).toBe(1);
    expect(report.results.find((r) => r.name === 'watchdog')?.status).toBe('fixed');
    expect(audits.find((a) => a.name === 'watchdog')?.eventType).toBe('serve.precondition.fixed');
  });

  test('install throws (EACCES) → refused, not crashed', async () => {
    const { deps, audits } = buildDeps({
      collectHealth: async () => fakeHealth({ watchdog: 'warn' }),
      installWatchdog: async () => {
        throw new Error("EACCES: permission denied, open '/etc/systemd/system/genie-watchdog.timer'");
      },
    });
    const report = await runDoctorMaintenance({ deps, silent: true });
    const wd = report.results.find((r) => r.name === 'watchdog');
    expect(wd?.status).toBe('refused');
    expect(wd?.detail).toContain('EACCES');
    expect(report.ok).toBe(false);
    expect(audits.find((a) => a.name === 'watchdog')?.eventType).toBe('serve.precondition.refused');
  });
});

// ============================================================================
// Backfill precondition × auto-fix / refuse
// ============================================================================

describe('backfill precondition', () => {
  test('drift below threshold → ok, no convergence pass', async () => {
    let syncCalls = 0;
    const { deps } = buildDeps({
      measureBackfillDrift: async () => ({ driftPct: 1.2, detail: '1.2%' }),
      runBackfillSync: async () => {
        syncCalls++;
        return { ranSync: true, driftPct: 0, detail: 'unused' };
      },
    });
    const report = await ensureServeReady({ autoFix: true, deps });
    expect(report.results.find((r) => r.name === 'backfill')?.status).toBe('ok');
    expect(syncCalls).toBe(0);
  });

  test('drift above threshold + autoFix=true → fixed via runBackfillSync (fire-and-forget at boot)', async () => {
    let syncCalls = 0;
    const { deps, audits } = buildDeps({
      measureBackfillDrift: async () => ({ driftPct: 12.5, detail: '12.5%' }),
      // Boot uses the fire-and-forget default; the test's stub stands in for
      // it — what matters is the call count, not whether it blocks.
      runBackfillSync: async () => {
        syncCalls++;
        return { ranSync: true, driftPct: null, detail: 'background convergence kicked' };
      },
    });
    const report = await ensureServeReady({ autoFix: true, deps });
    expect(syncCalls).toBe(1);
    const bf = report.results.find((r) => r.name === 'backfill');
    expect(bf?.status).toBe('fixed');
    expect(bf?.detail).toContain('background convergence kicked');
    expect(audits.find((a) => a.name === 'backfill')?.eventType).toBe('serve.precondition.fixed');
  });

  test('drift above threshold + autoFix=false → refused with sessions sync hint', async () => {
    const { deps } = buildDeps({
      measureBackfillDrift: async () => ({ driftPct: 8.0, detail: '8%' }),
    });
    const report = await ensureServeReady({ autoFix: false, deps });
    const bf = report.results.find((r) => r.name === 'backfill');
    expect(bf?.status).toBe('refused');
    expect(bf?.fixCommand).toContain('genie sessions sync');
    expect(report.ok).toBe(false);
  });

  test('drift unknown (no prior backfill row) → skipped, ok=true', async () => {
    const { deps } = buildDeps({
      measureBackfillDrift: async () => ({ driftPct: null, detail: 'no prior backfill row' }),
    });
    const report = await ensureServeReady({ autoFix: false, deps });
    expect(report.results.find((r) => r.name === 'backfill')?.status).toBe('skipped');
    expect(report.ok).toBe(true);
  });
});

// ============================================================================
// Dead-pane zombies — never auto-fixed at boot, only surfaced
// ============================================================================

describe('dead-pane zombies precondition', () => {
  test('no orphans → ok', async () => {
    const { deps } = buildDeps();
    const report = await ensureServeReady({ autoFix: true, deps });
    expect(report.results.find((r) => r.name === 'dead_pane_zombies')?.status).toBe('ok');
  });

  test('orphans present + autoFix=true → still refused (boot does not auto-archive)', async () => {
    const { deps, audits } = buildDeps({
      listOrphanedZombies: async () => [
        { id: 'agent-1', lastStateChange: '2026-04-20T00:00:00.000Z' },
        { id: 'agent-2', lastStateChange: '2026-04-20T00:00:00.000Z' },
      ],
    });
    const report = await ensureServeReady({ autoFix: true, deps });
    const z = report.results.find((r) => r.name === 'dead_pane_zombies');
    expect(z?.status).toBe('refused');
    expect(z?.detail).toContain('2 exhausted');
    expect(z?.fixCommand).toContain('genie prune --zombies');
    expect(report.ok).toBe(false);
    expect(audits.find((a) => a.name === 'dead_pane_zombies')?.eventType).toBe('serve.precondition.refused');
  });
});

// ============================================================================
// Team-config orphans × active / stale × auto-fix / refuse
// ============================================================================

describe('runDoctorMaintenance — team-config orphans precondition', () => {
  function activeOrphan(name: string): TeamConfigOrphan {
    return { teamName: name, path: `/tmp/${name}`, newestInboxMs: Date.now(), hasContent: true };
  }
  function staleOrphan(name: string): TeamConfigOrphan {
    return {
      teamName: name,
      path: `/tmp/${name}`,
      newestInboxMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
      hasContent: false,
    };
  }

  test('no orphans → ok, no archive call', async () => {
    let archiveCalls = 0;
    const { deps } = buildDeps({
      archiveStaleTeamConfigs: () => {
        archiveCalls++;
        return [];
      },
    });
    const report = await runDoctorMaintenance({ deps, silent: true });
    expect(report.results.find((r) => r.name === 'team_config_orphans')?.status).toBe('ok');
    expect(archiveCalls).toBe(0);
  });

  test('only stale orphans → fixed via archive', async () => {
    let archived: string[] = [];
    const { deps, audits } = buildDeps({
      scanTeamConfigOrphans: () => ({ active: [], stale: [staleOrphan('qa-moak1'), staleOrphan('qa-moak2')] }),
      archiveStaleTeamConfigs: (orphans) => {
        archived = orphans.map((o) => `archived-${o.teamName}`);
        return archived;
      },
    });
    const report = await runDoctorMaintenance({ deps, silent: true });
    const o = report.results.find((r) => r.name === 'team_config_orphans');
    expect(o?.status).toBe('fixed');
    expect(o?.detail).toContain('archived 2');
    expect(archived).toHaveLength(2);
    expect(audits.find((a) => a.name === 'team_config_orphans')?.eventType).toBe('serve.precondition.fixed');
  });

  test('active orphans → refused (cannot rebuild config without operator)', async () => {
    const { deps, audits } = buildDeps({
      scanTeamConfigOrphans: () => ({
        active: [activeOrphan('felipe-scout')],
        stale: [staleOrphan('qa-moak1')],
      }),
      archiveStaleTeamConfigs: () => ['archived-qa-moak1'],
    });
    const report = await runDoctorMaintenance({ deps, silent: true });
    const o = report.results.find((r) => r.name === 'team_config_orphans');
    expect(o?.status).toBe('refused');
    expect(o?.fixCommand).toContain('genie team repair felipe-scout');
    expect(o?.detail).toContain('archived 1 stale');
    expect(report.ok).toBe(false);
    expect(audits.find((a) => a.name === 'team_config_orphans')?.eventType).toBe('serve.precondition.refused');
  });
});

// ============================================================================
// Reporter (printReport via deps.log)
// ============================================================================

describe('reporter', () => {
  test('refused entry includes the fix command on its own line', async () => {
    const { deps, log } = buildDeps({
      collectHealth: async () => fakeHealth({ partition_health: 'fail' }),
    });
    await ensureServeReady({ autoFix: false, deps });
    const arrow = log.find((line) => line.includes('→') && line.includes('genie doctor'));
    expect(arrow).toBeDefined();
  });

  test('every entry uses a status tag', async () => {
    const { deps, log } = buildDeps();
    await ensureServeReady({ autoFix: true, deps });
    // Boot path: partition + backfill + dead_pane_zombies → 3 [ok] lines.
    const okLines = log.filter((l) => l.includes('[ok]'));
    expect(okLines).toHaveLength(3);
  });
});

// ============================================================================
// defaultScanTeamConfigOrphans — filesystem behavior
// ============================================================================

describe('defaultScanTeamConfigOrphans (filesystem)', () => {
  let tmpRoot: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `genie-orphan-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpRoot, 'teams'), { recursive: true });
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpRoot;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env mutation in test teardown — `= undefined` leaves the key visible
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('healthy team (config.json present) is not classified as an orphan', () => {
    const dir = join(tmpRoot, 'teams', 'healthy');
    mkdirSync(join(dir, 'inboxes'), { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'inboxes', 'team-lead.json'), '[]');
    const scan = defaultScanTeamConfigOrphans();
    expect(scan.active).toHaveLength(0);
    expect(scan.stale).toHaveLength(0);
  });

  test('orphan with empty inboxes → stale', () => {
    const dir = join(tmpRoot, 'teams', 'qa-moak');
    mkdirSync(join(dir, 'inboxes'), { recursive: true });
    writeFileSync(join(dir, 'inboxes', 'team-lead.json'), '[]');
    const scan = defaultScanTeamConfigOrphans();
    expect(scan.active).toHaveLength(0);
    expect(scan.stale).toHaveLength(1);
    expect(scan.stale[0].teamName).toBe('qa-moak');
  });

  test('orphan with fresh non-empty inbox → active', () => {
    const dir = join(tmpRoot, 'teams', 'felipe-scout');
    mkdirSync(join(dir, 'inboxes'), { recursive: true });
    writeFileSync(
      join(dir, 'inboxes', 'team-lead.json'),
      '[{"from":"u","text":"hi","summary":"hi","timestamp":"2026-04-26T00:00:00Z","color":"#fff","read":false}]',
    );
    const scan = defaultScanTeamConfigOrphans();
    expect(scan.active).toHaveLength(1);
    expect(scan.active[0].teamName).toBe('felipe-scout');
    expect(scan.active[0].hasContent).toBe(true);
  });

  test('archive moves stale orphan into _archive/<name>-<timestamp>/', () => {
    const dir = join(tmpRoot, 'teams', 'qa-moak1');
    mkdirSync(join(dir, 'inboxes'), { recursive: true });
    writeFileSync(join(dir, 'inboxes', 'team-lead.json'), '[]');
    const scan = defaultScanTeamConfigOrphans();
    const archived = defaultArchiveStaleTeamConfigs(scan.stale);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain('_archive');
    expect(archived[0]).toContain('qa-moak1');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(archived[0])).toBe(true);
  });

  test('skips _archive subdirectory itself (does not loop on prior archives)', () => {
    mkdirSync(join(tmpRoot, 'teams', '_archive'), { recursive: true });
    const scan = defaultScanTeamConfigOrphans();
    expect(scan.active).toHaveLength(0);
    expect(scan.stale).toHaveLength(0);
  });
});
