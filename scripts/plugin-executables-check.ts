#!/usr/bin/env bun

/** Static coverage for Node executables shipped outside the main tsconfig. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const path of CHECK_JS_TARGETS) {
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
  '--skipLibCheck',
  '--module',
  'nodenext',
  '--moduleResolution',
  'nodenext',
  '--target',
  'es2022',
  '--types',
  'node',
  ...CHECK_JS_TARGETS,
]);

const nodeExecutables = readdirSync(SCRIPTS)
  .filter((name) => name.endsWith('.cjs') || name === 'smart-install.js')
  .sort();
for (const name of nodeExecutables) run('node', ['--check', join(SCRIPTS, name)]);

process.stdout.write(
  `plugin-executables-check: OK (${CHECK_JS_TARGETS.length} checked sources, ${nodeExecutables.length} shipped scripts)\n`,
);
