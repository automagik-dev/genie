#!/usr/bin/env bun
/**
 * dedup-team-settings — one-time cleanup migration for #1710 Bug 2.
 *
 * Wish: spawn-compounding-defects, Group 3.
 *
 * Background
 * ----------
 * `src/hooks/inject.ts:upsertGenieEntry()` historically dedup'd by a
 * heuristic that missed drifted command paths. As a result, every team's
 * `<claudeConfigDir>/teams/<team>/settings.json` accumulated multiple
 * genie-shape hook entries — one per command-path revision the host went
 * through (legacy `genie hook dispatch` literal, compiled binary at
 * `~/.genie/bin/genie-hook`, codex variant, etc.). On the filing host
 * 65 of 82 team settings files held 2-7× genie-shape entries. Every
 * `PreToolUse *` event then fired the dispatcher N times, each invocation
 * walking the same handler chain.
 *
 * Group 2 hardened the inject-time dedup (`upsertGenieEntry` now keys on
 * the canonical `{matcher, command, timeout}` triplet AND collapses
 * drifted genie-shape entries). That stops the bleed for new injections,
 * but pre-existing duplicates stay on disk until a re-spawn happens to
 * touch the file. This script removes them in one pass.
 *
 * Strategy
 * --------
 * For each `<base>/<team>/settings.json`:
 *
 *   1. Load JSON. Skip cleanly if the file is missing or unparseable.
 *   2. For each event under `hooks.<event>`:
 *        a. Walk the matcher array. For each matcher entry, split its
 *           `hooks` into genie-shape vs non-genie hooks (regex match —
 *           same shape used by `inject.ts:isGenieDispatchCommand`).
 *        b. Collect every genie-shape hook found across the array, paired
 *           with the matcher it came from.
 *        c. Dedup by `{matcher, command, timeout}` triplet. Then collapse
 *           any remaining drift (different triplets, all genie-shape) to
 *           the first survivor — the next `genie spawn` will normalize
 *           that survivor to the host's current canonical form via
 *           Group 2's hardened `upsertGenieEntry`.
 *        d. Rebuild the matcher array: every original matcher entry that
 *           had ≥1 non-genie hook is preserved (with non-genie hooks
 *           only); the chosen genie entry is appended once.
 *   3. Write back only if the JSON serialization changed (preserves mtime
 *      for already-clean files).
 *
 * Non-genie hooks are NEVER modified. The drift-collapse pass keys on a
 * regex that matches only genie-dispatch shapes — anything outside that
 * shape is opaque to this script.
 *
 * Idempotency
 * -----------
 * After a successful `--apply` run the script writes a marker at
 * `<claudeConfigDir>/.genie/state/dedup-1710.done`. Subsequent invocations
 * detect the marker and exit 0 without scanning, emitting
 * `settings.dedup.skip.marker_present`. `--force` re-runs the scan
 * regardless; on a clean host this is a no-op (no entries removed) and
 * still emits `settings.dedup.completed` with zero counts.
 *
 * Modes
 * -----
 *   `--dry-run` (default) — prints classification per file and a summary.
 *                            Never writes to disk.
 *   `--apply`             — writes deduped settings + marker. Emits
 *                            `settings.dedup.completed` audit event with
 *                            `{filesScanned, filesModified, entriesRemoved}`.
 *   `--force`             — bypass the marker; re-run even after success.
 *
 * Exit codes
 * ----------
 *   0 — scan completed (with or without changes).
 *   1 — fatal error reading the teams directory itself.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Genie-shape recognition — kept verbatim with `src/hooks/inject.ts` so the
// script and the inject path classify the same commands the same way. If the
// inject regex changes, update both. The script-side copy is intentional —
// scripts/* must be runnable without bundling the full `dist/` tree.
// ============================================================================

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

// ============================================================================
// Shape types — match the JSON the inject path writes. Kept as `any`-friendly
// shapes because real-world settings.json files contain user-authored hooks
// whose schema we do not control.
// ============================================================================

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

type HooksConfig = Record<string, HookMatcher[]>;

// ============================================================================
// Path helpers — mirror `src/hooks/inject.ts:claudeConfigDir()` so the script
// honors `CLAUDE_CONFIG_DIR` overrides during tests.
// ============================================================================

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function teamsBaseDir(): string {
  return join(claudeConfigDir(), 'teams');
}

function markerPath(base: string = claudeConfigDir()): string {
  return join(base, '.genie', 'state', 'dedup-1710.done');
}

// ============================================================================
// Per-file dedup pass — pure, returns a new HooksConfig + counts for audit.
// ============================================================================

export interface DedupOutcome {
  /** New hooks config with duplicates collapsed. */
  hooks: HooksConfig;
  /** Number of genie-shape hook entries removed (across all events). */
  entriesRemoved: number;
  /** Per-event before/after counts for the dry-run report. */
  perEvent: Record<string, { before: number; after: number }>;
  /** True iff the new hooks differ structurally from the input. */
  changed: boolean;
}

