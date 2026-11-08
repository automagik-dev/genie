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
  lstatSync,
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

/**
 * Review fix1 HIGH-1: a symlink (or any non-directory) at any directory
 * component below a configured root is refused and left in place, never
 * traversed. Each fixture points the redirect at an `outside` tree and asserts
 * that tree and the install record are unchanged.
 */
describe('redirected paths are refused, never traversed (fix1 HIGH-1)', () => {
  let outside: string;
  const OWNER = 'outside owner data\n';

  beforeEach(() => {
    outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
  });

  function plantOutside(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(outside, path)), { recursive: true });
      writeFileSync(join(outside, path), content);
    }
  }

  function failsWithNothingWritten(lines: string[], redirected: string): void {
    expect(lines.at(-1)).toContain(`Herdr mod install failed: ${redirected} is not a physical directory`);
  }

  test('a symlinked payload mod root is refused: nothing is copied from outside the payload', () => {
    writeRecord();
    plantOutside({ 'mod.json': '{"name":"not-genie"}\n', 'main.js': OWNER });
    mkdirSync(dirname(payload), { recursive: true });
    symlinkSync(outside, payload);
    const before = snapshot(outside);
    const lines: string[] = [];

    const exitCode = capturingExitCode(() => expect(converge({ lines }).status).toBe('failed'));

    expect(exitCode).toBe(1);
    failsWithNothingWritten(lines, join(genieHome, 'plugins', 'genie-herdr'));
    expect(existsSync(join(herdrAppHome, 'mods'))).toBe(false);
    expect(snapshot(outside)).toEqual(before);
    expect(rawRecordField()).toBeUndefined();
  });

  test('a symlinked mods root is refused before any write', () => {
    writeRecord();
    deliver();
    plantOutside({ 'genie-herdr/main.js': OWNER });
    symlinkSync(outside, join(herdrAppHome, 'mods'));
    const before = snapshot(outside);
    const lines: string[] = [];

    const exitCode = capturingExitCode(() => expect(converge({ lines }).status).toBe('failed'));

    expect(exitCode).toBe(1);
    failsWithNothingWritten(lines, join(herdrAppHome, 'mods'));
    expect(snapshot(outside)).toEqual(before);
    expect(rawRecordField()).toBeUndefined();
  });

  test('a symlinked mod root is refused before any write, and a recorded install is left as recorded', () => {
    writeRecord();
    deliver();
    converge();
    const field = rawRecordField();
    rmSync(modDir, { recursive: true, force: true });
    plantOutside({ 'main.js': OWNER, 'data.js': MOD_FILES['data.js'] ?? '' });
    symlinkSync(outside, modDir);
    const before = snapshot(outside);
    const lines: string[] = [];

    const exitCode = capturingExitCode(() => expect(converge({ lines }).status).toBe('failed'));

    expect(exitCode).toBe(1);
    failsWithNothingWritten(lines, join(herdrAppHome, 'mods', 'genie-herdr'));
    expect(snapshot(outside)).toEqual(before);
    expect(rawRecordField()).toBe(field);
  });

  test('a symlinked nested directory preserves the file behind it and keeps its recorded receipt', () => {
    writeRecord();
    deliver();
    converge();
    const recordedSvg = readSkillsInstallRecord(genieHome)?.herdrMod?.files['assets/tasks.svg'];
    rmSync(join(modDir, 'assets'), { recursive: true, force: true });
    plantOutside({ 'tasks.svg': OWNER });
    symlinkSync(outside, join(modDir, 'assets'));
    deliver({ ...MOD_FILES, 'assets/tasks.svg': '<svg id="v2"/>\n' });
    const before = snapshot(outside);
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('installed');

    expect(snapshot(outside)).toEqual(before);
    expect(lines).toContain(
      `herdr-mod: preserved assets/tasks.svg — ${join(modDir, 'assets')} is not a physical directory; left in place`,
    );
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.files['assets/tasks.svg']).toBe(recordedSvg);
    expect(readFileSync(join(modDir, 'main.js'), 'utf8')).toBe(MOD_FILES['main.js']);
  });

  test('a symlinked parent of a stale recorded file is preserved: nothing outside is deleted', () => {
    writeRecord();
    deliver();
    converge();
    const recordedSvg = readSkillsInstallRecord(genieHome)?.herdrMod?.files['assets/tasks.svg'];
    rmSync(join(modDir, 'assets'), { recursive: true, force: true });
    // Byte-equal to the recorded file, so without the chain check it would be retired.
    plantOutside({ 'tasks.svg': MOD_FILES['assets/tasks.svg'] ?? '' });
    symlinkSync(outside, join(modDir, 'assets'));
    const { 'assets/tasks.svg': _dropped, ...rest } = MOD_FILES;
    deliver(rest);
    const before = snapshot(outside);
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('installed');

    expect(snapshot(outside)).toEqual(before);
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.files['assets/tasks.svg']).toBe(recordedSvg);
    expect(lines.some((line) => line.startsWith('herdr-mod: preserved assets/tasks.svg — no longer shipped'))).toBe(
      true,
    );
    expect(backupRoots()).toEqual([]);
  });

  test('a planted staging-name symlink is never followed: staging is a private mkdtemp dir', () => {
    writeRecord();
    deliver();
    mkdirSync(modDir, { recursive: true });
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, OWNER);
    // Every name the pre-fix `.genie-staging-<pid>-<Date.now()>` scheme could
    // pick in the next few seconds.
    const start = Date.now();
    const planted: string[] = [];
    for (let at = start; at < start + 4000; at += 1) {
      const name = join(modDir, `.genie-staging-${process.pid}-${at}`);
      symlinkSync(victim, name);
      planted.push(name);
    }

    expect(converge().status).toBe('installed');

    expect(readFileSync(victim, 'utf8')).toBe(OWNER);
    expect(planted.every((name) => lstatSync(name).isSymbolicLink())).toBe(true);
    for (const [path, content] of Object.entries(MOD_FILES)) {
      expect(readFileSync(join(modDir, path), 'utf8')).toBe(content);
    }
    // The private staging dir is gone afterwards.
    expect(
      readdirSync(modDir).filter((name) => name.startsWith('.genie-staging-') && !name.includes(`-${process.pid}-`)),
    ).toEqual([]);
  });

  test('symlinked configured roots and system aliases are followed, by policy', () => {
    // The operator chose GENIE_HOME and HERDR_APP_HOME; a symlink AT them (and
    // the macOS /var -> /private/var alias every tmpdir here sits under) is
    // resolved, not refused.
    writeRecord();
    deliver();
    const genieLink = join(root, 'genie-home-link');
    const appLink = join(root, 'herdr-app-link');
    symlinkSync(genieHome, genieLink);
    symlinkSync(herdrAppHome, appLink);

    const result = runHerdrModChannelConvergence({
      selection: 'auto',
      version: VERSION,
      genieHome: genieLink,
      herdrAppHome: appLink,
      log: () => undefined,
      now: () => STAMP,
    });

    expect(result.status).toBe('installed');
    expect(snapshot(modDir)).toEqual(MOD_FILES);
    expect(readSkillsInstallRecord(genieHome)?.herdrMod?.dir).toBe(join(appLink, 'mods', 'genie-herdr'));
  });
});

