/**
 * Agent Registry — Agent identity CRUD + legacy runtime functions.
 *
 * All state is persisted in PostgreSQL (`agents` and `agent_templates` tables).
 * PG transactions replace file locks — no acquireLock needed.
 *
 * ## Executor Model (v4)
 *
 * New identity-focused API:
 *   findOrCreateAgent(), getAgent(), getAgentByName(), setCurrentExecutor(),
 *   getAgentEffectiveState(), listAgents()
 *
 * Legacy functions (register, update, findByPane, etc.) are preserved for
 * backward compatibility during the transition. They will be migrated to
 * use executor-registry in Groups 6-7.
 */

import { createHash, randomUUID } from 'node:crypto';
import { recordAuditEvent } from './audit.js';
import { type Sql, getConnection } from './db.js';
import type { AgentIdentity, ExecutorState } from './executor-types.js';
import type { ProviderName } from './provider-adapters.js';

export type AgentState = 'spawning' | 'working' | 'idle' | 'permission' | 'question' | 'done' | 'error' | 'suspended';
export type TransportType = 'tmux' | 'inline';

export interface Agent {
  id: string;
  paneId: string;
  session: string;
  worktree: string | null;
  taskId?: string;
  taskTitle?: string;
  wishSlug?: string;
  groupNumber?: number;
  startedAt: string;
  state: AgentState;
  lastStateChange: string;
  repoPath: string;
  claudeSessionId?: string;
  windowName?: string;
  windowId?: string;
  role?: string;
  customName?: string;
  subPanes?: string[];
  provider?: ProviderName;
  transport?: TransportType;
  skill?: string;
  team?: string;
  window?: string;
  nativeAgentId?: string;
  nativeColor?: string;
  nativeTeamEnabled?: boolean;
  parentSessionId?: string;
  suspendedAt?: string;
  autoResume?: boolean;
  resumeAttempts?: number;
  lastResumeAttempt?: string;
  maxResumeAttempts?: number;
  paneColor?: string;
  /** FK to current active executor. Added by executor model (Group 2). */
  currentExecutorId?: string | null;
  /** Self-ref for org tree hierarchy (NULL = root). */
  reportsTo?: string | null;
  /** Agent title in org context (CPO, CTO, Research Lead). */
  title?: string | null;
}

export interface WorkerTemplate {
  id: string;
  provider: ProviderName;
  team: string;
  role?: string;
  skill?: string;
  cwd: string;
  extraArgs?: string[];
  nativeTeamEnabled?: boolean;
  lastSpawnedAt: string;
}

interface AgentRow {
  id: string;
  pane_id: string;
  session: string;
  worktree: string | null;
  task_id: string | null;
  task_title: string | null;
  wish_slug: string | null;
  group_number: number | null;
  started_at: Date | string;
  state: AgentState;
  last_state_change: Date | string;
  repo_path: string;
  claude_session_id: string | null;
  window_name: string | null;
  window_id: string | null;
  role: string | null;
  custom_name: string | null;
  sub_panes: string | string[] | null;
  provider: ProviderName | null;
  transport: TransportType | null;
  skill: string | null;
  team: string | null;
  tmux_window: string | null;
  native_agent_id: string | null;
  native_color: string | null;
  native_team_enabled: boolean;
  parent_session_id: string | null;
  suspended_at: Date | string | null;
  auto_resume: boolean | null;
  resume_attempts: number | null;
  last_resume_attempt: Date | string | null;
  max_resume_attempts: number | null;
  pane_color: string | null;
  current_executor_id: string | null;
  reports_to: string | null;
  title: string | null;
}

interface TemplateRow {
  id: string;
  provider: ProviderName;
  team: string;
  role: string | null;
  skill: string | null;
  cwd: string;
  extra_args: string | string[] | null;
  native_team_enabled: boolean;
  last_spawned_at: Date | string;
}

