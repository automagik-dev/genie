import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SkillsInstallRecord, readSkillsInstallRecord, writeSkillsInstallRecord } from './skills-installer.js';
import { classifyWorkflowFile, runWorkflowsChannelConvergence, shippedWorkflowsRoot } from './workflows-installer.js';

const VERSION = '5.260918.9';

let root: string;
let home: string;
let genieHome: string;
let claudeDir: string;
let workflowsDir: string;

function digest(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

/** A minimal, schema-valid record — the state the skills channel leaves behind. */
function baseRecord(overrides: Partial<SkillsInstallRecord> = {}): SkillsInstallRecord {
  return {
    ref: `v${VERSION}`,
    cliVersion: '1.5.23',
    inventory: ['wish'],
    agentDirs: [join(home, '.claude', 'skills')],
    installedAt: new Date('2026-09-18T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function writeRecord(overrides: Partial<SkillsInstallRecord> = {}): void {
  writeSkillsInstallRecord(genieHome, baseRecord(overrides));
}

function deliver(files: Record<string, string>): void {
  const catalog = shippedWorkflowsRoot(genieHome);
  mkdirSync(catalog, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(catalog, name), content);
}

function converge(options: { selection?: 'auto' | 'none'; lines?: string[] } = {}) {
  return runWorkflowsChannelConvergence({
    selection: options.selection ?? 'auto',
    version: VERSION,
    genieHome,
    home,
    log: (line) => options.lines?.push(line),
    now: () => new Date('2026-09-18T12:34:56.000Z'),
  });
}

function backupRoots(): string[] {
  const backups = join(genieHome, 'state-backups');
  return existsSync(backups) ? readdirSync(backups).sort() : [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-workflows-channel-'));
  home = join(root, 'home');
  genieHome = join(home, '.genie');
  claudeDir = join(home, '.claude');
  workflowsDir = join(claudeDir, 'workflows');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(genieHome, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// ============================================================================
// The classification table — the one decision every caller shares.
// ============================================================================

describe('classifyWorkflowFile', () => {
  const recorded = digest('recorded');
  const delivered = digest('delivered');

  test('nothing on disk is missing, whatever the digests say', () => {
    expect(classifyWorkflowFile({ recorded, delivered, onDisk: null })).toBe('missing');
    expect(classifyWorkflowFile({ delivered, onDisk: null })).toBe('missing');
    expect(classifyWorkflowFile({ recorded, onDisk: null })).toBe('missing');
  });

  test('the delivered bytes win over every other verdict', () => {
    expect(classifyWorkflowFile({ recorded, delivered, onDisk: delivered })).toBe('current');
    expect(classifyWorkflowFile({ delivered, onDisk: delivered })).toBe('current');
    // A release that re-ships exactly what the record names is still `current`:
    // there is nothing to write and nothing to archive.
    expect(classifyWorkflowFile({ recorded, delivered: recorded, onDisk: recorded })).toBe('current');
  });

  test('genie own stale copy is replace; a dropped name matching the record is the same verdict', () => {
    expect(classifyWorkflowFile({ recorded, delivered, onDisk: recorded })).toBe('replace');
    expect(classifyWorkflowFile({ recorded, onDisk: recorded })).toBe('replace');
  });

  test('a recorded file that is neither is modified; an unrecorded one is foreign', () => {
    expect(classifyWorkflowFile({ recorded, delivered, onDisk: digest('edited') })).toBe('modified');
    expect(classifyWorkflowFile({ recorded, onDisk: digest('edited') })).toBe('modified');
    expect(classifyWorkflowFile({ delivered, onDisk: digest('someone else') })).toBe('foreign');
    expect(classifyWorkflowFile({ onDisk: digest('someone else') })).toBe('foreign');
  });
});

// ============================================================================
// The channel.
// ============================================================================

describe('runWorkflowsChannelConvergence — install and no-op', () => {
  test('a fresh HOME with ~/.claude gets every catalog file, recorded by digest', () => {
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n', 'council.js': 'export const council = 2;\n' });
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('installed');
    expect(readFileSync(join(workflowsDir, 'wish.js'), 'utf8')).toBe('export const wish = 1;\n');
    expect(readFileSync(join(workflowsDir, 'council.js'), 'utf8')).toBe('export const council = 2;\n');
    const record = readSkillsInstallRecord(genieHome);
    expect(record?.workflows).toEqual({
      dir: workflowsDir,
      ref: `v${VERSION}`,
      files: {
        'council.js': digest('export const council = 2;\n'),
        'wish.js': digest('export const wish = 1;\n'),
      },
    });
    // The summary is LAST and names what the host now has.
    expect(lines.at(-1)).toBe(
      `workflows: 2 workflow(s) in ${workflowsDir} @ v${VERSION} (2 written, 0 already current)`,
    );
    expect(backupRoots()).toEqual([]);
  });

  test('a second run is a no-op that creates no backup root', () => {
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    converge();
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('installed');
    expect(result.warnings).toEqual([]);
    expect(lines).toEqual([`workflows: 1 workflow(s) in ${workflowsDir} @ v${VERSION} (0 written, 1 already current)`]);
    expect(backupRoots()).toEqual([]);
  });

  test('a stale file matching the record is replaced silently, with no backup root', () => {
    // The 2026-09-15 failure being fixed: a stale user-scope copy shadowing the
    // repository's. It is genie's own byte-identical install, so it is replaced
    // without a line of its own.
    const stale = 'export const wish = 0;\n';
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'wish.js'), stale);
    writeRecord({ workflows: { dir: workflowsDir, ref: 'v5.260918.1', files: { 'wish.js': digest(stale) } } });
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('installed');
    expect(readFileSync(join(workflowsDir, 'wish.js'), 'utf8')).toBe('export const wish = 1;\n');
    expect(result.warnings).toEqual([]);
    expect(backupRoots()).toEqual([]);
    expect(lines).toHaveLength(1);
  });
});

describe('runWorkflowsChannelConvergence — backup-first replacement', () => {
  test('a hand-edited file is archived, replaced, and named in the transcript', () => {
    const edited = 'export const wish = 1; // my own tweak\n';
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'wish.js'), edited);
    writeRecord({
      workflows: { dir: workflowsDir, ref: 'v5.260918.1', files: { 'wish.js': digest('export const wish = 0;\n') } },
    });
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('installed');
    const roots = backupRoots();
    expect(roots).toEqual(['workflows-collision-2026-09-18T12-34-56-000Z']);
    const archived = join(genieHome, 'state-backups', roots[0] as string, 'wish.js');
    expect(readFileSync(archived, 'utf8')).toBe(edited);
    expect(readFileSync(join(workflowsDir, 'wish.js'), 'utf8')).toBe('export const wish = 1;\n');
    expect(lines[0]).toBe(
      `workflows: wish.js was modified locally — previous contents backed up to ${join(genieHome, 'state-backups', roots[0] as string)}`,
    );
    expect(lines[1]).toContain('workflows: collision backup kept at');
    // What the run DID comes before what the host HAS.
    expect(lines.at(-1)).toContain('1 written');
  });

  test('a file genie never recorded is archived too, and called foreign', () => {
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'wish.js'), 'someone else wrote this\n');
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('installed');
    expect(lines[0]).toContain('workflows: wish.js was not installed by genie — previous contents backed up to');
    const archived = join(genieHome, 'state-backups', backupRoots()[0] as string, 'wish.js');
    expect(readFileSync(archived, 'utf8')).toBe('someone else wrote this\n');
  });

  test('an entry that is not a regular file is preserved, never replaced', () => {
    mkdirSync(workflowsDir, { recursive: true });
    symlinkSync(join(root, 'elsewhere.js'), join(workflowsDir, 'wish.js'));
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('installed');
    expect(lines[0]).toBe('workflows: preserved wish.js — not a regular file; left in place');
    expect(existsSync(join(root, 'elsewhere.js'))).toBe(false);
    expect(readSkillsInstallRecord(genieHome)?.workflows?.files).toEqual({});
  });
});

