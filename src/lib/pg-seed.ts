/**
 * PG Seed — Idempotent one-time JSON → PostgreSQL data migration.
 *
 * Reads existing JSON state files (workers.json, teams/*.json,
 * mailbox/*.json, chat/*.jsonl) and UPSERTs into PG tables.
 * Source files are renamed to `.migrated` only after all UPSERTs succeed.
 *
 * Safe to re-run: uses INSERT ... ON CONFLICT DO NOTHING.
 * Trigger: source `.json` exists AND `.json.migrated` does NOT.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { type NativeTeamConfig, loadAllNativeTeamConfigs } from './claude-native-teams.js';

type Sql = postgres.Sql;

// ============================================================================
// Path helpers
// ============================================================================

function getGenieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function workersJsonPath(): string {
  return join(getGenieHome(), 'workers.json');
}

/** Check if a source file needs migration (exists and not yet migrated). */
function needsMigration(filePath: string): boolean {
  return existsSync(filePath) && !existsSync(`${filePath}.migrated`);
}

/** Read and parse a JSON file. Returns null on any failure. */
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Rename files matching a filter in a directory to .migrated. */
async function renameMatchingFiles(dir: string, filter: (filename: string) => boolean): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const files = await readdir(dir);
    for (const f of files) {
      if (!filter(f)) continue;
      const fp = join(dir, f);
      if (needsMigration(fp)) {
        await rename(fp, `${fp}.migrated`);
      }
    }
  } catch {
    // Best effort
  }
}

// ============================================================================
// Seed detection — should we run?
// ============================================================================

/**
 * Check if seed should run.
 *
 * Returns true when:
 *  - `~/.genie/workers.json` exists without a `.migrated` sibling (legacy
 *    one-time migration path — worker seed still uses markers), OR
 *  - Any Claude-native team config exists on disk at
 *    `~/.claude/teams/<name>/config.json`.
 *
 * The Claude-native branch triggers on every boot when teams exist on disk.
 * That's intentional: `seedTeams` is idempotent (`ON CONFLICT DO NOTHING`) and
 * this is how we rehydrate PG after a `pgserve` reset. See Bug A in
 * `.genie/wishes/fix-pg-disk-rehydration/WISH.md`.
 */
export function needsSeed(): boolean {
  if (needsMigration(workersJsonPath())) return true;

  // Claude-native team configs are authoritative — if any exist on disk,
  // run the seed so PG mirrors them. No `.migrated` markers here.
  const claudeTeamsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'teams');
  if (!existsSync(claudeTeamsDir)) return false;
  try {
    const entries = require('node:fs').readdirSync(claudeTeamsDir) as string[];
    return entries.some((e) => !e.startsWith('.'));
  } catch {
    return false;
  }
}

// ============================================================================
// Seed workers.json → agents + agent_templates
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: JSON data uses dynamic keys
type JsonRecord = Record<string, any>;