function ts(v: Date | string | null): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : v;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat field mapping
function rowToAgent(r: AgentRow): Agent {
  const agent: Agent = {
    id: r.id,
    paneId: r.pane_id,
    session: r.session,
    worktree: r.worktree ?? null,
    startedAt: ts(r.started_at),
    state: r.state,
    lastStateChange: ts(r.last_state_change),
    repoPath: r.repo_path,
  };
  if (r.task_id != null) agent.taskId = r.task_id;
  if (r.task_title != null) agent.taskTitle = r.task_title;
  if (r.wish_slug != null) agent.wishSlug = r.wish_slug;
  if (r.group_number != null) agent.groupNumber = r.group_number;
  if (r.claude_session_id != null) agent.claudeSessionId = r.claude_session_id;
  if (r.window_name != null) agent.windowName = r.window_name;
  if (r.window_id != null) agent.windowId = r.window_id;
  if (r.role != null) agent.role = r.role;
  if (r.custom_name != null) agent.customName = r.custom_name;
  if (r.sub_panes != null) {
    const sp = typeof r.sub_panes === 'string' ? JSON.parse(r.sub_panes) : r.sub_panes;
    if (Array.isArray(sp) && sp.length > 0) agent.subPanes = sp;
  }
  if (r.provider != null) agent.provider = r.provider;
  if (r.transport != null) agent.transport = r.transport;
  if (r.skill != null) agent.skill = r.skill;
  if (r.team != null) agent.team = r.team;
  if (r.tmux_window != null) agent.window = r.tmux_window;
  if (r.native_agent_id != null) agent.nativeAgentId = r.native_agent_id;
  if (r.native_color != null) agent.nativeColor = r.native_color;
  if (r.native_team_enabled) agent.nativeTeamEnabled = r.native_team_enabled;
  if (r.parent_session_id != null) agent.parentSessionId = r.parent_session_id;
  if (r.suspended_at != null) agent.suspendedAt = ts(r.suspended_at);
  if (r.auto_resume != null) agent.autoResume = r.auto_resume;
  if (r.resume_attempts != null) agent.resumeAttempts = r.resume_attempts;
  if (r.last_resume_attempt != null) agent.lastResumeAttempt = ts(r.last_resume_attempt);
  if (r.max_resume_attempts != null) agent.maxResumeAttempts = r.max_resume_attempts;
  if (r.pane_color != null) agent.paneColor = r.pane_color;
  agent.currentExecutorId = r.current_executor_id ?? null;
  agent.reportsTo = r.reports_to ?? null;
  agent.title = r.title ?? null;
  return agent;
}

function rowToTemplate(r: TemplateRow): WorkerTemplate {
  const tpl: WorkerTemplate = {
    id: r.id,
    provider: r.provider,
    team: r.team,
    cwd: r.cwd,
    lastSpawnedAt: ts(r.last_spawned_at),
  };
  if (r.role != null) tpl.role = r.role;
  if (r.skill != null) tpl.skill = r.skill;
  if (r.extra_args != null) {
    const ea = typeof r.extra_args === 'string' ? JSON.parse(r.extra_args) : r.extra_args;
    if (Array.isArray(ea) && ea.length > 0) tpl.extraArgs = ea;
  }
  if (r.native_team_enabled) tpl.nativeTeamEnabled = r.native_team_enabled;
  return tpl;
}

function shortProjectHash(repoPath: string): string {
  return createHash('sha1').update(repoPath).digest('hex').slice(0, 8);
}
function buildProjectTeamLeadEntryId(teamName: string, session: string, repoPath: string): string {
  return `team-lead:${session}:${shortProjectHash(repoPath)}:${teamName}`;
}
function buildSessionTeamLeadEntryId(teamName: string, session: string): string {
  return `team-lead:${session}:${teamName}`;
}
function buildLegacyTeamLeadEntryId(teamName: string): string {
  return `team-lead:${teamName}`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat field mapping
export async function register(agent: Agent): Promise<void> {
  const sql = await getConnection();
  const now = new Date().toISOString();
  await sql`INSERT INTO agents (id, pane_id, session, worktree, task_id, task_title, wish_slug, group_number, started_at, state, last_state_change, repo_path, claude_session_id, window_name, window_id, role, custom_name, sub_panes, provider, transport, skill, team, tmux_window, native_agent_id, native_color, native_team_enabled, parent_session_id, suspended_at, auto_resume, resume_attempts, last_resume_attempt, max_resume_attempts, pane_color) VALUES (${agent.id}, ${agent.paneId}, ${agent.session}, ${agent.worktree ?? null}, ${agent.taskId ?? null}, ${agent.taskTitle ?? null}, ${agent.wishSlug ?? null}, ${agent.groupNumber ?? null}, ${agent.startedAt ?? now}, ${agent.state ?? 'spawning'}, ${agent.lastStateChange ?? now}, ${agent.repoPath}, ${agent.claudeSessionId ?? null}, ${agent.windowName ?? null}, ${agent.windowId ?? null}, ${agent.role ?? null}, ${agent.customName ?? null}, ${sql.json(agent.subPanes ?? [])}, ${agent.provider ?? null}, ${agent.transport ?? 'tmux'}, ${agent.skill ?? null}, ${agent.team ?? null}, ${agent.window ?? null}, ${agent.nativeAgentId ?? null}, ${agent.nativeColor ?? null}, ${agent.nativeTeamEnabled ?? false}, ${agent.parentSessionId ?? null}, ${agent.suspendedAt ?? null}, ${agent.autoResume ?? true}, ${agent.resumeAttempts ?? 0}, ${agent.lastResumeAttempt ?? null}, ${agent.maxResumeAttempts ?? 3}, ${agent.paneColor ?? null}) ON CONFLICT (id) DO UPDATE SET pane_id = EXCLUDED.pane_id, session = EXCLUDED.session, state = EXCLUDED.state, last_state_change = EXCLUDED.last_state_change, updated_at = now()`;
}

export async function unregister(id: string): Promise<void> {
  const sql = await getConnection();
  await sql`DELETE FROM agents WHERE id = ${id}`;
}

export async function get(id: string): Promise<Agent | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM agents WHERE id = ${id}`;
  return rows.length > 0 ? rowToAgent(rows[0]) : null;
}

export async function list(): Promise<Agent[]> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM agents`;
  return rows.map(rowToAgent);
}

