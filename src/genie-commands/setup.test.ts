import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLifecycleLease, lifecycleLockPath } from '../lib/lifecycle-lease.js';
import { SETUP_NON_INTERACTIVE_MESSAGE, setupCommand } from './setup.js';

/**
 * `setup --codex` and the whole Codex activation path left with the Codex
 * plugin subsystem. What remains under test here is the surviving surface:
 * the explicit orchestration-mode switch, the read-only `--show`, and the
 * lifecycle-lease contract every setup mutation still runs under.
 */
describe('genie setup', () => {
  let root: string;
  let priorGenieHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-setup-'));
    priorGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = join(root, 'genie-home');
    mkdirSync(join(root, 'repo'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(root, 'repo') });
    process.exitCode = 0;
  });

  afterEach(() => {
    if (priorGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
    else process.env.GENIE_HOME = priorGenieHome;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  function capture(): { restore: () => { out: string; err: string; exitCode: number } } {
    const out: string[] = [];
    const err: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
    return {
      restore: () => {
        console.log = originalLog;
        console.error = originalError;
        return {
          out: out.join('\n'),
          err: err.join('\n'),
          exitCode: typeof process.exitCode === 'number' ? process.exitCode : 0,
        };
      },
    };
  }

  test('the CLI surface no longer offers --codex', () => {
    const help = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'genie.ts'), 'setup', '--help'], {
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = `${help.stdout.toString()}${help.stderr.toString()}`;
    expect(help.exitCode).toBe(0);
    expect(text).not.toContain('--codex');
    expect(text).toContain('--orchestration-mode');
  });

  test('an unknown orchestration mode is refused without touching config', async () => {
    const cap = capture();
    await setupCommand({ orchestrationMode: 'bogus' as never });
    const { err, exitCode } = cap.restore();
    expect(exitCode).toBe(1);
    expect(err).toContain('orchestration mode must be either "standalone" or "orca"');
  });

  test('selecting standalone reports the resolved mode and returns before the wizard', async () => {
    const cap = capture();
    await setupCommand({ orchestrationMode: 'standalone' });
    const { out, exitCode } = cap.restore();
    expect(exitCode).toBe(0);
    expect(out).toContain('Orchestration mode');
    expect(out).toContain('standalone');
    // The mode switch is not the wizard: no section banners were printed.
    expect(out).not.toContain('Debug Options');
  });

  test('--show is read-only and prints the resolved configuration', async () => {
    const cap = capture();
    await setupCommand({ show: true });
    const { out, exitCode } = cap.restore();
    expect(exitCode).toBe(0);
    expect(out).toContain('Current Genie Configuration');
  });

  test('setup performs zero writes while another process owns the GENIE_HOME lease', () => {
    const genieHome = process.env.GENIE_HOME as string;
    const lease = acquireLifecycleLease(genieHome);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) throw new Error(lease.skipped);
    const lockPath = lifecycleLockPath(genieHome);
    const ownerRecord = readFileSync(lockPath, 'utf8');
    const runnerPath = join(root, 'setup-contender.ts');
    writeFileSync(
      runnerPath,
      [
        `import { setupCommand } from ${JSON.stringify(join(import.meta.dir, 'setup.ts'))};`,
        'await setupCommand({ reset: true });',
      ].join('\n'),
    );
    try {
      const child = Bun.spawnSync(['bun', runnerPath], {
        env: { ...process.env, GENIE_HOME: genieHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain('holds the lock');
      expect(existsSync(genieHome)).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(ownerRecord);
    } finally {
      lease.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  test('setup.ts carries no Codex activation surface', () => {
    const source = readFileSync(join(import.meta.dir, 'setup.ts'), 'utf8');
    for (const forbidden of [
      'requestRetirementAssertion',
      'executeCodexActivation',
      'authorizeCodexActivation',
      'codex-activation',
      'codex-lifecycle-lease',
      '--codex',
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });
});

/**
 * Dogfood B1, same defect family as `genie uninstall`: every prompting section
 * of the wizard used to render an @inquirer question against a closed stdin and
 * then hang forever. `--quick` and `--show` answer from defaults and must stay
 * scriptable; everything else refuses on one line with exit 2.
 */
describe('genie setup — non-interactive contract', () => {
  const CLI_PATH = join(import.meta.dir, '..', 'genie.ts');
  const spawnRoots: string[] = [];

  afterEach(() => {
    for (const dir of spawnRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function runSetup(args: string[]): { code: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'genie-setup-noninteractive-'));
    spawnRoots.push(dir);
    const res = Bun.spawnSync([process.execPath, CLI_PATH, '--no-interactive', 'setup', ...args], {
      cwd: dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
      env: { ...process.env, HOME: dir, GENIE_HOME: join(dir, '.genie'), NO_COLOR: '1' },
    });
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  }

  for (const section of [[], ['--shortcuts'], ['--terminal'], ['--session']]) {
    test(`\`setup ${section.join(' ') || '(wizard)'}\` exits 2 instead of hanging on a prompt`, () => {
      const res = runSetup(section);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain(SETUP_NON_INTERACTIVE_MESSAGE);
      // No question was drawn, so no half-rendered prompt is left on the terminal.
      expect(res.stdout).not.toContain('(y/N)');
    });
  }

  test('--quick stays the scripted route: it answers from defaults and exits 0', () => {
    const res = runSetup(['--quick']);
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain(SETUP_NON_INTERACTIVE_MESSAGE);
  });

  test('--show is read-only and never gated', () => {
    expect(runSetup(['--show']).code).toBe(0);
  });
});
