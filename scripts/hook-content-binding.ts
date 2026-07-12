#!/usr/bin/env bun

/** Bind trusted Codex hook definitions to the exact launcher bytes they run. */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
export const CODEX_HOOK_MANIFEST = join(ROOT, 'plugins', 'genie', 'hooks', 'codex-hooks.json');
export const CODEX_HOOK_LAUNCHER = join(ROOT, 'plugins', 'genie', 'scripts', 'dispatch-runtime.cjs');
export const CODEX_LAUNCHER_CONTRACT = 'genie-codex-dispatch-v1';

interface CommandHook {
  command?: unknown;
  commandWindows?: unknown;
}

interface HookGroup {
  hooks?: unknown;
}

interface HookManifest {
  hooks?: Record<string, unknown>;
}

const COMMAND_PATTERN =
  /^(node .+dispatch-runtime\.cjs" codex (PreToolUse|PermissionRequest))(?: --launcher-contract ([^\s]+) --launcher-sha256 ([a-f0-9]{64}))?$/;

export function launcherSha256(launcherPath = CODEX_HOOK_LAUNCHER): string {
  const stat = lstatSync(launcherPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Codex hook launcher must be a physical file: ${launcherPath}`);
  }
  return createHash('sha256').update(readFileSync(launcherPath)).digest('hex');
}

function commandHooks(manifest: HookManifest): Array<{ event: string; hook: CommandHook }> {
  const found: Array<{ event: string; hook: CommandHook }> = [];
  for (const [event, groups] of Object.entries(manifest.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as HookGroup[]) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks as CommandHook[]) {
        if (
          (typeof hook.command === 'string' && hook.command.includes('dispatch-runtime.cjs')) ||
          (typeof hook.commandWindows === 'string' && hook.commandWindows.includes('dispatch-runtime.cjs'))
        ) {
          found.push({ event, hook });
        }
      }
    }
  }
  return found;
}

function parseManifest(path: string): HookManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Codex hook manifest must be a JSON object: ${path}`);
  }
  return value as HookManifest;
}

function boundCommand(command: string, digest: string, expectedEvent: string): string {
  const match = command.match(COMMAND_PATTERN);
  if (!match || match[2] !== expectedEvent) {
    throw new Error(`unexpected Codex dispatch command for ${expectedEvent}: ${command}`);
  }
  return `${match[1]} --launcher-contract ${CODEX_LAUNCHER_CONTRACT} --launcher-sha256 ${digest}`;
}

export function renderBoundManifest(manifestPath = CODEX_HOOK_MANIFEST, launcherPath = CODEX_HOOK_LAUNCHER): string {
  const manifest = parseManifest(manifestPath);
  const digest = launcherSha256(launcherPath);
  const hooks = commandHooks(manifest);
  if (
    hooks.length !== 2 ||
    hooks
      .map(({ event }) => event)
      .sort()
      .join(',') !== 'PermissionRequest,PreToolUse'
  ) {
    throw new Error('Codex hook manifest must contain exactly one H4 and one H6 dispatch launcher');
  }
  for (const { event, hook } of hooks) {
    if (typeof hook.command !== 'string' || typeof hook.commandWindows !== 'string') {
      throw new Error(`${event} dispatch launcher must define command and commandWindows`);
    }
    hook.command = boundCommand(hook.command, digest, event);
    hook.commandWindows = boundCommand(hook.commandWindows, digest, event);
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function assertHookContentBinding(manifestPath = CODEX_HOOK_MANIFEST, launcherPath = CODEX_HOOK_LAUNCHER): void {
  const actual = readFileSync(manifestPath, 'utf8');
  const expected = renderBoundManifest(manifestPath, launcherPath);
  if (actual !== expected) {
    throw new Error(
      'Codex hook launcher binding drift: run `bun scripts/hook-content-binding.ts --write`, then review the changed hook definitions with `/hooks`.',
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('usage: bun scripts/hook-content-binding.ts [--check|--write]');
  }
  if (args[0] === '--write') {
    writeFileSync(CODEX_HOOK_MANIFEST, renderBoundManifest());
    console.log('hook-content-binding: updated Codex H4/H6 launcher digests');
    return;
  }
  assertHookContentBinding();
  console.log('hook-content-binding: OK');
}

if (import.meta.main) await main();
