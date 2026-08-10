#!/usr/bin/env bun

/** Static coverage for Node executables shipped outside the main tsconfig. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPTS = join(ROOT, 'plugins', 'genie', 'scripts');
const CHECK_JS_TARGETS = [
  'first-run-check.cjs',
  'council-stamp.cjs',
  'dispatch-runtime.cjs',
  'mcp-launcher.cjs',
  'smart-install.js',
  'src/session-context.ts',
  'src/validate-completion.ts',
  'src/validate-wish.ts',
].map((path) => join(SCRIPTS, path));

/**
 * Scripts a runtime execs directly through their shebang rather than via
 * `node <path>`. Kimi's manifest runs `mcpServers.genie.command` as the
 * program itself, so a lost executable bit is a silent MCP outage.
 */
const REQUIRED_EXECUTABLES = ['mcp-launcher.cjs'].map((path) => join(SCRIPTS, path));

function strictFixtureTargets(argv: string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--strict-fixture' || !argv[index + 1]) {
      throw new Error('usage: plugin-executables-check.ts [--strict-fixture <path>]');
    }
    targets.push(resolve(argv[index + 1]));
    index++;
  }
  return targets;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const fixtureTargets = strictFixtureTargets(process.argv.slice(2));
const typecheckTargets = [...CHECK_JS_TARGETS, ...fixtureTargets];
for (const path of typecheckTargets) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`plugin executable source must be a physical file: ${path}`);
}

const typescriptCli = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(typescriptCli)) throw new Error('typescript CLI is missing; run `bun install` before static checks');
run(process.execPath, [
  typescriptCli,
  '--noEmit',
  '--allowJs',
  '--checkJs',
  '--strict',
  '--skipLibCheck',
  '--module',
  'nodenext',
  '--moduleResolution',
  'nodenext',
  '--target',
  'es2022',
  '--types',
  'node',
  ...typecheckTargets,
]);

for (const path of REQUIRED_EXECUTABLES) {
  const mode = lstatSync(path).mode & 0o777;
  // Owner bit only: git records just the 100755/100644 class and materializes
  // it as 0777 & ~umask, so a clean checkout under umask 077 is 0700 — the
  // group/other bits are checkout-environment noise, not the committed mode.
  if ((mode & 0o100) !== 0o100) {
    throw new Error(
      `plugin executable must be committed with the executable bit (100755): ${path} is ${mode.toString(8).padStart(4, '0')}`,
    );
  }
}

const nodeExecutables = readdirSync(SCRIPTS)
  .filter((name) => name.endsWith('.cjs') || name === 'smart-install.js')
  .sort();
for (const name of nodeExecutables) run('node', ['--check', join(SCRIPTS, name)]);

process.stdout.write(
  `plugin-executables-check: OK (${CHECK_JS_TARGETS.length} strict checked sources, ${REQUIRED_EXECUTABLES.length} exec-bit asserted, ${nodeExecutables.length} shipped scripts)\n`,
);
