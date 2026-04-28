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
import { DISPATCHED_EVENTS, DISPATCHED_EVENT_MATCHERS } from './types.js';

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

export function buildDispatchCommand(): string {
  const entrypoint = fileURLToPath(new URL('../genie.ts', import.meta.url));
  if (!existsSync(entrypoint)) return 'genie hook dispatch';

  const bun = process.execPath || 'bun';
  return `${escapeShellArg(bun)} run ${escapeShellArg(entrypoint)} hook dispatch`;
}

function isGenieDispatchCommand(command: string | undefined): boolean {
  return typeof command === 'string' && /(?:^|\s)hook\s+dispatch(?:\s|$)/.test(command);
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

  if (
    existingHooks &&
    allEventsAlreadyInjected(existingHooks, hooksConfig) &&
    hasNoObsoleteGenieEntries(existingHooks)
  ) {
    return false; // already injected and clean — nothing to do
  }

  const mergedHooks: HooksConfig = existingHooks ? { ...existingHooks } : {};
  pruneObsoleteGenieEntries(mergedHooks);
  for (const event of DISPATCHED_EVENTS) {
    upsertGenieEntry(mergedHooks, event, hooksConfig[event][0]);
  }
  settings.hooks = mergedHooks;

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
