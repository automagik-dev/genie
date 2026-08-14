#!/usr/bin/env bun

/** Bind trusted hook definitions to the exact launcher bytes they run. */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
export const CODEX_HOOK_MANIFEST = join(ROOT, 'plugins', 'genie', 'hooks', 'codex-hooks.json');
export const CLAUDE_HOOK_MANIFEST = join(ROOT, 'plugins', 'genie', 'hooks', 'hooks.json');
export const KIMI_HOOK_MANIFEST = join(ROOT, 'plugins', 'genie', '.kimi-plugin', 'plugin.json');
export const CODEX_HOOK_LAUNCHER = join(ROOT, 'plugins', 'genie', 'scripts', 'dispatch-runtime.cjs');
export const CODEX_LAUNCHER_CONTRACT = 'genie-codex-dispatch-v1';
/** The Claude + Kimi invocations run the same shared launcher as `claude`;
 *  the contract identifier is distinct so a Codex/Claude definition swap
 *  cannot satisfy the pin. */
export const CLAUDE_LAUNCHER_CONTRACT = 'genie-claude-dispatch-v1';

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

interface KimiHookEntry {
  event?: unknown;
  command?: unknown;
}

interface KimiManifest {
  hooks?: unknown;
}

const BINDING_SUFFIX = '(?: --launcher-contract [^\\s]+ --launcher-sha256 [a-f0-9]{64})?';
const CODEX_POSIX_COMMAND_PATTERN = new RegExp(
  `^(node "\\$\\{PLUGIN_ROOT\\}/scripts/dispatch-runtime\\.cjs" codex (PreToolUse|PermissionRequest))${BINDING_SUFFIX}$`,
);
const CODEX_WINDOWS_COMMAND_PATTERN = new RegExp(
  `^(node "%PLUGIN_ROOT%\\\\scripts\\\\dispatch-runtime\\.cjs" codex (PreToolUse|PermissionRequest))${BINDING_SUFFIX}$`,
);

/**
 * The Claude dispatch invocation carries no event-name argument (`codex` is
 * followed by the event; `claude` reads the event from the payload). The
 * whole-command pattern accepts the pinned suffix when present and rejects
 * any other trailing argument shape.
 */
const CLAUDE_POSIX_COMMAND_PATTERN = new RegExp(
  `^node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/dispatch-runtime\\.cjs" claude${BINDING_SUFFIX}$`,
);
const CLAUDE_WINDOWS_COMMAND_PATTERN = new RegExp(
  `^node "%CLAUDE_PLUGIN_ROOT%\\\\scripts\\\\dispatch-runtime\\.cjs" claude${BINDING_SUFFIX}$`,
);
const KIMI_COMMAND_PATTERN = new RegExp(
  `^node "\\$KIMI_PLUGIN_ROOT/scripts/dispatch-runtime\\.cjs" claude${BINDING_SUFFIX}$`,
);

export function launcherSha256(launcherPath = CODEX_HOOK_LAUNCHER): string {
  const stat = lstatSync(launcherPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`hook launcher must be a physical file: ${launcherPath}`);
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

function kimiCommandHooks(manifest: KimiManifest): Array<{ event: string; hook: CommandHook }> {
  const found: Array<{ event: string; hook: CommandHook }> = [];
  if (!Array.isArray(manifest.hooks)) return found;
  for (const entry of manifest.hooks as KimiHookEntry[]) {
    if (typeof entry.command === 'string' && entry.command.includes('dispatch-runtime.cjs')) {
      found.push({
        event: typeof entry.event === 'string' ? entry.event : '<missing-event>',
        hook: { command: entry.command },
      });
    }
  }
  return found;
}

function parseManifest(path: string): HookManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`hook manifest must be a JSON object: ${path}`);
  }
  return value as HookManifest;
}

function boundCodexCommand(command: string, digest: string, expectedEvent: string, windows = false): string {
  const match = command.match(windows ? CODEX_WINDOWS_COMMAND_PATTERN : CODEX_POSIX_COMMAND_PATTERN);
  if (!match || match[2] !== expectedEvent) {
    throw new Error(`unexpected Codex dispatch command for ${expectedEvent}: ${command}`);
  }
  return `${match[1]} --launcher-contract ${CODEX_LAUNCHER_CONTRACT} --launcher-sha256 ${digest}`;
}

function boundClaudeCommand(command: string, digest: string, pattern: RegExp): string {
  if (!pattern.test(command)) {
    throw new Error(`unexpected Claude dispatch command: ${command}`);
  }
  const base = command.replace(/\s+--launcher-contract\s+\S+\s+--launcher-sha256\s+[a-f0-9]{64}$/, '');
  return `${base} --launcher-contract ${CLAUDE_LAUNCHER_CONTRACT} --launcher-sha256 ${digest}`;
}

function assertSingleDispatchLauncher(
  hooks: Array<{ event: string; hook: CommandHook }>,
  label: string,
): { event: string; hook: CommandHook } {
  if (hooks.length !== 1 || hooks[0].event !== 'PreToolUse') {
    throw new Error(`${label} must contain exactly one dispatch launcher (PreToolUse)`);
  }
  return hooks[0];
}

