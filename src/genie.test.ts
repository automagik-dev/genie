import { describe, expect, test } from 'bun:test';
import { type EntrypointDeps, handleEntrypointArgs } from './genie.js';

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function makeDeps(overrides: Partial<EntrypointDeps> = {}): { deps: EntrypointDeps; calls: Record<string, number> } {
  const calls = {
    ensureInboxWatcherDaemon: 0,
    sessionCommand: 0,
    startNamedSession: 0,
    parseProgram: 0,
    error: 0,
  };

  const deps: EntrypointDeps = {
    ensureInboxWatcherDaemon: async () => {
      calls.ensureInboxWatcherDaemon++;
    },
    sessionCommand: async () => {
      calls.sessionCommand++;
    },
    startNamedSession: async () => {
      calls.startNamedSession++;
    },
    parseProgram: () => {
      calls.parseProgram++;
    },
    error: () => {
      calls.error++;
    },
    exit: (code) => {
      throw new ExitSignal(code);
    },
    ...overrides,
  };

  return { deps, calls };
}

describe('handleEntrypointArgs', () => {
  test('starts the inbox watcher for the default interactive session', async () => {
    const { deps, calls } = makeDeps();

    await expect(handleEntrypointArgs([], deps)).rejects.toMatchObject({ code: 0 });
    expect(calls.ensureInboxWatcherDaemon).toBe(1);
    expect(calls.sessionCommand).toBe(1);
    expect(calls.startNamedSession).toBe(0);
    expect(calls.parseProgram).toBe(0);
  });

  test('starts the inbox watcher for named sessions', async () => {
    const { deps, calls } = makeDeps();

    await expect(handleEntrypointArgs(['--session', 'alpha'], deps)).rejects.toMatchObject({ code: 0 });
    expect(calls.ensureInboxWatcherDaemon).toBe(1);
    expect(calls.startNamedSession).toBe(1);
    expect(calls.sessionCommand).toBe(0);
    expect(calls.parseProgram).toBe(0);
  });

  test('does not start the watcher for regular subcommands', async () => {
    const { deps, calls } = makeDeps();

    await handleEntrypointArgs(['ls'], deps);
    expect(calls.ensureInboxWatcherDaemon).toBe(0);
    expect(calls.parseProgram).toBe(1);
  });

  test('treats --session with a subcommand as a normal parse path', async () => {
    const { deps, calls } = makeDeps();

    await handleEntrypointArgs(['--session', 'alpha', 'ls'], deps);
    expect(calls.ensureInboxWatcherDaemon).toBe(0);
    expect(calls.startNamedSession).toBe(0);
    expect(calls.parseProgram).toBe(1);
  });

  test('reports session startup failures and exits non-zero', async () => {
    const { deps, calls } = makeDeps({
      startNamedSession: async () => {
        calls.startNamedSession++;
        throw new Error('boom');
      },
    });

    await expect(handleEntrypointArgs(['--session', 'alpha'], deps)).rejects.toMatchObject({ code: 1 });
    expect(calls.ensureInboxWatcherDaemon).toBe(1);
    expect(calls.error).toBe(1);
  });
});
