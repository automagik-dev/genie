// Cross-ref: https://github.com/automagik-dev/genie/issues/1233
/**
 * Pattern 10 — Agent-tool bypass detector.
 *
 * Rot condition:
 *   A Claude Code `Agent`-tool subagent is actively writing a transcript on
 *   disk (under `/tmp/claude-<session>/…/tasks/<agent-id>.output`) with no
 *   corresponding row in the PG `agents` table. Such subagents bypass
 *   `genie spawn`, so
 *   the event substrate (timeline, tools, costs, errors) never sees them.
 *
 * Why it matters:
 *   Self-healing detectors can only fire on data that was emitted. Bypass
 *   subagents are invisible to every downstream rot detector and to cost
 *   tracking — a structural blind spot. Emitting `rot.detected` with the
 *   transcript path + size is enough signal for operators to audit, and for
 *   future V2 work (emitter shim, issue #1233 option 2) to justify itself.
 *
 * Query shape:
 *   1. Walk `/tmp/claude-<session>` directories looking for `.output` files.
 *   2. Filter to transcripts whose mtime is within the "active" window.
 *   3. Batch-lookup candidate agent ids against the `agents` table.
 *   4. Report each active transcript with no matching PG row as an orphan.
 *
 * Dependency injection:
 *   `makeAgentToolBypassDetector(deps)` accepts `listTranscripts`,
 *   `checkAgentIds`, and `now` so tests can inject fixtures without touching
 *   the real filesystem or PG connection. Production wires defaults.
 *
 * Read-only discipline:
 *   No spawn interception, no state mutation. V1 observes only. A follow-up
 *   wish may add an emitter shim to register Agent-tool spawns with PG; that
 *   work is deliberately out of scope here.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getConnection } from '../lib/db.js';
import type { DetectorEvent, DetectorModule } from './index.js';
import { registerDetector } from './index.js';

/** On-disk transcript candidate discovered during enumeration. */
export interface TranscriptInfo {
  readonly agent_id: string;
  readonly transcript_path: string;
  readonly size_bytes: number;
  readonly mtime_ms: number;
}

/** A confirmed orphan — active transcript with no PG agent row. */
export interface OrphanTranscript {
  readonly agent_id: string;
  readonly transcript_path: string;
  readonly size_bytes: number;
  readonly mtime_iso: string;
}

export interface AgentToolBypassState {
  readonly orphans: ReadonlyArray<OrphanTranscript>;
  /** Count of active transcripts scanned this tick (before orphan filter). */
  readonly scanned_count: number;
}

export interface AgentToolBypassDeps {
  readonly listTranscripts: () => Promise<ReadonlyArray<TranscriptInfo>>;
  readonly checkAgentIds: (ids: ReadonlyArray<string>) => Promise<ReadonlySet<string>>;
  readonly now: () => number;
  /**
   * How recently a transcript's mtime must have changed for it to count as
   * "active". Defaults to 10 minutes. Stale files (crash artefacts, cleanup
   * leftovers) are ignored so the detector only flags genuine bypass runs.
   */
  readonly activeWindowMs?: number;
  /** Max number of orphans reported in a single event payload. */
  readonly maxOrphansPerEvent?: number;
}

const DEFAULT_ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ORPHANS_PER_EVENT = 32;
const DEFAULT_SEARCH_ROOT = '/tmp';
const DEFAULT_SEARCH_PREFIX = 'claude-';
const DEFAULT_WALK_DEPTH = 4;

async function defaultListTranscripts(): Promise<ReadonlyArray<TranscriptInfo>> {
  let entries: string[];
  try {
    entries = await readdir(DEFAULT_SEARCH_ROOT);
  } catch {
    return [];
  }
  const out: TranscriptInfo[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(DEFAULT_SEARCH_PREFIX)) continue;
    await walkForOutputFiles(join(DEFAULT_SEARCH_ROOT, entry), out, DEFAULT_WALK_DEPTH);
  }
  return out;
}

