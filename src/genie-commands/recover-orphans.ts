/**
 * Genie Recover-Orphans Command
 *
 * Backfills `executors.claude_session_id` for Claude Code session JSONLs that
 * survived an executor crash, host reboot, or pre-#1684 spawn path that
 * forgot to write the session row. Without this, `genie agent resume` /
 * `genie history` cannot find the on-disk transcript even though the
 * conversation is still on disk and Claude itself would happily resume it.
 *
 * The scanner walks `<claudeConfigDir>/projects/<encoded-cwd>/*.jsonl`,
 * cross-references each session UUID against the `executors` table, maps
 * each project dir to a candidate agent via `agents.repo_path`, and either
 * reports the orphans (default / `--list`) or attaches them to a fresh
 * executor row (`--apply --newest` or `--apply --uuid`).
 *
 * Heal-not-wipe: this command never overwrites a live executor. If the
 * candidate agent already has `current_executor_id` set to a row whose
 * `ended_at IS NULL`, the orphan is reported but not attached.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordAuditEvent } from '../lib/audit.js';
import { getConnection, isAvailable } from '../lib/db.js';
import { createAndLinkExecutor, createExecutor } from '../lib/executor-registry.js';

// ============================================================================
// Public types & options
// ============================================================================

export interface RecoverOrphansOptions {
  /** Restrict the scan to a single agent cwd (real path, not encoded). */
  dir?: string;
  /** Dry-run — list orphans grouped by agent dir; never mutate. */
  list?: boolean;
  /** Mutate: insert/update executor rows. Requires --newest or --uuid. */
  apply?: boolean;
  /** Pair with `--apply` to auto-attach the newest orphan per agent dir. */
  newest?: boolean;
  /** Pair with `--apply` to attach exactly one session UUID. */
  uuid?: string;
}

interface OrphanCandidate {
  sessionId: string;
  jsonlPath: string;
  size: number;
  mtime: Date;
  firstMessagePreview: string | null;
}

