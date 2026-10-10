#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import lint from '@commitlint/lint';
import load from '@commitlint/load';
import { foreignOnlyMikroCommits } from './git-history-ownership.js';

type CommitLintOptions = NonNullable<Parameters<typeof lint>[2]>;
const ROOT = join(import.meta.dir, '..');
const COMMIT_ID = /^[0-9a-f]{40}$/;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
}

async function main(): Promise<number> {
  const [fromFlag, from, toFlag, to, ...extra] = process.argv.slice(2);
  if (
    fromFlag !== '--from' ||
    toFlag !== '--to' ||
    !from ||
    !to ||
    extra.length ||
    !COMMIT_ID.test(from) ||
    !COMMIT_ID.test(to)
  ) {
    process.stderr.write('usage: bun scripts/commitlint.ts --from <40-hex commit> --to <40-hex commit>\n');
    return 2;
  }
  if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') {
    throw new Error('refusing incomplete commit ownership on a shallow clone; use fetch-depth: 0');
  }
  git('cat-file', '-e', `${from}^{commit}`);
  git('cat-file', '-e', `${to}^{commit}`);
  const foreign = foreignOnlyMikroCommits(git, to);
  const config = await load({}, { cwd: ROOT, file: join(ROOT, 'commitlint.config.ts') });
  if (Object.keys(config.rules).length === 0) throw new Error('empty commit lint rules configuration');
  const options: CommitLintOptions = {
    plugins: config.plugins,
    ignores: config.ignores,
    defaultIgnores: config.defaultIgnores,
  };
  const parserOptions = config.parserPreset?.parserOpts;
  if (parserOptions && typeof parserOptions === 'object') {
    // load owns preset normalization; its public type leaves this resolved parser contract unknown.
    options.parserOpts = parserOptions as CommitLintOptions['parserOpts'];
  }
  const fields = git('log', '--reverse', '--topo-order', '--format=%H%x00%B%x00', `${from}..${to}`).split('\0');
  if ((fields.length - 1) % 2 !== 0 || fields.at(-1)?.trim()) throw new Error('invalid Git commit message records');
  let checked = 0;
  let excluded = 0;
  let failed = false;
  for (let index = 0; index < fields.length - 1; index += 2) {
    const commit = fields[index]?.trim();
    const message = fields[index + 1];
    if (!commit || !COMMIT_ID.test(commit) || message === undefined)
      throw new Error('invalid Git commit message record');
    if (foreign.has(commit)) {
      excluded++;
      continue;
    }
    const result = await lint(message, config.rules, options);
    checked++;
    process.stdout.write(`${commit}: ${result.valid ? 'valid' : 'invalid'}\n`);
    for (const warning of result.warnings)
      process.stderr.write(`${commit}: warning [${warning.name}] ${warning.message}\n`);
    for (const error of result.errors) process.stderr.write(`${commit}: error [${error.name}] ${error.message}\n`);
    if (!result.valid) failed = true;
  }
  process.stdout.write(
    `Checked ${checked} Genie-owned commits; excluded ${excluded} proven foreign-only Mikro commits.\n`,
  );
  return failed ? 1 : 0;
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`commitlint: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
