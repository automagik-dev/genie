#!/usr/bin/env bun
/**
 * undefined-residue: the post-test check of `bun run check`.
 *
 * Fails (exit 1) when the tree holds any entry with a path component named
 * exactly `undefined`. That name is what a test run leaves behind when it leaks
 * its environment: a test that deletes HOME without restoring it, or restores it
 * with `process.env.HOME = saved` / `Object.assign(process.env, snapshot)` while
 * `saved` is undefined (Bun stores the string "undefined"), makes the next bun it
 * spawns cache packages under `./undefined/.bun` relative to that child's cwd.
 * The root `.gitignore` carries `/undefined/`, so a plain `git status` hides the
 * root case; this check reads ignored entries too.
 *
 * It checks the tree as it stands, not a before/after diff: nothing legitimate
 * is named `undefined`, so a stale entry from an earlier run fails too, with the
 * same remedy.
 *
 * Reads `git status --porcelain=v1 -z --ignored --untracked-files=normal`, so a
 * wholly untracked or ignored directory is one collapsed entry: `undefined/`
 * under the root or under a tracked directory (a plugin package) is found; one
 * nested inside an already-ignored directory (`node_modules/`, a scratch dir) is
 * not, and git lists no empty directory. Exit 2 when git cannot answer.
 */

import { execFileSync } from 'node:child_process';

/** Porcelain v1 `-z` records → every path that has a component equal to `undefined`. Pure. */
export function residueEntries(porcelainZ: string): string[] {
  const records = porcelainZ.split('\0');
  const found: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // A rename or copy carries its origin path as the next NUL-separated field.
    if (/[RC]/.test(status)) index++;
    if (path.split('/').includes('undefined')) found.push(path);
  }
  return found;
}

/** The `undefined` entries of the git work tree that contains `cwd`. */
export function scanResidue(cwd: string): string[] {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return residueEntries(status);
}

export function formatFailure(entries: string[]): string {
  return [
    `undefined-residue: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} named "undefined" in the tree:`,
    ...entries.map((entry) => `  ${entry}`),
    'A bun run with HOME unset, or set to the text "undefined", wrote its cache there.',
    'Delete it and rerun; if it comes back, a test is leaking the environment.',
  ].join('\n');
}

function main(): void {
  const entries = scanResidue(process.cwd());
  if (entries.length === 0) {
    process.stdout.write('undefined-residue: no entry named "undefined" in the tree\n');
    process.exit(0);
  }
  process.stderr.write(`${formatFailure(entries)}\n`);
  process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`undefined-residue: cannot read the git status: ${detail}\n`);
    process.exit(2);
  }
}
