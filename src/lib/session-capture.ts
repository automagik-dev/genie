/**
 * Session Capture v2 — Shared core for filewatch + backfill.
 *
 * Replaces session-ingester.ts with:
 *   - Async I/O only (no statSync/readSync)
 *   - Line-safe chunked reads (64KB default)
 *   - Tool event extraction with full I/O and auto-parsed sub_tool
 *   - Subagent session discovery
 *   - Offset committed in same PG transaction as content + tool_events
 */

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
type SqlClient = any;

// ============================================================================
// Live work coordination (shared with filewatch + backfill)
// ============================================================================

/** Set by filewatch when processing events, checked by backfill before each file. */
export let liveWorkPending = false;

export function setLiveWorkPending(v: boolean): void {
  liveWorkPending = v;
}

// ============================================================================
// Types
// ============================================================================

interface DiscoveredFile {
  sessionId: string;
  jsonlPath: string;
  projectPath: string;
  parentSessionId: string | null;
  isSubagent: boolean;
  mtime: number;
  fileSize: number;
}

interface ContentRow {
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  tool_name: string | null;
  timestamp: string;
}

interface ToolEventRow {
  session_id: string;
  turn_index: number;
  timestamp: string;
  tool_name: string;
  sub_tool: string | null;
  tool_use_id: string | null;
  input_raw: string | null;
  output_raw: string | null;
  is_error: boolean;
  error_message: string | null;
  duration_ms: number | null;
  agent_id: string | null;
  team: string | null;
  wish_slug: string | null;
  task_id: string | null;
}

interface WorkerMatch {
  agentId: string;
  executorId: string | null;
  team: string | null;
  wishSlug: string | null;
  taskId: string | null;
  role: string | null;
}

interface IngestResult {
  newOffset: number;
  contentRowsInserted: number;
  toolEventsInserted: number;
}

// ============================================================================
// JSONL types (matching Claude Code output format)
// ============================================================================

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  thinking?: string;
}

interface JsonlEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
}

// ============================================================================
// Sub-tool extraction (automatic, no hardcoded categories)
// ============================================================================

// Postgres btree index row size limit is ~2704 bytes. Cap well below so multi-byte
// UTF-8 chars + index overhead still fit in idx_te_sub_tool.
const MAX_SUB_TOOL_LEN = 2000;

function truncateSubTool(value: string | null): string | null {
  if (!value) return null;
  return value.length > MAX_SUB_TOOL_LEN ? value.slice(0, MAX_SUB_TOOL_LEN) : value;
}

export function extractSubTool(toolName: string, input: unknown): string | null {
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case 'Bash': {
      const cmd = (obj?.command as string) ?? '';
      return truncateSubTool(cmd.split('\n')[0]?.trim() || null);
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return truncateSubTool((obj?.file_path as string) || null);
    case 'Grep':
      return truncateSubTool((obj?.pattern as string) || null);
    case 'Glob':
      return truncateSubTool((obj?.pattern as string) || null);
    case 'Agent':
      return truncateSubTool((obj?.subagent_type as string) || null);
    case 'Skill':
      return truncateSubTool((obj?.skill as string) || null);
    default:
      return null;
  }
}

// ============================================================================
// Text content extraction
// ============================================================================

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') texts.push(block);
      else if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

// ============================================================================
// JSONL discovery — main sessions + subagent sessions
// ============================================================================

async function discoverMainSession(
  filePath: string,
  projectPath: string,
  name: string,
): Promise<DiscoveredFile | null> {
  try {
    const st = await stat(filePath);
    return {
      sessionId: basename(name, '.jsonl'),
      jsonlPath: filePath,
      projectPath,
      parentSessionId: null,
      isSubagent: false,
      mtime: Math.floor(st.mtimeMs),
      fileSize: st.size,
    };
  } catch {
    return null;
  }
}

