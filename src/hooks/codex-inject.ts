/**
 * Codex hook injection — writes TOML hook config into ~/.codex/config.toml
 * (or $CODEX_HOME/config.toml) so codex's hook system routes events through
 * `genie hook dispatch`.
 *
 * Mirror of `src/hooks/inject.ts` (claude flavor). Codex hooks fire on the
 * SAME events claude does (PreToolUse, PostToolUse, UserPromptSubmit,
 * SessionStart, Stop) and use a near-identical TOML/JSON wire shape — see
 * `~/workspace/repos/genie/.genie/brainstorms/codex-first-class-integration/DESIGN.md`
 * for the codex schema survey.
 *
 * Codex hook config example (the format we generate here):
 *
 *   [hooks]
 *   feature_enabled = true
 *
 *   [[hooks.UserPromptSubmit]]
 *   matcher = "*"
 *
 *   [[hooks.UserPromptSubmit.hooks]]
 *   type = "command"
 *   command = "genie hook dispatch"
 *   timeout = 15
 *
 * Once this is in place, codex agents become first-class:
 *   - Hook events flow through `genie hook dispatch` (the same shim claude
 *     uses) → runtime_events PG table → genie log/events surfaces light up
 *   - UserPromptSubmit handlers can return additionalContext to inject
 *     genie inbox messages into the codex turn (file-watcher equivalent —
 *     replaces tmux send-keys for engineer-driven sends)
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildDispatchCommand } from './inject.js';

const DISPATCH_TIMEOUT = 15;

/**
 * Codex hook events we route through the dispatcher. Same events claude
 * uses, minus claude-specific ones (TeammateIdle, TaskCompleted, etc.).
 *
 * Source: codex-rs/hooks/src/events/*.rs (PreToolUse, PostToolUse,
 * UserPromptSubmit, SessionStart, Stop, PermissionRequest).
 */
export const CODEX_DISPATCHED_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'PermissionRequest',
] as const;

function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function codexConfigPath(): string {
  return join(codexHomeDir(), 'config.toml');
}

function escapeTomlString(value: string): string {
  // TOML basic-string escapes — codex uses these literal-style.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the TOML fragment that wires codex hooks into `genie hook dispatch`.
 *
 * Returns the complete fragment as a string; merge logic is in
 * `injectCodexHooks` below so we can detect existing genie-injected entries
 * and avoid duplicate writes.
 */
function buildCodexHookFragment(): string {
  const cmd = buildDispatchCommand();
  const lines: string[] = [];
  lines.push('# === GENIE HOOK BRIDGE BEGIN ===');
  lines.push('# Auto-injected by `genie spawn ... --provider codex`. Do not edit by hand.');
  lines.push('# Removing this block disables codex → genie hook event delivery.');
  lines.push('[hooks]');
  lines.push('feature_enabled = true');
  lines.push('');
  for (const event of CODEX_DISPATCHED_EVENTS) {
    lines.push(`[[hooks.${event}]]`);
    lines.push('matcher = "*"');
    lines.push('');
    lines.push(`[[hooks.${event}.hooks]]`);
    lines.push('type = "command"');
    lines.push(`command = ${escapeTomlString(cmd)}`);
    lines.push(`timeout = ${DISPATCH_TIMEOUT}`);
    lines.push('');
  }
  lines.push('# === GENIE HOOK BRIDGE END ===');
  return lines.join('\n');
}

const BEGIN_MARKER = '# === GENIE HOOK BRIDGE BEGIN ===';
const END_MARKER = '# === GENIE HOOK BRIDGE END ===';

/**
 * Strip an existing GENIE HOOK BRIDGE block from a TOML config string.
 * Preserves all other content. Returns the trimmed config + a flag
 * indicating whether a block was found.
 */
function stripExistingBlock(content: string): { trimmed: string; existed: boolean } {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { trimmed: content, existed: false };
  }
  const before = content.slice(0, beginIdx).replace(/\s+$/, '');
  const after = content.slice(endIdx + END_MARKER.length).replace(/^\s+/, '');
  const joined = before && after ? `${before}\n\n${after}\n` : before ? `${before}\n` : after ? `${after}` : '';
  return { trimmed: joined, existed: true };
}

/**
 * Inject the genie hook bridge into the codex config TOML.
 *
 * - Idempotent: if the existing block matches what we'd write, no-op.
 * - Preserves all other TOML content (model, sandbox, MCP config, etc.).
 * - Atomically replaces an old block if the dispatch command changed
 *   (e.g. `genie hook dispatch` path moved between bun and source installs).
 *
 * Returns `true` if the file was modified, `false` if no change needed.
 */
export async function injectCodexHooks(): Promise<boolean> {
  const path = codexConfigPath();
  let existing = '';
  if (existsSync(path)) {
    try {
      existing = await readFile(path, 'utf-8');
    } catch {
      existing = '';
    }
  }

  const desired = buildCodexHookFragment();
  const { trimmed, existed } = stripExistingBlock(existing);

  // If a block existed AND the rest of the file plus the same desired
  // block reconstructs the original, no write is needed.
  const candidate = trimmed ? `${trimmed.replace(/\s+$/, '')}\n\n${desired}\n` : `${desired}\n`;
  if (existing.trim() === candidate.trim()) return false;

  await mkdir(codexHomeDir(), { recursive: true });
  await writeFile(path, candidate);
  // Semantics: "modified or freshly added"; existed is captured for any
  // future caller that wants to distinguish "first install" from "update".
  void existed;
  return true;
}

/**
 * Check whether the genie hook bridge block is present in the codex config.
 * Used by tests + diagnostics.
 */
export async function codexHooksInjected(): Promise<boolean> {
  const path = codexConfigPath();
  if (!existsSync(path)) return false;
  try {
    const content = await readFile(path, 'utf-8');
    return content.includes(BEGIN_MARKER) && content.includes(END_MARKER);
  } catch {
    return false;
  }
}
