import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE_PLUGIN = join(import.meta.dir, '..');
const NODE_BIN = Bun.which('node');
if (!NODE_BIN) throw new Error('Node is required to test the Codex plugin MCP launcher');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-mcp-launcher-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedFakeGenie(genieHome: string): string {
  const binary = join(genieHome, 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie');
  mkdirSync(join(genieHome, 'bin'), { recursive: true });
  writeFileSync(
    binary,
    `#!${NODE_BIN}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

function controlledNodePath(): string {
  const binDir = join(root, 'controlled-path');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(NODE_BIN, join(binDir, 'node'));
  return `${binDir}:/usr/bin:/bin`;
}

function runLauncher(pluginRoot: string, genieHome: string, path = controlledNodePath()) {
  // Exact committed .mcp.json command/args/cwd contract.
  return Bun.spawnSync(['node', './scripts/mcp-launcher.cjs'], {
    cwd: pluginRoot,
    env: { ...process.env, GENIE_HOME: genieHome, PATH: path },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 2_000,
  });
}

describe('plugin-local MCP launcher', () => {
  test('starts the canonical binary from the source plugin with only the mcp argument', () => {
    const genieHome = join(root, 'genie-home');
    seedFakeGenie(genieHome);
    const result = runLauncher(SOURCE_PLUGIN, genieHome);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ args: ['mcp'], cwd: SOURCE_PLUGIN });
  });

  test('starts from an extracted plugin copy without escaping its relative launcher path', () => {
    const extracted = join(root, 'extracted', 'plugins', 'genie');
    mkdirSync(join(root, 'extracted', 'plugins'), { recursive: true });
    cpSync(SOURCE_PLUGIN, extracted, { recursive: true, dereference: false, verbatimSymlinks: true });
    const genieHome = join(root, 'genie-home');
    seedFakeGenie(genieHome);
    const result = runLauncher(extracted, genieHome);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ args: ['mcp'], cwd: realpathSync(extracted) });
  });

  test('starts from a Codex-like versioned cache using the same bare Node command', () => {
    const cached = join(root, 'cache', 'automagik', 'genie', 'fixture-version');
    mkdirSync(join(root, 'cache', 'automagik', 'genie'), { recursive: true });
    cpSync(SOURCE_PLUGIN, cached, { recursive: true, dereference: false, verbatimSymlinks: true });
    const genieHome = join(root, 'genie-home');
    seedFakeGenie(genieHome);
    const result = runLauncher(cached, genieHome);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ args: ['mcp'], cwd: realpathSync(cached) });
  });

  test('missing canonical binary fails closed even when PATH contains a different genie', () => {
    const pathBin = join(root, 'path-bin');
    mkdirSync(pathBin, { recursive: true });
    const decoy = join(pathBin, 'genie');
    writeFileSync(decoy, `#!${NODE_BIN}\nprocess.stdout.write('PATH FALLBACK RAN');\n`);
    chmodSync(decoy, 0o755);

    controlledNodePath();
    const result = runLauncher(
      SOURCE_PLUGIN,
      join(root, 'missing-home'),
      `${join(root, 'controlled-path')}:${pathBin}:/usr/bin:/bin`,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).not.toContain('PATH FALLBACK RAN');
    expect(result.stderr.toString()).toContain('launcher refused startup');
    expect(result.stderr.toString()).toContain(join('missing-home', 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie'));
  });
});