async function discoverSubagentSessions(projectPath: string, parentName: string): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];
  const subagentsDir = join(projectPath, parentName, 'subagents');
  try {
    const subFiles = await readdir(subagentsDir);
    for (const subFile of subFiles) {
      if (!subFile.endsWith('.jsonl')) continue;
      try {
        const filePath = join(subagentsDir, subFile);
        const st = await stat(filePath);
        results.push({
          sessionId: basename(subFile, '.jsonl'),
          jsonlPath: filePath,
          projectPath,
          parentSessionId: parentName,
          isSubagent: true,
          mtime: Math.floor(st.mtimeMs),
          fileSize: st.size,
        });
      } catch {
        // deleted between readdir and stat
      }
    }
  } catch {
    // no subagents dir
  }
  return results;
}

async function discoverProjectSessions(projectPath: string): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const file = await discoverMainSession(join(projectPath, entry.name), projectPath, entry.name);
        if (file) results.push(file);
        continue;
      }

      if (entry.isDirectory()) {
        const subs = await discoverSubagentSessions(projectPath, entry.name);
        results.push(...subs);
      }
    }
  } catch {
    // readdir on project failed
  }
  return results;
}

export async function discoverAllJsonlFiles(): Promise<DiscoveredFile[]> {
  const claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

  let projects: string[];
  try {
    projects = await readdir(claudeDir);
  } catch {
    return [];
  }

  const results: DiscoveredFile[] = [];
  for (const project of projects) {
    const files = await discoverProjectSessions(join(claudeDir, project));
    results.push(...files);
  }

  return results;
}

// ============================================================================
// Worker map (session → agent metadata)
// ============================================================================

let workerMapCache: { map: Map<string, WorkerMatch>; expires: number } | null = null;
const WORKER_MAP_TTL_MS = 5 * 60 * 1000;

export async function buildWorkerMap(sql: SqlClient): Promise<Map<string, WorkerMatch>> {
  if (workerMapCache && Date.now() < workerMapCache.expires) {
    return workerMapCache.map;
  }
  const map = new Map<string, WorkerMatch>();
  try {
    // Query executors table (source of truth for claude_session_id) with agent join
    const rows = await sql`
      SELECT e.id as executor_id, e.agent_id, e.claude_session_id, a.team, a.wish_slug, a.task_id, a.role
      FROM executors e
      JOIN agents a ON e.agent_id = a.id
      WHERE e.claude_session_id IS NOT NULL
    `;
    for (const row of rows) {
      map.set(row.claude_session_id, {
        agentId: row.agent_id,
        executorId: row.executor_id,
        team: row.team,
        wishSlug: row.wish_slug,
        taskId: row.task_id,
        role: row.role,
      });
    }
    // Fallback: also check legacy agents table for sessions not yet migrated
    const legacyRows = await sql`
      SELECT id, claude_session_id, team, wish_slug, task_id, role
      FROM agents WHERE claude_session_id IS NOT NULL
    `;
    for (const row of legacyRows) {
      if (!map.has(row.claude_session_id)) {
        map.set(row.claude_session_id, {
          agentId: row.id,
          executorId: null,
          team: row.team,
          wishSlug: row.wish_slug,
          taskId: row.task_id,
          role: row.role,
        });
      }
    }
  } catch {
    // best-effort
  }
  workerMapCache = { map, expires: Date.now() + WORKER_MAP_TTL_MS };
  return map;
}

// ============================================================================
// Ensure session record exists
// ============================================================================

interface SessionContext {
  agentId: string | null;
  team: string | null;
  wishSlug: string | null;
  taskId: string | null;
  lastOffset: number;
  totalTurns: number;
}

function workerToContext(worker: WorkerMatch | undefined): SessionContext {
  return {
    agentId: worker?.agentId ?? null,
    team: worker?.team ?? null,
    wishSlug: worker?.wishSlug ?? null,
    taskId: worker?.taskId ?? null,
    lastOffset: 0,
    totalTurns: 0,
  };
}

async function resolveSafeParentId(sql: SqlClient, parentSessionId: string | null | undefined): Promise<string | null> {
  // If the referenced parent row doesn't exist yet (stale orphan subagent, or
  // ordering race where parent is discovered later), return NULL rather than
  // crashing on the FK constraint. reconcileSubagentParents() can backfill
  // the link once the parent row exists.
  if (!parentSessionId) return null;
  const parentExists = await sql`SELECT 1 FROM sessions WHERE id = ${parentSessionId} LIMIT 1`;
  return parentExists.length > 0 ? parentSessionId : null;
}

