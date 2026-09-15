import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colorEnabled, colorizeFor, stripAnsi } from './term-color.js';

const CLI = join(import.meta.dir, '..', 'genie.ts');
const ESC = '[';
const RED = '[31m';
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

describe('colorEnabled — the one gate for every ANSI escape genie writes', () => {
  test('is decided PER STREAM: a TTY stdout never licenses colour on a piped stderr', () => {
    // The m15 shape: `genie task create 2>err` keeps its pretty stdout while the
    // diagnostic lands in a file that must not carry a red escape.
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.NO_COLOR;
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.FORCE_COLOR;
    process.env.TERM = 'xterm-256color';
    setTty('stdout', true);
    setTty('stderr', false);

    expect(colorEnabled('stdout')).toBe(true);
    expect(colorEnabled('stderr')).toBe(false);
    expect(colorizeFor('stderr', RED, 'Error: nope')).toBe('Error: nope');
    expect(colorizeFor('stdout', RED, 'ok')).toBe(`${RED}ok${RESET}`);
  });

  test('NO_COLOR wins over a TTY on both streams', () => {
    process.env.NO_COLOR = '1';
    process.env.TERM = 'xterm-256color';
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.FORCE_COLOR;
    setTty('stdout', true);
    setTty('stderr', true);

    expect(colorEnabled('stdout')).toBe(false);
    expect(colorEnabled('stderr')).toBe(false);
  });

  test('NO_COLOR wins over FORCE_COLOR — the standard says any value disables colour', () => {
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '1';
    setTty('stderr', true);

    expect(colorEnabled('stderr')).toBe(false);
  });

  test('an empty NO_COLOR is not a setting', () => {
    process.env.NO_COLOR = '';
    process.env.TERM = 'xterm-256color';
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.FORCE_COLOR;
    setTty('stderr', true);

    expect(colorEnabled('stderr')).toBe(true);
  });

  test('TERM=dumb disables colour on a real TTY', () => {
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.NO_COLOR;
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.FORCE_COLOR;
    process.env.TERM = 'dumb';
    setTty('stdout', true);
    setTty('stderr', true);

    expect(colorEnabled('stdout')).toBe(false);
    expect(colorEnabled('stderr')).toBe(false);
  });

  test('FORCE_COLOR turns colour on for a non-TTY, but FORCE_COLOR=0 does not', () => {
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    setTty('stderr', false);

    process.env.FORCE_COLOR = '1';
    expect(colorEnabled('stderr')).toBe(true);
    process.env.FORCE_COLOR = '0';
    expect(colorEnabled('stderr')).toBe(false);
  });

  test('the gate is read per call, never cached at module load', () => {
    // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    setTty('stderr', true);
    expect(colorEnabled('stderr')).toBe(true);

    process.env.NO_COLOR = '1';
    expect(colorEnabled('stderr')).toBe(false);
  });
});

describe('stripAnsi', () => {
  test('removes SGR sequences and leaves the text', () => {
    expect(stripAnsi(`[1m[33mwarn${RESET}: x`)).toBe('warn: x');
  });
});

describe('CLI diagnostics on a non-TTY stderr (m15)', () => {
  function runCli(env: Record<string, string>): { code: number; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), 'genie-term-color-'));
    roots.push(root);
    Bun.spawnSync(['git', 'init', '-q', '.'], { cwd: root });
    // A bare `genie task create` is missing its required `--title`, so Commander
    // routes through genie's `outputError` — the exact line that used to carry an
    // unconditional red escape into every log file and CI transcript.
    const res = Bun.spawnSync([process.execPath, CLI, 'task', 'create'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: root, ...env },
    });
    return { code: res.exitCode, stderr: res.stderr.toString() };
  }

  test('a piped stderr gets plain text, whatever TERM says', () => {
    const res = runCli({ TERM: 'xterm-256color' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("required option '--title <title>' not specified");
    expect(res.stderr).not.toContain(ESC);
  });

  test('NO_COLOR is honoured', () => {
    expect(runCli({ NO_COLOR: '1', TERM: 'xterm-256color' }).stderr).not.toContain(ESC);
  });

  test('TERM=dumb is honoured', () => {
    expect(runCli({ TERM: 'dumb' }).stderr).not.toContain(ESC);
  });

  test('FORCE_COLOR still opts a non-TTY in — the gate is a policy, not a blanket strip', () => {
    const res = runCli({ FORCE_COLOR: '1', TERM: 'xterm-256color' });
    expect(res.stderr).toContain(RED);
    expect(stripAnsi(res.stderr)).toContain("required option '--title <title>' not specified");
  });
});
