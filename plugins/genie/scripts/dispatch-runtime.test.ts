import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
interface LaunchDeps {
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
  spawn?: (...args: unknown[]) => never;
  resolveCommand?: () =>
    | { command: string; shell: false; error?: never }
    | { error: string; command?: never; shell?: never };
}

const launcher = require('./dispatch-runtime.cjs') as {
  childTimeoutMs: (event: string, runtime: 'codex' | 'claude', env?: NodeJS.ProcessEnv) => number;
  launch: (
    runtime: string,
    raw: string,
    deps?: LaunchDeps,
  ) => Promise<number>;
  resolveGenieCommand: (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    exists: (path: string) => boolean,
  ) => { command: string; shell: false; error?: never } | { error: string; command?: never; shell?: never };
  validCodexOutput: (raw: string, event: string) => boolean;
};

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
  process.env.GENIE_HOME = home;
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
        "fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), runtime: process.env.GENIE_HOOK_RUNTIME, input }));",
      ].join('\n'),
    );
    const raw = payload();
    const result = await run('codex', raw);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    const call = JSON.parse(await Bun.file(log).text());
    expect(call.argv).toEqual(['hook', 'dispatch']);
    expect(call.runtime).toBe('codex');
    expect(call.input).toBe(raw);
  });

  test('rejects malformed and structurally invalid Codex input before spawning', async () => {
    const log = join(root, 'unexpected-spawn');
    process.env.FAKE_LOG = log;
    fakeGenie("fs.writeFileSync(process.env.FAKE_LOG, 'spawned');");

    const malformed = await run('codex', '{not json');
    expect(JSON.parse(malformed.stdout)).toEqual({
      decision: 'block',
      reason: 'genie hook launcher: payload is not valid JSON',
    });
    const invalidPermission = await run(
      'codex',
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_input: { command: 'echo hi' } }),
    );
    expect(JSON.parse(invalidPermission.stdout).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(existsSync(log)).toBe(false);
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

  test('Claude preserves the child exit status', async () => {
    fakeGenie('process.exit(7);');
    expect((await run('claude')).code).toBe(7);
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
        "fs.writeFileSync(process.env.FAKE_READY, 'ready');",
        "process.on('SIGTERM', () => { fs.writeFileSync(process.env.FAKE_SIGNAL, 'SIGTERM'); process.exit(0); });",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );
    const proc = Bun.spawn(['node', join(import.meta.dir, 'dispatch-runtime.cjs'), 'codex'], {
      env: { ...process.env, GENIE_HOME: join(root, 'genie-home') },
      stdin: Buffer.from(payload()),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(signalLog).text()).toBe('SIGTERM');
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
    const command = launcher.resolveGenieCommand(
      { GENIE_HOME: 'C:\\Users\\test\\.genie' },
      'win32',
      (path) => path.endsWith('genie.exe'),
    );
    expect(command).toEqual({ command: 'C:\\Users\\test\\.genie\\bin\\genie.exe', shell: false });
  });

  test('hostile PATH, cwd-relative homes, and Windows command shims cannot select a dispatcher', async () => {
    const checked: string[] = [];
    const missing = launcher.resolveGenieCommand(
      { GENIE_HOME: join(root, 'missing-home'), PATH: join(root, 'attacker-bin') },
      process.platform,
      (candidate) => {
        checked.push(candidate);
        return false;
      },
    );
    expect(missing.error).toContain('canonical Genie hook dispatcher not found');
    expect(checked).toEqual([join(root, 'missing-home', 'bin', 'genie')]);

    const relative = launcher.resolveGenieCommand(
      { GENIE_HOME: 'relative-home', PATH: join(root, 'attacker-bin') },
      process.platform,
      () => true,
    );
    expect(relative.error).toBe('GENIE_HOME must be an absolute path');

    const windowsShim = launcher.resolveGenieCommand(
      { GENIE_HOME: 'C:\\Users\\test\\.genie', PATH: 'C:\\attacker' },
      'win32',
      (candidate) => candidate.endsWith('genie.cmd'),
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