async function ensureSession(
  sql: SqlClient,
  sessionId: string,
  jsonlPath: string,
  projectPath: string,
  workerMap: Map<string, WorkerMatch>,
  opts?: { parentSessionId?: string | null; isSubagent?: boolean; fileSize?: number; mtime?: number },
): Promise<SessionContext> {
  const existing =
    await sql`SELECT agent_id, team, wish_slug, task_id, last_ingested_offset, total_turns FROM sessions WHERE id = ${sessionId}`;
  if (existing.length > 0) {
    const row = existing[0];
    return {
      agentId: row.agent_id,
      team: row.team,
      wishSlug: row.wish_slug,
      taskId: row.task_id,
      lastOffset: row.last_ingested_offset ?? 0,
      totalTurns: row.total_turns ?? 0,
    };
  }

  const worker = workerMap.get(sessionId);
  const parentSessionId = await resolveSafeParentId(sql, opts?.parentSessionId);

  await sql`
    INSERT INTO sessions (id, agent_id, executor_id, team, wish_slug, task_id, role, project_path, jsonl_path, status, last_ingested_offset, total_turns, parent_session_id, is_subagent, file_size, file_mtime)
    VALUES (${sessionId}, ${worker?.agentId ?? null}, ${worker?.executorId ?? null}, ${worker?.team ?? null}, ${worker?.wishSlug ?? null}, ${worker?.taskId ?? null}, ${worker?.role ?? null}, ${projectPath}, ${jsonlPath}, ${worker ? 'active' : 'orphaned'}, 0, 0, ${parentSessionId}, ${opts?.isSubagent ?? false}, ${opts?.fileSize ?? 0}, ${opts?.mtime ?? 0})
    ON CONFLICT (id) DO NOTHING
  `;
  return workerToContext(worker);
}

// ============================================================================
// Reconcile parent_session_id for subagent rows that landed before their parent
// ============================================================================

export async function reconcileSubagentParents(sql: SqlClient): Promise<number> {
  // jsonl_path for a subagent is: <projectPath>/<parentUuid>/subagents/<child>.jsonl
  // Recover <parentUuid> from jsonl_path and link if a matching session now exists.
  const linkResult = await sql`
    UPDATE sessions s
    SET parent_session_id = p.id
    FROM sessions p
    WHERE s.is_subagent = true
      AND s.parent_session_id IS NULL
      AND position('/subagents/' in s.jsonl_path) > 0
      AND p.id = regexp_replace(
        split_part(s.jsonl_path, '/subagents/', 1),
        '.*/',
        ''
      )
  `;

  // Inherit metadata from the parent for subagent rows that have a parent
  // but were captured before their worker was registered. Subagent JSONLs
  // (Task-tool children) never get a direct worker, so their agent_id/team/
  // wish_slug/task_id/role stay NULL and they land as status='orphaned'.
  // Copy the parent's context so `genie sessions list --orphaned` shows
  // proper lineage and downstream tool-usage queries can join on these
  // rows. We only fill NULLs — never overwrite existing values.
  //
  // Status stays 'orphaned': these subagents have no direct worker of
  // their own, so they still don't belong in `--active`. This change is
  // purely metadata inheritance for observability.
  await sql`
    UPDATE sessions s
    SET
      agent_id    = COALESCE(s.agent_id,    p.agent_id),
      executor_id = COALESCE(s.executor_id, p.executor_id),
      team        = COALESCE(s.team,        p.team),
      wish_slug   = COALESCE(s.wish_slug,   p.wish_slug),
      task_id     = COALESCE(s.task_id,     p.task_id),
      role        = COALESCE(s.role,        p.role),
      updated_at  = now()
    FROM sessions p
    WHERE s.is_subagent = true
      AND s.parent_session_id = p.id
      AND (
        (s.agent_id    IS NULL AND p.agent_id    IS NOT NULL) OR
        (s.executor_id IS NULL AND p.executor_id IS NOT NULL) OR
        (s.team        IS NULL AND p.team        IS NOT NULL) OR
        (s.wish_slug   IS NULL AND p.wish_slug   IS NOT NULL) OR
        (s.task_id     IS NULL AND p.task_id     IS NOT NULL) OR
        (s.role        IS NULL AND p.role        IS NOT NULL)
      )
  `;

  return linkResult.count ?? 0;
}

