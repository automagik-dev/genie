/**
 * Hook Injection — writes CC hook config into team settings.json
 *
 * Called during `genie spawn` to ensure every spawned agent
 * routes its hook events through `genie hook dispatch`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBaselineAllowedTools } from '../lib/claude-settings.js';
import { DISPATCHED_EVENTS, DISPATCHED_EVENT_MATCHERS } from './types.js';

// Re-export `homedir` symbol so the binary-candidates resolver below has a
// stable import target — keeping the existing `homedir()` callsite intact in
// `claudeConfigDir()`.

interface HookEntry {
  type: string;
  command: string;
  timeout: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

type HooksConfig = Record<string, HookMatcher[]>;

const DISPATCH_TIMEOUT = 15; // seconds — auto-spawn can take up to 10s

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Candidate install locations for the compiled `genie-hook` binary, in
 * preference order. Found at the first path that exists; falls back to the
 * bun-based command when none resolves.
 */
function compiledBinaryCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.GENIE_HOOK_BIN) candidates.push(process.env.GENIE_HOOK_BIN);
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  candidates.push(join(home, 'bin', 'genie-hook'));
  // Local-dev convenience: fall back to a build artifact under the repo root.
  try {
    const repoBin = fileURLToPath(new URL('../../dist/genie-hook', import.meta.url));
    candidates.push(repoBin);
  } catch {
    // resolver failed — repo layout missing, ignore
  }
  return candidates;
}

export function buildDispatchCommand(): string {
  // Prefer the compiled `genie-hook` binary when available — single-process
  // invocation, sub-millisecond cold start, talks to ~/.genie/hook.sock.
  for (const candidate of compiledBinaryCandidates()) {
    if (existsSync(candidate)) return escapeShellArg(candidate);
  }

  // Dev/test/CI fallback: invoke the bundled bun source. Never fails CC even
  // if the daemon socket is missing — `genie hook dispatch` runs in-process.
  const entrypoint = fileURLToPath(new URL('../genie.ts', import.meta.url));
  if (!existsSync(entrypoint)) return 'genie hook dispatch';

  const bun = process.execPath || 'bun';
  return `${escapeShellArg(bun)} run ${escapeShellArg(entrypoint)} hook dispatch`;
}

