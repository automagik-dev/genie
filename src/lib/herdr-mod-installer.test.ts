/**
 * T10 — the Herdr mod channel (wish `genie-v7-board`, group 3).
 *
 * Every case runs against a temporary GENIE_HOME and a temporary Herdr app
 * home, with a fixture mod tree standing in for the payload's
 * `plugins/genie-herdr` (group 2 owns the real one; this channel treats it as
 * an opaque directory). Nothing here reads or writes `~/.config/herdr-app`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { installCommand } from '../genie-commands/install.js';
import type { cleanupV4 } from '../genie-commands/legacy-v4.js';
import { applyConvergenceExitSignal, runManualUpdateConvergence } from '../genie-commands/update.js';
import {
  type HerdrModChannelConvergenceResult,
  resolveHerdrAppHome,
  runHerdrModChannelConvergence,
  shippedHerdrModRoot,
} from './herdr-mod-installer.js';
import {
  type SkillsChannelConvergenceResult,
  type SkillsInstallRecord,
  readSkillsInstallRecord,
  skillsInstallRecordPath,
  writeSkillsInstallRecord,
} from './skills-installer.js';
import type { WorkflowsChannelConvergenceResult } from './workflows-installer.js';

const VERSION = '6.261104.3';
const STAMP = new Date('2026-11-04T12:34:56.000Z');

let root: string;
let genieHome: string;
let herdrAppHome: string;
let modDir: string;
let payload: string;

const MOD_FILES: Record<string, string> = {
  'mod.json': '{"name":"genie-herdr"}\n',
  'main.js': 'export const view = 1;\n',
  'data.js': 'export const rules = 1;\n',
  '.gitignore': 'node_modules/\n',
  'assets/tasks.svg': '<svg id="tasks"/>\n',
};

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function baseRecord(overrides: Partial<SkillsInstallRecord> = {}): SkillsInstallRecord {
  return {
    ref: `v${VERSION}`,
    cliVersion: '1.5.23',
    inventory: ['wish'],
    agentDirs: [join(root, 'home', '.claude', 'skills')],
    installedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

function writeRecord(overrides: Partial<SkillsInstallRecord> = {}): void {
  writeSkillsInstallRecord(genieHome, baseRecord(overrides));
}

/** Replace the payload's mod tree with exactly `files`. */
function deliver(files: Record<string, string> = MOD_FILES): void {
  rmSync(payload, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(payload, path)), { recursive: true });
    writeFileSync(join(payload, path), content);
  }
}

function converge(
  options: { selection?: 'auto' | 'none'; lines?: string[]; appHome?: string | null } = {},
): HerdrModChannelConvergenceResult {
  return runHerdrModChannelConvergence({
    selection: options.selection ?? 'auto',
    version: VERSION,
    genieHome,
    ...(options.appHome === null ? {} : { herdrAppHome: options.appHome ?? herdrAppHome }),
    log: (line) => options.lines?.push(line),
    now: () => STAMP,
  });
}