/**
 * Reconcile stale spawns: reset agents stuck in 'spawning' state
 * with no pane_id for longer than the threshold back to 'error'.
 * Returns the IDs of agents that were reset.
 *
 * @param thresholdSeconds - How long an agent must be stuck before reset (default: 60)
 */
export async function reconcileStaleSpawns(thresholdSeconds = 60): Promise<string[]> {
  try {
    const sql = await getConnection();
    const rows = await sql<{ id: string }[]>`
      UPDATE agents
      SET state = 'error', last_state_change = now()
      WHERE state = 'spawning'
        AND (pane_id IS NULL OR pane_id = '')
        AND started_at < now() - interval '1 second' * ${thresholdSeconds}
      RETURNING id
    `;
    for (const row of rows) {
      console.error(`[reconcile] Reset stuck agent ${row.id} from spawning → error`);
      recordAuditEvent('worker', row.id, 'state_changed', 'reconciler', {
        state: 'error',
        reason: 'stale_spawn',
      }).catch(() => {});
    }
    return rows.map((r: { id: string }) => r.id);
  } catch {
    return []; // Best-effort — don't block startup if DB is unavailable
  }
}

export async function filterBySession(sessionName: string): Promise<Agent[]> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM agents WHERE session = ${sessionName}`;
  return rows.map(rowToAgent);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat field mapping
export async function update(id: string, updates: Partial<Agent>): Promise<void> {
  const sql = await getConnection();
  const s: Record<string, unknown> = {};
  if (updates.paneId !== undefined) s.pane_id = updates.paneId;
  if (updates.session !== undefined) s.session = updates.session;
  if (updates.worktree !== undefined) s.worktree = updates.worktree;
  if (updates.taskId !== undefined) s.task_id = updates.taskId;
  if (updates.taskTitle !== undefined) s.task_title = updates.taskTitle;
  if (updates.wishSlug !== undefined) s.wish_slug = updates.wishSlug;
  if (updates.groupNumber !== undefined) s.group_number = updates.groupNumber;
  if (updates.startedAt !== undefined) s.started_at = updates.startedAt;
  if (updates.state !== undefined) {
    s.state = updates.state;
    s.last_state_change = new Date().toISOString();
    // Emit audit event for state transitions
    recordAuditEvent('worker', id, 'state_changed', process.env.GENIE_AGENT_NAME ?? 'cli', {
      state: updates.state,
    }).catch(() => {});
  }
  if (updates.lastStateChange !== undefined) s.last_state_change = updates.lastStateChange;
  if (updates.repoPath !== undefined) s.repo_path = updates.repoPath;
  if (updates.claudeSessionId !== undefined) s.claude_session_id = updates.claudeSessionId;
  if (updates.windowName !== undefined) s.window_name = updates.windowName;
  if (updates.windowId !== undefined) s.window_id = updates.windowId;
  if (updates.role !== undefined) s.role = updates.role;
  if (updates.customName !== undefined) s.custom_name = updates.customName;
  if (updates.subPanes !== undefined) s.sub_panes = sql.json(updates.subPanes);
  if (updates.provider !== undefined) s.provider = updates.provider;
  if (updates.transport !== undefined) s.transport = updates.transport;
  if (updates.skill !== undefined) s.skill = updates.skill;
  if (updates.team !== undefined) s.team = updates.team;
  if (updates.window !== undefined) s.tmux_window = updates.window;
  if (updates.nativeAgentId !== undefined) s.native_agent_id = updates.nativeAgentId;
  if (updates.nativeColor !== undefined) s.native_color = updates.nativeColor;
  if (updates.nativeTeamEnabled !== undefined) s.native_team_enabled = updates.nativeTeamEnabled;
  if (updates.parentSessionId !== undefined) s.parent_session_id = updates.parentSessionId;
  if (updates.suspendedAt !== undefined) s.suspended_at = updates.suspendedAt;
  if (updates.autoResume !== undefined) s.auto_resume = updates.autoResume;
  if (updates.resumeAttempts !== undefined) s.resume_attempts = updates.resumeAttempts;
  if (updates.lastResumeAttempt !== undefined) s.last_resume_attempt = updates.lastResumeAttempt;
  if (updates.maxResumeAttempts !== undefined) s.max_resume_attempts = updates.maxResumeAttempts;
  if (updates.paneColor !== undefined) s.pane_color = updates.paneColor;
  if (Object.keys(s).length === 0) return;
  await sql`UPDATE agents SET ${sql(s)} WHERE id = ${id}`;
}

export async function findByPane(paneId: string): Promise<Agent | null> {
  const sql = await getConnection();
  const n = paneId.startsWith('%') ? paneId : `%${paneId}`;
  const rows = await sql`SELECT * FROM agents WHERE pane_id = ${n}`;
  return rows.length > 0 ? rowToAgent(rows[0]) : null;
}
export async function findByWindow(windowId: string): Promise<Agent | null> {
  const sql = await getConnection();
  const n = windowId.startsWith('@') ? windowId : `@${windowId}`;
  const rows = await sql`SELECT * FROM agents WHERE window_id = ${n}`;
  return rows.length > 0 ? rowToAgent(rows[0]) : null;
}
export async function findByTask(taskId: string): Promise<Agent | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM agents WHERE task_id = ${taskId} LIMIT 1`;
  return rows.length > 0 ? rowToAgent(rows[0]) : null;
}