/**
 * Dedup a single `hooks` config in-memory. Pure: input is not mutated.
 *
 * Within each event:
 *   - Each matcher entry is split into genie-shape and non-genie hooks.
 *   - Non-genie hooks are preserved verbatim, in their original matcher entry,
 *     in their original order.
 *   - All genie-shape hooks (across every matcher entry of this event) are
 *     collected, deduped by `{matcher, command, timeout}` triplet, then
 *     drift-collapsed to the FIRST surviving triplet — yielding at most one
 *     genie matcher entry per event.
 *   - The single surviving genie matcher entry is appended after any
 *     preserved non-genie matcher entries.
 */
export function dedupHooks(input: HooksConfig | undefined): DedupOutcome {
  const out: HooksConfig = {};
  const perEvent: Record<string, { before: number; after: number }> = {};
  let entriesRemoved = 0;

  if (!input || typeof input !== 'object') {
    return { hooks: {}, entriesRemoved: 0, perEvent: {}, changed: false };
  }

  for (const [event, matchers] of Object.entries(input)) {
    if (!Array.isArray(matchers)) {
      // Pass through non-array values untouched — schema we don't recognize.
      out[event] = matchers as never;
      continue;
    }

    const preserved: HookMatcher[] = []; // non-genie matcher entries (or partial, with non-genie hooks only)
    const genieCandidates: { matcher: string; hook: HookEntry }[] = [];
    let beforeGenieCount = 0;

    for (const m of matchers) {
      if (!m || typeof m !== 'object') {
        preserved.push(m);
        continue;
      }
      const hooks = Array.isArray(m.hooks) ? m.hooks : [];
      const genie = hooks.filter((h) => isGenieDispatchCommand(h?.command));
      const nonGenie = hooks.filter((h) => !isGenieDispatchCommand(h?.command));
      beforeGenieCount += genie.length;

      // Preserve a matcher entry only when it carries non-genie hooks; drop
      // the entry entirely when its only purpose was a genie hook (the genie
      // pool is rebuilt below from `genieCandidates`).
      if (nonGenie.length > 0) {
        preserved.push({ ...m, hooks: nonGenie });
      } else if (!Array.isArray(m.hooks)) {
        // Matcher entry with no `hooks` array — preserve untouched (not our schema).
        preserved.push(m);
      }

      const matcherKey = typeof m.matcher === 'string' ? m.matcher : '';
      for (const h of genie) {
        genieCandidates.push({ matcher: matcherKey, hook: h });
      }
    }

    // Triplet dedup: keep only the FIRST occurrence of each
    // `{matcher, command, timeout}` triplet.
    const seen = new Set<string>();
    const tripletDedup: { matcher: string; hook: HookEntry }[] = [];
    for (const c of genieCandidates) {
      const key = JSON.stringify([c.matcher, c.hook.command ?? null, c.hook.timeout ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      tripletDedup.push(c);
    }

    // Drift collapse: if multiple distinct triplets remain (different command
    // paths or different matchers), keep ONLY the first survivor. The next
    // `genie spawn` will normalize this entry to the host's canonical form
    // via Group 2's hardened `upsertGenieEntry`.
    const surviving = tripletDedup.slice(0, 1);
    const afterGenieCount = surviving.length;

    const finalMatchers: HookMatcher[] = [...preserved];
    if (surviving.length === 1) {
      const s = surviving[0];
      finalMatchers.push({ matcher: s.matcher, hooks: [s.hook] });
    }

    out[event] = finalMatchers;
    perEvent[event] = { before: beforeGenieCount, after: afterGenieCount };
    entriesRemoved += beforeGenieCount - afterGenieCount;
  }

  // Determine `changed` by structural comparison rather than counter — a
  // matcher entry whose `hooks` array got reordered or pruned still counts
  // as changed even when entriesRemoved happens to be zero.
  const changed = JSON.stringify(out) !== JSON.stringify(input);
  return { hooks: out, entriesRemoved, perEvent, changed };
}

// ============================================================================
// File-level processing — wraps dedupHooks with read/write/write-only-on-change.
// ============================================================================

export interface FileResult {
  team: string;
  path: string;
  status: 'unchanged' | 'modified' | 'unparseable' | 'no-hooks-key';
  entriesRemoved: number;
  perEvent: Record<string, { before: number; after: number }>;
}

/** Read, dedup, and (when `apply`) write a single settings.json file. */
export function processSettingsFile(filePath: string, apply: boolean, teamName: string): FileResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { team: teamName, path: filePath, status: 'unparseable', entriesRemoved: 0, perEvent: {} };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { team: teamName, path: filePath, status: 'unparseable', entriesRemoved: 0, perEvent: {} };
  }

  const hooks = parsed.hooks as HooksConfig | undefined;
  if (!hooks || typeof hooks !== 'object') {
    return { team: teamName, path: filePath, status: 'no-hooks-key', entriesRemoved: 0, perEvent: {} };
  }

  const outcome = dedupHooks(hooks);
  if (!outcome.changed) {
    return {
      team: teamName,
      path: filePath,
      status: 'unchanged',
      entriesRemoved: 0,
      perEvent: outcome.perEvent,
    };
  }

  if (apply) {
    const next = { ...parsed, hooks: outcome.hooks };
    // Match the inject path's `JSON.stringify(value, null, 2)` formatting so
    // dedup'd files don't churn diffs against future inject re-writes.
    const serialized = JSON.stringify(next, null, 2);
    writeFileSync(filePath, `${serialized}\n`, 'utf-8');
  }

  return {
    team: teamName,
    path: filePath,
    status: 'modified',
    entriesRemoved: outcome.entriesRemoved,
    perEvent: outcome.perEvent,
  };
}

