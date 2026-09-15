/**
 * m15 — colour is a property of the DESTINATION STREAM.
 *
 * Round 1 gated the two call sites the dogfood repro walked through (commander's
 * `outputError` and `term-format.color()`). The verifier then found ~110 raw
 * `\x1b[` literals across eight command modules still writing colour with no
 * gate at all: `genie doctor`, `genie shortcuts status` and `genie setup --show`
 * all painted a piped stdout under `NO_COLOR=1 TERM=dumb`.
 *
 * These tests pin the contract CLI-wide, at three levels:
 *   1. the sink itself (unit),
 *   2. a structural rule that keeps the gap from reopening — a module that
 *      composes escapes may not write them itself,
 *   3. the real CLI, both streams piped, for the commands that regressed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { stripAnsi } from './term-color.js';
import { isBrokenPipeError, printErr, printOut, renderFor, runUnderBrokenPipeGuard } from './term-output.js';
import { openDb } from './v5/genie-db.js';
import { appendTaskEvent, createTask, getTask } from './v5/task-state.js';

const SRC = join(import.meta.dir, '..');
const CLI = join(SRC, 'genie.ts');
const ESC = '';
const GREEN = '[32m';
const RESET = '[0m';

const envKeys = ['NO_COLOR', 'TERM', 'FORCE_COLOR'] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
const savedTty = { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY };
const roots: string[] = [];

function setTty(stream: 'stdout' | 'stderr', value: boolean | undefined): void {
  Object.defineProperty(process[stream], 'isTTY', { value, configurable: true, writable: true });
}

afterEach(() => {
  for (const key of envKeys) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  setTty('stdout', savedTty.stdout);
  setTty('stderr', savedTty.stderr);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the write sink strips what the stream cannot carry', () => {
  test('renderFor keeps escapes for a colour-bearing stream and strips them otherwise', () => {
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.NO_COLOR;
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.FORCE_COLOR;
    process.env.TERM = 'xterm-256color';
    setTty('stdout', true);
    setTty('stderr', false);

    const line = `  ${GREEN}✔${RESET} genie version — 5.260915.6`;
    expect(renderFor('stdout', line)).toBe(line);
    expect(renderFor('stderr', line)).toBe('  ✔ genie version — 5.260915.6');
  });

  test('NO_COLOR and TERM=dumb strip a TTY stream too', () => {
    setTty('stdout', true);
    setTty('stderr', true);
    const line = `${GREEN}ok${RESET}`;

    process.env.NO_COLOR = '1';
    expect(renderFor('stdout', line)).toBe('ok');

    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.NO_COLOR;
    process.env.TERM = 'dumb';
    expect(renderFor('stderr', line)).toBe('ok');
  });

  test('printOut / printErr add exactly one newline and route to their own stream', () => {
    process.env.NO_COLOR = '1';
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      printOut(`${GREEN}hello${RESET}`);
      printOut();
      printErr(`${GREEN}boom${RESET}`);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }

    expect(out).toEqual(['hello\n', '\n']);
    expect(err).toEqual(['boom\n']);
  });
});

describe('structural rule: a module that composes escapes never writes them itself', () => {
  // The round-1 gap was not a missing decision, it was ~110 write sites that
  // never asked. Ownership is what keeps it closed: compose colour anywhere,
  // but hand the line to term-output.ts, which knows the destination stream.
  const ALLOWED = new Set(['lib/term-output.ts']);

  function sourceFiles(): string[] {
    return readdirSync(SRC, { recursive: true, encoding: 'utf-8' })
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__'))
      .map((p) => p.replaceAll('\\', '/'));
  }

  test('no ungated ANSI write survives anywhere under src/', () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(join(SRC, rel), 'utf-8');
      if (!text.includes('\\x1b[')) continue;
      const writes = text.match(/console\.(log|error|warn|info)\(|process\.(stdout|stderr)\.write\(/g);
      if (writes) offenders.push(`${rel}: ${writes.length} direct write(s)`);
    }
    expect(offenders).toEqual([]);
  });

  test('the rule is anchored on real files — src/ does carry escape-composing modules', () => {
    const composing = sourceFiles().filter((rel) => readFileSync(join(SRC, rel), 'utf-8').includes('\\x1b['));
    expect(composing.length).toBeGreaterThan(5);
    expect(relative(SRC, CLI).replaceAll('\\', '/')).toBe('genie.ts');
  });
});

describe('the real CLI never paints a piped stream (m15)', () => {
  function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), 'genie-term-output-'));
    roots.push(root);
    Bun.spawnSync(['git', 'init', '-q', '.'], { cwd: root });
    const res = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: root, GENIE_HOME: join(root, '.genie'), ...env },
    });
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  }

  // Every one of these painted a piped stdout before the sink landed:
  // doctor 21 lines, `shortcuts status` 4, `setup --show` 2.
  const commands: Array<[string, string[]]> = [
    ['doctor', ['doctor']],
    ['shortcuts status', ['shortcuts', 'status']],
    ['setup --show', ['setup', '--show']],
  ];

  for (const [label, args] of commands) {
    test(`${label}: NO_COLOR=1 TERM=dumb leaves both streams plain`, () => {
      const res = runCli(args, { NO_COLOR: '1', TERM: 'dumb' });
      expect(res.stdout).not.toContain(ESC);
      expect(res.stderr).not.toContain(ESC);
      expect(res.stdout.length).toBeGreaterThan(0);
    });

    test(`${label}: a piped stream stays plain even with a colour-capable TERM`, () => {
      const res = runCli(args, { TERM: 'xterm-256color' });
      expect(res.stdout).not.toContain(ESC);
      expect(res.stderr).not.toContain(ESC);
    });
  }

  test('FORCE_COLOR still opts a piped stdout in — the sink is a policy, not a blanket strip', () => {
    const res = runCli(['doctor'], { FORCE_COLOR: '1', TERM: 'xterm-256color' });
    expect(res.stdout).toContain(ESC);
    expect(stripAnsi(res.stdout)).not.toContain(ESC);
  });
});

/**
 * Dogfood r2 §3.2 C — a reader that closes early (`| head -1`) made every
 * `genie task` verb die with an uncaught Bun `EPIPE` stack trace and exit 1.
 * For `task checkout` the claim was already committed, so a card genuinely in
 * progress reported a failed claim to the caller.
 */