export function getElapsedTime(agent: Agent): { ms: number; formatted: string } {
  const ms = Date.now() - new Date(agent.startedAt).getTime();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  let formatted: string;
  if (h > 0) formatted = `${h}h ${m % 60}m`;
  else if (m > 0) formatted = `${m}m`;
  else formatted = '<1m';
  return { ms, formatted };
}

export async function addSubPane(workerId: string, paneId: string, _registryPath?: string): Promise<void> {
  const agent = await get(workerId);
  if (!agent) return;
  const subPanes = [...(agent.subPanes ?? []), paneId];
  const sql = await getConnection();
  await sql`UPDATE agents SET sub_panes = ${sql.json(subPanes)} WHERE id = ${workerId}`;
}
export async function getPane(workerId: string, index: number, _registryPath?: string): Promise<string | null> {
  const agent = await get(workerId);
  if (!agent) return null;
  if (index === 0) return agent.paneId;
  const si = index - 1;
  if (!agent.subPanes || si >= agent.subPanes.length || si < 0) return null;
  return agent.subPanes[si];
}
export async function removeSubPane(workerId: string, paneId: string, _registryPath?: string): Promise<void> {
  const agent = await get(workerId);
  if (!agent?.subPanes) return;
  const filtered = agent.subPanes.filter((p) => p !== paneId);
  const sql = await getConnection();
  await sql`UPDATE agents SET sub_panes = ${sql.json(filtered)} WHERE id = ${workerId}`;
}

/** Resolve the dynamic leader name for a team. Never returns 'team-lead'. */
async function resolveDynamicLeaderName(teamName: string): Promise<string | null> {
  try {
    const { resolveLeaderName } = await import('./team-manager.js');
    const name = await resolveLeaderName(teamName);
    return name !== teamName ? name : null;
  } catch {
    return null;
  }
}