// ============================================================================
// Top-level scan — iterate `<base>/teams/*/settings.json`, optionally guarded
// by the marker file.
// ============================================================================

export interface ScanOpts {
  apply?: boolean;
  force?: boolean;
  baseDir?: string;
  /** Override the marker base directory (defaults to claudeConfigDir()). */
  markerBaseDir?: string;
}

export interface ScanReport {
  filesScanned: number;
  filesModified: number;
  entriesRemoved: number;
  results: FileResult[];
  /** True iff the marker was present and `--force` was not passed. */
  skippedDueToMarker: boolean;
}

/** Run the migration. Pure with respect to `opts.baseDir`/`opts.markerBaseDir`. */
export function dedupTeamSettings(opts: ScanOpts = {}): ScanReport {
  const apply = opts.apply ?? false;
  const force = opts.force ?? false;
  const base = opts.baseDir ?? teamsBaseDir();
  const markerBase = opts.markerBaseDir ?? claudeConfigDir();
  const marker = markerPath(markerBase);

  if (!force && existsSync(marker)) {
    return {
      filesScanned: 0,
      filesModified: 0,
      entriesRemoved: 0,
      results: [],
      skippedDueToMarker: true,
    };
  }

  if (!existsSync(base)) {
    return { filesScanned: 0, filesModified: 0, entriesRemoved: 0, results: [], skippedDueToMarker: false };
  }

  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return { filesScanned: 0, filesModified: 0, entriesRemoved: 0, results: [], skippedDueToMarker: false };
  }

  const results: FileResult[] = [];
  let filesScanned = 0;
  let filesModified = 0;
  let entriesRemoved = 0;

  for (const name of entries) {
    if (name === '_archive' || name.startsWith('.')) continue;
    const teamDir = join(base, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(teamDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const settings = join(teamDir, 'settings.json');
    if (!existsSync(settings)) continue;

    filesScanned++;
    const result = processSettingsFile(settings, apply, name);
    results.push(result);
    if (result.status === 'modified') {
      filesModified++;
      entriesRemoved += result.entriesRemoved;
    }
  }

  // Marker write: only on `--apply` AND only if at least the scan completed
  // without crash. Idempotent — re-running creates the dir if missing.
  if (apply) {
    try {
      const dir = join(markerBase, '.genie', 'state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const markerBody = JSON.stringify(
        {
          wish: 'spawn-compounding-defects',
          issue: 1710,
          completedAt: new Date().toISOString(),
          filesScanned,
          filesModified,
          entriesRemoved,
        },
        null,
        2,
      );
      writeFileSync(marker, `${markerBody}\n`, 'utf-8');
    } catch {
      // Marker is best-effort. The next run will re-scan; on a clean host
      // it'll be a no-op.
    }
  }

  return { filesScanned, filesModified, entriesRemoved, results, skippedDueToMarker: false };
}

// ============================================================================
// Audit emission — best-effort, mirrors `src/hooks/inject.ts:emitInjectAudit`.
// Uses dynamic import so the script stays runnable even when DB is offline.
// ============================================================================

async function emitDedupAudit(eventType: string, details: Record<string, unknown>): Promise<void> {
  try {
    const { recordAuditEvent } = await import('../src/lib/audit.js');
    await recordAuditEvent('hooks', 'dedup-team-settings', eventType, process.env.GENIE_AGENT_NAME ?? 'cli', details);
  } catch {
    // Never block the migration on audit failure — this script may run on
    // hosts where genie-pgserve isn't up.
  }
}

// ============================================================================
// CLI entry — `bun scripts/dedup-team-settings.ts [--dry-run|--apply] [--force]`
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run') || !apply; // dry-run is default
  const force = args.includes('--force');

  if (apply && dryRun && !args.includes('--apply')) {
    // unreachable, retained for clarity
  }

  const report = dedupTeamSettings({ apply, force });

  if (report.skippedDueToMarker) {
    console.log('  marker present at', markerPath(), '— skipping. Pass --force to re-scan.');
    await emitDedupAudit('settings.dedup.skip.marker_present', { marker: markerPath() });
    process.exit(0);
  }

  for (const r of report.results) {
    if (r.status === 'unchanged') {
      console.log(`  [unchanged] ${r.team}`);
      continue;
    }
    if (r.status === 'unparseable') {
      console.log(`  [unparseable] ${r.team} — ${r.path}`);
      continue;
    }
    if (r.status === 'no-hooks-key') {
      // Quiet — most settings files without hooks just lack the section.
      continue;
    }
    const tag = apply ? 'modified' : 'would-modify';
    const summary = Object.entries(r.perEvent)
      .filter(([, v]) => v.before !== v.after)
      .map(([k, v]) => `${k}: ${v.before}→${v.after}`)
      .join(', ');
    console.log(
      `  [${tag}] ${r.team} — removed ${r.entriesRemoved} entr${r.entriesRemoved === 1 ? 'y' : 'ies'} (${summary})`,
    );
  }

  console.log(
    `\n  ${report.filesScanned} file${report.filesScanned === 1 ? '' : 's'} scanned, ` +
      `${report.filesModified} ${apply ? 'modified' : 'would-be-modified'}, ` +
      `${report.entriesRemoved} duplicate hook entr${report.entriesRemoved === 1 ? 'y' : 'ies'} ${apply ? 'removed' : 'queued for removal'}.`,
  );

  if (apply) {
    await emitDedupAudit('settings.dedup.completed', {
      filesScanned: report.filesScanned,
      filesModified: report.filesModified,
      entriesRemoved: report.entriesRemoved,
    });
    console.log(`\n  marker written to ${markerPath()}`);
  } else {
    console.log('\n  dry-run mode (default). Re-run with --apply to write changes + marker.');
  }
}

if (import.meta.path === Bun.main) {
  main().catch((err) => {
    console.error('dedup-team-settings: fatal', err);
    process.exit(1);
  });
}
