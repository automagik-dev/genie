#!/usr/bin/env node
'use strict';

/**
 * Codex plugin-local launcher for `genie mcp`.
 *
 * This file intentionally has no PATH or shell fallback. The only executable
 * it will start is the canonical platform binary under `$GENIE_HOME/bin`
 * (default `~/.genie/bin`). Missing, non-regular, symlinked, or non-executable
 * binaries fail closed so an enabled plugin cannot silently route elsewhere.
 */

const { accessSync, constants, lstatSync, realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const { isAbsolute, join, normalize } = require('node:path');
const { spawn } = require('node:child_process');

function resolveGenieBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const configuredHome = env.GENIE_HOME;
  const genieHome = configuredHome && configuredHome.trim() ? configuredHome : join(userHome, '.genie');
  if (!isAbsolute(genieHome)) {
    throw new Error(`GENIE_HOME must be absolute for Codex MCP startup: ${JSON.stringify(genieHome)}`);
  }

  const fileName = platform === 'win32' ? 'genie.exe' : 'genie';
  const expected = normalize(join(genieHome, 'bin', fileName));
  const stat = lstatSync(expected);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`canonical Genie MCP binary is not a regular file: ${expected}`);
  }
  const canonical = realpathSync(expected);
  const equivalentExpected = platform === 'darwin' && expected.startsWith('/') ? `/private${expected}` : expected;
  if (normalize(canonical) !== expected && normalize(canonical) !== equivalentExpected) {
    throw new Error(`canonical Genie MCP binary resolves outside its expected path: ${expected} -> ${canonical}`);
  }
  accessSync(canonical, platform === 'win32' ? constants.F_OK : constants.X_OK);
  return canonical;
}

function launchMcp(options = {}) {
  const binary = resolveGenieBinary(options);
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(binary, ['mcp'], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  const forwardedSignals = ['SIGINT', 'SIGTERM'];
  for (const signal of forwardedSignals) {
    process.once(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.once('error', (error) => {
    process.stderr.write(`genie MCP launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`genie MCP exited on ${signal}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
  return child;
}

if (require.main === module) {
  try {
    launchMcp();
  } catch (error) {
    process.stderr.write(`genie MCP launcher refused startup: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { launchMcp, resolveGenieBinary };