export async function getTeamLeadEntry(teamName: string, session?: string, repoPath?: string): Promise<Agent | null> {
  const sql = await getConnection();
  if (session) return findTeamLeadBySession(sql, teamName, session, repoPath);
  const legacyId = buildLegacyTeamLeadEntryId(teamName);
  const lr = await sql`SELECT * FROM agents WHERE id = ${legacyId}`;
  if (lr.length > 0) return rowToAgent(lr[0]);

  const leaderName = await resolveDynamicLeaderName(teamName);
  const sr = leaderName
    ? await sql`SELECT * FROM agents WHERE (role = 'team-lead' OR role = ${leaderName}) AND team = ${teamName} ORDER BY started_at DESC LIMIT 1`
    : await sql`SELECT * FROM agents WHERE role = 'team-lead' AND team = ${teamName} ORDER BY started_at DESC LIMIT 1`;
  return sr.length > 0 ? rowToAgent(sr[0]) : null;
}

async function findTeamLeadBySession(
  sql: Sql,
  teamName: string,
  session: string,
  repoPath?: string,
): Promise<Agent | null> {
  if (repoPath) {
    const rows = await sql<
      AgentRow[]
    >`SELECT * FROM agents WHERE id = ${buildProjectTeamLeadEntryId(teamName, session, repoPath)}`;
    if (rows.length > 0) return rowToAgent(rows[0]);
  }
  const sessRows = await sql<
    AgentRow[]
  >`SELECT * FROM agents WHERE id = ${buildSessionTeamLeadEntryId(teamName, session)}`;
  if (sessRows.length > 0) {
    const a = rowToAgent(sessRows[0]);
    if (!repoPath || a.repoPath === repoPath) return a;
  }
  const legRows = await sql<AgentRow[]>`SELECT * FROM agents WHERE id = ${buildLegacyTeamLeadEntryId(teamName)}`;
  if (legRows.length > 0) {
    const a = rowToAgent(legRows[0]);
    if (a.session === session && (!repoPath || a.repoPath === repoPath)) return a;
  }

  const leaderName = await resolveDynamicLeaderName(teamName);
  const scanRows = leaderName
    ? await sql<
        AgentRow[]
      >`SELECT * FROM agents WHERE (role = 'team-lead' OR role = ${leaderName}) AND team = ${teamName} AND session = ${session} ${repoPath ? sql`AND repo_path = ${repoPath}` : sql``} LIMIT 1`
    : await sql<
        AgentRow[]
      >`SELECT * FROM agents WHERE role = 'team-lead' AND team = ${teamName} AND session = ${session} ${repoPath ? sql`AND repo_path = ${repoPath}` : sql``} LIMIT 1`;
  return scanRows.length > 0 ? rowToAgent(scanRows[0]) : null;
}

export async function saveTemplate(template: WorkerTemplate): Promise<void> {
  const sql = await getConnection();
  await sql`INSERT INTO agent_templates (id, provider, team, role, skill, cwd, extra_args, native_team_enabled, last_spawned_at) VALUES (${template.id}, ${template.provider}, ${template.team}, ${template.role ?? null}, ${template.skill ?? null}, ${template.cwd}, ${sql.json(template.extraArgs ?? [])}, ${template.nativeTeamEnabled ?? false}, ${template.lastSpawnedAt}) ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, team = EXCLUDED.team, role = EXCLUDED.role, skill = EXCLUDED.skill, cwd = EXCLUDED.cwd, extra_args = EXCLUDED.extra_args, native_team_enabled = EXCLUDED.native_team_enabled, last_spawned_at = EXCLUDED.last_spawned_at`;
}

