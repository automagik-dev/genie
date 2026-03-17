import { describe, expect, test } from 'bun:test';

// genie-config.ts uses module-level constants that read homedir() at import time.
// We can't override GENIE_DIR/GENIE_CONFIG_FILE. Instead we test the pure functions
// and verify the ones that use the filesystem work without crashing.

import {
  contractPath,
  genieConfigExists,
  getGenieConfigPath,
  getGenieDir,
  getTerminalConfig,
  isSetupComplete,
  loadGenieConfig,
  loadGenieConfigSync,
} from './genie-config.js';

describe('getGenieDir', () => {
  test('returns a path containing .genie', () => {
    const dir = getGenieDir();
    expect(dir).toContain('.genie');
  });
});

describe('getGenieConfigPath', () => {
  test('returns a path ending with config.json', () => {
    const path = getGenieConfigPath();
    expect(path).toEndWith('config.json');
  });
});

describe('genieConfigExists', () => {
  test('returns a boolean', () => {
    const result = genieConfigExists();
    expect(typeof result).toBe('boolean');
  });
});

describe('contractPath', () => {
  test('contracts home directory to ~', () => {
    const { homedir } = require('node:os');
    const home = homedir();
    expect(contractPath(`${home}/projects/test`)).toBe('~/projects/test');
  });

  test('contracts exact home to ~', () => {
    const { homedir } = require('node:os');
    expect(contractPath(homedir())).toBe('~');
  });

  test('returns non-home paths unchanged', () => {
    expect(contractPath('/tmp/foo')).toBe('/tmp/foo');
  });

  test('returns relative paths unchanged', () => {
    expect(contractPath('relative/path')).toBe('relative/path');
  });
});

describe('loadGenieConfig', () => {
  test('returns a valid config object', async () => {
    const config = await loadGenieConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });
});

describe('loadGenieConfigSync', () => {
  test('returns a valid config object', () => {
    const config = loadGenieConfigSync();
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });
});

describe('getTerminalConfig', () => {
  test('returns terminal config with expected shape', () => {
    const config = getTerminalConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });
});

describe('isSetupComplete', () => {
  test('returns a boolean', () => {
    const result = isSetupComplete();
    expect(typeof result).toBe('boolean');
  });
});