const DRIFT_HINT =
  'run `bun scripts/hook-content-binding.ts --write`, then review the changed hook definitions with `/hooks`.';

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
    hook.command = boundCodexCommand(hook.command, digest, event);
    hook.commandWindows = boundCodexCommand(hook.commandWindows, digest, event, true);
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function assertHookContentBinding(manifestPath = CODEX_HOOK_MANIFEST, launcherPath = CODEX_HOOK_LAUNCHER): void {
  const actual = readFileSync(manifestPath, 'utf8');
  const expected = renderBoundManifest(manifestPath, launcherPath);
  if (actual !== expected) {
    throw new Error(`Codex hook launcher binding drift: ${DRIFT_HINT}`);
  }
}

export function assertClaudeHookContentBinding(
  manifestPath = CLAUDE_HOOK_MANIFEST,
  launcherPath = CODEX_HOOK_LAUNCHER,
): void {
  const manifest = parseManifest(manifestPath);
  const digest = launcherSha256(launcherPath);
  const { hook } = assertSingleDispatchLauncher(commandHooks(manifest), 'Claude hook manifest');
  if (typeof hook.command !== 'string' || typeof hook.commandWindows !== 'string') {
    throw new Error('Claude PreToolUse dispatch launcher must define command and commandWindows');
  }
  if (
    hook.command !== boundClaudeCommand(hook.command, digest, CLAUDE_POSIX_COMMAND_PATTERN) ||
    hook.commandWindows !== boundClaudeCommand(hook.commandWindows, digest, CLAUDE_WINDOWS_COMMAND_PATTERN)
  ) {
    throw new Error(`Claude hook launcher binding drift: ${DRIFT_HINT}`);
  }
}

export function assertKimiHookContentBinding(
  manifestPath = KIMI_HOOK_MANIFEST,
  launcherPath = CODEX_HOOK_LAUNCHER,
): void {
  const manifest = parseManifest(manifestPath);
  const digest = launcherSha256(launcherPath);
  const { hook } = assertSingleDispatchLauncher(kimiCommandHooks(manifest), 'Kimi plugin manifest');
  if (typeof hook.command !== 'string') {
    throw new Error('Kimi PreToolUse dispatch launcher must define a command');
  }
  if (hook.command !== boundClaudeCommand(hook.command, digest, KIMI_COMMAND_PATTERN)) {
    throw new Error(`Kimi hook launcher binding drift: ${DRIFT_HINT}`);
  }
}

/**
 * Rebind the claude-runtime dispatch commands in place (surgical textual
 * replacement of the JSON-escaped values) so the manifests' hand-tuned
 * formatting survives — neither the Claude hooks.json nor the Kimi
 * plugin.json is canonical `JSON.stringify` output. Returns whether the
 * file changed.
 */
function writeClaudeBinding(manifestPath = CLAUDE_HOOK_MANIFEST, launcherPath = CODEX_HOOK_LAUNCHER): boolean {
  const manifest = parseManifest(manifestPath);
  const digest = launcherSha256(launcherPath);
  const { hook } = assertSingleDispatchLauncher(commandHooks(manifest), 'Claude hook manifest');
  if (typeof hook.command !== 'string' || typeof hook.commandWindows !== 'string') {
    throw new Error('Claude PreToolUse dispatch launcher must define command and commandWindows');
  }
  const next = boundClaudeCommand(hook.command, digest, CLAUDE_POSIX_COMMAND_PATTERN);
  const nextWindows = boundClaudeCommand(hook.commandWindows, digest, CLAUDE_WINDOWS_COMMAND_PATTERN);
  if (hook.command === next && hook.commandWindows === nextWindows) return false;
  let raw = readFileSync(manifestPath, 'utf8');
  raw = raw.replace(JSON.stringify(hook.command), JSON.stringify(next));
  raw = raw.replace(JSON.stringify(hook.commandWindows), JSON.stringify(nextWindows));
  writeFileSync(manifestPath, raw);
  return true;
}

function writeKimiBinding(manifestPath = KIMI_HOOK_MANIFEST, launcherPath = CODEX_HOOK_LAUNCHER): boolean {
  const manifest = parseManifest(manifestPath);
  const digest = launcherSha256(launcherPath);
  const { hook } = assertSingleDispatchLauncher(kimiCommandHooks(manifest), 'Kimi plugin manifest');
  if (typeof hook.command !== 'string') {
    throw new Error('Kimi PreToolUse dispatch launcher must define a command');
  }
  const next = boundClaudeCommand(hook.command, digest, KIMI_COMMAND_PATTERN);
  if (hook.command === next) return false;
  let raw = readFileSync(manifestPath, 'utf8');
  raw = raw.replace(JSON.stringify(hook.command), JSON.stringify(next));
  writeFileSync(manifestPath, raw);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check' && args[0] !== '--write')) {
    throw new Error('usage: bun scripts/hook-content-binding.ts [--check|--write]');
  }
  if (args[0] === '--write') {
    writeFileSync(CODEX_HOOK_MANIFEST, renderBoundManifest());
    const updated = ['Codex H4/H6 launcher digests'];
    if (writeClaudeBinding()) updated.push('Claude dispatch binding');
    if (writeKimiBinding()) updated.push('Kimi dispatch binding');
    console.log(`hook-content-binding: updated ${updated.join(' + ')}`);
    return;
  }
  assertHookContentBinding();
  assertClaudeHookContentBinding();
  assertKimiHookContentBinding();
  console.log('hook-content-binding: OK');
}

if (import.meta.main) await main();