export async function listTemplates(): Promise<WorkerTemplate[]> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM agent_templates`;
  return rows.map(rowToTemplate);
}

// ============================================================================
// Identity-Focused API (Executor Model v4)
// ============================================================================

/** Row shape for identity-only agent queries. */
interface AgentIdentityRow {
  id: string;
  started_at: Date | string;
  role: string | null;
  custom_name: string | null;
  team: string | null;
  native_agent_id: string | null;
  native_color: string | null;
  native_team_enabled: boolean;
  parent_session_id: string | null;
  current_executor_id: string | null;
  reports_to: string | null;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToAgentIdentity(r: AgentIdentityRow): AgentIdentity {
  return {
    id: r.id,
    startedAt: ts(r.started_at),
    role: r.role ?? undefined,
    customName: r.custom_name ?? undefined,
    team: r.team ?? undefined,
    nativeAgentId: r.native_agent_id ?? undefined,
    nativeColor: r.native_color ?? undefined,
    nativeTeamEnabled: r.native_team_enabled || undefined,
    parentSessionId: r.parent_session_id ?? undefined,
    currentExecutorId: r.current_executor_id ?? null,
    reportsTo: r.reports_to ?? null,
    title: r.title ?? null,
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

/**
 * Find or create an agent by (custom_name, team) composite key.
 * If an agent with matching name+team exists, returns it.
 * Otherwise creates a new agent with a generated UUID.
 */
export async function findOrCreateAgent(name: string, team: string, role?: string): Promise<AgentIdentity> {
  const sql = await getConnection();

  // Try to find existing agent by composite unique (custom_name, team)
  const existing = await sql<AgentIdentityRow[]>`
    SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
           native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
    FROM agents
    WHERE custom_name = ${name} AND team = ${team}
    LIMIT 1
  `;
  if (existing.length > 0) return rowToAgentIdentity(existing[0]);

  // Create new agent with identity columns only
  const id = randomUUID();
  const now = new Date().toISOString();
  const rows = await sql<AgentIdentityRow[]>`
    INSERT INTO agents (id, custom_name, team, role, started_at, created_at, updated_at)
    VALUES (${id}, ${name}, ${team}, ${role ?? null}, ${now}, ${now}, ${now})
    ON CONFLICT (custom_name, team) WHERE custom_name IS NOT NULL AND team IS NOT NULL
    DO UPDATE SET updated_at = now()
    RETURNING id, started_at, role, custom_name, team, native_agent_id, native_color,
              native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
  `;

  return rowToAgentIdentity(rows[0]);
}

/** Get an agent identity by ID. */
export async function getAgent(id: string): Promise<AgentIdentity | null> {
  const sql = await getConnection();
  const rows = await sql<AgentIdentityRow[]>`
    SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
           native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
    FROM agents WHERE id = ${id}
  `;
  return rows.length > 0 ? rowToAgentIdentity(rows[0]) : null;
}

/** Get an agent identity by (custom_name, team) composite key. */
export async function getAgentByName(name: string, team: string): Promise<AgentIdentity | null> {
  const sql = await getConnection();
  const rows = await sql<AgentIdentityRow[]>`
    SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
           native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
    FROM agents WHERE custom_name = ${name} AND team = ${team}
    LIMIT 1
  `;
  return rows.length > 0 ? rowToAgentIdentity(rows[0]) : null;
}

/** Set the current executor FK on an agent. Pass null to clear. */
export async function setCurrentExecutor(agentId: string, executorId: string | null): Promise<void> {
  const sql = await getConnection();
  await sql`UPDATE agents SET current_executor_id = ${executorId} WHERE id = ${agentId}`;
}

/**
 * Get the effective state of an agent: the state of its current executor,
 * or 'offline' if no executor is assigned.
 */
export async function getAgentEffectiveState(agentId: string): Promise<ExecutorState | 'offline'> {
  const sql = await getConnection();
  const rows = await sql<{ state: ExecutorState }[]>`
    SELECT e.state FROM executors e
    JOIN agents a ON a.current_executor_id = e.id
    WHERE a.id = ${agentId}
  `;
  return rows.length > 0 ? rows[0].state : 'offline';
}

/** Filter options for listing agents. */
interface ListAgentsFilter {
  team?: string;
  role?: string;
}

/** List agent identities with optional filters. */
export async function listAgents(filters?: ListAgentsFilter): Promise<AgentIdentity[]> {
  const sql = await getConnection();
  let rows: AgentIdentityRow[];

  if (filters?.team && filters?.role) {
    rows = await sql<AgentIdentityRow[]>`
      SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
             native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
      FROM agents WHERE team = ${filters.team} AND role = ${filters.role}
    `;
  } else if (filters?.team) {
    rows = await sql<AgentIdentityRow[]>`
      SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
             native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
      FROM agents WHERE team = ${filters.team}
    `;
  } else if (filters?.role) {
    rows = await sql<AgentIdentityRow[]>`
      SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
             native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
      FROM agents WHERE role = ${filters.role}
    `;
  } else {
    rows = await sql<AgentIdentityRow[]>`
      SELECT id, started_at, role, custom_name, team, native_agent_id, native_color,
             native_team_enabled, parent_session_id, current_executor_id, reports_to, title, created_at, updated_at
      FROM agents
    `;
  }

  return rows.map(rowToAgentIdentity);
}