describe('runWorkflowsChannelConvergence — retiring a dropped catalog name', () => {
  test('a dropped name is archived and removed while its digest matches the record', () => {
    const dropped = 'export const gone = 1;\n';
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'gone.js'), dropped);
    writeRecord({
      workflows: { dir: workflowsDir, ref: 'v5.260918.1', files: { 'gone.js': digest(dropped) } },
    });
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('installed');
    expect(existsSync(join(workflowsDir, 'gone.js'))).toBe(false);
    const archived = join(genieHome, 'state-backups', backupRoots()[0] as string, 'gone.js');
    expect(readFileSync(archived, 'utf8')).toBe(dropped);
    expect(lines[0]).toContain('workflows: retired gone.js — no longer shipped; archived to ');
    expect(readSkillsInstallRecord(genieHome)?.workflows?.files).toEqual({
      'wish.js': digest('export const wish = 1;\n'),
    });
    expect(lines.at(-1)).toContain('1 retired');
  });

  test('a dropped name that was edited stays on disk, in the record, and is reported', () => {
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'gone.js'), 'my own version\n');
    const recorded = digest('export const gone = 1;\n');
    writeRecord({ workflows: { dir: workflowsDir, ref: 'v5.260918.1', files: { 'gone.js': recorded } } });
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    expect(converge({ lines }).status).toBe('installed');
    expect(readFileSync(join(workflowsDir, 'gone.js'), 'utf8')).toBe('my own version\n');
    expect(lines[0]).toBe(
      'workflows: preserved gone.js — this release no longer ships it, and it changed since the recorded install; left in place',
    );
    // Kept in the record under its RECORDED digest: the next update retries the
    // retirement, and uninstall still refuses to delete bytes it cannot prove.
    expect(readSkillsInstallRecord(genieHome)?.workflows?.files['gone.js']).toBe(recorded);
    expect(backupRoots()).toEqual([]);
  });

  test('a dropped name that is already gone costs nothing and leaves the record', () => {
    writeRecord({
      workflows: { dir: workflowsDir, ref: 'v5.260918.1', files: { 'gone.js': digest('export const gone = 1;\n') } },
    });
    deliver({ 'wish.js': 'export const wish = 1;\n' });

    expect(converge().status).toBe('installed');
    expect(readSkillsInstallRecord(genieHome)?.workflows?.files).toEqual({
      'wish.js': digest('export const wish = 1;\n'),
    });
    expect(backupRoots()).toEqual([]);
  });
});

