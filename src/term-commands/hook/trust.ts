/**
 * `genie hook trust [path]` — add a hook file to the trust allowlist.
 *
 * Without a path, prints the current trust file. With a path, computes the
 * file's SHA-256, scopes the entry (default global; --repo for per-repo),
 * surfaces declared capabilities, and writes the entry. Re-trusting an
 * existing path with a different SHA overwrites silently — that's the
 * expected flow when the operator edits a trusted hook.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  type TrustEntry,
  type TrustFile,
  defaultTrustPath,
  parseCapabilities,
  readTrustFile,
  sha256OfFile,
} from '../../hooks/trust.js';

interface TrustOptions {
  repo?: boolean;
  global?: boolean;
  team?: string;
  note?: string;
  yes?: boolean;
}

/** Resolve current repo's `remote.origin.url` via git. Returns null on failure. */
function resolveOriginUrl(repoRoot: string): string | null {
  try {
    const out = execSync('git config --get remote.origin.url', { cwd: repoRoot, encoding: 'utf-8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Walk up from `start` until a directory containing `.git` is found. */
function findRepoRoot(start: string): string | null {
  let current = start;
  while (current !== '/') {
    if (existsSync(join(current, '.git'))) return current;
    current = dirname(current);
  }
  return null;
}

function writeTrustFile(path: string, file: TrustFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Atomic write via temp + rename so a crash mid-write doesn't corrupt the
  // trust file (the security boundary). Stable JSON (sorted keys, 2-space
  // indent, trailing newline) so byte-equal diffs survive cosmetic edits.
  const sorted: TrustFile = {
    version: 1,
    entries: [...file.entries].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const serialized = `${JSON.stringify(sorted, null, 2)}\n`;
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, serialized, 'utf-8');
  renameSync(tmpPath, path);
}

function runTrustList(trustPath: string): void {
  const current = readTrustFile(trustPath);
  if (current.entries.length === 0) {
    console.log(`(trust file empty: ${trustPath})`);
    return;
  }
  console.log(`Trusted hooks (${current.entries.length}, from ${trustPath}):`);
  for (const entry of current.entries) {
    const scope = entry.scope === 'repo' ? `repo:${entry.repoRemoteUrl ?? '?'}` : entry.scope;
    console.log(`  ${entry.path}`);
    console.log(`    scope:    ${scope}`);
    console.log(`    sha256:   ${entry.sha256}`);
    console.log(`    trusted:  ${entry.trustedAt}`);
    if (entry.capabilities && entry.capabilities.length > 0) {
      console.log(`    caps:     ${entry.capabilities.join(', ')}`);
    }
    if (entry.note) console.log(`    note:     ${entry.note}`);
  }
}

function resolveTrustScope(
  filePath: string,
  options: TrustOptions,
): { scope: TrustEntry['scope']; repoRemoteUrl?: string } {
  if (options.repo) {
    const repoRoot = findRepoRoot(dirname(filePath));
    if (!repoRoot) {
      console.error(`Error: --repo passed but no .git directory found above ${filePath}`);
      process.exit(1);
    }
    const remote = resolveOriginUrl(repoRoot);
    if (!remote) {
      console.error(`Error: --repo passed but ${repoRoot} has no remote.origin.url`);
      process.exit(1);
    }
    return { scope: 'repo', repoRemoteUrl: remote };
  }
  if (options.team) return { scope: 'team' };
  return { scope: 'global' };
}

async function confirmTrustOrAbort(yes: boolean): Promise<void> {
  if (yes || !process.stdin.isTTY) return;
  process.stdout.write('Confirm? (y/N) ');
  const buf = Buffer.alloc(8);
  let read = 0;
  try {
    const fs = await import('node:fs');
    read = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    console.error('Error: cannot read confirmation; pass --yes to trust non-interactively');
    process.exit(1);
  }
  const answer = buf.subarray(0, read).toString().trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborted.');
    process.exit(1);
  }
}

async function runTrustAdd(target: string, options: TrustOptions, trustPath: string): Promise<void> {
  const filePath = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }
  if (!filePath.endsWith('.ts')) {
    console.error(`Error: trust target must be a .ts file: ${filePath}`);
    process.exit(1);
  }

  const { scope, repoRemoteUrl } = resolveTrustScope(filePath, options);
  const sha = sha256OfFile(filePath);
  const source = readFileSync(filePath, 'utf-8');
  const capabilities = parseCapabilities(source);

  console.log(`About to trust: ${filePath}`);
  console.log(`  scope:    ${scope === 'repo' ? `repo:${repoRemoteUrl}` : scope}`);
  console.log(`  sha256:   ${sha}`);
  if (capabilities.length > 0) console.log(`  caps:     ${capabilities.join(', ')}`);
  if (options.note) console.log(`  note:     ${options.note}`);

  await confirmTrustOrAbort(options.yes ?? false);

  const current = readTrustFile(trustPath);
  const newEntry: TrustEntry = {
    path: filePath,
    sha256: sha,
    scope,
    repoRemoteUrl,
    trustedAt: new Date().toISOString(),
    note: options.note,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
  };
  // Replace any existing entry for the same path.
  const next: TrustFile = {
    version: 1,
    entries: [...current.entries.filter((e) => e.path !== filePath), newEntry],
  };
  writeTrustFile(trustPath, next);
  console.log(`Trusted ${filePath} → ${trustPath}`);
}

async function trustAction(target: string | undefined, options: TrustOptions): Promise<void> {
  const trustPath = defaultTrustPath();
  if (!target) return runTrustList(trustPath);
  await runTrustAdd(target, options, trustPath);
}

export function registerHookTrustCommand(parent: Command): void {
  parent
    .command('trust [path]')
    .description('Add a .ts hook file to the trust allowlist (or list current entries when [path] is omitted)')
    .option('--repo', 'Scope to current repo (pinned to remote.origin.url)')
    .option('--global', 'Scope globally (default)')
    .option('--team <name>', 'Scope to a specific team directory')
    .option('--note <text>', 'Free-form note saved with the entry')
    .option('--yes', 'Skip the interactive confirmation prompt')
    .action(trustAction);
}

/** @public Re-export defaultTrustPath for callers that want to display it. */
export { defaultTrustPath } from '../../hooks/trust.js';
/** @public Re-export readTrustFile for callers that want to inspect entries. */
export { readTrustFile } from '../../hooks/trust.js';