/** Every regular file under `dir`, relative path → contents. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(dir, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function backupRoots(): string[] {
  const backups = join(genieHome, 'state-backups');
  return existsSync(backups) ? readdirSync(backups).sort() : [];
}

function rawRecordField(): string | undefined {
  const raw = JSON.parse(readFileSync(skillsInstallRecordPath(genieHome), 'utf8')) as { herdrMod?: unknown };
  return raw.herdrMod === undefined ? undefined : JSON.stringify(raw.herdrMod);
}

/** Run `fn` with process.exitCode restored afterwards, returning what it was set to. */
function capturingExitCode(fn: () => void): number | string | undefined {
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    fn();
    return process.exitCode;
  } finally {
    process.exitCode = saved ?? 0;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-herdr-mod-channel-'));
  genieHome = join(root, 'genie-home');
  herdrAppHome = join(root, 'herdr-app');
  modDir = join(herdrAppHome, 'mods', 'genie-herdr');
  payload = shippedHerdrModRoot(genieHome);
  mkdirSync(genieHome, { recursive: true });
  mkdirSync(herdrAppHome, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('T10 runs — install, record, and a no-op rerun', () => {
  test('the first run copies every payload file and records its sha256', () => {
    writeRecord();
    deliver();
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result).toEqual({ status: 'installed', warnings: [] });
    expect(snapshot(modDir)).toEqual(MOD_FILES);
    const recorded = readSkillsInstallRecord(genieHome)?.herdrMod;
    expect(recorded).toEqual({
      dir: modDir,
      ref: `v${VERSION}`,
      files: Object.fromEntries(Object.entries(MOD_FILES).map(([path, content]) => [path, digest(content)])),
    });
    expect(lines).toEqual([`herdr-mod: 5 file(s) in ${modDir} @ v${VERSION} (5 written, 0 already current)`]);
    // Genie's own record survives the field write untouched.
    expect(readSkillsInstallRecord(genieHome)?.inventory).toEqual(['wish']);
  });

  test('a second run changes nothing and creates no backup root', () => {
    writeRecord();
    deliver();
    converge();
    const before = snapshot(modDir);
    const mtimes = Object.keys(before).map((path) => statSync(join(modDir, path)).mtimeMs);
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('installed');

    expect(snapshot(modDir)).toEqual(before);
    expect(Object.keys(before).map((path) => statSync(join(modDir, path)).mtimeMs)).toEqual(mtimes);
    expect(backupRoots()).toEqual([]);
    expect(lines).toEqual([`herdr-mod: 5 file(s) in ${modDir} @ v${VERSION} (0 written, 5 already current)`]);
  });

  test('a release that changes a file replaces genie’s own previous copy silently', () => {
    writeRecord();
    deliver();
    converge();
    deliver({ ...MOD_FILES, 'main.js': 'export const view = 2;\n' });
    const lines: string[] = [];

    converge({ lines });

    expect(readFileSync(join(modDir, 'main.js'), 'utf8')).toBe('export const view = 2;\n');
    expect(backupRoots()).toEqual([]);
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.files['main.js']).toBe(digest('export const view = 2;\n'));
    expect(lines).toEqual([`herdr-mod: 5 file(s) in ${modDir} @ v${VERSION} (1 written, 4 already current)`]);
  });
});

describe('T10 backups — backup-first replacement', () => {
  test('a hand-edited genie file is copied to state-backups/herdr-mod-collision-* before replacement', () => {
    writeRecord();
    deliver();
    converge();
    writeFileSync(join(modDir, 'main.js'), 'export const view = "mine";\n');
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('installed');

    const roots = backupRoots();
    expect(roots).toEqual(['herdr-mod-collision-2026-11-04T12-34-56-000Z']);
    const backupRoot = join(genieHome, 'state-backups', roots[0] ?? '');
    expect(snapshot(backupRoot)).toEqual({ 'main.js': 'export const view = "mine";\n' });
    expect(readFileSync(join(modDir, 'main.js'), 'utf8')).toBe(MOD_FILES['main.js']);
    expect(lines).toEqual([
      `herdr-mod: main.js was modified locally — previous contents backed up to ${backupRoot}`,
      `herdr-mod: collision backup kept at ${backupRoot} (1 file(s))`,
      `herdr-mod: 5 file(s) in ${modDir} @ v${VERSION} (1 written, 4 already current)`,
    ]);
  });

  test('a file genie never installed at a delivered path is backed up before the first install', () => {
    writeRecord();
    deliver();
    mkdirSync(join(modDir, 'assets'), { recursive: true });
    writeFileSync(join(modDir, 'assets', 'tasks.svg'), '<svg id="hand-made"/>\n');
    const lines: string[] = [];

    converge({ lines });

    const backupRoot = join(genieHome, 'state-backups', backupRoots()[0] ?? '');
    expect(snapshot(backupRoot)).toEqual({ 'assets/tasks.svg': '<svg id="hand-made"/>\n' });
    expect(readFileSync(join(modDir, 'assets', 'tasks.svg'), 'utf8')).toBe(MOD_FILES['assets/tasks.svg']);
    expect(lines[0]).toBe(
      `herdr-mod: assets/tasks.svg was not installed by genie — previous contents backed up to ${backupRoot}`,
    );
  });

  test('a non-regular file at a delivered path is preserved, never followed or replaced', () => {
    writeRecord();
    deliver();
    mkdirSync(modDir, { recursive: true });
    const outside = join(root, 'outside.js');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(modDir, 'main.js'));
    const lines: string[] = [];

    converge({ lines });

    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(lines).toContain('herdr-mod: preserved main.js — not a regular file; left in place');
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.files['main.js']).toBeUndefined();
  });
});