/** Map camelCase JSON agent to snake_case PG row values. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat field mapping with null-coalescing defaults, no branching logic
function toAgentRow(a: JsonRecord): JsonRecord {
  const now = new Date().toISOString();
  return {
    id: a.id,
    pane_id: a.paneId ?? '',
    session: a.session ?? '',
    worktree: a.worktree ?? null,
    task_id: a.taskId ?? null,
    task_title: a.taskTitle ?? null,
    wish_slug: a.wishSlug ?? null,
    group_number: a.groupNumber ?? null,
    started_at: a.startedAt ?? now,
    state: a.state ?? 'spawning',
    last_state_change: a.lastStateChange ?? now,
    repo_path: a.repoPath ?? '',
    window_name: a.windowName ?? null,
    window_id: a.windowId ?? null,
    role: a.role ?? null,
    custom_name: a.customName ?? null,
    // Kept as JS array — serialized via `sql.json()` at write time, not here.
    // Legacy: was `JSON.stringify(a.subPanes ?? [])` which produced double-encoded jsonb strings.
    sub_panes: a.subPanes ?? [],
    provider: a.provider ?? null,
    transport: a.transport ?? 'tmux',
    skill: a.skill ?? null,
    team: a.team ?? null,
    tmux_window: a.window ?? null,
    native_agent_id: a.nativeAgentId ?? null,
    native_color: a.nativeColor ?? null,
    native_team_enabled: a.nativeTeamEnabled ?? false,
    parent_session_id: a.parentSessionId ?? null,
    suspended_at: a.suspendedAt ?? null,
    auto_resume: a.autoResume ?? true,
    resume_attempts: a.resumeAttempts ?? 0,
    last_resume_attempt: a.lastResumeAttempt ?? null,
    max_resume_attempts: a.maxResumeAttempts ?? 3,
    pane_color: null,
  };
}

async function upsertAgent(sql: Sql, a: JsonRecord): Promise<void> {
  const r = toAgentRow(a);
  // NOTE: `r.sub_panes` is kept as a JS array (NativeTeamMember[]) and passed
  // via `sql.json()` so postgres.js encodes it once into a proper jsonb array.
  // Previously this used `JSON.stringify(a.subPanes ?? [])` which double-encoded
  // into a jsonb-string and broke `jsonb_array_length`. See migration 045.
  await sql`
    INSERT INTO agents (
      id, pane_id, session, worktree, task_id, task_title,
      wish_slug, group_number, started_at, state, last_state_change,
      repo_path, window_name, window_id,
      role, custom_name, sub_panes, provider, transport,
      skill, team, tmux_window, native_agent_id, native_color,
      native_team_enabled, parent_session_id, suspended_at,
      auto_resume, resume_attempts, last_resume_attempt, max_resume_attempts,
      pane_color
    ) VALUES (
      ${r.id}, ${r.pane_id}, ${r.session}, ${r.worktree},
      ${r.task_id}, ${r.task_title}, ${r.wish_slug},
      ${r.group_number}, ${r.started_at}, ${r.state},
      ${r.last_state_change}, ${r.repo_path},
      ${r.window_name}, ${r.window_id},
      ${r.role}, ${r.custom_name}, ${sql.json(r.sub_panes)},
      ${r.provider}, ${r.transport}, ${r.skill},
      ${r.team}, ${r.tmux_window}, ${r.native_agent_id},
      ${r.native_color}, ${r.native_team_enabled},
      ${r.parent_session_id}, ${r.suspended_at},
      ${r.auto_resume}, ${r.resume_attempts},
      ${r.last_resume_attempt}, ${r.max_resume_attempts}, ${r.pane_color}
    ) ON CONFLICT (id) DO NOTHING
  `;
}

async function upsertTemplate(sql: Sql, t: JsonRecord): Promise<void> {
  // extra_args stays a JS array until `sql.json()` encodes it once at bind
  // time. See migration 045 for the cleanup of pre-fix rows.
  await sql`
    INSERT INTO agent_templates (
      id, provider, team, role, skill, cwd,
      extra_args, native_team_enabled, last_spawned_at
    ) VALUES (
      ${t.id}, ${t.provider ?? 'claude'}, ${t.team ?? ''},
      ${t.role ?? null}, ${t.skill ?? null}, ${t.cwd ?? ''},
      ${sql.json(t.extraArgs ?? [])},
      ${t.nativeTeamEnabled ?? false},
      ${t.lastSpawnedAt ?? new Date().toISOString()}
    ) ON CONFLICT (id) DO NOTHING
  `;
}

/** Create an executor record from a legacy JSON agent and link it to the agent. */
async function upsertExecutorFromAgent(sql: Sql, a: JsonRecord): Promise<void> {
  const executorId = `exec-${a.id}`;
  const transport = a.transport === 'inline' ? 'process' : (a.transport ?? 'tmux');
  const state = a.state === 'suspended' ? 'terminated' : (a.state ?? 'spawning');
  await sql`
    INSERT INTO executors (
      id, agent_id, provider, transport, pid,
      tmux_session, tmux_pane_id, tmux_window, tmux_window_id,
      claude_session_id, state, metadata, worktree, repo_path, pane_color,
      started_at
    ) VALUES (
      ${executorId}, ${a.id}, ${a.provider ?? 'claude'}, ${transport}, ${null},
      ${a.session ?? null}, ${a.paneId ?? null},
      ${a.window ?? null}, ${a.windowId ?? null},
      ${a.claudeSessionId ?? null}, ${state},
      ${sql.json({})}, ${a.worktree ?? null},
      ${a.repoPath ?? null}, ${null},
      ${a.startedAt ?? new Date().toISOString()}
    ) ON CONFLICT (id) DO NOTHING
  `;
  // Link agent to executor
  await sql`UPDATE agents SET current_executor_id = ${executorId} WHERE id = ${a.id} AND current_executor_id IS NULL`;
}

