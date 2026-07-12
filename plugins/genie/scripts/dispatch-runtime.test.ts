import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const LAUNCHER_PATH = join(import.meta.dir, 'dispatch-runtime.cjs');
interface LaunchDeps {
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
  spawn?: (...args: unknown[]) => never;
  resolveCommand?: () =>
    | { command: string; shell: false; error?: never }
    | { error: string; command?: never; shell?: never };
}

interface ResolverFs {
  lstat: (path: string) => Pick<ReturnType<typeof lstatSync>, 'isFile' | 'isSymbolicLink' | 'mode'>;
  realpath: (path: string) => string;
  access: (path: string, mode: number) => void;
}

const launcher = require('./dispatch-runtime.cjs') as {
  CODEX_LAUNCHER_CONTRACT: string;
  childTimeoutMs: (event: string, runtime: 'codex' | 'claude', env?: NodeJS.ProcessEnv) => number;
  launch: (
    runtime: string,
    raw: string,
    deps?: LaunchDeps,
  ) => Promise<number>;
  launcherSha256: (path?: string) => { digest: string } | { error: string };
  launcherBindingError: (digest: string, contract: string, path?: string) => string | null;
  resolveGenieCommand: (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    fs?: ResolverFs,
  ) => { command: string; shell: false; error?: never } | { error: string; command?: never; shell?: never };
  validCodexOutput: (raw: string, event: string) => boolean;
  readBoundedStdin: (
    stream: NodeJS.ReadableStream,
    maxBytes?: number,
  ) => Promise<{ raw: string; overflow: boolean }>;
};

function codexMainArgs(event: 'PreToolUse' | 'PermissionRequest'): string[] {
  const hashed = launcher.launcherSha256();
  if ('error' in hashed) throw new Error(hashed.error);
  return [
    'codex',
    event,
    '--launcher-contract',
    launcher.CODEX_LAUNCHER_CONTRACT,
    '--launcher-sha256',
    hashed.digest,
  ];
}

let root: string;
let previous: Record<string, string | undefined>;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-hook-launcher-'));
  previous = {
    home: process.env.GENIE_HOME,
    timeout: process.env.GENIE_HOOK_CHILD_TIMEOUT_MS,
    runtime: process.env.GENIE_HOOK_RUNTIME,
    killGrace: process.env.GENIE_HOOK_KILL_GRACE_MS,
    fakeLog: process.env.FAKE_LOG,
    fakeReady: process.env.FAKE_READY,
    fakeSignal: process.env.FAKE_SIGNAL,
    omniEnabled: process.env.OMNI_APPROVALS_ENABLED,
  };
});

afterEach(() => {
  restoreEnv('GENIE_HOME', previous.home);
  restoreEnv('GENIE_HOOK_CHILD_TIMEOUT_MS', previous.timeout);
  restoreEnv('GENIE_HOOK_RUNTIME', previous.runtime);
  restoreEnv('GENIE_HOOK_KILL_GRACE_MS', previous.killGrace);
  restoreEnv('FAKE_LOG', previous.fakeLog);
  restoreEnv('FAKE_READY', previous.fakeReady);
  restoreEnv('FAKE_SIGNAL', previous.fakeSignal);
  restoreEnv('OMNI_APPROVALS_ENABLED', previous.omniEnabled);
  rmSync(root, { recursive: true, force: true });
});

function fakeGenie(body: string): string {
  const home = join(root, 'genie-home');
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, 'genie');
  writeFileSync(
    path,
    ['#!/usr/bin/env node', "'use strict';", "const fs = require('node:fs');", body, ''].join('\n'),
    'utf8',
  );
  chmodSync(path, 0o755);
  process.env.GENIE_HOME = realpathSync(home);
  return path;
}

function payload(event: 'PreToolUse' | 'PermissionRequest' = 'PreToolUse'): string {
  return JSON.stringify({
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
  });
}

