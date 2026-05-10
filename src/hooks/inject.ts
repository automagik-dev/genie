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

/**
 * Audit-event emission dependency — overridable for testing. Mirrors the
 * pattern in src/hooks/handlers/session-sync.ts: when null, the inject layer
 * lazy-imports `recordAuditEvent` from `../lib/audit.js` at call time. Tests
 * that want to assert the {settings.hook.injected, settings.hook.dedup.skip,
 * settings.hook.dedup.collapse_drift} classification install a mock here and
 * reset in afterEach.
 */
type EmitAuditEventFn = (
  entityType: string,
  entityId: string,
  eventType: string,
  actor: string | null,
  details: Record<string, unknown>,
) => Promise<void>;

export const _deps: {
  emitAuditEvent: EmitAuditEventFn | null;
} = {
  emitAuditEvent: null,
};

async function emitInjectAudit(
  eventType: string,
  settingsPath: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const fn = _deps.emitAuditEvent ?? (await import('../lib/audit.js')).recordAuditEvent;
    await fn('hooks', settingsPath, eventType, process.env.GENIE_AGENT_NAME ?? 'cli', details);
  } catch {
    // Best-effort — never block the inject path on audit failure.
  }
}

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

/**
 * Canonical hooks-config for the running host — exported so the one-time
 * cleanup migration (`scripts/dedup-team-settings.ts`) can synthesize
 * canonical entries instead of preserving stale first-survivor shapes
 * (CR feedback on PR #1735.13). Keeping the function colocated with the
 * inject path ensures both paths use the same canonical source of truth.
 */