// ============================================================================
// Parse JSONL content — extract content rows + tool events
// ============================================================================

interface ParseResult {
  contentRows: ContentRow[];
  toolEvents: ToolEventRow[];
  turnCount: number;
}

function stringifyInput(input: unknown): string | null {
  if (!input) return null;
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function extractBlockOutput(block: ContentBlock): string | null {
  if (typeof block.content === 'string') return block.content;
  return block.content ? extractTextContent(block.content) : null;
}

function extractContentBlocks(entry: JsonlEntry): ContentBlock[] {
  if (!entry.message?.content || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.filter((b: unknown): b is ContentBlock => typeof b === 'object' && b !== null);
}

interface ParseContext {
  sessionId: string;
  agentId: string | null;
  team: string | null;
  wishSlug: string | null;
  taskId: string | null;
}

function buildToolEventRow(
  pending: { name: string; input: unknown; turnIndex: number; timestamp: string },
  toolUseId: string,
  output: string | null,
  isError: boolean,
  ctx: ParseContext,
): ToolEventRow {
  return {
    session_id: ctx.sessionId,
    turn_index: pending.turnIndex,
    timestamp: pending.timestamp,
    tool_name: pending.name,
    sub_tool: extractSubTool(pending.name, pending.input),
    tool_use_id: toolUseId,
    input_raw: stringifyInput(pending.input),
    output_raw: output,
    is_error: isError,
    error_message: isError ? (output?.slice(0, 1000) ?? null) : null,
    duration_ms: null,
    agent_id: ctx.agentId,
    team: ctx.team,
    wish_slug: ctx.wishSlug,
    task_id: ctx.taskId,
  };
}

function processToolUseBlocks(
  blocks: ContentBlock[],
  sessionId: string,
  turnIndex: number,
  timestamp: string,
  contentRows: ContentRow[],
  pendingToolUses: Map<string, { name: string; input: unknown; turnIndex: number; timestamp: string }>,
): number {
  let idx = turnIndex;
  for (const block of blocks) {
    if (block.type !== 'tool_use' || !block.name || !block.id) continue;
    contentRows.push({
      session_id: sessionId,
      turn_index: idx,
      role: 'tool_input',
      content: stringifyInput(block.input) ?? '',
      tool_name: block.name,
      timestamp,
    });
    idx++;
    pendingToolUses.set(block.id, { name: block.name, input: block.input, turnIndex: idx - 1, timestamp });
  }
  return idx;
}

function processToolResultBlocks(
  blocks: ContentBlock[],
  sessionId: string,
  turnIndex: number,
  timestamp: string,
  contentRows: ContentRow[],
  toolEvents: ToolEventRow[],
  pendingToolUses: Map<string, { name: string; input: unknown; turnIndex: number; timestamp: string }>,
  ctx: ParseContext,
): number {
  let idx = turnIndex;
  for (const block of blocks) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue;
    const output = extractBlockOutput(block);
    if (output && output.length > 0) {
      contentRows.push({
        session_id: sessionId,
        turn_index: idx,
        role: 'tool_output',
        content: output,
        tool_name: null,
        timestamp,
      });
      idx++;
    }

    const pending = pendingToolUses.get(block.tool_use_id);
    if (pending) {
      const isError = block.is_error === true || (typeof output === 'string' && output.includes('<tool_use_error>'));
      toolEvents.push(buildToolEventRow(pending, block.tool_use_id, output, isError, ctx));
      pendingToolUses.delete(block.tool_use_id);
    }
  }
  return idx;
}

function parseJsonlChunk(
  data: string,
  sessionId: string,
  startTurnIndex: number,
  context: { agentId: string | null; team: string | null; wishSlug: string | null; taskId: string | null },
): ParseResult {
  const contentRows: ContentRow[] = [];
  const toolEvents: ToolEventRow[] = [];
  let turnIndex = startTurnIndex;
  const pendingToolUses = new Map<string, { name: string; input: unknown; turnIndex: number; timestamp: string }>();
  const ctx: ParseContext = { sessionId, ...context };

  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'assistant') continue;

    const timestamp = entry.timestamp ?? new Date().toISOString();
    const blocks = extractContentBlocks(entry);

    // Extract assistant text
    const text = extractTextContent(entry.message?.content);
    if (text && text.length > 0) {
      contentRows.push({
        session_id: sessionId,
        turn_index: turnIndex,
        role: 'assistant',
        content: text,
        tool_name: null,
        timestamp,
      });
      turnIndex++;
    }

    turnIndex = processToolUseBlocks(blocks, sessionId, turnIndex, timestamp, contentRows, pendingToolUses);
    turnIndex = processToolResultBlocks(
      blocks,
      sessionId,
      turnIndex,
      timestamp,
      contentRows,
      toolEvents,
      pendingToolUses,
      ctx,
    );
  }

  // Orphaned tool uses (no matching result — session may have crashed)
  for (const [toolUseId, pending] of pendingToolUses) {
    toolEvents.push(buildToolEventRow(pending, toolUseId, null, false, ctx));
  }

  return { contentRows, toolEvents, turnCount: turnIndex - startTurnIndex };
}

