import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  genieConfigExists,
  getGenieConfigPath,
  getGenieDir,
  loadGenieConfig,
  saveGenieConfig,
} from './genie-config.js';

describe('genie-config GENIE_HOME resolution', () => {
  let dir: string;
  let prevGenieHome: string | undefined;

  beforeEach(() => {
    prevGenieHome = process.env.GENIE_HOME;
    dir = mkdtempSync(join(tmpdir(), 'genie-config-'));
    process.env.GENIE_HOME = dir;
  });

  afterEach(() => {
    if (prevGenieHome === undefined) {
      Reflect.deleteProperty(process.env, 'GENIE_HOME');
    } else {
      process.env.GENIE_HOME = prevGenieHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('config dir and path honor GENIE_HOME lazily (set after import)', () => {
    expect(getGenieDir()).toBe(dir);
    expect(getGenieConfigPath()).toBe(join(dir, 'config.json'));
  });

  test('load returns isolated defaults, save/load round-trips inside GENIE_HOME', async () => {
    expect(genieConfigExists()).toBe(false);
    const config = await loadGenieConfig();
    expect(config.budgets).toEqual({ maxFableCallsPerWish: 3, maxEscalationsPerGroup: 2 });
    expect(config.routing).toEqual({ maxAutoEffort: 'xhigh', fableGateMaxAt: 7 });
    config.setupComplete = true;
    await saveGenieConfig(config);
    expect(genieConfigExists()).toBe(true);
    const reloaded = await loadGenieConfig();
    expect(reloaded.setupComplete).toBe(true);
    expect(reloaded.budgets).toEqual({ maxFableCallsPerWish: 3, maxEscalationsPerGroup: 2 });
    expect(reloaded.routing).toEqual({ maxAutoEffort: 'xhigh', fableGateMaxAt: 7 });
  });

  test('load and save preserve configured routing-matrix values', async () => {
    writeFileSync(
      getGenieConfigPath(),
      JSON.stringify({
        budgets: { maxFableCallsPerWish: 5, maxEscalationsPerGroup: 4 },
        routing: { maxAutoEffort: 'high', fableGateMaxAt: 9 },
      }),
      'utf-8',
    );

    const config = await loadGenieConfig();
    expect(config.budgets).toEqual({ maxFableCallsPerWish: 5, maxEscalationsPerGroup: 4 });
    expect(config.routing).toEqual({ maxAutoEffort: 'high', fableGateMaxAt: 9 });

    await saveGenieConfig(config);
    const saved = JSON.parse(readFileSync(getGenieConfigPath(), 'utf-8')) as Record<string, unknown>;
    expect(saved.budgets).toEqual({ maxFableCallsPerWish: 5, maxEscalationsPerGroup: 4 });
    expect(saved.routing).toEqual({ maxAutoEffort: 'high', fableGateMaxAt: 9 });
  });

  test('falls back to ~/.genie when GENIE_HOME is unset', () => {
    Reflect.deleteProperty(process.env, 'GENIE_HOME');
    expect(getGenieDir()).toBe(join(homedir(), '.genie'));
    expect(getGenieConfigPath()).toBe(join(homedir(), '.genie', 'config.json'));
  });
});
