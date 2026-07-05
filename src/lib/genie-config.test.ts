import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
    config.setupComplete = true;
    await saveGenieConfig(config);
    expect(genieConfigExists()).toBe(true);
    const reloaded = await loadGenieConfig();
    expect(reloaded.setupComplete).toBe(true);
  });

  test('falls back to ~/.genie when GENIE_HOME is unset', () => {
    Reflect.deleteProperty(process.env, 'GENIE_HOME');
    expect(getGenieDir()).toBe(join(homedir(), '.genie'));
    expect(getGenieConfigPath()).toBe(join(homedir(), '.genie', 'config.json'));
  });
});