// ============================================================================
// Batch insert helpers
// ============================================================================

async function batchInsertContent(sql: SqlClient, rows: ContentRow[]): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO session_content (session_id, turn_index, role, content, tool_name, timestamp)
    SELECT * FROM unnest(
      ${sql.array(rows.map((r) => r.session_id))}::text[],
      ${sql.array(rows.map((r) => r.turn_index))}::int[],
      ${sql.array(rows.map((r) => r.role))}::text[],
      ${sql.array(rows.map((r) => r.content))}::text[],
      ${sql.array(rows.map((r) => r.tool_name ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.timestamp))}::timestamptz[]
    )
    ON CONFLICT (session_id, turn_index) DO NOTHING
  `;
}

async function batchInsertToolEvents(sql: SqlClient, rows: ToolEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO tool_events (session_id, turn_index, timestamp, tool_name, sub_tool, tool_use_id, input_raw, output_raw, is_error, error_message, duration_ms, agent_id, team, wish_slug, task_id)
    SELECT * FROM unnest(
      ${sql.array(rows.map((r) => r.session_id))}::text[],
      ${sql.array(rows.map((r) => r.turn_index))}::int[],
      ${sql.array(rows.map((r) => r.timestamp))}::timestamptz[],
      ${sql.array(rows.map((r) => r.tool_name))}::text[],
      ${sql.array(rows.map((r) => r.sub_tool ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.tool_use_id ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.input_raw ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.output_raw ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.is_error))}::bool[],
      ${sql.array(rows.map((r) => r.error_message ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.duration_ms ?? 0))}::int[],
      ${sql.array(rows.map((r) => r.agent_id ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.team ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.wish_slug ?? ''))}::text[],
      ${sql.array(rows.map((r) => r.task_id ?? ''))}::text[]
    )
    ON CONFLICT (session_id, tool_use_id) DO NOTHING
  `;
}

// ============================================================================
// Core: ingestFile — shared by filewatch + backfill
// ============================================================================

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64KB