export function buildHooksConfig(): HooksConfig {
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

/**
 * True if no obsolete events (removed from DISPATCHED_EVENT_MATCHERS) still
 * carry a genie entry. Defensive against malformed user-authored configs
 * (`hooks.<event>` not an array, matcher entries with non-array `hooks`):
 * non-array shapes count as "no genie entry present" and are safely skipped.
 */
function hasNoObsoleteGenieEntries(existingHooks: HooksConfig): boolean {
  return Object.keys(existingHooks).every((event) => {
    if (DISPATCHED_EVENTS.includes(event as never)) return true;
    const entries = existingHooks[event];
    if (!Array.isArray(entries)) return true;
    return !entries.some((m) => {
      if (!m || typeof m !== 'object') return false;
      const hooksArr = Array.isArray(m.hooks) ? m.hooks : [];
      return hooksArr.some((h) => h && isGenieDispatchCommand(h.command));
    });
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
    // Defensive: real-world settings.json can have malformed values like
    // `hooks: { PreToolUse: {} }` (object instead of array). Coerce to an
    // empty array so the prune step never throws on user-authored configs.
    // Mirrors the same Array.isArray guard that `upsertGenieEntry` uses below.
    // CR feedback on PR #1735.
    const raw = mergedHooks[event];
    const list: HookMatcher[] = Array.isArray(raw) ? raw : [];
    const cleaned = list
      .map((matcher) => {
        if (!matcher || typeof matcher !== 'object') return matcher;
        const hooksArr = Array.isArray(matcher.hooks) ? matcher.hooks : [];
        return {
          ...matcher,
          hooks: hooksArr.filter((hook) => hook && !isGenieDispatchCommand(hook.command)),
        };
      })
      .filter((matcher) => {
        if (!matcher || typeof matcher !== 'object') return false;
        return (matcher.hooks?.length ?? 0) > 0;
      });
    if (cleaned.length === 0) {
      delete mergedHooks[event];
    } else {
      mergedHooks[event] = cleaned;
    }
  }
}

/** Per-event classification for audit-emission and write decisions. */
type UpsertResult = 'injected' | 'dedup.skip' | 'dedup.collapse_drift';

/**
 * Add, refresh, or collapse the genie entry for one event in-place on
 * mergedHooks. Returns the per-event classification.
 *
 * Three cases:
 *   - `injected`: no existing genie-dispatch hook for this event. Append the
 *     canonical entry alongside any pre-existing user hooks.
 *   - `dedup.skip`: exactly one matcher entry under this event has the
 *     canonical `{matcher, command, timeout}` triplet. Leave the array
 *     untouched (idempotent).
 *   - `dedup.collapse_drift`: existing genie-shape entries differ from the
 *     canonical triplet (drifted command path, wrong matcher, wrong timeout,
 *     OR multiple entries — the historical 65/82 duplicate-bug case). Strip
 *     ALL genie hooks across all matcher entries (preserving non-genie hooks
 *     alongside them), then append the single canonical entry.
 *
 * The `dedup.collapse_drift` branch is what fixes the duplicate-hook
 * accumulation: any number of genie-shape entries with any path-drifted
 * command (current `genie-hook` binary, older path, bun-fork form, codex
 * variant) is collapsed to exactly one canonical entry per event.
 */
function upsertGenieEntry(mergedHooks: HooksConfig, event: string, genieEntry: HookMatcher): UpsertResult {
  // Defensive: malformed user-authored settings can have `hooks.<event>` as
  // an object, string, etc. Coerce to an empty array so the iteration below
  // never throws on a non-iterable value. CR feedback on PR #1735.
  const raw = mergedHooks[event];
  const existing: HookMatcher[] = Array.isArray(raw) ? raw : [];

  const canonicalCommand = genieEntry.hooks[0].command;
  const canonicalTimeout = genieEntry.hooks[0].timeout;
  const canonicalMatcher = genieEntry.matcher;

  let genieMatcherCount = 0;
  let canonicalMatch = false;
  for (const entry of existing) {
    // Defensive: `existing` can hold null/non-object entries when user-authored
    // settings.json is malformed. Match the script-side `Array.isArray` guard
    // in `scripts/dedup-team-settings.ts:dedupHooks` so both paths classify
    // unrecognized shapes the same way (skipped, never mutated).
    if (!entry || typeof entry !== 'object') continue;
    const hooksArr = Array.isArray(entry.hooks) ? entry.hooks : [];
    const genieHooks = hooksArr.filter((h) => h && isGenieDispatchCommand(h.command));
    if (genieHooks.length === 0) continue;
    genieMatcherCount++;
    if (
      entry.matcher === canonicalMatcher &&
      hooksArr.length === 1 &&
      genieHooks.length === 1 &&
      genieHooks[0].type === 'command' &&
      genieHooks[0].command === canonicalCommand &&
      genieHooks[0].timeout === canonicalTimeout
    ) {
      canonicalMatch = true;
    }
  }

  if (genieMatcherCount === 0) {
    mergedHooks[event] = [...existing, genieEntry];
    return 'injected';
  }

  if (genieMatcherCount === 1 && canonicalMatch) {
    mergedHooks[event] = existing;
    return 'dedup.skip';
  }

  // Drift / duplicate detected. Strip every genie-shape hook across all
  // matcher entries, preserve any non-genie hooks alongside them (drop the
  // matcher entry entirely if it had ONLY genie hooks), then append a single
  // canonical genie entry. Same defensive guards as the upper loop — malformed
  // entries are passed through untouched rather than crashed on.
  const stripped: HookMatcher[] = [];
  for (const entry of existing) {
    if (!entry || typeof entry !== 'object') {
      stripped.push(entry);
      continue;
    }
    const hooksArr = Array.isArray(entry.hooks) ? entry.hooks : [];
    const nonGenieHooks = hooksArr.filter((h) => h && !isGenieDispatchCommand(h.command));
    if (nonGenieHooks.length > 0) {
      stripped.push({ ...entry, hooks: nonGenieHooks });
    } else if (!Array.isArray(entry.hooks)) {
      // No `hooks` array at all — preserve the entry; not our schema.
      stripped.push(entry);
    }
  }
  mergedHooks[event] = [...stripped, genieEntry];
  return 'dedup.collapse_drift';
}

/**
 * Roll up per-event upsert results into a single classification for audit.
 *
 * Drift cleanup outranks fresh injection — when one event injects fresh AND
 * another event collapses drift in the same call, the audit signal must
 * surface the drift (dirty host state) rather than the injection (a
 * back-fillable normal-case event). CR feedback on PR #1735.
 */
function classifyInject(perEvent: UpsertResult[], hadObsolete: boolean): UpsertResult {
  if (hadObsolete || perEvent.includes('dedup.collapse_drift')) return 'dedup.collapse_drift';
  if (perEvent.includes('injected')) return 'injected';
  return 'dedup.skip';
}

/**
 * Inject genie hook dispatch into a settings.json file.
 * Preserves existing non-hook settings. Overwrites existing hooks.
 *
 * Emits one of three audit events per call (best-effort):
 *   - `settings.hook.injected`         — at least one event got a fresh genie entry.
 *   - `settings.hook.dedup.collapse_drift` — at least one event had drifted/dup
 *     genie entries that were collapsed to the single canonical triplet, OR
 *     obsolete genie entries (SessionStart/etc.) were pruned.
 *   - `settings.hook.dedup.skip`       — every event already had the canonical
 *     `{matcher, command, timeout}` triplet; this call was a no-op for hooks.
 */
async function injectIntoFile(settingsPath: string): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  const hooksConfig = buildHooksConfig();
  const existingHooks = settings.hooks as HooksConfig | undefined;

  const hadObsolete = !!existingHooks && !hasNoObsoleteGenieEntries(existingHooks);

  const mergedHooks: HooksConfig = existingHooks ? { ...existingHooks } : {};
  pruneObsoleteGenieEntries(mergedHooks);

  const perEventResults: UpsertResult[] = [];
  for (const event of DISPATCHED_EVENTS) {
    perEventResults.push(upsertGenieEntry(mergedHooks, event, hooksConfig[event][0]));
  }

  const classification = classifyInject(perEventResults, hadObsolete);
  const hooksChanged = classification !== 'dedup.skip';

  // Seed GENIE_BASELINE_ALLOWED_TOOLS (currently `AskUserQuestion`) into the
  // team's settings.json. Without this, CC team mode reads team settings with
  // no permissions block and routes baseline tool calls through the team-lead
  // approval queue instead of surfacing them to the human — closes the team-
  // side gap left after #1688's global-only fix in `ensureClaudeSettingsSafe`.
  const permissionsChanged = ensureBaselineAllowedTools(settings);

  // Always emit the audit event so the inject path is fully observable, even
  // when nothing on disk changes (true idempotent fast path).
  await emitInjectAudit(`settings.hook.${classification}`, settingsPath, {
    per_event: Object.fromEntries(DISPATCHED_EVENTS.map((e, i) => [e, perEventResults[i]])),
    pruned_obsolete: hadObsolete,
    permissions_changed: permissionsChanged,
  });

  if (!hooksChanged && !permissionsChanged) {
    return false; // already injected and clean — nothing to do
  }

  if (hooksChanged) {
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