describe('T10 hands off — Herdr’s own files and undelivered files', () => {
  test('a file genie never delivered, gpui-kit.d.ts and jsconfig.json stay byte-identical', () => {
    writeRecord();
    // Even a payload that carried Herdr's generated names would not deliver them.
    deliver({ ...MOD_FILES, 'gpui-kit.d.ts': 'payload copy\n', 'jsconfig.json': '{"payload":true}\n' });
    mkdirSync(modDir, { recursive: true });
    const herdrOwned = {
      'gpui-kit.d.ts': 'declare module "gpui-kit";\n',
      'jsconfig.json': '{"compilerOptions":{}}\n',
      'notes/owner.txt': 'my notes\n',
    };
    for (const [path, content] of Object.entries(herdrOwned)) {
      mkdirSync(dirname(join(modDir, path)), { recursive: true });
      writeFileSync(join(modDir, path), content);
    }

    converge();
    converge();

    const after = snapshot(modDir);
    for (const [path, content] of Object.entries(herdrOwned)) expect(after[path]).toBe(content);
    expect(Object.keys(readSkillsInstallRecord(genieHome)?.herdrMod?.files ?? {}).sort()).toEqual(
      Object.keys(MOD_FILES).sort(),
    );
    expect(backupRoots()).toEqual([]);
  });

  test('a host with no Herdr app home is skipped with one line and gets no product home', () => {
    rmSync(herdrAppHome, { recursive: true, force: true });
    writeRecord();
    deliver();
    const lines: string[] = [];

    expect(converge({ lines })).toEqual({ status: 'skipped', warnings: [] });

    expect(lines).toEqual([`herdr-mod: skipped (no Herdr app home — ${herdrAppHome} does not exist)`]);
    expect(existsSync(herdrAppHome)).toBe(false);
    expect(readSkillsInstallRecord(genieHome)?.herdrMod).toBeUndefined();
  });

  test('$HERDR_APP_HOME names the Herdr app home; ~/.config/herdr-app is the default', () => {
    const saved = process.env.HERDR_APP_HOME;
    try {
      writeRecord();
      deliver();
      process.env.HERDR_APP_HOME = herdrAppHome;
      expect(resolveHerdrAppHome()).toBe(herdrAppHome);
      // No seam: the production resolution reads the temporary $HERDR_APP_HOME.
      expect(converge({ appHome: null }).status).toBe('installed');
      expect(snapshot(modDir)).toEqual(MOD_FILES);

      Reflect.deleteProperty(process.env, 'HERDR_APP_HOME');
      expect(resolveHerdrAppHome()).toBe(join(homedir(), '.config', 'herdr-app'));
      process.env.HERDR_APP_HOME = '';
      expect(resolveHerdrAppHome()).toBe(join(homedir(), '.config', 'herdr-app'));
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'HERDR_APP_HOME');
      else process.env.HERDR_APP_HOME = saved;
    }
  });
});

describe('T10 consent — no consent, no record, no install', () => {
  test('a none selection skips the channel and writes nothing', () => {
    writeRecord();
    deliver();
    const lines: string[] = [];

    expect(converge({ selection: 'none', lines })).toEqual({ status: 'skipped', warnings: [] });

    expect(lines).toEqual(['herdr-mod: skipped (consent: none)']);
    expect(existsSync(join(herdrAppHome, 'mods'))).toBe(false);
    expect(rawRecordField()).toBeUndefined();
  });

  test('a missing or malformed install record skips the channel and writes nothing', () => {
    deliver();
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('skipped');
    writeFileSync(skillsInstallRecordPath(genieHome), '{"ref":"v1"}\n');
    expect(converge({ lines }).status).toBe('skipped');

    expect(lines).toEqual([
      'herdr-mod: skipped (no install record — run genie update)',
      'herdr-mod: skipped (no install record — run genie update)',
    ]);
    expect(existsSync(join(herdrAppHome, 'mods'))).toBe(false);
    expect(readFileSync(skillsInstallRecordPath(genieHome), 'utf8')).toBe('{"ref":"v1"}\n');
  });
});

