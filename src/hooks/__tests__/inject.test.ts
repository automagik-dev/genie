import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _deps as injectDeps, injectTeamHooks, isTeamHooked } from '../inject.js';
import { DISPATCHED_EVENTS, DISPATCHED_EVENT_MATCHERS } from '../types.js';

interface CapturedAuditEvent {
  entityType: string;
  entityId: string;
  eventType: string;
  actor: string | null;
  details: Record<string, unknown>;
}

/**
 * Install a mock audit-event sink for the duration of a test. Returns the
 * array that captures events; callers should reset injectDeps.emitAuditEvent
 * in afterEach (handled by the outer suite's beforeEach/afterEach).
 */
function captureInjectAudit(): CapturedAuditEvent[] {
  const events: CapturedAuditEvent[] = [];
  injectDeps.emitAuditEvent = async (entityType, entityId, eventType, actor, details) => {
    events.push({ entityType, entityId, eventType, actor, details });
  };
  return events;
}

/**
 * True if `command` is a recognizable genie hook-dispatch command — either the
 * legacy bun-fork form (`bun run .../src/genie.ts hook dispatch`) or the new
 * compiled-binary form (`'.../genie-hook'`). Mirrors the production matcher in
 * `inject.ts::isGenieDispatchCommand`. Tests should assert against this shape
 * rather than a specific form so they pass on machines where the postinstall
 * binary is or isn't present.
 */