/**
 * Review fix1 HIGH-2: `state-backups/` is an archive. Every run allocates a
 * FRESH root and never writes into an existing one, whatever is at its name.
 */
describe('archives are allocated exclusively (fix1 HIGH-2)', () => {
  const base = 'herdr-mod-collision-2026-11-04T12-34-56-000Z';

  function backupRootPath(name: string): string {
    return join(genieHome, 'state-backups', name);
  }

  test('two runs with the same timestamp keep both earlier archives byte-identical', () => {
    writeRecord();
    deliver();
    converge();
    writeFileSync(join(modDir, 'main.js'), 'owner version one\n');
    converge();
    writeFileSync(join(modDir, 'main.js'), 'owner version two\n');
    converge();

    expect(backupRoots()).toEqual([base, `${base}-1`]);
    expect(snapshot(backupRootPath(base))).toEqual({ 'main.js': 'owner version one\n' });
    expect(snapshot(backupRootPath(`${base}-1`))).toEqual({ 'main.js': 'owner version two\n' });
  });

  test('an archive root name that is already a symlink is skipped, never written through', () => {
    writeRecord();
    deliver();
    converge();
    const outside = join(root, 'outside-archive');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'main.js'), 'outside owner data\n');
    mkdirSync(join(genieHome, 'state-backups'), { recursive: true });
    symlinkSync(outside, backupRootPath(base));
    writeFileSync(join(modDir, 'main.js'), 'owner edit\n');

    expect(converge().status).toBe('installed');

    expect(lstatSync(backupRootPath(base)).isSymbolicLink()).toBe(true);
    expect(snapshot(outside)).toEqual({ 'main.js': 'outside owner data\n' });
    expect(snapshot(backupRootPath(`${base}-1`))).toEqual({ 'main.js': 'owner edit\n' });
  });

  test('an existing root holding a symlinked archive file is never reused', () => {
    writeRecord();
    deliver();
    converge();
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'outside owner data\n');
    mkdirSync(backupRootPath(base), { recursive: true });
    symlinkSync(victim, join(backupRootPath(base), 'main.js'));
    writeFileSync(join(modDir, 'main.js'), 'owner edit\n');

    expect(converge().status).toBe('installed');

    expect(readFileSync(victim, 'utf8')).toBe('outside owner data\n');
    expect(readdirSync(backupRootPath(base))).toEqual(['main.js']);
    expect(lstatSync(join(backupRootPath(base), 'main.js')).isSymbolicLink()).toBe(true);
    expect(snapshot(backupRootPath(`${base}-1`))).toEqual({ 'main.js': 'owner edit\n' });
  });

  test('a backup that cannot be made fails the channel and keeps the original target', () => {
    writeRecord();
    deliver();
    converge();
    const field = rawRecordField();
    writeFileSync(join(genieHome, 'state-backups'), 'not a directory\n');
    writeFileSync(join(modDir, 'main.js'), 'owner edit\n');
    const lines: string[] = [];

    const exitCode = capturingExitCode(() => expect(converge({ lines }).status).toBe('failed'));

    expect(exitCode).toBe(1);
    expect(readFileSync(join(modDir, 'main.js'), 'utf8')).toBe('owner edit\n');
    expect(rawRecordField()).toBe(field);
    expect(lines.at(-1)).toMatch(/^Herdr mod install failed: could not archive: .+\. Run: genie update$/);
  });
});

