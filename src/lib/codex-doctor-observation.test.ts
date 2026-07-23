import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeDoctorCodexHost } from './codex-doctor-observation.js';
import type { CommandResult } from './runtime-integrations.js';

const T = '5.260722.1';
// An absolute, existing, executable path so the probe's trusted-executable
// validation passes without a real Codex install.
const FAKE_CODEX = process.execPath;

function pluginListJson(entries: Array<{ version: string; enabled?: boolean }>): string {
  return JSON.stringify({
    installed: entries.map((e) => ({ pluginId: 'genie@automagik', version: e.version, enabled: e.enabled ?? true })),
  });
}

let codexHome: string;
beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), 'doctor-obs-codex-'));
});
afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
});

function observe(result: Partial<CommandResult>, calls: string[][] = []) {
  return observeDoctorCodexHost({
    which: () => FAKE_CODEX,
    codexHome,
    runner: (command, args) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stdout: '', stderr: '', ...result };
    },
  });
}

describe('observeDoctorCodexHost — one bounded observation, every surface derived', () => {
  test('absent CLI: zero spawns, probe reports Claude-only mode', () => {
    const calls: string[][] = [];
    const obs = observeDoctorCodexHost({
      which: () => null,
      runner: () => {
        calls.push(['spawned']);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(calls).toEqual([]);
    expect(obs.codexCommand).toBeNull();
    expect(obs.observation).toBeNull();
    expect(obs.projection).toBeNull();
    expect(obs.advisory).toBeNull();
    expect(obs.activationRunner).toBeNull();
    expect(obs.probe.cliAvailable).toBe(false);
  });

  test('exactly ONE bounded query feeds probe, projection, and replay runner', () => {
    const calls: string[][] = [];
    const obs = observe({ stdout: pluginListJson([{ version: T, enabled: true }]) }, calls);
    expect(calls).toEqual([[FAKE_CODEX, 'plugin', 'list', '--json']]);
    expect(obs.observation?.status).toBe('ok');
    expect(obs.probe).toMatchObject({ cliAvailable: true, installed: true, enabled: true, version: T });
    expect(obs.projection).toMatchObject({ registration: 'present', installedVersion: T, queryFailed: false });
    // Deriving the activation snapshot must NOT spawn again.
    obs.activationRunner?.(FAKE_CODEX, ['plugin', 'list', '--json']);
    expect(calls).toHaveLength(1);
  });

  test('the real sandbox PATH advisory: ok observation, advisory retained, replay stderr blanked (Decision 11)', () => {
    const obs = observe({
      stdout: pluginListJson([{ version: T }]),
      stderr: '\x1b[33mWARN: PATH does not include codex shims\x1b[0m',
    });
    expect(obs.observation?.status).toBe('ok');
    expect(obs.advisory).toBe('WARN: PATH does not include codex shims');
    // Probe side already tolerated exit-0 stderr; replay side must now agree.
    expect(obs.probe.installed).toBe(true);
    const replay = obs.activationRunner?.(FAKE_CODEX, ['plugin', 'list', '--json']);
    expect(replay?.stderr).toBe('');
    expect(replay?.stdout).toBe(pluginListJson([{ version: T }]));
  });

  test('nonzero exit fails BOTH surfaces from the same fact', () => {
    const obs = observe({ exitCode: 3, stderr: 'boom' });
    expect(obs.observation?.status).toBe('failed');
    expect(obs.projection?.queryFailed).toBe(true);
    expect(obs.probe.status).toBe('error');
    const replay = obs.activationRunner?.(FAKE_CODEX, ['plugin', 'list', '--json']);
    expect(replay?.exitCode).toBe(3);
    expect(replay?.stderr).toBe('boom');
  });

  test('timeout fails both surfaces', () => {
    const obs = observe({ timedOut: true });
    expect(obs.observation).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(obs.probe).toMatchObject({ status: 'error', timedOut: true });
    expect(obs.activationRunner?.(FAKE_CODEX, [])?.timedOut).toBe(true);
  });

  test('output overflow can never replay as a smaller valid answer (e.g. "not installed")', () => {
    const obs = observe({ outputOverflow: true, stdout: '{"installed":' });
    expect(obs.observation).toMatchObject({ status: 'failed', code: 'output-overflow' });
    expect(obs.probe.status).toBe('error');
    expect(obs.probe.installed).toBe(false);
    expect(obs.probe.detail).toContain('output cap');
    const replay = obs.activationRunner?.(FAKE_CODEX, []);
    expect(replay?.outputOverflow).toBe(true);
  });

  test('malformed stdout fails both surfaces', () => {
    const obs = observe({ stdout: 'not json' });
    expect(obs.observation).toMatchObject({ status: 'failed', code: 'malformed-json' });
    const replay = obs.activationRunner?.(FAKE_CODEX, []);
    expect(replay?.stdout).toBe('not json');
  });
});
