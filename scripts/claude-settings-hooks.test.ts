import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The project-scope .claude/settings.json registers exactly one hook: the git-safety guard.
// Operator observability hooks (transcript shipping, poll guards) stay in user scope, never here.

const ROOT = join(import.meta.dir, '..');
const SETTINGS_PATH = join(ROOT, '.claude', 'settings.json');
const GIT_SAFETY = 'bash .claude/hooks/git-safety.sh';

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

/** Every registered hook, across every hook event, as `<event>: <type> <command>`. */
function registeredHooks(settings: unknown): string[] {
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (hooks === undefined) return [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return ['<hooks is not an object>'];
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      out.push(`${event}: <not a list>`);
      continue;
    }
    for (const group of groups as HookGroup[]) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : [];
      if (entries.length === 0) out.push(`${event}: <group without hooks>`);
      for (const entry of entries)
        out.push(`${event}: ${entry?.type ?? '<no type>'} ${entry?.command ?? '<no command>'}`);
    }
  }
  return out;
}

function onlyGitSafety(settings: unknown): boolean {
  const hooks = registeredHooks(settings);
  return hooks.length === 1 && hooks[0] === `PreToolUse: command ${GIT_SAFETY}`;
}

describe('.claude/settings.json hook registry', () => {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as {
    hooks: Record<string, HookGroup[]>;
  };

  test('the only registered hook is the git-safety guard', () => {
    expect(registeredHooks(settings)).toEqual([`PreToolUse: command ${GIT_SAFETY}`]);
    expect(onlyGitSafety(settings)).toBe(true);
  });

  test('a second hook under the same group fails the pin', () => {
    const probe = structuredClone(settings);
    probe.hooks.PreToolUse?.[0]?.hooks?.push({ type: 'command', command: 'bash hooks/bash-poll-guard.sh' });
    expect(onlyGitSafety(probe)).toBe(false);
  });

  test('a second hook under another event fails the pin', () => {
    const probe = structuredClone(settings);
    probe.hooks.Stop = [{ hooks: [{ type: 'command', command: 'bash hooks/claude-session-end.sh' }] }];
    expect(onlyGitSafety(probe)).toBe(false);
  });

  test('a replaced or emptied registry fails the pin', () => {
    const replaced = structuredClone(settings);
    replaced.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash other.sh' }] }];
    expect(onlyGitSafety(replaced)).toBe(false);
    expect(onlyGitSafety({})).toBe(false);
  });
});