async function seedWorkers(sql: Sql): Promise<{ agents: number; templates: number }> {
  const filePath = workersJsonPath();
  if (!needsMigration(filePath)) return { agents: 0, templates: 0 };

  const data = await readJson<{ workers?: Record<string, JsonRecord>; templates?: Record<string, JsonRecord> }>(
    filePath,
  );
  if (!data) return { agents: 0, templates: 0 };

  let agentCount = 0;
  for (const agent of Object.values(data.workers ?? {})) {
    if (!agent.id) continue;
    await upsertAgent(sql, agent);
    // Also create an executor record for the migrated agent
    await upsertExecutorFromAgent(sql, agent);
    agentCount++;
  }

  let templateCount = 0;
  for (const tpl of Object.values(data.templates ?? {})) {
    if (!tpl.id) continue;
    await upsertTemplate(sql, tpl);
    templateCount++;
  }

  return { agents: agentCount, templates: templateCount };
}

// ============================================================================
// Seed ~/.claude/teams/<name>/config.json → teams
// ============================================================================
//
// The old layout (`~/.genie/teams/*.json` with `.migrated` markers) is dead.
// The live system writes Claude-native configs under `~/.claude/teams/<name>/
// config.json`. This seed reads those configs and upserts full team rows into
// PG so `genie team ls` mirrors disk after any pgserve reset.
//
// Disk is authoritative — this path never writes back. Configs are re-read
// every boot; there are no migration markers. See Bug A in
// `.genie/wishes/fix-pg-disk-rehydration/WISH.md`.

/** Derive the bare leader name from Claude-native `leadAgentId` (`name@team`). */
function deriveLeader(cfg: NativeTeamConfig): string | null {
  if (!cfg.leadAgentId) return null;
  const at = cfg.leadAgentId.indexOf('@');
  return at === -1 ? cfg.leadAgentId : cfg.leadAgentId.slice(0, at);
}

/**
 * UPSERT a team row from a Claude-native config.
 *
 * Members are mapped from rich `NativeTeamMember[]` → bare `string[]` (the PG
 * column stores names only). Writes via `sql.json(names)` so postgres.js
 * encodes the array once into a proper jsonb array. ON CONFLICT DO NOTHING —
 * the seed is an idempotent backfill; `ensureTeamRow` owns the hot update
 * path and may refresh fields there.
 */
async function upsertNativeTeam(sql: Sql, c: NativeTeamConfig): Promise<void> {
  const memberNames = (c.members ?? []).map((m) => m.name).filter((n) => typeof n === 'string' && n.length > 0);
  await sql`
    INSERT INTO teams (
      name, repo, base_branch, worktree_path, leader,
      members, status, native_team_parent_session_id,
      native_teams_enabled, tmux_session_name, wish_slug, created_at
    ) VALUES (
      ${c.name}, ${c.repo ?? ''}, ${c.baseBranch ?? 'dev'},
      ${c.worktreePath ?? ''}, ${deriveLeader(c)},
      ${sql.json(memberNames)}, ${c.status ?? 'in_progress'},
      ${c.nativeTeamParentSessionId ?? null}, ${c.nativeTeamsEnabled ?? true},
      ${c.tmuxSessionName ?? null}, ${c.wishSlug ?? null},
      ${new Date(c.createdAt ?? Date.now()).toISOString()}
    ) ON CONFLICT (name) DO NOTHING
  `;
}

