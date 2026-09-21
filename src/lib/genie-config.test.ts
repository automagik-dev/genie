import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenieConfigSchema } from '../types/genie-config.js';
import {
  UnknownConfigKeyError,
  configSchemaHasKey,
  genieConfigExists,
  getGenieConfigPath,
  getGenieDir,
  loadGenieConfig,
  resolveConfigKey,
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

describe('budget ceilings', () => {
  test('a budget past its schema ceiling is rejected, not clamped', () => {
    expect(() => GenieConfigSchema.parse({ budgets: { maxEscalationsPerGroup: 6 } })).toThrow();
    expect(() => GenieConfigSchema.parse({ budgets: { maxFableCallsPerWish: 11 } })).toThrow();
  });

  test('a budget at its ceiling is accepted', () => {
    const config = GenieConfigSchema.parse({
      budgets: { maxEscalationsPerGroup: 5, maxFableCallsPerWish: 10 },
    });
    expect(config.budgets).toEqual({ maxEscalationsPerGroup: 5, maxFableCallsPerWish: 10 });
  });
});

describe('config key resolution', () => {
  let dir: string;
  let prevGenieHome: string | undefined;

  beforeEach(() => {
    prevGenieHome = process.env.GENIE_HOME;
    dir = mkdtempSync(join(tmpdir(), 'genie-config-key-'));
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

  test('only schema keys are addressable', () => {
    expect(configSchemaHasKey('budgets.maxEscalationsPerGroup')).toBe(true);
    expect(configSchemaHasKey('budgets')).toBe(true);
    expect(configSchemaHasKey('otel.logPrompts')).toBe(true); // reaches through an OPTIONAL branch
    expect(configSchemaHasKey('budgets.nope')).toBe(false);
    expect(configSchemaHasKey('workerProfiles.anything')).toBe(false);
    expect(configSchemaHasKey('')).toBe(false);
    expect(configSchemaHasKey('budgets..maxEscalationsPerGroup')).toBe(false);
  });

  test('an unknown key throws UnknownConfigKeyError carrying the key', async () => {
    await expect(resolveConfigKey('budgets.nope')).rejects.toBeInstanceOf(UnknownConfigKeyError);
  });

  test('source distinguishes a default from a configured value', async () => {
    expect(await resolveConfigKey('budgets.maxEscalationsPerGroup')).toEqual({
      key: 'budgets.maxEscalationsPerGroup',
      value: 2,
      source: 'default',
    });
    writeFileSync(getGenieConfigPath(), JSON.stringify({ budgets: { maxEscalationsPerGroup: 4 } }), 'utf-8');
    expect(await resolveConfigKey('budgets.maxEscalationsPerGroup')).toEqual({
      key: 'budgets.maxEscalationsPerGroup',
      value: 4,
      source: 'file',
    });
  });

  test('a file the schema refuses reports the default as a default', async () => {
    writeFileSync(getGenieConfigPath(), JSON.stringify({ budgets: { maxEscalationsPerGroup: 99 } }), 'utf-8');
    expect(await resolveConfigKey('budgets.maxEscalationsPerGroup')).toEqual({
      key: 'budgets.maxEscalationsPerGroup',
      value: 2,
      source: 'default',
    });
  });
});

describe('atomic config save', () => {
  let dir: string;
  let prevGenieHome: string | undefined;

  beforeEach(() => {
    prevGenieHome = process.env.GENIE_HOME;
    dir = mkdtempSync(join(tmpdir(), 'genie-config-atomic-'));
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

  test('the write commits by rename and leaves no staging sibling behind', async () => {
    const config = await loadGenieConfig();
    config.setupComplete = true;
    await saveGenieConfig(config);
    const entries = readdirSync(dir);
    expect(entries).toContain('config.json');
    expect(entries.filter((name) => name.includes('staging'))).toEqual([]);
    expect(JSON.parse(readFileSync(getGenieConfigPath(), 'utf-8')).setupComplete).toBe(true);
  });

  test('a rejected config never truncates the file already on disk', async () => {
    const config = await loadGenieConfig();
    await saveGenieConfig(config);
    const before = readFileSync(getGenieConfigPath(), 'utf-8');
    const overBudget = { ...config, budgets: { ...config.budgets, maxEscalationsPerGroup: 99 } };
    await expect(saveGenieConfig(overBudget)).rejects.toThrow('Failed to save genie config');
    expect(readFileSync(getGenieConfigPath(), 'utf-8')).toBe(before);
  });
});