export async function ingestFile(
  sql: SqlClient,
  sessionId: string,
  jsonlPath: string,
  projectPath: string,
  fromOffset: number,
  opts?: {
    chunkSize?: number;
    parentSessionId?: string | null;
    isSubagent?: boolean;
    fileSize?: number;
    mtime?: number;
    workerMap?: Map<string, WorkerMatch>;
  },
): Promise<IngestResult> {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const workerMap = opts?.workerMap ?? (await buildWorkerMap(sql));

  // Ensure session exists and get context
  const session = await ensureSession(sql, sessionId, jsonlPath, projectPath, workerMap, {
    parentSessionId: opts?.parentSessionId,
    isSubagent: opts?.isSubagent,
    fileSize: opts?.fileSize,
    mtime: opts?.mtime,
  });

  // Get current file size
  let fileSize: number;
  try {
    const st = await stat(jsonlPath);
    fileSize = st.size;
  } catch {
    return { newOffset: fromOffset, contentRowsInserted: 0, toolEventsInserted: 0 };
  }

  const effectiveOffset = Math.max(fromOffset, session.lastOffset);
  if (fileSize <= effectiveOffset) {
    return { newOffset: effectiveOffset, contentRowsInserted: 0, toolEventsInserted: 0 };
  }

  // Calculate read size
  const bytesAvailable = fileSize - effectiveOffset;
  const bytesToRead = Math.min(bytesAvailable, chunkSize);

  // Async read
  const fh = await open(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, effectiveOffset);
    if (bytesRead === 0) {
      return { newOffset: effectiveOffset, contentRowsInserted: 0, toolEventsInserted: 0 };
    }

    const raw = buf.subarray(0, bytesRead).toString('utf-8');

    // Line-safe: find last complete newline
    let safeEnd = raw.length;
    if (bytesRead === chunkSize && bytesAvailable > chunkSize) {
      // Chunk may end mid-line — scan backward for last \n
      const lastNewline = raw.lastIndexOf('\n');
      if (lastNewline === -1) {
        // Entire chunk is one partial line (>64KB single JSONL line)
        // Skip this line by scanning forward to find the next newline
        const skipBuf = Buffer.alloc(Math.min(bytesAvailable, chunkSize * 4));
        const { bytesRead: skipRead } = await fh.read(skipBuf, 0, skipBuf.length, effectiveOffset);
        const skipStr = skipBuf.subarray(0, skipRead).toString('utf-8');
        const nlPos = skipStr.indexOf('\n');
        if (nlPos === -1) {
          // Entire remaining file is one line — skip to EOF
          return { newOffset: fileSize, contentRowsInserted: 0, toolEventsInserted: 0 };
        }
        // Skip past the oversized line, return so next call starts after it
        const skipOffset = effectiveOffset + Buffer.byteLength(skipStr.slice(0, nlPos + 1), 'utf-8');
        return { newOffset: skipOffset, contentRowsInserted: 0, toolEventsInserted: 0 };
      }
      safeEnd = lastNewline + 1;
    }

    const safeData = raw.slice(0, safeEnd);
    const newOffset = effectiveOffset + Buffer.byteLength(safeData, 'utf-8');

    // Parse
    const { contentRows, toolEvents, turnCount } = parseJsonlChunk(safeData, sessionId, session.totalTurns, {
      agentId: session.agentId,
      team: session.team,
      wishSlug: session.wishSlug,
      taskId: session.taskId,
    });

    // Batch insert content + tool events + update offset in same transaction
    await sql.begin(async (tx: SqlClient) => {
      await batchInsertContent(tx, contentRows);
      await batchInsertToolEvents(tx, toolEvents);
      await tx`
        UPDATE sessions SET last_ingested_offset = ${newOffset}, total_turns = ${session.totalTurns + turnCount}, updated_at = now()
        WHERE id = ${sessionId}
      `;
    });

    return { newOffset, contentRowsInserted: contentRows.length, toolEventsInserted: toolEvents.length };
  } finally {
    await fh.close();
  }
}

// ============================================================================
// Convenience: ingest a file fully (for filewatch — read to EOF)
// ============================================================================

export async function ingestFileFull(
  sql: SqlClient,
  sessionId: string,
  jsonlPath: string,
  projectPath: string,
  fromOffset: number,
  opts?: { parentSessionId?: string | null; isSubagent?: boolean; workerMap?: Map<string, WorkerMatch> },
): Promise<IngestResult> {
  // No chunk limit — read everything available
  return ingestFile(sql, sessionId, jsonlPath, projectPath, fromOffset, {
    ...opts,
    chunkSize: Number.MAX_SAFE_INTEGER,
  });
}