describe('runWorkflowsChannelConvergence — the three skip paths', () => {
  test('consent none writes nothing at all', () => {
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    const result = converge({ selection: 'none', lines });

    expect(result).toEqual({ status: 'skipped', warnings: [] });
    expect(lines).toEqual(['workflows: skipped (consent: none)']);
    expect(existsSync(workflowsDir)).toBe(false);
    expect(readSkillsInstallRecord(genieHome)?.workflows).toBeUndefined();
  });

  test('no ~/.claude installs nothing and creates no product home', () => {
    rmSync(claudeDir, { recursive: true, force: true });
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    const result = converge({ lines });

    expect(result.status).toBe('skipped');
    expect(lines).toEqual([`workflows: skipped (no ~/.claude — ${claudeDir} does not exist)`]);
    expect(existsSync(claudeDir)).toBe(false);
  });

  test('no readable install record installs nothing and says why', () => {
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    const lines: string[] = [];

    // (a) no record at all — the consent-`none` skills run, or a fresh host.
    expect(converge({ lines }).status).toBe('skipped');
    // (b) a record that is present but malformed: fail closed, exactly as
    // `genie uninstall` does. A file genie cannot record is a file it can never
    // remove, so nothing is written.
    writeFileSync(join(genieHome, 'skills-install.json'), '{"ref":"v1"}\n');
    expect(converge({ lines }).status).toBe('skipped');

    expect(lines).toEqual([
      'workflows: skipped (no install record — run genie update)',
      'workflows: skipped (no install record — run genie update)',
    ]);
    expect(existsSync(workflowsDir)).toBe(false);
  });

  test('a missing delivered catalog is a retryable failure, never a silent skip', () => {
    writeRecord();
    const lines: string[] = [];
    const saved = process.exitCode;
    try {
      const result = converge({ lines });
      expect(result.status).toBe('failed');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved ?? 0;
    }
    expect(lines.at(-1)).toBe(
      `Workflows install failed: no delivered workflow catalog at ${shippedWorkflowsRoot(genieHome)}. Run: genie update`,
    );
    expect(readSkillsInstallRecord(genieHome)?.workflows).toBeUndefined();
  });

  test('the delivered catalog is only top-level .js files', () => {
    writeRecord();
    deliver({ 'wish.js': 'export const wish = 1;\n' });
    writeFileSync(join(shippedWorkflowsRoot(genieHome), 'README.md'), '# not a workflow\n');
    mkdirSync(join(shippedWorkflowsRoot(genieHome), 'nested'), { recursive: true });

    expect(converge().status).toBe('installed');
    expect(readdirSync(workflowsDir)).toEqual(['wish.js']);
  });
});
