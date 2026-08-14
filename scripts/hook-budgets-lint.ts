#!/usr/bin/env bun

/**
 * Hook timeout budget lint (hooks-v2#budgets).
 *
 * Every shipped plugin-manifest hook timeout must sit inside its class
 * ceiling. The script-name → class table below is the single place a new
 * hook declares its class: no manifest carries a `class` field (adding one
 * would be a three-manifest schema change for no gain), and an unlisted
 * script name fails this lint instead of defaulting to a permissive class.
 *
 * Ceilings:
 * - guard     ≤ 30s — in-process guardrails on the agent's hot path; a
 *   decision that needs more than half a minute is a background job.
 * - context   ≤ 5s  — machine-derived session context (at most 2 KiB of
 *   wish records), so 5s is already generous.
 * - telemetry ≤ 2s  — out-of-band reporting must drop its sample rather
 *   than stall the agent.
 *
 * Shipped exceptions: the three Omni ladder rungs, all `dispatch-runtime.cjs`
 * at 125s — the host rung of the 110s poll budget → 115s launcher child →
 * 125s host manifest ladder (constants in src/lib/omni-config.ts):
 * - plugins/genie/hooks/hooks.json PreToolUse (Claude),
 * - plugins/genie/.kimi-plugin/plugin.json PreToolUse (Kimi),
 * - plugins/genie/hooks/codex-hooks.json PermissionRequest (Codex).
 * Why PreToolUse carries the rung on the Claude runtime: the omni-approval
 * handler registers on PreToolUse for Claude (src/hooks/index.ts) and polls
 * approvals.pollBudgetMs (default 110s), and dispatch-runtime.cjs grants
 * runtime === 'claude' the 115s child rung. Capping those two entries at
 * the guard ceiling would let CC kill the hook mid-poll and silently vanish
 * the approval gate. The lint re-derives every rung from the ladder
 * constants so none can drift silently, and genie doctor independently
 * warns whenever an enabled Omni poll budget reaches its hook timeout
 * (timeout > pollBudget).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_APPROVAL_POLL_BUDGET_MS,
  PERMISSION_CHILD_TIMEOUT_MS,
  PERMISSION_HOST_TIMEOUT_MS,
} from '../src/lib/omni-config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Class ceilings in seconds. */
export const HOOK_CLASS_CEILINGS = {
  guard: 30,
  context: 5,
  telemetry: 2,
} as const;

export type HookClass = keyof typeof HOOK_CLASS_CEILINGS;

/**
 * Script-name → class. The single place a new hook declares its class; an
 * unlisted script name fails the lint rather than defaulting to a
 * permissive class.
 */
export const HOOK_SCRIPT_CLASSES: Readonly<Record<string, HookClass>> = {
  'dispatch-runtime.cjs': 'guard',
  'validate-wish.cjs': 'guard',
  'session-context.cjs': 'context',
  // No shipped hook is telemetry-class today; the ceiling is reserved for
  // future out-of-band reporters.
};

export type HookManifestStyle = 'claude' | 'kimi';

export interface HookBudgetManifest {
  /** Repo-relative path, used verbatim in violation messages. */
  path: string;
  style: HookManifestStyle;
}

/** The three shipped plugin hook manifests (claude, codex, kimi). */
export const HOOK_BUDGET_MANIFESTS: readonly HookBudgetManifest[] = [
  { path: 'plugins/genie/hooks/hooks.json', style: 'claude' },
  { path: 'plugins/genie/hooks/codex-hooks.json', style: 'claude' },
  { path: 'plugins/genie/.kimi-plugin/plugin.json', style: 'kimi' },
];

/** One flat hook entry. `script` is '' when the command names no script. */
export interface HookBudgetEntry {
  manifest: string;
  event: string;
  script: string;
  /** Whole seconds; null when missing or not a finite number. */
  timeout: number | null;
  /** Script named by `commandWindows`; null when the hook has no Windows variant. */
  windowsScript?: string | null;
}

/** A script-file token inside a hook command: `node ".../scripts/name.cjs" [args]`. */
const SCRIPT_TOKEN_PATTERN = /([A-Za-z0-9_.-]+\.(?:cjs|mjs|js|ts|sh))(?=["'\s]|$)/;

export function scriptFromCommand(command: string): string {
  return command.match(SCRIPT_TOKEN_PATTERN)?.[1] ?? '';
}

interface ClaudeStyleHook {
  command?: string;
  commandWindows?: string;
  timeout?: number;
}

interface ClaudeStyleManifest {
  hooks?: Record<string, Array<{ hooks?: ClaudeStyleHook[] }>>;
}

interface KimiStyleHook {
  event?: string;
  command?: string;
  timeout?: number;
}

interface KimiStyleManifest {
  hooks?: KimiStyleHook[];
}

function entryFromHook(
  manifest: string,
  event: string,
  hook: { command?: string; commandWindows?: string; timeout?: number },
): HookBudgetEntry {
  const timeout = typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout : null;
  return {
    manifest,
    event,
    script: hook.command === undefined ? '' : scriptFromCommand(hook.command),
    timeout,
    windowsScript: hook.commandWindows === undefined ? null : scriptFromCommand(hook.commandWindows),
  };
}

export function parseClaudeStyleManifest(manifest: string, raw: string): HookBudgetEntry[] {
  const parsed = JSON.parse(raw) as ClaudeStyleManifest;
  const entries: HookBudgetEntry[] = [];
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        entries.push(entryFromHook(manifest, event, hook));
      }
    }
  }
  return entries;
}