describe('T10 no mod in payload (review r1 MEDIUM-1)', () => {
  test('an installed mod with no payload dir prints one line and changes nothing', () => {
    writeRecord();
    deliver();
    converge();
    const files = snapshot(modDir);
    const field = rawRecordField();
    rmSync(payload, { recursive: true, force: true });
    const lines: string[] = [];

    expect(converge({ lines })).toEqual({ status: 'skipped', warnings: [] });

    expect(lines).toEqual([`herdr-mod: skipped (no mod in payload — ${payload})`]);
    expect(snapshot(modDir)).toEqual(files);
    expect(rawRecordField()).toBe(field);
    expect(backupRoots()).toEqual([]);
  });
});

describe('stale files (A19)', () => {
  test('an unmodified recorded file the payload no longer ships is removed and dropped from the record', () => {
    writeRecord();
    deliver();
    converge();
    const { 'data.js': _dropped, ...rest } = MOD_FILES;
    deliver(rest);
    const lines: string[] = [];

    converge({ lines });

    expect(existsSync(join(modDir, 'data.js'))).toBe(false);
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.files['data.js']).toBeUndefined();
    expect(Object.keys(readSkillsInstallRecord(genieHome)?.herdrMod?.files ?? {}).sort()).toEqual(
      Object.keys(rest).sort(),
    );
    expect(lines.at(-1)).toBe(
      `herdr-mod: 4 file(s) in ${modDir} @ v${VERSION} (0 written, 4 already current, 1 retired)`,
    );
  });

  test('a modified recorded file the payload no longer ships is backed up first, then removed', () => {
    writeRecord();
    deliver();
    converge();
    writeFileSync(join(modDir, 'assets', 'tasks.svg'), '<svg id="edited"/>\n');
    const { 'assets/tasks.svg': _dropped, ...rest } = MOD_FILES;
    deliver(rest);
    const lines: string[] = [];

    converge({ lines });

    const backupRoot = join(genieHome, 'state-backups', backupRoots()[0] ?? '');
    expect(snapshot(backupRoot)).toEqual({ 'assets/tasks.svg': '<svg id="edited"/>\n' });
    expect(existsSync(join(modDir, 'assets', 'tasks.svg'))).toBe(false);
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.files['assets/tasks.svg']).toBeUndefined();
    expect(lines[0]).toBe(
      `herdr-mod: retired assets/tasks.svg — no longer shipped, modified locally; previous contents backed up to ${backupRoot}`,
    );
  });
});

describe('failure is retryable, never a throw', () => {
  test('an unwritable mod dir fails with the remedy, exit 1, and leaves the record alone', () => {
    writeRecord();
    deliver();
    mkdirSync(join(herdrAppHome, 'mods'), { recursive: true });
    writeFileSync(modDir, 'a file where the mod dir should be\n');
    const lines: string[] = [];
    let result: HerdrModChannelConvergenceResult | undefined;

    const exitCode = capturingExitCode(() => {
      result = converge({ lines });
    });

    expect(result?.status).toBe('failed');
    expect(exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/^Herdr mod install failed: .+\. Run: genie update$/);
    expect(rawRecordField()).toBeUndefined();
  });
});