async function run(
  runtime: 'codex' | 'claude',
  raw = payload(),
  deps: LaunchDeps = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await launcher.launch(runtime, raw, {
    ...deps,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

describe('dispatch-runtime launcher', () => {
  test('passes stdin and runtime through the old-binary-compatible command shape', async () => {
    const log = join(root, 'invocation.json');
    process.env.FAKE_LOG = log;
    fakeGenie(
      [
        "const input = fs.readFileSync(0, 'utf8');",
        "fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), runtime: process.env.GENIE_HOOK_RUNTIME, omni: process.env.OMNI_APPROVALS_ENABLED, input }));",
      ].join('\n'),
    );
    const raw = payload();
    const result = await run('codex', raw);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    const call = JSON.parse(await Bun.file(log).text());
    expect(call.argv).toEqual(['hook', 'dispatch']);
    expect(call.runtime).toBe('codex');
    expect(call.omni).toBe('0');
    expect(call.input).toBe(raw);
  });

  test('disables previous-binary Omni only for H4 and preserves H6 approval consent', async () => {
    const log = join(root, 'compatibility.jsonl');
    process.env.FAKE_LOG = log;
    process.env.OMNI_APPROVALS_ENABLED = '1';
    fakeGenie(
      [
        "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
        "fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ event: input.hook_event_name, omni: process.env.OMNI_APPROVALS_ENABLED, leaked: process.env.OMNI_APPROVALS_ENABLED === '1' ? input.tool_input.command : undefined }) + '\\n');",
        "const permission = input.hook_event_name === 'PermissionRequest';",
        "process.stdout.write(permission ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'fixture' } } }) : '');",
      ].join('\n'),
    );

    expect((await run('codex', payload('PreToolUse'))).stdout).toBe('');
    expect(JSON.parse((await run('codex', payload('PermissionRequest'))).stdout).hookSpecificOutput.decision.behavior).toBe(
      'deny',
    );
    const calls = (await Bun.file(log).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      { event: 'PreToolUse', omni: '0' },
      { event: 'PermissionRequest', omni: '1', leaked: 'echo hi' },
    ]);
  });

  test('retains at most the bounded stdin prefix before rejecting an oversized pipe', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const chunks = Array.from({ length: 64 }, () => chunk);
    const result = await launcher.readBoundedStdin(Readable.from(chunks), 128 * 1024);
    expect(result.overflow).toBe(true);
    expect(Buffer.byteLength(result.raw)).toBe(128 * 1024 + 1);
  });

  test('executable main path returns an event-valid H6 denial for oversized PermissionRequest stdin', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi', padding: 'x'.repeat(1024 * 1024) },
    });
    const proc = Bun.spawn(['node', LAUNCHER_PATH, ...codexMainArgs('PermissionRequest')], {
      stdin: Buffer.from(raw),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(launcher.validCodexOutput(stdout, 'PermissionRequest')).toBe(true);
    expect(JSON.parse(stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'genie hook launcher: input exceeded the safety limit',
    });
  });

  for (const event of ['PreToolUse', 'PermissionRequest'] as const) {
    test(`executable main gives ${event} recovery for a stale hook definition with missing binding flags`, async () => {
      const unexpected = join(root, `unexpected-stale-hook-spawn-${event}`);
      process.env.FAKE_LOG = unexpected;
      fakeGenie("fs.writeFileSync(process.env.FAKE_LOG, 'spawned');");

      const proc = Bun.spawn(['node', LAUNCHER_PATH, 'codex', event], {
        env: process.env,
        stdin: Buffer.from(payload(event)),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(launcher.validCodexOutput(stdout, event)).toBe(true);
      const output = JSON.parse(stdout).hookSpecificOutput;
      const reason = (event === 'PreToolUse' ? output.permissionDecisionReason : output.decision.message) as string;
      if (event === 'PreToolUse') expect(output.permissionDecision).toBe('deny');
      else expect(output.decision.behavior).toBe('deny');
      expect(reason).toContain('stale Codex hook definition after a Genie plugin refresh');
      expect(reason).toContain('Close all Codex tasks first');
      expect(reason).toContain('external terminal');
      expect(reason).toContain('`genie doctor`');
      expect(reason).toContain('if repair is needed, run `genie setup --codex`');
      expect(reason).toContain('review `/hooks`, then start a new Codex task');
      expect(reason.indexOf('Close all Codex tasks first')).toBeLessThan(reason.indexOf('external terminal'));
      expect(existsSync(unexpected)).toBe(false);
    });
  }

  test('executable main denies before spawn when its bytes drift from the reviewed definition', async () => {
    const mutated = join(root, 'dispatch-runtime-mutated.cjs');
    writeFileSync(mutated, `${readFileSync(LAUNCHER_PATH, 'utf8')}\n// unreviewed mutation\n`);
    const unexpected = join(root, 'unexpected-spawn');
    process.env.FAKE_LOG = unexpected;
    fakeGenie("fs.writeFileSync(process.env.FAKE_LOG, 'spawned');");

    const proc = Bun.spawn(['node', mutated, ...codexMainArgs('PreToolUse')], {
      stdin: Buffer.from(payload()),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      'launcher bytes do not match the reviewed hook definition',
    );
    expect(existsSync(unexpected)).toBe(false);
  });

  test('launcher contract version is checked independently of the content digest', () => {
    const hashed = launcher.launcherSha256();
    if ('error' in hashed) throw new Error(hashed.error);
    expect(launcher.launcherBindingError(hashed.digest, launcher.CODEX_LAUNCHER_CONTRACT)).toBeNull();
    expect(launcher.launcherBindingError(hashed.digest, 'unreviewed-contract')).toContain(
      'contract version is missing or does not match',
    );
  });

  test('rejects malformed and structurally invalid Codex input before spawning', async () => {
    const log = join(root, 'unexpected-spawn');
    process.env.FAKE_LOG = log;
    fakeGenie("fs.writeFileSync(process.env.FAKE_LOG, 'spawned');");

    const malformed = await run('codex', '{not json');
    expect(JSON.parse(malformed.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'genie hook launcher: payload is not valid JSON' },
    });
    const invalidPermission = await run(
      'codex',
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_input: { command: 'echo hi' } }),
    );
    expect(JSON.parse(invalidPermission.stdout).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(existsSync(log)).toBe(false);
  });

  test('rejects whitespace, control-character, and overlong Codex tool names before spawning', async () => {
    let spawned = false;
    const invalid = ['   ', 'Bad\nTool', 'x'.repeat(129)];
    for (const tool_name of invalid) {
      const result = await run(
        'codex',
        JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name, tool_input: {} }),
        {
          resolveCommand: () => ({ command: '/never', shell: false }),
          spawn: () => {
            spawned = true;
            throw new Error('unreachable');
          },
        },
      );
      expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe('deny');
    }
    expect(spawned).toBe(false);
  });

  test('preserves a valid Codex decision', async () => {
    fakeGenie(
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }));",
    );
    const result = await run('codex');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toBe('blocked');
  });

  test('malformed or wrong-event output becomes an event-specific deny', async () => {
    fakeGenie("process.stdout.write('{not json');");
    const malformed = await run('codex');
    expect(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision).toBe('deny');

    fakeGenie(
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));",
    );
    const wrongWire = await run('codex', payload('PermissionRequest'));
    expect(JSON.parse(wrongWire.stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'Genie hook dispatcher returned an invalid Codex response',
    });
  });

  test('non-zero exit and timeout fail closed for Codex', async () => {
    fakeGenie('process.exit(7);');
    const failed = await run('codex');
    expect(failed.code).toBe(0);
    expect(JSON.parse(failed.stdout).hookSpecificOutput.permissionDecisionReason).toContain('exit 7');

    process.env.GENIE_HOOK_CHILD_TIMEOUT_MS = '100';
    process.env.GENIE_HOOK_KILL_GRACE_MS = '20';
    fakeGenie("process.on('SIGTERM', () => {}); setInterval(() => {}, 10_000);");
    const timedOut = await run('codex', payload('PermissionRequest'));
    expect(timedOut.code).toBe(0);
    expect(JSON.parse(timedOut.stdout).hookSpecificOutput.decision.message).toContain('timed out');
  });

  test('Claude normalizes a child failure to the host-blocking exit status', async () => {
    fakeGenie('process.exit(7);');
    expect((await run('claude')).code).toBe(2);
  });

  test('Claude fails closed when a timed-out fake child exits zero after termination', async () => {
    process.env.GENIE_HOOK_CHILD_TIMEOUT_MS = '100';
    process.env.GENIE_HOOK_KILL_GRACE_MS = '20';
    fakeGenie("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 10_000);");

    const result = await run('claude');

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Genie hook dispatcher timed out');
  });

  test('Claude fails closed when a close-zero fake child exceeds stdout or stderr bounds', async () => {
    fakeGenie("process.stdout.write('x'.repeat(1024 * 1024));");
    const stdoutOverflow = await run('claude');
    expect(stdoutOverflow.code).toBe(2);
    expect(stdoutOverflow.stdout).toBe('');
    expect(stdoutOverflow.stderr).toContain('output exceeded the safety limit');

    fakeGenie("process.stderr.write('x'.repeat(1024 * 1024));");
    const stderrOverflow = await run('claude');
    expect(stderrOverflow.code).toBe(2);
    expect(stderrOverflow.stdout).toBe('');
    expect(Buffer.byteLength(stderrOverflow.stderr)).toBeLessThan(70 * 1024);
    expect(stderrOverflow.stderr).toContain('[genie hook launcher: stderr truncated]');
    expect(stderrOverflow.stderr).toContain('stderr exceeded the safety limit');
  });

  test('Claude fails closed when the dispatcher cannot spawn', async () => {
    const asyncFailure = await run('claude', payload(), {
      resolveCommand: () => ({ command: join(root, 'missing-genie'), shell: false }),
    });
    expect(asyncFailure.code).toBe(2);
    expect(asyncFailure.stdout).toBe('');
    expect(asyncFailure.stderr).toContain('could not start Genie hook dispatcher');

    const synchronousFailure = await run('claude', payload(), {
      resolveCommand: () => ({ command: '/fixture/genie', shell: false }),
      spawn: () => {
        throw new Error('fixture spawn failed');
      },
    });
    expect(synchronousFailure.code).toBe(2);
    expect(synchronousFailure.stdout).toBe('');
    expect(synchronousFailure.stderr).toContain('fixture spawn failed');
  });

  test('Claude input and resolver guardrails also use the host-blocking exit status', async () => {
    const oversized = await run('claude', 'x'.repeat(1024 * 1024 + 1));
    expect(oversized.code).toBe(2);
    expect(oversized.stderr).toContain('input exceeded the safety limit');

    const unresolved = await run('claude', payload(), {
      resolveCommand: () => ({ error: 'canonical dispatcher absent' }),
    });
    expect(unresolved.code).toBe(2);
    expect(unresolved.stdout).toBe('');
    expect(unresolved.stderr).toContain('canonical dispatcher absent');
  });

  test('spawn failures fail closed without an unhandled stdin error', async () => {
    const result = await run('codex', payload('PermissionRequest'), {
      resolveCommand: () => ({ command: join(root, 'missing-genie'), shell: false }),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: expect.stringContaining('could not start Genie hook dispatcher'),
    });
  });

  test('forwards termination signals to the dispatcher child', async () => {
    if (process.platform === 'win32') return;
    const ready = join(root, 'ready');
    const signalLog = join(root, 'signal');
    process.env.FAKE_READY = ready;
    process.env.FAKE_SIGNAL = signalLog;
    fakeGenie(
      [
        "process.on('SIGTERM', () => { fs.writeFileSync(process.env.FAKE_SIGNAL, 'SIGTERM'); process.exit(0); });",
        "fs.writeFileSync(process.env.FAKE_READY, 'ready');",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );
    const proc = Bun.spawn(['node', LAUNCHER_PATH, ...codexMainArgs('PreToolUse')], {
      env: { ...process.env, GENIE_HOME: realpathSync(join(root, 'genie-home')) },
      stdin: Buffer.from(payload()),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    proc.kill('SIGTERM');
    expect(await proc.exited).not.toBe(0);
    expect(await Bun.file(signalLog).text()).toBe('SIGTERM');
  });

  test('external termination starts the kill grace even when the child ignores the signal', async () => {
    if (process.platform === 'win32') return;
    const ready = join(root, 'ignored-ready');
    process.env.FAKE_READY = ready;
    process.env.GENIE_HOOK_KILL_GRACE_MS = '40';
    fakeGenie(
      [
        "fs.writeFileSync(process.env.FAKE_READY, 'ready');",
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );
    const proc = Bun.spawn(['node', LAUNCHER_PATH, ...codexMainArgs('PreToolUse')], {
      env: { ...process.env, GENIE_HOME: realpathSync(join(root, 'genie-home')) },
      stdin: Buffer.from(payload()),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await Bun.sleep(10);
    const started = performance.now();
    proc.kill('SIGTERM');
    expect(await proc.exited).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('timeout TERM→KILL reaches dispatcher descendants in the detached process group', async () => {
    if (process.platform === 'win32') return;
    const grandchildPidFile = join(root, 'grandchild-pid');
    process.env.FAKE_LOG = grandchildPidFile;
    process.env.GENIE_HOOK_CHILD_TIMEOUT_MS = '500';
    process.env.GENIE_HOOK_KILL_GRACE_MS = '30';
    fakeGenie(
      [
        "const { spawn } = require('node:child_process');",
        "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 10000)\"], { stdio: 'ignore' });",
        "fs.writeFileSync(process.env.FAKE_LOG, String(grandchild.pid));",
        "process.on('SIGTERM', () => process.exit(0));",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );

    const result = await run('codex', payload('PermissionRequest'));
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision.message).toContain('timed out');
    const pid = Number(await Bun.file(grandchildPidFile).text());
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await Bun.sleep(10);
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    expect(alive).toBe(false);
  });

  test('normal dispatcher exit still reaps a daemonized descendant before returning', async () => {
    if (process.platform === 'win32') return;
    const grandchildPidFile = join(root, 'daemonized-grandchild-pid');
    process.env.FAKE_LOG = grandchildPidFile;
    process.env.GENIE_HOOK_KILL_GRACE_MS = '30';
    fakeGenie(
      [
        "const { spawn } = require('node:child_process');",
        "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 10000)\"], { stdio: 'ignore' });",
        "fs.writeFileSync(process.env.FAKE_LOG, String(grandchild.pid));",
        'process.exit(0);',
      ].join('\n'),
    );

    const result = await run('codex');
    expect(result.code).toBe(0);
    const pid = Number(await Bun.file(grandchildPidFile).text());
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await Bun.sleep(10);
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    expect(alive).toBe(false);
  });

  test('captures and forwards at most a bounded stderr diagnostic with a truncation marker', async () => {
    fakeGenie("process.stderr.write('x'.repeat(1024 * 1024));");
    const result = await run('codex');
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(70 * 1024);
    expect(result.stderr).toEndWith('[genie hook launcher: stderr truncated]\n');
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      'stderr exceeded the safety limit',
    );
  });

  test('keeps Claude approval polling inside the shared launcher budget', () => {
    expect(launcher.childTimeoutMs('PreToolUse', 'codex', {})).toBe(12_000);
    expect(launcher.childTimeoutMs('PermissionRequest', 'codex', {})).toBe(115_000);
    expect(launcher.childTimeoutMs('PreToolUse', 'claude', {})).toBe(115_000);
    expect(
      launcher.childTimeoutMs('PermissionRequest', 'codex', { GENIE_HOOK_CHILD_TIMEOUT_MS: '999999' }),
    ).toBe(115_000);
    expect(launcher.childTimeoutMs('PreToolUse', 'codex', { GENIE_HOOK_CHILD_TIMEOUT_MS: '999999' })).toBe(
      12_000,
    );
  });

  test('Windows resolution uses only a canonical native executable without a shell', () => {
    const expected = 'C:\\Users\\test\\.genie\\bin\\genie.exe';
    const command = launcher.resolveGenieCommand(
      { GENIE_HOME: 'C:\\Users\\test\\.genie' },
      'win32',
      {
        lstat: (candidate) => ({ isFile: () => candidate === expected, isSymbolicLink: () => false, mode: 0 }),
        realpath: (candidate) => candidate,
        access: () => {},
      },
    );
    expect(command).toEqual({ command: 'C:\\Users\\test\\.genie\\bin\\genie.exe', shell: false });
  });

  test('hostile PATH, cwd-relative homes, and Windows command shims cannot select a dispatcher', async () => {
    const checked: string[] = [];
    const missing = launcher.resolveGenieCommand(
      { GENIE_HOME: join(root, 'missing-home'), PATH: join(root, 'attacker-bin') },
      process.platform,
      {
        lstat: (candidate) => {
          checked.push(candidate);
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        realpath: (candidate) => candidate,
        access: () => {},
      },
    );
    expect(missing.error).toContain('canonical Genie hook dispatcher not found');
    expect(checked).toEqual([join(root, 'missing-home', 'bin', 'genie')]);

    const relative = launcher.resolveGenieCommand(
      { GENIE_HOME: 'relative-home', PATH: join(root, 'attacker-bin') },
      process.platform,
      {
        lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 }),
        realpath: (candidate) => candidate,
        access: () => {},
      },
    );
    expect(relative.error).toBe('GENIE_HOME must be an absolute path');

    const windowsShim = launcher.resolveGenieCommand(
      { GENIE_HOME: 'C:\\Users\\test\\.genie', PATH: 'C:\\attacker' },
      'win32',
      {
        lstat: (candidate) => ({ isFile: () => candidate.endsWith('genie.cmd'), isSymbolicLink: () => false, mode: 0 }),
        realpath: (candidate) => candidate,
        access: () => {},
      },
    );
    expect(windowsShim.error).toContain('canonical Genie hook dispatcher not found');

    let spawned = false;
    const denied = await run('codex', payload('PermissionRequest'), {
      resolveCommand: () => ({ error: 'canonical dispatcher absent' }),
      spawn: () => {
        spawned = true;
        throw new Error('unreachable');
      },
    });
    expect(spawned).toBe(false);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'could not start Genie hook dispatcher: canonical dispatcher absent',
    });
  });

  test('rejects symlink, directory, realpath-redirection, and non-executable dispatcher candidates', () => {
    if (process.platform === 'win32') return;
    mkdirSync(join(root, 'genie-home', 'bin'), { recursive: true });
    const home = realpathSync(join(root, 'genie-home'));
    const candidate = join(home, 'bin', 'genie');
    const target = join(root, 'outside');

    rmSync(candidate, { force: true });
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    chmodSync(target, 0o755);
    symlinkSync(target, candidate);
    expect(launcher.resolveGenieCommand({ GENIE_HOME: home }, process.platform).error).toContain('not found');

    rmSync(candidate);
    mkdirSync(candidate);
    expect(launcher.resolveGenieCommand({ GENIE_HOME: home }, process.platform).error).toContain('not found');

    rmSync(candidate, { recursive: true });
    writeFileSync(candidate, '#!/bin/sh\nexit 0\n');
    chmodSync(candidate, 0o644);
    expect(launcher.resolveGenieCommand({ GENIE_HOME: home }, process.platform).error).toContain('not found');

    chmodSync(candidate, 0o755);
    expect(
      launcher.resolveGenieCommand({ GENIE_HOME: home }, process.platform, {
        lstat: lstatSync,
        realpath: () => target,
        access: () => {},
      }).error,
    ).toContain('not found');
  });

  test('validates only documented Codex response shapes', () => {
    expect(
      launcher.validCodexOutput(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } },
        }),
        'PermissionRequest',
      ),
    ).toBe(true);
    expect(
      launcher.validCodexOutput(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
        }),
        'PreToolUse',
      ),
    ).toBe(false);
  });
});