async function seedTeams(sql: Sql): Promise<number> {
  const configs = await loadAllNativeTeamConfigs();
  let count = 0;
  for (const cfg of configs) {
    if (!cfg?.name) continue;
    try {
      await upsertNativeTeam(sql, cfg);
      count++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pg-seed] Failed to seed team "${cfg.name}": ${msg}`);
    }
  }
  return count;
}

// ============================================================================
// Seed mailbox/*.json → mailbox (scoped by repo_path)
// ============================================================================

async function upsertMailboxMessage(sql: Sql, msg: JsonRecord, repoPath: string, fallbackTo: string): Promise<void> {
  await sql`
    INSERT INTO mailbox (
      id, from_worker, to_worker, body, repo_path,
      read, delivered_at, created_at
    ) VALUES (
      ${msg.id}, ${msg.from ?? 'unknown'}, ${msg.to ?? fallbackTo},
      ${msg.body ?? ''}, ${repoPath}, ${msg.read ?? false},
      ${msg.deliveredAt ?? null}, ${msg.createdAt ?? new Date().toISOString()}
    ) ON CONFLICT (id) DO NOTHING
  `;
}

function isMailboxFile(filename: string): boolean {
  return filename.endsWith('.json') && !filename.endsWith('.migrated') && !filename.includes('-sent');
}

async function seedMailbox(sql: Sql, repoPath: string): Promise<number> {
  const dir = join(repoPath, '.genie', 'mailbox');
  if (!existsSync(dir)) return 0;

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const file of files) {
    if (!isMailboxFile(file)) continue;
    if (!needsMigration(join(dir, file))) continue;

    const data = await readJson<{ messages?: JsonRecord[] }>(join(dir, file));
    if (!data?.messages || !Array.isArray(data.messages)) continue;

    const fallbackTo = file.replace('.json', '');
    for (const msg of data.messages) {
      if (!msg.id) continue;
      await upsertMailboxMessage(sql, msg, repoPath, fallbackTo);
      count++;
    }
  }

  return count;
}

// ============================================================================
// Seed chat/*.jsonl → team_chat (scoped by repo_path)
// ============================================================================

async function upsertChatMessage(sql: Sql, msg: JsonRecord, teamName: string, repoPath: string): Promise<void> {
  await sql`
    INSERT INTO team_chat (
      id, team, repo_path, sender, body, created_at
    ) VALUES (
      ${msg.id}, ${teamName}, ${repoPath},
      ${msg.sender ?? 'unknown'}, ${msg.body ?? ''},
      ${msg.timestamp ?? new Date().toISOString()}
    ) ON CONFLICT (id) DO NOTHING
  `;
}

/** Parse JSONL content into valid records with an id field. */
function parseJsonlRecords(content: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of content.trim().split('\n').filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.id) records.push(msg);
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

async function seedTeamChat(sql: Sql, repoPath: string): Promise<number> {
  const dir = join(repoPath, '.genie', 'chat');
  if (!existsSync(dir)) return 0;

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const file of files) {
    if (!file.endsWith('.jsonl') || file.endsWith('.migrated')) continue;
    if (!needsMigration(join(dir, file))) continue;

    const teamName = file.replace('.jsonl', '').replace(/--/g, '/');
    let content: string;
    try {
      content = await readFile(join(dir, file), 'utf-8');
    } catch {
      continue;
    }

    for (const msg of parseJsonlRecords(content)) {
      await upsertChatMessage(sql, msg, teamName, repoPath);
      count++;
    }
  }

  return count;
}

// ============================================================================
// Rename source files to .migrated
// ============================================================================

async function markMigrated(repoPath?: string): Promise<void> {
  // Mark workers.json
  const workersPath = workersJsonPath();
  if (needsMigration(workersPath)) {
    await rename(workersPath, `${workersPath}.migrated`);
  }

  // NOTE: Claude-native team configs at `~/.claude/teams/<name>/config.json`
  // are NOT marked as migrated. They are the authoritative on-disk source and
  // must remain readable on every boot so the seed can rehydrate PG after any
  // `pgserve` reset. See `seedTeams` above.

  if (!repoPath) return;

  // Mark mailbox/*.json (exclude -sent outbox files)
  await renameMatchingFiles(join(repoPath, '.genie', 'mailbox'), isMailboxFile);

  // Mark chat/*.jsonl
  await renameMatchingFiles(join(repoPath, '.genie', 'chat'), (f) => f.endsWith('.jsonl') && !f.endsWith('.migrated'));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run the full idempotent seed: JSON → PG.
 *
 * 1. UPSERTs all data from JSON files into PG tables
 * 2. Renames source files to `.migrated` only after ALL UPSERTs succeed
 *
 * Safe to call multiple times — ON CONFLICT DO NOTHING prevents duplicates.
 * Safe to interrupt — source files remain until all UPSERTs complete.
 *
 * @param sql - postgres.js connection
 * @param repoPath - optional repo path for mailbox/chat (repo-scoped files)
 */
export async function runSeed(sql: Sql, repoPath?: string): Promise<SeedResult> {
  const result: SeedResult = {
    agents: 0,
    templates: 0,
    teams: 0,
    mailboxMessages: 0,
    chatMessages: 0,
  };

  // Phase 1: UPSERT all data
  const workers = await seedWorkers(sql);
  result.agents = workers.agents;
  result.templates = workers.templates;

  result.teams = await seedTeams(sql);

  if (repoPath) {
    result.mailboxMessages = await seedMailbox(sql, repoPath);
    result.chatMessages = await seedTeamChat(sql, repoPath);
  }

  // Phase 2: Mark source files as migrated (only after all UPSERTs succeed)
  await markMigrated(repoPath);

  return result;
}

interface SeedResult {
  agents: number;
  templates: number;
  teams: number;
  mailboxMessages: number;
  chatMessages: number;
}