describe('broken-pipe guard (dogfood r2 §3.2 C)', () => {
  test('isBrokenPipeError recognises the shapes Bun and Node raise, and nothing else', () => {
    expect(isBrokenPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isBrokenPipeError({ syscall: 'write', errno: -32 })).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false);
    expect(isBrokenPipeError(new Error('Task not found: t_ghost'))).toBe(false);
    expect(isBrokenPipeError(undefined)).toBe(false);
  });

  test('runUnderBrokenPipeGuard re-throws everything that is not a broken pipe', async () => {
    const boom = new Error('real failure');
    await expect(runUnderBrokenPipeGuard(() => Promise.reject(boom))).rejects.toThrow('real failure');
  });

  /** A repo whose one card has a timeline far longer than one `head` window. */
  function seedLongTimeline(): { repo: string; taskId: string } {
    const repo = mkdtempSync(join(tmpdir(), 'genie-epipe-'));
    roots.push(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    git('init', '-b', 'main', repo);
    git('-C', repo, 'commit', '--allow-empty', '-m', 'init');

    const db = openDb({ cwd: repo });
    const task = createTask(db, { title: 'pipe probe' });
    for (let i = 0; i < 400; i += 1) {
      appendTaskEvent(db, task.id, { kind: 'comment', note: `note ${i}`, author: 'test', authorKind: 'cli' });
    }
    db.close();
    return { repo, taskId: task.id };
  }

  /** Run the real CLI with its stdout piped into a reader that quits after one line. */
  function pipeIntoHead(repo: string, args: string[]): { code: number; stderr: string; stdout: string } {
    const command = [
      'set -o pipefail',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args.map((a) => JSON.stringify(a)).join(' ')} | head -1`,
    ].join('; ');
    const res = Bun.spawnSync(['bash', '-c', command], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
    });
    return { code: res.exitCode, stderr: res.stderr.toString(), stdout: res.stdout.toString() };
  }

  test('task status into a reader that closes after one line exits 0 with no stack trace', () => {
    const { repo, taskId } = seedLongTimeline();
    const res = pipeIntoHead(repo, ['task', 'status', taskId]);
    expect(res.stderr).toBe('');
    expect(res.stderr).not.toContain('EPIPE');
    expect(res.code).toBe(0);
  }, 90_000);

  test('a committed checkout is never reported as a failure because the reader left', () => {
    const { repo, taskId } = seedLongTimeline();
    const res = pipeIntoHead(repo, ['task', 'checkout', taskId, '--worker', 'w9']);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);

    // The claim really did commit — the exit code was telling the truth.
    const db = openDb({ cwd: repo });
    const claimed = getTask(db, taskId)?.claimedBy;
    db.close();
    expect(claimed).toBe('w9');
  }, 90_000);
});