function isRecognizedDispatchCommand(command: string): boolean {
  if (command.includes('hook dispatch') && command.includes('src/genie.ts')) return true;
  if (/(?:^|[/\\'"])genie-hook(?:['"]|\s|$)/.test(command)) return true;
  return false;
}

describe('hook injection', () => {
  const testDir = join(tmpdir(), `genie-hook-test-${Date.now()}`);
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.GENIE_HOME;
  const originalHookBin = process.env.GENIE_HOOK_BIN;

  beforeEach(async () => {
    process.env.CLAUDE_CONFIG_DIR = testDir;
    // Pin GENIE_HOME to a tmp dir so the inject layer's compiled-binary
    // candidate (~/.genie/bin/genie-hook) doesn't resolve to a real binary
    // produced by postinstall on the CI runner. These tests assert the
    // bun-fork fallback shape; binary resolution is covered separately.
    process.env.GENIE_HOME = join(testDir, 'genie-home');
    process.env.GENIE_HOOK_BIN = join(testDir, 'genie-home', 'no-such-binary');
    await mkdir(testDir, { recursive: true });
    // Default mock — no-op audit emitter so we don't reach PG in unit tests.
    // Tests that want to assert events install their own via captureInjectAudit().
    injectDeps.emitAuditEvent = async () => {};
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    } else {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    }
    if (originalHome === undefined) process.env.GENIE_HOME = undefined;
    else process.env.GENIE_HOME = originalHome;
    if (originalHookBin === undefined) process.env.GENIE_HOOK_BIN = undefined;
    else process.env.GENIE_HOOK_BIN = originalHookBin;
    injectDeps.emitAuditEvent = null;
    await rm(testDir, { recursive: true, force: true });
  });

  test('injectTeamHooks creates settings.json with hooks', async () => {
    const result = await injectTeamHooks('test-team');
    expect(result).toBe(true);

    const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();

    for (const event of DISPATCHED_EVENTS) {
      expect(settings.hooks[event]).toBeDefined();
      expect(isRecognizedDispatchCommand(settings.hooks[event][0].hooks[0].command)).toBe(true);
    }
  });

  test('injectTeamHooks is idempotent', async () => {
    await injectTeamHooks('test-team');
    const result = await injectTeamHooks('test-team');
    expect(result).toBe(false); // already injected
  });

  test('injectTeamHooks preserves existing settings + appends baseline permissions', async () => {
    const teamDir = join(testDir, 'teams', 'test-team');
    await mkdir(teamDir, { recursive: true });

    const settingsPath = join(teamDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(*)'] },
        customField: 'preserved',
      }),
    );

    await injectTeamHooks('test-team');

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    // Pre-existing entries preserved + GENIE_BASELINE_ALLOWED_TOOLS appended.
    expect(settings.permissions.allow).toEqual(['Bash(*)', 'AskUserQuestion']);
    expect(settings.customField).toBe('preserved');
    expect(settings.hooks).toBeDefined();
  });

  describe('baseline permissions seeding (#1688 team-side gap)', () => {
    test('seeds AskUserQuestion when team settings has no permissions block', async () => {
      await injectTeamHooks('test-team');

      const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

      expect(settings.permissions).toBeDefined();
      expect(settings.permissions.allow).toContain('AskUserQuestion');
    });

    test('does not duplicate AskUserQuestion across re-injections', async () => {
      await injectTeamHooks('test-team');
      await injectTeamHooks('test-team');
      await injectTeamHooks('test-team');

      const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

      const askEntries = (settings.permissions.allow as string[]).filter((t) => t === 'AskUserQuestion');
      expect(askEntries).toHaveLength(1);
    });

    test('seeds baseline even when hooks are already clean (write triggered by perms-change alone)', async () => {
      // First inject: hooks fresh + baseline written. Then DELETE permissions
      // block to simulate an upgrade path where a user (or older genie) wrote
      // hooks but never seeded permissions. Re-inject must detect the missing
      // baseline and write it back, even though hooks are already up-to-date.
      await injectTeamHooks('test-team');
      const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
      const after = JSON.parse(await readFile(settingsPath, 'utf-8'));
      after.permissions = undefined;
      await writeFile(settingsPath, JSON.stringify(after));

      const result = await injectTeamHooks('test-team');
      expect(result).toBe(true); // a write happened (baseline seed)

      const reseeded = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(reseeded.permissions.allow).toContain('AskUserQuestion');
    });

    test('idempotent — second call with baseline already present returns false', async () => {
      await injectTeamHooks('test-team');
      const result = await injectTeamHooks('test-team');
      expect(result).toBe(false);
    });
  });

  // Bug 2 (#1710 Group 2) — triplet dedup hardening + audit-event emission.
  //
  // Why: prior dedup keyed on `isGenieDispatchCommand(h.command)` heuristics
  // and did not catch path-drifted entries. On the filing host this produced
  // 65/82 team `settings.json` files with 2-7× duplicate `*`-matcher entries.
  // The hardened logic (a) matches the canonical `{matcher, command, timeout}`
  // triplet exactly for the idempotent fast path AND (b) collapses any genie-
  // shape entries (current/historical command paths) to the single canonical
  // entry on drift detection. Each branch emits a corresponding audit event.
  describe('Bug 2 (#1710 Group 2) — triplet dedup + drift-collapse audit events', () => {
    test('spawn-twice fixture: exactly one matching hook entry, second emits dedup.skip', async () => {
      // First inject is fresh — should emit `settings.hook.injected`.
      const events = captureInjectAudit();
      await injectTeamHooks('test-team');

      const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
      const afterFirst = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(afterFirst.hooks.PreToolUse).toHaveLength(1);
      expect(afterFirst.hooks.PostToolUse).toHaveLength(1);
      const firstInjectedEvents = events.filter((e) => e.eventType === 'settings.hook.injected');
      expect(firstInjectedEvents).toHaveLength(1);
      expect(firstInjectedEvents[0].entityId).toBe(settingsPath);

      // Second inject is identical — must emit `dedup.skip`, no new entries.
      events.length = 0;
      const result = await injectTeamHooks('test-team');
      expect(result).toBe(false);

      const afterSecond = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(afterSecond.hooks.PreToolUse).toHaveLength(1);
      expect(afterSecond.hooks.PostToolUse).toHaveLength(1);
      const skipEvents = events.filter((e) => e.eventType === 'settings.hook.dedup.skip');
      expect(skipEvents).toHaveLength(1);
      expect(skipEvents[0].entityId).toBe(settingsPath);
      // No spurious `injected` or `collapse_drift` on identical re-inject.
      expect(events.filter((e) => e.eventType === 'settings.hook.injected')).toHaveLength(0);
      expect(events.filter((e) => e.eventType === 'settings.hook.dedup.collapse_drift')).toHaveLength(0);
    });

    test('drift collapse: stale path-drifted genie entry → single canonical entry + collapse_drift event', async () => {
      // Pre-seed settings with a drifted genie-shape entry (older path,
      // wrong timeout, wrong matcher for PostToolUse). Mimics the wild-host
      // state where 65/82 settings files accumulated 2-7× duplicates with
      // path-drifted commands across genie versions.
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      const driftedBinaryPath = '/legacy/path/to/genie-hook';
      const driftedCmd = `'${driftedBinaryPath}'`;

      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: '*', hooks: [{ type: 'command', command: driftedCmd, timeout: 30 }] },
              // Duplicate: SAME genie shape, slightly different drift path.
              { matcher: '*', hooks: [{ type: 'command', command: 'genie hook dispatch', timeout: 15 }] },
            ],
            PostToolUse: [
              // Drifted matcher — should be `SendMessage` per current types.ts.
              { matcher: '*', hooks: [{ type: 'command', command: driftedCmd, timeout: 30 }] },
            ],
          },
        }),
      );

      const events = captureInjectAudit();
      const result = await injectTeamHooks('test-team');
      expect(result).toBe(true);

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));

      // PreToolUse must collapse to exactly ONE canonical entry.
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].matcher).toBe(DISPATCHED_EVENT_MATCHERS.PreToolUse);
      expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(15);

      // PostToolUse must collapse to exactly ONE canonical entry, with the
      // narrowed `SendMessage` matcher.
      expect(settings.hooks.PostToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse[0].matcher).toBe(DISPATCHED_EVENT_MATCHERS.PostToolUse);
      expect(settings.hooks.PostToolUse[0].hooks).toHaveLength(1);
      expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBe(15);

      // Audit event must classify as collapse_drift (not injected, not skip).
      const collapseEvents = events.filter((e) => e.eventType === 'settings.hook.dedup.collapse_drift');
      expect(collapseEvents).toHaveLength(1);
      expect(collapseEvents[0].entityId).toBe(settingsPath);
      expect(events.filter((e) => e.eventType === 'settings.hook.injected')).toHaveLength(0);
      expect(events.filter((e) => e.eventType === 'settings.hook.dedup.skip')).toHaveLength(0);
    });

    test('drift collapse preserves user-defined non-genie hooks within the same event', async () => {
      // Realistic mixed state: a user-defined hook lives next to a drifted
      // genie hook on the same event. Collapse must remove only the genie
      // duplicates, never the user's hook.
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-bash-hook', timeout: 5 }] },
              { matcher: '*', hooks: [{ type: 'command', command: "'/legacy/genie-hook'", timeout: 30 }] },
              { matcher: '*', hooks: [{ type: 'command', command: 'genie hook dispatch', timeout: 15 }] },
            ],
          },
        }),
      );

      await injectTeamHooks('test-team');

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // User's Bash hook MUST survive.
      const userEntry = settings.hooks.PreToolUse.find(
        (e: { matcher?: string; hooks?: Array<{ command?: string }> }) =>
          e.matcher === 'Bash' && e.hooks?.[0]?.command === 'echo user-bash-hook',
      );
      expect(userEntry).toBeDefined();
      // Exactly ONE canonical genie entry remains.
      const genieEntries = settings.hooks.PreToolUse.filter(
        (e: { matcher?: string; hooks?: Array<{ command?: string }> }) =>
          e.matcher === '*' &&
          e.hooks?.some((h) => h.command?.includes('hook dispatch') || /genie-hook/.test(h.command ?? '')),
      );
      expect(genieEntries).toHaveLength(1);
    });
  });

  test('injectTeamHooks upgrades legacy bare genie dispatch commands', async () => {
    const teamDir = join(testDir, 'teams', 'test-team');
    await mkdir(teamDir, { recursive: true });

    const settingsPath = join(teamDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: Object.fromEntries(
          DISPATCHED_EVENTS.map((event) => [
            event,
            [{ hooks: [{ type: 'command', command: 'genie hook dispatch', timeout: 15 }] }],
          ]),
        ),
      }),
    );

    const result = await injectTeamHooks('test-team');
    expect(result).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    for (const event of DISPATCHED_EVENTS) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(isRecognizedDispatchCommand(command)).toBe(true);
    }
  });

  test('isTeamHooked returns false for missing team', async () => {
    const result = await isTeamHooked('nonexistent');
    expect(result).toBe(false);
  });

  test('isTeamHooked returns true after injection', async () => {
    await injectTeamHooks('test-team');
    const result = await isTeamHooked('test-team');
    expect(result).toBe(true);
  });

  // Mac-CPU fix D — narrow matchers + drop empty events
  describe('Mac-CPU fix D — narrowed matchers + dropped empty events', () => {
    test('DISPATCHED_EVENT_MATCHERS only wires events that have handlers', () => {
      // PreToolUse + PostToolUse are the only events with registered handlers
      // (UserPromptSubmit and Stop have handlers too, but inject path is
      // claude-only and those aren't currently wired through this layer)
      expect(Object.keys(DISPATCHED_EVENT_MATCHERS).sort()).toEqual(['PostToolUse', 'PreToolUse']);
      // Empty-handler events MUST NOT be wired
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('SessionStart');
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('SessionEnd');
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('TeammateIdle');
      expect(DISPATCHED_EVENT_MATCHERS).not.toHaveProperty('TaskCompleted');
    });

    test('PostToolUse is wired with SendMessage matcher (not "*")', async () => {
      await injectTeamHooks('test-team');
      const settingsPath = join(testDir, 'teams', 'test-team', 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // The genie entry for PostToolUse must be SendMessage, not '*'
      const postToolUseEntries = settings.hooks.PostToolUse;
      expect(postToolUseEntries).toBeDefined();
      const genieEntry = postToolUseEntries.find((e: { matcher?: string }) => e.matcher === 'SendMessage');
      expect(genieEntry).toBeDefined();
      // No genie entry should have '*' matcher under PostToolUse
      const wildcardGenie = postToolUseEntries.find(
        (e: { matcher?: string; hooks?: Array<{ command?: string }> }) =>
          e.matcher === '*' && e.hooks?.some((h) => h.command?.includes('hook dispatch')),
      );
      expect(wildcardGenie).toBeUndefined();
    });

    test('injectIntoFile prunes obsolete genie entries (SessionStart, etc.) on re-inject', async () => {
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      // Simulate pre-fix-D settings: SessionStart/SessionEnd/TeammateIdle/TaskCompleted
      // wired with the genie dispatch command
      const stalePath = '/path/to/genie/src/genie.ts';
      const staleCmd = `bun run '${stalePath}' hook dispatch`;
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            TeammateIdle: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
            TaskCompleted: [{ matcher: '*', hooks: [{ type: 'command', command: staleCmd, timeout: 15 }] }],
          },
        }),
      );

      const result = await injectTeamHooks('test-team');
      expect(result).toBe(true); // re-injected (changes detected)

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // Obsolete events with only-genie entries should be DELETED entirely
      expect(settings.hooks.SessionStart).toBeUndefined();
      expect(settings.hooks.SessionEnd).toBeUndefined();
      expect(settings.hooks.TeammateIdle).toBeUndefined();
      expect(settings.hooks.TaskCompleted).toBeUndefined();
      // Active events should remain
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
      // PostToolUse matcher must be narrowed
      expect(settings.hooks.PostToolUse[0].matcher).toBe('SendMessage');
    });

    test('injectIntoFile is idempotent when existing entries use compiled-binary form (regression)', async () => {
      // Regression for the duplicate-hook bug: when settings.json already
      // contains a genie entry written with the compiled-binary command
      // (e.g. `'/home/.../genie-hook'`), re-running injection MUST recognize
      // it as a genie entry and refuse to append another. Prior to this fix,
      // `isGenieDispatchCommand` only matched the legacy `hook dispatch`
      // substring → re-injection appended a new entry every run, producing 4+
      // identical PreToolUse + PostToolUse entries in the wild.
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      const compiledBinaryCmd = `'${join(testDir, 'genie-home', 'bin', 'genie-hook')}'`;
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: compiledBinaryCmd, timeout: 15 }] }],
            PostToolUse: [
              { matcher: 'SendMessage', hooks: [{ type: 'command', command: compiledBinaryCmd, timeout: 15 }] },
            ],
          },
        }),
      );

      // Re-inject 3× — count of entries per event must remain 1, not grow.
      await injectTeamHooks('test-team');
      await injectTeamHooks('test-team');
      await injectTeamHooks('test-team');

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toHaveLength(1);
    });

    test('injectIntoFile preserves user-defined hooks under obsolete events', async () => {
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');

      // User has their own SessionStart hook (not genie's) — must be preserved
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook', timeout: 5 }] }],
          },
        }),
      );

      await injectTeamHooks('test-team');

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // User's SessionStart hook MUST survive
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('echo user-hook');
    });
  });

  // CR feedback on PR #1735 (#20): malformed hooks.<event> values must not
  // crash the inject path. The new defensive guards in upsertGenieEntry only
  // helped if the prune step survived the malformed shape first.
  describe('CR #1735: malformed user-authored configs do not crash inject', () => {
    test('hooks.<event> as object instead of array does not throw', async () => {
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            // Malformed shape — a real settings.json the wild can carry an
            // object here when a user/script writes the file by hand.
            PreToolUse: {},
            // Valid shape alongside, to confirm the inject path still proceeds.
            PostToolUse: [],
          },
        }),
      );
      // Must not throw.
      const result = await injectTeamHooks('test-team');
      expect(result).toBe(true);
      // Inject overwrites PreToolUse with the canonical entry.
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
      expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
    });

    test('matcher entry with non-array hooks key does not throw', async () => {
      const teamDir = join(testDir, 'teams', 'test-team');
      await mkdir(teamDir, { recursive: true });
      const settingsPath = join(teamDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              // Matcher entry with hooks=null — schema we don't recognize.
              { matcher: '*', hooks: null },
              // Matcher entry with no hooks key at all.
              { matcher: 'Bash' },
            ],
          },
        }),
      );
      const result = await injectTeamHooks('test-team');
      expect(result).toBe(true);
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      // Inject completed without throwing; canonical entry appended.
      const genie = settings.hooks.PreToolUse.find(
        (e: { matcher?: string; hooks?: Array<{ command?: string }> }) =>
          e.matcher === '*' &&
          e.hooks?.some((h) => h.command?.includes('hook dispatch') || /genie-hook/.test(h.command ?? '')),
      );
      expect(genie).toBeDefined();
    });
  });
});