export function parseKimiStyleManifest(manifest: string, raw: string): HookBudgetEntry[] {
  const parsed = JSON.parse(raw) as KimiStyleManifest;
  return (parsed.hooks ?? []).map((hook) => entryFromHook(manifest, hook.event ?? '<missing-event>', hook));
}

export function parseHookManifest(manifest: HookBudgetManifest): HookBudgetEntry[] {
  const raw = readFileSync(join(ROOT, manifest.path), 'utf8');
  return manifest.style === 'claude'
    ? parseClaudeStyleManifest(manifest.path, raw)
    : parseKimiStyleManifest(manifest.path, raw);
}

/**
 * The shipped budget exceptions: the three Omni ladder rungs. Interactive
 * Omni approval may wait on a human, and the Claude runtime registers the
 * approval handler on PreToolUse (not PermissionRequest), so the Claude and
 * Kimi PreToolUse dispatch entries must carry the host rung too — full
 * justification and ladder constants in the header comment. The same script
 * in any other manifest/event position stays guard-class (≤ 30s).
 */
export function isOmniLadderEntry(entry: HookBudgetEntry): boolean {
  return (
    entry.script === 'dispatch-runtime.cjs' &&
    ((entry.manifest === 'plugins/genie/hooks/hooks.json' && entry.event === 'PreToolUse') ||
      (entry.manifest === 'plugins/genie/.kimi-plugin/plugin.json' && entry.event === 'PreToolUse') ||
      (entry.manifest === 'plugins/genie/hooks/codex-hooks.json' && entry.event === 'PermissionRequest'))
  );
}

export function omniLadderViolations(entry: HookBudgetEntry): string[] {
  if (!isOmniLadderEntry(entry) || entry.timeout === null) return [];
  const violations: string[] = [];
  const hostMs = entry.timeout * 1000;
  if (hostMs !== PERMISSION_HOST_TIMEOUT_MS) {
    violations.push(
      `${entry.manifest} ${entry.event} ${entry.script}: ladder exception must stay pinned to the host rung — ` +
        `timeout ${hostMs}ms ≠ PERMISSION_HOST_TIMEOUT_MS ${PERMISSION_HOST_TIMEOUT_MS}ms`,
    );
  }
  const childMarginMs = PERMISSION_CHILD_TIMEOUT_MS - MAX_APPROVAL_POLL_BUDGET_MS;
  if (childMarginMs < 5_000) {
    violations.push(
      `${entry.manifest} ${entry.event} ${entry.script}: Omni ladder child margin shrank below 5s (${childMarginMs}ms)`,
    );
  }
  if (hostMs - MAX_APPROVAL_POLL_BUDGET_MS < 15_000) {
    violations.push(
      `${entry.manifest} ${entry.event} ${entry.script}: Omni ladder host margin shrank below 15s ` +
        `(${hostMs - MAX_APPROVAL_POLL_BUDGET_MS}ms)`,
    );
  }
  return violations;
}

export function collectHookBudgetViolations(entries: HookBudgetEntry[]): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    const label = `${entry.manifest} ${entry.event} ${entry.script || '<unnamed-script>'}`;
    const windowsScript = entry.windowsScript ?? null;
    if (entry.script === '') {
      violations.push(`${label}: command names no hook script — unable to classify`);
      continue;
    }
    if (windowsScript === '') {
      violations.push(`${label}: commandWindows names no hook script — unable to classify`);
      continue;
    }
    if (windowsScript !== null && windowsScript !== entry.script) {
      violations.push(
        `${label}: commandWindows names a different script (${windowsScript}) — platform variants must run the same hook script`,
      );
      continue;
    }
    if (entry.timeout === null) {
      violations.push(
        `${label}: missing or non-finite timeout — every hook timeout must be declared inside its class ceiling`,
      );
      continue;
    }
    if (isOmniLadderEntry(entry)) {
      violations.push(...omniLadderViolations(entry));
      continue;
    }
    const hookClass = HOOK_SCRIPT_CLASSES[entry.script];
    if (hookClass === undefined) {
      violations.push(
        `${label}: unlisted script name — declare its class in HOOK_SCRIPT_CLASSES (scripts/hook-budgets-lint.ts); there is no permissive default`,
      );
      continue;
    }
    const ceiling = HOOK_CLASS_CEILINGS[hookClass];
    if (entry.timeout > ceiling) {
      violations.push(`${label}: timeout ${entry.timeout}s exceeds the ${hookClass} class ceiling of ${ceiling}s`);
    }
  }
  return violations;
}

export function lintHookBudgetManifests(manifests: readonly HookBudgetManifest[] = HOOK_BUDGET_MANIFESTS): string[] {
  return collectHookBudgetViolations(manifests.flatMap(parseHookManifest));
}

function main(): void {
  const violations = lintHookBudgetManifests();
  if (violations.length > 0) {
    console.error(`hook-budgets-lint: ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log('hook-budgets-lint: OK');
}

if (import.meta.main) main();