describe('Herdr-generated files are never retired (fix1 MEDIUM-1)', () => {
  test('a valid record naming gpui-kit.d.ts and jsconfig.json loses the claim and the files stay', () => {
    const generated = { 'gpui-kit.d.ts': 'declare module "gpui-kit";\n', 'jsconfig.json': '{"compilerOptions":{}}\n' };
    deliver();
    mkdirSync(modDir, { recursive: true });
    for (const [path, content] of Object.entries(generated)) writeFileSync(join(modDir, path), content);
    // Recorded digests equal the on-disk bytes: without the exclusion they read
    // as genie's own unmodified stale files and would be retired.
    writeRecord({
      herdrMod: {
        dir: modDir,
        ref: 'v6.261104.2',
        files: Object.fromEntries(Object.entries(generated).map(([path, content]) => [path, digest(content)])),
      },
    });

    expect(converge().status).toBe('installed');

    for (const [path, content] of Object.entries(generated)) {
      expect(readFileSync(join(modDir, path), 'utf8')).toBe(content);
    }
    const files = readSkillsInstallRecord(genieHome)?.herdrMod?.files ?? {};
    expect(Object.keys(files).sort()).toEqual(Object.keys(MOD_FILES).sort());
    expect(backupRoots()).toEqual([]);
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