function isGenieDispatchCommand(command: string | undefined): boolean {
  if (typeof command !== 'string') return false;
  // Legacy bun-fork or literal `genie hook dispatch`:
  if (/(?:^|\s)hook\s+dispatch(?:\s|$)/.test(command)) return true;
  // Compiled binary path — bare or shell-quoted: `genie-hook`, `/path/to/genie-hook`,
  // `'/path/to/genie-hook'`, etc. Anchored at a path-or-quote boundary so substrings
  // like `genie-hook-helper` don't false-positive.
  if (/(?:^|[/\\'"])genie-hook(?:['"]|\s|$)/.test(command)) return true;
  return false;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function teamSettingsPath(teamName: string): string {
  const sanitized = teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return join(claudeConfigDir(), 'teams', sanitized, 'settings.json');
}

function buildHooksConfig(): HooksConfig {
  const hooks: HooksConfig = {};
  const dispatchCommand = buildDispatchCommand();

  // Mac-CPU fix D — wire each event with its declared matcher.
  // Events absent from DISPATCHED_EVENT_MATCHERS are NOT wired (avoids
  // useless `bun` cold-starts for events with zero handlers).
  for (const [event, matcher] of Object.entries(DISPATCHED_EVENT_MATCHERS)) {
    hooks[event] = [
      {
        matcher,
        hooks: [
          {
            type: 'command',
            command: dispatchCommand,
            timeout: DISPATCH_TIMEOUT,
          },
        ],
      },
    ];
  }

  return hooks;
}

/** Read existing settings (or start fresh on missing/corrupt). */
async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

/** True if every dispatched event already matches both desired matcher AND command. */
function allEventsAlreadyInjected(existingHooks: HooksConfig, hooksConfig: HooksConfig): boolean {
  return DISPATCHED_EVENTS.every((event) => {
    const existing = existingHooks[event];
    const desiredCommand = hooksConfig[event][0].hooks[0].command;
    const desiredMatcher = hooksConfig[event][0].matcher;
    return existing?.some((m) => m.matcher === desiredMatcher && m.hooks?.some((h) => h.command === desiredCommand));
  });
}

/** True if no obsolete events (removed from DISPATCHED_EVENT_MATCHERS) still carry a genie entry. */
function hasNoObsoleteGenieEntries(existingHooks: HooksConfig): boolean {
  return Object.keys(existingHooks).every((event) => {
    if (DISPATCHED_EVENTS.includes(event as never)) return true;
    const entries = existingHooks[event];
    return !entries?.some((m) => m.hooks?.some((h) => isGenieDispatchCommand(h.command)));
  });
}

/**
 * Mac-CPU fix D — prune genie-dispatch entries from events that are no
 * longer in DISPATCHED_EVENT_MATCHERS (SessionStart/SessionEnd/TeammateIdle/
 * TaskCompleted). User-defined hooks under those events are preserved.
 */
function pruneObsoleteGenieEntries(mergedHooks: HooksConfig): void {
  for (const event of Object.keys(mergedHooks)) {
    if (DISPATCHED_EVENTS.includes(event as never)) continue;
    const cleaned = (mergedHooks[event] ?? [])
      .map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks?.filter((hook) => !isGenieDispatchCommand(hook.command)),
      }))
      .filter((matcher) => (matcher.hooks?.length ?? 0) > 0);
    if (cleaned.length === 0) {
      delete mergedHooks[event];
    } else {
      mergedHooks[event] = cleaned;
    }
  }
}

/**
 * Refresh existing matcher entries: any matcher with a genie-dispatch hook
 * inside it gets its `matcher` field rewritten to the desired value (so
 * PostToolUse '*' → 'SendMessage' on next inject) and its command + timeout
 * refreshed.
 */
function refreshMatcherEntries(entries: HookMatcher[], genieEntry: HookMatcher): HookMatcher[] {
  return entries.map((matcher) => {
    const hasGenieHook = matcher.hooks?.some((h) => isGenieDispatchCommand(h.command));
    return {
      ...matcher,
      matcher: hasGenieHook ? genieEntry.matcher : matcher.matcher,
      hooks: matcher.hooks?.map((hook) =>
        isGenieDispatchCommand(hook.command)
          ? { ...hook, command: genieEntry.hooks[0].command, timeout: DISPATCH_TIMEOUT }
          : hook,
      ),
    };
  });
}

/** Add or refresh the genie entry for one event in-place on mergedHooks. */
function upsertGenieEntry(mergedHooks: HooksConfig, event: string, genieEntry: HookMatcher): void {
  const existingEntries = refreshMatcherEntries(mergedHooks[event] ?? [], genieEntry);
  const alreadyPresent = existingEntries.some((m) => m.hooks?.some((h) => isGenieDispatchCommand(h.command)));
  mergedHooks[event] = alreadyPresent ? existingEntries : [...existingEntries, genieEntry];
}

/**
 * Inject genie hook dispatch into a settings.json file.
 * Preserves existing non-hook settings. Overwrites existing hooks.
 */
async function injectIntoFile(settingsPath: string): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  const hooksConfig = buildHooksConfig();
  const existingHooks = settings.hooks as HooksConfig | undefined;

  const hooksAlreadyClean =
    !!existingHooks && allEventsAlreadyInjected(existingHooks, hooksConfig) && hasNoObsoleteGenieEntries(existingHooks);

  // Seed GENIE_BASELINE_ALLOWED_TOOLS (currently `AskUserQuestion`) into the
  // team's settings.json. Without this, CC team mode reads team settings with
  // no permissions block and routes baseline tool calls through the team-lead
  // approval queue instead of surfacing them to the human — closes the team-
  // side gap left after #1688's global-only fix in `ensureClaudeSettingsSafe`.
  const permissionsChanged = ensureBaselineAllowedTools(settings);

  if (hooksAlreadyClean && !permissionsChanged) {
    return false; // already injected and clean — nothing to do
  }

  if (!hooksAlreadyClean) {
    const mergedHooks: HooksConfig = existingHooks ? { ...existingHooks } : {};
    pruneObsoleteGenieEntries(mergedHooks);
    for (const event of DISPATCHED_EVENTS) {
      upsertGenieEntry(mergedHooks, event, hooksConfig[event][0]);
    }
    settings.hooks = mergedHooks;
  }

  // Ensure parent directory exists
  const dir = join(settingsPath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  return true;
}

/**
 * Inject hook dispatch config into a team's settings.json.
 * Called automatically during `genie spawn`.
 */
export async function injectTeamHooks(teamName: string): Promise<boolean> {
  const path = teamSettingsPath(teamName);
  return injectIntoFile(path);
}

/**
 * Check if a team has hook dispatch configured.
 */
export async function isTeamHooked(teamName: string): Promise<boolean> {
  const path = teamSettingsPath(teamName);
  if (!existsSync(path)) return false;

  try {
    const content = await readFile(path, 'utf-8');
    const settings = JSON.parse(content);
    const hooks = settings.hooks as HooksConfig | undefined;
    if (!hooks) return false;

    // Check ALL dispatched events, not just the first one
    return DISPATCHED_EVENTS.every((event) => {
      const existing = hooks[event];
      return existing?.some((m) => m.hooks?.some((h) => isGenieDispatchCommand(h.command)));
    });
  } catch {
    return false;
  }
}
