/**
 * Hook Injection — writes CC hook config into team settings.json
 *
 * Called during `genie agent spawn` to ensure every spawned agent
 * routes its hook events through `genie hook dispatch`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

const DISPATCH_COMMAND = 'genie hook dispatch';
const DISPATCH_TIMEOUT = 15; // seconds — auto-spawn can take up to 10s

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function teamSettingsPath(teamName: string): string {
  const sanitized = teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return join(claudeConfigDir(), 'teams', sanitized, 'settings.json');
}

function buildHooksConfig(): HooksConfig {
  const hooks: HooksConfig = {};

  for (const event of DISPATCHED_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: DISPATCH_COMMAND,
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
    const firstEvent = DISPATCHED_EVENTS[0];
    const existing = existingHooks[firstEvent];
    if (existing?.[0]?.hooks?.[0]?.command === DISPATCH_COMMAND) {
      return false; // already injected
    }
  }

  settings.hooks = hooksConfig;

  // Ensure parent directory exists
  const dir = join(settingsPath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  return true;
}

/**
 * Inject hook dispatch config into a team's settings.json.
 * Called automatically during `genie agent spawn`.
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

    const firstEvent = DISPATCHED_EVENTS[0];
    const existing = hooks[firstEvent];
    return existing?.[0]?.hooks?.[0]?.command === DISPATCH_COMMAND;
  } catch {
    return false;
  }
}