async function walkForOutputFiles(dir: string, sink: TranscriptInfo[], depthBudget: number): Promise<void> {
  if (depthBudget <= 0) return;
  let dirents: Awaited<ReturnType<typeof readdir>>;
  try {
    // withFileTypes: true returns Dirent entries instead of plain strings.
    dirents = (await readdir(dir, { withFileTypes: true })) as unknown as Awaited<ReturnType<typeof readdir>>;
  } catch {
    return;
  }
  for (const dirent of dirents as unknown as Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walkForOutputFiles(full, sink, depthBudget - 1);
      continue;
    }
    if (!dirent.isFile() || !dirent.name.endsWith('.output')) continue;
    try {
      const st = await stat(full);
      sink.push({
        agent_id: basename(dirent.name, '.output'),
        transcript_path: full,
        size_bytes: st.size,
        mtime_ms: st.mtimeMs,
      });
    } catch {
      // stat failed mid-walk (file removed) — skip and continue.
    }
  }
}

async function defaultCheckAgentIds(ids: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const sql = await getConnection();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM agents WHERE id = ANY(${ids as string[]})
  `;
  return new Set(rows.map((r: { id: string }) => r.id));
}

/** Build a DetectorModule around injected deps. */
export function makeAgentToolBypassDetector(deps: AgentToolBypassDeps): DetectorModule<AgentToolBypassState> {
  const windowMs = deps.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const maxOrphans = deps.maxOrphansPerEvent ?? DEFAULT_MAX_ORPHANS_PER_EVENT;

  return {
    id: 'rot.agent-tool-bypass',
    version: '1.0.0',
    riskClass: 'medium',
    async query(): Promise<AgentToolBypassState> {
      const nowMs = deps.now();
      const transcripts = await deps.listTranscripts();
      const active = transcripts.filter((t) => nowMs - t.mtime_ms <= windowMs);
      const ids = active.map((t) => t.agent_id);
      const known = ids.length === 0 ? new Set<string>() : await deps.checkAgentIds(ids);
      const orphans: OrphanTranscript[] = [];
      for (const t of active) {
        if (known.has(t.agent_id)) continue;
        orphans.push({
          agent_id: t.agent_id,
          transcript_path: t.transcript_path,
          size_bytes: t.size_bytes,
          mtime_iso: new Date(t.mtime_ms).toISOString(),
        });
      }
      return { orphans, scanned_count: active.length };
    },
    shouldFire(state: AgentToolBypassState): boolean {
      return state.orphans.length > 0;
    },
    render(state: AgentToolBypassState): DetectorEvent {
      const head = state.orphans.slice(0, maxOrphans);
      const first = head[0];
      return {
        type: 'rot.detected',
        subject: first?.agent_id ?? 'unknown',
        payload: {
          pattern_id: 'pattern-10-agent-tool-bypass',
          entity_id: first?.agent_id ?? 'unknown',
          observed_state_json: {
            agent_id: first?.agent_id ?? 'unknown',
            transcript_path: first?.transcript_path ?? '',
            size_bytes: first?.size_bytes ?? 0,
            mtime_iso: first?.mtime_iso ?? '',
            detected_at: new Date(deps.now()).toISOString(),
            orphan_count: state.orphans.length,
            scanned_count: state.scanned_count,
            agent_ids: head.map((o) => o.agent_id),
            transcript_paths: head.map((o) => o.transcript_path),
            sizes_bytes: head.map((o) => o.size_bytes),
          },
        },
      };
    },
  };
}

// Production default — reads the real filesystem and PG. Module-local so
// knip does not flag it; only the side-effect registration leaves the file.
const agentToolBypassDetector = makeAgentToolBypassDetector({
  listTranscripts: defaultListTranscripts,
  checkAgentIds: defaultCheckAgentIds,
  now: () => Date.now(),
});

// Self-register at module load — the scheduler picks this up via
// `listDetectors()` once `built-in.ts` imports this file.
registerDetector(agentToolBypassDetector);