interface ProjectDirSummary {
  encoded: string;
  realCwd: string | null;
  agent: { id: string; team: string | null; customName: string | null } | null;
  agentHasLiveExecutor: boolean;
  attachedSessionIds: string[];
  orphans: OrphanCandidate[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Same encoder Claude Code uses to derive `<config-dir>/projects/<encoded>/`
 * from a cwd. Mirrors `sanitizeCwdForProjects` in `executor-registry.ts`.
 *
 * Lossy by design — we cannot decode an encoded dir back to a unique cwd
 * (multiple cwds collapse to the same dir). The decode side queries the
 * `agents` table and matches by re-encoding each `repo_path`.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function resolveProjectsRoot(): string {
  return join(resolveClaudeConfigDir(), 'projects');
}

/**
 * Read the head of a JSONL and return a short user-facing preview of the
 * first user message. Returns null if the file is unreadable, empty, or
 * has no parseable user message in the first ~16 KiB.
 */
export function readFirstUserMessagePreview(jsonlPath: string, maxChars = 80): string | null {
  let head: string;
  try {
    const fd = readFileSync(jsonlPath, { encoding: 'utf-8', flag: 'r' });
    head = fd.slice(0, 16384);
  } catch {
    return null;
  }
  for (const line of head.split('\n').slice(0, 60)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: unknown; role?: unknown; message?: unknown };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const text = extractUserText(entry);
    if (text) {
      const oneLine = text.replace(/\s+/g, ' ').trim();
      return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
    }
  }
  return null;
}

function extractUserText(entry: { type?: unknown; role?: unknown; message?: unknown }): string | null {
  // Newer schema: `{type: 'user', message: {role: 'user', content: '…' | [{type:'text', text:'…'}]}}`
  if (entry.type !== 'user') return null;
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || typeof message !== 'object') return null;
  if (message.role !== 'user' && entry.role !== 'user') return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part === 'object' && 'type' in part && (part as { type: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

function isSessionJsonl(name: string): boolean {
  // Session files are named `<uuid>.jsonl`. The dir also collects backups
  // (`<uuid>.jsonl.<timestamp>.bak`) and trimmed copies (`<uuid>.trimmed.jsonl`)
  // — neither is a live session, so skip.
  if (!name.endsWith('.jsonl')) return false;
  const stem = name.slice(0, -'.jsonl'.length);
  if (stem.includes('.')) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem);
}

interface AgentRepoRow {
  id: string;
  repo_path: string | null;
  team: string | null;
  custom_name: string | null;
  current_executor_id: string | null;
}

interface CurrentExecutorRow {
  id: string;
  ended_at: Date | string | null;
}

async function loadAgentsByEncodedCwd(): Promise<Map<string, AgentRepoRow[]>> {
  const sql = await getConnection();
  const rows = await sql<AgentRepoRow[]>`
    SELECT id, repo_path, team, custom_name, current_executor_id
    FROM agents
    WHERE repo_path IS NOT NULL
  `;
  const map = new Map<string, AgentRepoRow[]>();
  for (const row of rows) {
    if (!row.repo_path) continue;
    const encoded = encodeCwdForClaudeProjects(row.repo_path);
    const bucket = map.get(encoded) ?? [];
    bucket.push(row);
    map.set(encoded, bucket);
  }
  return map;
}

/**
 * Pick the canonical agent for an encoded project dir.
 *
 * Preference order:
 *   1. `id` starts with `dir:` (the master row for the directory — durable
 *      across teammate spawns, see migration 049).
 *   2. Lexicographically smallest id (deterministic across reruns).
 *
 * Returns null if no agents claim that cwd.
 */
function pickCanonicalAgent(rows: AgentRepoRow[]): AgentRepoRow | null {
  if (rows.length === 0) return null;
  const dirRow = rows.find((r) => r.id.startsWith('dir:'));
  if (dirRow) return dirRow;
  return [...rows].sort((a, b) => a.id.localeCompare(b.id))[0];
}

async function loadAttachedSessionIds(): Promise<Set<string>> {
  const sql = await getConnection();
  const rows = await sql<{ claude_session_id: string }[]>`
    SELECT DISTINCT claude_session_id
    FROM executors
    WHERE claude_session_id IS NOT NULL
  `;
  return new Set(rows.map((r: { claude_session_id: string }) => r.claude_session_id));
}

async function isExecutorLive(executorId: string | null): Promise<boolean> {
  if (!executorId) return false;
  const sql = await getConnection();
  const rows = await sql<CurrentExecutorRow[]>`
    SELECT id, ended_at FROM executors WHERE id = ${executorId} LIMIT 1
  `;
  if (rows.length === 0) return false;
  return rows[0].ended_at === null;
}

function listProjectDirs(projectsRoot: string, restrictEncoded: string | null): string[] {
  if (!existsSync(projectsRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot);
  } catch {
    return [];
  }
  const candidates = entries.filter((name) => {
    try {
      return statSync(join(projectsRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (restrictEncoded === null) return candidates;
  return candidates.filter((c) => c === restrictEncoded);
}

function scanDirForOrphans(projectsRoot: string, encodedDir: string, attached: Set<string>) {
  const dirPath = join(projectsRoot, encodedDir);
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return { orphans: [] as OrphanCandidate[], attachedSessionIds: [] as string[] };
  }
  const orphans: OrphanCandidate[] = [];
  const attachedHere: string[] = [];
  for (const name of entries) {
    if (!isSessionJsonl(name)) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (attached.has(sessionId)) {
      attachedHere.push(sessionId);
      continue;
    }
    const full = join(dirPath, name);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    orphans.push({
      sessionId,
      jsonlPath: full,
      size: stats.size,
      mtime: stats.mtime,
      firstMessagePreview: readFirstUserMessagePreview(full),
    });
  }
  orphans.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return { orphans, attachedSessionIds: attachedHere };
}

// ============================================================================
// Core scan + apply
// ============================================================================

export async function scanOrphans(opts: { dir?: string }): Promise<ProjectDirSummary[]> {
  const projectsRoot = resolveProjectsRoot();
  const restrictEncoded = opts.dir ? encodeCwdForClaudeProjects(opts.dir) : null;

  const [agentsByEncoded, attached] = await Promise.all([loadAgentsByEncodedCwd(), loadAttachedSessionIds()]);
  const dirs = listProjectDirs(projectsRoot, restrictEncoded);

  const summaries: ProjectDirSummary[] = [];
  for (const encoded of dirs) {
    const agentRows = agentsByEncoded.get(encoded) ?? [];
    const canonical = pickCanonicalAgent(agentRows);
    const { orphans, attachedSessionIds } = scanDirForOrphans(projectsRoot, encoded, attached);
    if (orphans.length === 0 && attachedSessionIds.length === 0) continue;
    const live = canonical ? await isExecutorLive(canonical.current_executor_id) : false;
    summaries.push({
      encoded,
      realCwd: canonical?.repo_path ?? null,
      agent: canonical ? { id: canonical.id, team: canonical.team, customName: canonical.custom_name } : null,
      agentHasLiveExecutor: live,
      attachedSessionIds,
      orphans,
    });
  }
  // Stable order: dirs with the most orphans first, then alphabetically.
  summaries.sort((a, b) => b.orphans.length - a.orphans.length || a.encoded.localeCompare(b.encoded));
  return summaries;
}

interface AttachOutcome {
  sessionId: string;
  agentId: string;
  executorId: string;
  linked: boolean;
}

async function attachOrphan(opts: {
  agentRow: AgentRepoRow;
  agentLive: boolean;
  candidate: OrphanCandidate;
}): Promise<AttachOutcome> {
  const { agentRow, agentLive, candidate } = opts;
  if (agentLive) {
    throw new Error(
      `agent ${agentRow.id} already has a live executor (current_executor_id=${agentRow.current_executor_id}); refusing to overwrite. Stop the live executor first, or pick a different session.`,
    );
  }

  const metadata = {
    source: 'recover-orphans',
    jsonl_path: candidate.jsonlPath,
    jsonl_mtime: candidate.mtime.toISOString(),
    jsonl_size: candidate.size,
  } as Record<string, unknown>;

  const linkable = agentRow.current_executor_id === null;
  const factory = linkable ? createAndLinkExecutor : createExecutor;
  const executor = await factory(agentRow.id, 'claude', 'tmux', {
    claudeSessionId: candidate.sessionId,
    state: 'terminated',
    metadata,
    repoPath: agentRow.repo_path,
  });

  await recordAuditEvent('executor', executor.id, 'executor.recovered_from_orphan', 'cli', {
    agent_id: agentRow.id,
    claude_session_id: candidate.sessionId,
    jsonl_path: candidate.jsonlPath,
    linked_as_current: linkable,
  });

  return { sessionId: candidate.sessionId, agentId: agentRow.id, executorId: executor.id, linked: linkable };
}

// ============================================================================
// Renderers
// ============================================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRelative(date: Date, now = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatAgentLabel(summary: ProjectDirSummary): string {
  if (!summary.agent) return 'unmapped';
  const team = summary.agent.team;
  const name = summary.agent.customName;
  if (!team && !name) return summary.agent.id;
  return `${summary.agent.id} (${team ?? '?'}/${name ?? '?'})`;
}

function renderOrphanDetails(orphans: OrphanCandidate[]): void {
  if (orphans.length === 0) return;
  const newest = orphans[0];
  const oldest = orphans[orphans.length - 1];
  const totalBytes = orphans.reduce((acc, o) => acc + o.size, 0);
  console.log(
    `  newest:   ${newest.sessionId.slice(0, 8)} · ${formatBytes(newest.size)} · ${formatRelative(newest.mtime)}`,
  );
  if (oldest !== newest) {
    console.log(
      `  oldest:   ${oldest.sessionId.slice(0, 8)} · ${formatBytes(oldest.size)} · ${formatRelative(oldest.mtime)}`,
    );
  }
  console.log(`  total:    ${formatBytes(totalBytes)} across ${orphans.length} JSONL(s)`);
  console.log('  top:');
  for (const o of orphans.slice(0, 5)) {
    const preview = o.firstMessagePreview ? ` — ${o.firstMessagePreview}` : '';
    console.log(`    · ${o.sessionId} · ${formatBytes(o.size)} · ${formatRelative(o.mtime)}${preview}`);
  }
}

function renderProjectDirSummary(summary: ProjectDirSummary): void {
  console.log();
  const cwdLabel = summary.realCwd ?? `(encoded: ${summary.encoded})`;
  const liveTag = summary.agentHasLiveExecutor ? ' \x1b[33m[live executor]\x1b[0m' : '';
  console.log(`\x1b[1m${cwdLabel}\x1b[0m`);
  console.log(`  agent:    ${formatAgentLabel(summary)}${liveTag}`);
  console.log(`  orphans:  ${summary.orphans.length}    attached: ${summary.attachedSessionIds.length}`);
  renderOrphanDetails(summary.orphans);
}

function renderSummary(summaries: ProjectDirSummary[]): void {
  if (summaries.length === 0) {
    console.log('No orphaned Claude session JSONLs detected.');
    return;
  }
  let totalOrphans = 0;
  let totalAttached = 0;
  for (const summary of summaries) {
    totalOrphans += summary.orphans.length;
    totalAttached += summary.attachedSessionIds.length;
    renderProjectDirSummary(summary);
  }
  console.log();
  console.log(
    `\x1b[1mTotal:\x1b[0m ${totalOrphans} orphan(s), ${totalAttached} already attached, ${summaries.length} dir(s).`,
  );
}

function renderApplyReport(
  outcomes: AttachOutcome[],
  skipped: { reason: string; sessionId?: string; encoded?: string }[],
): void {
  if (outcomes.length === 0 && skipped.length === 0) {
    console.log('Nothing to attach.');
    return;
  }
  for (const o of outcomes) {
    const linkNote = o.linked ? ' (linked as current_executor)' : ' (executor created, agent already had current)';
    console.log(`  \x1b[32m✓\x1b[0m ${o.sessionId} → ${o.agentId}${linkNote}`);
  }
  for (const s of skipped) {
    const target = s.sessionId ?? s.encoded ?? '?';
    console.log(`  \x1b[33m!\x1b[0m skipped ${target} — ${s.reason}`);
  }
  console.log();
  console.log(`Attached ${outcomes.length}; skipped ${skipped.length}.`);
}

// ============================================================================
// Apply paths
// ============================================================================

async function applyNewest(summaries: ProjectDirSummary[]): Promise<{
  outcomes: AttachOutcome[];
  skipped: { reason: string; sessionId?: string; encoded?: string }[];
}> {
  const outcomes: AttachOutcome[] = [];
  const skipped: { reason: string; sessionId?: string; encoded?: string }[] = [];
  for (const s of summaries) {
    if (s.orphans.length === 0) continue;
    if (!s.agent) {
      skipped.push({ reason: 'no agent claims this cwd', encoded: s.encoded });
      continue;
    }
    const newest = s.orphans[0];
    if (s.agentHasLiveExecutor) {
      skipped.push({ reason: `agent ${s.agent.id} has a live executor`, sessionId: newest.sessionId });
      continue;
    }
    try {
      const agentRow: AgentRepoRow = {
        id: s.agent.id,
        repo_path: s.realCwd,
        team: s.agent.team,
        custom_name: s.agent.customName,
        current_executor_id: null, // refreshed by query below
      };
      const sql = await getConnection();
      const rows = await sql<{ current_executor_id: string | null }[]>`
        SELECT current_executor_id FROM agents WHERE id = ${agentRow.id} LIMIT 1
      `;
      agentRow.current_executor_id = rows[0]?.current_executor_id ?? null;

      const outcome = await attachOrphan({ agentRow, agentLive: false, candidate: newest });
      outcomes.push(outcome);
    } catch (err) {
      skipped.push({ reason: err instanceof Error ? err.message : String(err), sessionId: newest.sessionId });
    }
  }
  return { outcomes, skipped };
}

async function applyUuid(summaries: ProjectDirSummary[], uuid: string) {
  for (const s of summaries) {
    const candidate = s.orphans.find((o) => o.sessionId === uuid);
    if (!candidate) continue;
    if (!s.agent) {
      return {
        outcomes: [] as AttachOutcome[],
        skipped: [{ reason: 'no agent claims this cwd', sessionId: uuid }],
      };
    }
    if (s.agentHasLiveExecutor) {
      return {
        outcomes: [] as AttachOutcome[],
        skipped: [{ reason: `agent ${s.agent.id} has a live executor`, sessionId: uuid }],
      };
    }
    const sql = await getConnection();
    const rows = await sql<{ current_executor_id: string | null }[]>`
      SELECT current_executor_id FROM agents WHERE id = ${s.agent.id} LIMIT 1
    `;
    const agentRow: AgentRepoRow = {
      id: s.agent.id,
      repo_path: s.realCwd,
      team: s.agent.team,
      custom_name: s.agent.customName,
      current_executor_id: rows[0]?.current_executor_id ?? null,
    };
    try {
      const outcome = await attachOrphan({ agentRow, agentLive: false, candidate });
      return { outcomes: [outcome], skipped: [] as { reason: string; sessionId?: string }[] };
    } catch (err) {
      return {
        outcomes: [] as AttachOutcome[],
        skipped: [{ reason: err instanceof Error ? err.message : String(err), sessionId: uuid }],
      };
    }
  }
  return {
    outcomes: [] as AttachOutcome[],
    skipped: [{ reason: 'session UUID not found among orphans', sessionId: uuid }],
  };
}

// ============================================================================
// Entry point
// ============================================================================

export async function recoverOrphansCommand(options: RecoverOrphansOptions = {}): Promise<void> {
  const projectsRoot = resolveProjectsRoot();
  if (!existsSync(projectsRoot)) {
    console.log(`No Claude projects directory at ${projectsRoot} — nothing to scan.`);
    return;
  }
  if (!(await isAvailable())) {
    console.error('Genie database is unreachable. Start it with `genie serve` and retry.');
    process.exit(1);
  }

  if (options.apply && !options.newest && !options.uuid) {
    console.error('--apply requires either --newest (attach the newest orphan per dir) or --uuid <session-id>.');
    process.exit(2);
  }

  const summaries = await scanOrphans({ dir: options.dir });

  if (!options.apply) {
    renderSummary(summaries);
    return;
  }

  let outcomes: AttachOutcome[] = [];
  let skipped: { reason: string; sessionId?: string; encoded?: string }[] = [];
  if (options.uuid) {
    ({ outcomes, skipped } = await applyUuid(summaries, options.uuid));
  } else if (options.newest) {
    ({ outcomes, skipped } = await applyNewest(summaries));
  }
  renderApplyReport(outcomes, skipped);
}

// Exposed for tests.
export const _internal = {
  encodeCwdForClaudeProjects,
  isSessionJsonl,
  pickCanonicalAgent,
  readFirstUserMessagePreview,
  scanDirForOrphans,
  attachOrphan,
};