describe('T10 hooks and exit codes', () => {
  const skipped: HerdrModChannelConvergenceResult = { status: 'skipped', warnings: [] };
  const failed: HerdrModChannelConvergenceResult = { status: 'failed', warnings: [] };
  const noSkills = (): SkillsChannelConvergenceResult => ({ status: 'skipped', reason: 'test fixture' });
  const noWorkflows = (): WorkflowsChannelConvergenceResult => ({ status: 'skipped', warnings: [] });
  const noopCleanup = (() => ({
    report: { rulesFile: { path: '/fixture', status: 'absent' }, cacheDirs: [], hasRelics: false },
    homeResidue: [],
    actions: [],
    backupDir: null,
    logFile: null,
    noOp: true,
  })) as unknown as typeof cleanupV4;
  const noopLease = () => ({ path: join(tmpdir(), 'genie-herdr-mod-test.lock'), release: () => undefined });

  function install(order: string[], herdrMod: HerdrModChannelConvergenceResult) {
    return installCommand(
      { integrations: 'claude' },
      noopCleanup,
      () => undefined,
      noopLease,
      () => undefined,
      () => {
        order.push('marker');
      },
      (selection) => {
        order.push(`skills:${selection}`);
        return noSkills();
      },
      (selection) => {
        order.push(`workflows:${selection}`);
        return noWorkflows();
      },
      (selection) => {
        order.push(`herdr-mod:${selection}`);
        return herdrMod;
      },
    );
  }

  test('genie install runs the channel after the workflows channel, under the same consent', async () => {
    const order: string[] = [];
    const saved = process.exitCode;
    try {
      await install(order, skipped);
    } finally {
      process.exitCode = saved ?? 0;
    }
    expect(order).toEqual(['skills:claude', 'workflows:claude', 'herdr-mod:claude', 'marker']);
  });

  test('genie install exits 1 on a failed herdr-mod result', async () => {
    const saved = process.exitCode;
    process.exitCode = 0;
    try {
      await install([], failed);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved ?? 0;
    }
  });

  test('the update convergence runs skills, workflows, then herdr-mod, and surfaces the result', () => {
    const steps: string[] = [];
    const result = runManualUpdateConvergence({
      expectedVersion: VERSION,
      selection: 'all',
      runSkills: () => {
        steps.push('skills');
        return noSkills();
      },
      runWorkflows: () => {
        steps.push('workflows');
        return noWorkflows();
      },
      runHerdrMod: (selection) => {
        steps.push(`herdr-mod:${selection}`);
        return skipped;
      },
      log: () => undefined,
    });
    expect(steps).toEqual(['skills', 'workflows', 'herdr-mod:all']);
    expect(result.herdrMod).toEqual(skipped);
    // Consent none reaches no channel, so the production default never runs.
    expect(runManualUpdateConvergence({ expectedVersion: VERSION, selection: 'none', log: () => {} })).toEqual({
      skills: null,
      workflows: null,
      herdrMod: null,
    });
  });

  test('a failed herdr-mod result on the update seam reaches the exit code as a failed workflows result does', () => {
    for (const leg of ['workflows', 'herdrMod'] as const) {
      const exitCode = capturingExitCode(() =>
        applyConvergenceExitSignal({
          skills: noSkills(),
          workflows: leg === 'workflows' ? failed : noWorkflows(),
          herdrMod: leg === 'herdrMod' ? failed : skipped,
        }),
      );
      expect(exitCode).toBe(1);
    }
    expect(
      capturingExitCode(() =>
        applyConvergenceExitSignal({ skills: noSkills(), workflows: noWorkflows(), herdrMod: skipped }),
      ),
    ).toBe(0);
  });

  test('only the new binary’s post-delivery convergence runs the channel, never the old binary’s update path', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'genie-commands', 'update.ts'), 'utf8');
    const bodyOf = (signature: string): string => {
      const start = source.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('\n}', start));
    };
    // The one call site of the production runner is the canonical convergence,
    // after the workflows channel…
    const convergence = bodyOf('export function runManualUpdateConvergence(');
    expect(convergence.indexOf('runUpdateHerdrModChannel')).toBeGreaterThan(
      convergence.indexOf('runUpdateWorkflowsChannel'),
    );
    const callSites = source.split('runUpdateHerdrModChannel)(').length - 1;
    expect(callSites).toBe(1);
    // …which `update --post-delivery-converge` runs in the freshly installed
    // binary, while the old binary only spawns that argv.
    expect(bodyOf('function runPostDeliveryConvergenceMode(')).toContain('runManualUpdateConvergence(');
    expect(source).toContain("run(binaryPath, ['update', '--post-delivery-converge'], environment)");
  });
});
