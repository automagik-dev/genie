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
import { DISPATCHED_EVENTS } from './types.js';

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

function buildDispatchCommand(): string {
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

  for (const event of DISPATCHED_EVENTS) {
    hooks[event] = [
      {
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

/**
 * Inject genie hook dispatch into a settings.json file.
 * Preserves existing non-hook settings. Overwrites existing hooks.
 */
async function injectIntoFile(settingsPath: string): Promise<boolean> {
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // Corrupted or empty — start fresh
    }
  }

  const hooksConfig = buildHooksConfig();

  // Check if already injected (avoid unnecessary writes)
  const existingHooks = settings.hooks as HooksConfig | undefined;
  if (existingHooks) {
    const allInjected = DISPATCHED_EVENTS.every((event) => {
      const existing = existingHooks[event];
      const desiredCommand = hooksConfig[event][0].hooks[0].command;
      return existing?.some((m) => m.hooks?.some((h) => h.command === desiredCommand));
    });
    if (allInjected) {
      return false; // already injected
    }
  }

  // Merge genie hook entries into existing hooks (preserve user-defined hooks)
  const mergedHooks: HooksConfig = existingHooks ? { ...existingHooks } : {};
  for (const event of DISPATCHED_EVENTS) {
    const genieEntry = hooksConfig[event][0];
    const existingEntries = (mergedHooks[event] ?? []).map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks?.map((hook) =>
        isGenieDispatchCommand(hook.command)
          ? { ...hook, command: genieEntry.hooks[0].command, timeout: DISPATCH_TIMEOUT }
          : hook,
      ),
    }));
    // Only add if not already present
    const alreadyPresent = existingEntries.some((m) => m.hooks?.some((h) => isGenieDispatchCommand(h.command)));
    if (!alreadyPresent) {
      mergedHooks[event] = [...existingEntries, genieEntry];
    } else {
      mergedHooks[event] = existingEntries;
    }
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
