/**
 * Session Ingester — Batch JSONL ingestion for complementary session content.
 *
 * Scans ~/.claude/projects/<hash>/sessions/<id>.jsonl, matches to workers via claude_session_id,
 * extracts ONLY complementary content (assistant text, tool I/O — NOT cost/tokens/duration
 * which come from OTel), batch INSERTs to session_content, and updates last_ingested_offset.
 *
 * Architecture:
 *   - 60s daemon poll (called from scheduler-daemon), no fs.watch/inotify
 *   - Incremental reads from last_ingested_offset to EOF
 *   - Unmatched sessions → status='orphaned', agent_id=NULL
 *   - session_id is the join key across sessions, session_content, and audit_events
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isAvailable } from './db.js';

// ============================================================================
// Types
// ============================================================================

interface SessionRow {
  id: string;
  agent_id: string | null;
  team: string | null;
  wish_slug: string | null;
  task_id: string | null;
  role: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  status: string;
  last_ingested_offset: number;
  total_turns: number;
}

interface ContentRow {
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  tool_name: string | null;
  timestamp: string;
}

interface JsonlEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  // Tool calls
  toolCalls?: Array<{ name?: string; input?: unknown }>;
  // Tool results
  toolResults?: Array<{ name?: string; output?: string; content?: unknown }>;
}

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type requires generics
type SqlClient = any;

// ============================================================================
// JSONL Discovery
// ============================================================================

/**
 * Discover all .claude session JSONL files.
 * Scans ~/.claude/projects/<hash>/sessions/<id>.jsonl
 */
function discoverJsonlFiles(): Array<{ sessionId: string; jsonlPath: string; projectPath: string }> {
  const claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const results: Array<{ sessionId: string; jsonlPath: string; projectPath: string }> = [];

  try {
    const projects = readdirSync(claudeDir);
    for (const project of projects) {
      const sessionsDir = join(claudeDir, project, 'sessions');
      try {
        const files = readdirSync(sessionsDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = basename(file, '.jsonl');
          results.push({
            sessionId,
            jsonlPath: join(sessionsDir, file),
            projectPath: join(claudeDir, project),
          });
        }
      } catch {
        // sessions dir may not exist for this project
      }
    }
  } catch {
    // .claude/projects may not exist
  }

  return results;
}

// ============================================================================
// JSONL Parsing — extract complementary content only
// ============================================================================

/**
 * Extract text content from a Claude message content field.
 * Content can be a string, array of blocks, or other shapes.
 */
// biome-ignore lint/suspicious/noExplicitAny: JSONL content is dynamically typed
function extractTextContent(content: any): string | null {
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

/** Push a content row and advance turn index. */
function pushRow(
  rows: ContentRow[],
  sessionId: string,
  turnIndex: number,
  role: string,
  content: string,
  toolName: string | null,
  timestamp: string,
): number {
  rows.push({ session_id: sessionId, turn_index: turnIndex, role, content, tool_name: toolName, timestamp });
  return turnIndex + 1;
}

/** Extract tool call inputs from an entry. */
function extractToolInputs(
  entry: JsonlEntry,
  rows: ContentRow[],
  sessionId: string,
  startIndex: number,
  timestamp: string,
): number {
  let idx = startIndex;
  if (!entry.toolCalls) return idx;
  for (const tc of entry.toolCalls) {
    if (tc.input) {
      const inputText = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
      idx = pushRow(rows, sessionId, idx, 'tool_input', inputText, tc.name ?? null, timestamp);
    }
  }
  return idx;
}

/** Extract tool results from an entry. */
function extractToolOutputs(
  entry: JsonlEntry,
  rows: ContentRow[],
  sessionId: string,
  startIndex: number,
  timestamp: string,
): number {
  let idx = startIndex;
  if (!entry.toolResults) return idx;
  for (const tr of entry.toolResults) {
    const output = tr.output ?? (tr.content ? extractTextContent(tr.content) : null);
    if (output && output.length > 0) {
      idx = pushRow(rows, sessionId, idx, 'tool_output', output, tr.name ?? null, timestamp);
    }
  }
  return idx;
}

/** Process a single assistant entry for content extraction. */
function processAssistantEntry(
  entry: JsonlEntry,
  rows: ContentRow[],
  sessionId: string,
  startIndex: number,
  timestamp: string,
): number {
  let idx = startIndex;
  if (entry.message?.content) {
    const text = extractTextContent(entry.message.content);
    if (text && text.length > 0) {
      idx = pushRow(rows, sessionId, idx, 'assistant', text, null, timestamp);
    }
  }
  idx = extractToolInputs(entry, rows, sessionId, idx, timestamp);
  idx = extractToolOutputs(entry, rows, sessionId, idx, timestamp);
  return idx;
}

/**
 * Parse JSONL content, extracting complementary content rows.
 */
function parseJsonlContent(
  data: string,
  sessionId: string,
  startTurnIndex: number,
): { rows: ContentRow[]; turnCount: number } {
  const rows: ContentRow[] = [];
  let turnIndex = startTurnIndex;

  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp ?? new Date().toISOString();
    if (entry.type === 'assistant') {
      turnIndex = processAssistantEntry(entry, rows, sessionId, turnIndex, timestamp);
    }
  }

  return { rows, turnCount: turnIndex - startTurnIndex };
}

// ============================================================================
// Session-to-Worker Matching
// ============================================================================

interface WorkerMatch {
  agentId: string;
  team: string | null;
  wishSlug: string | null;
  taskId: string | null;
  role: string | null;
}

/**
 * Build a session-to-worker mapping from the agents table.
 * Returns a map of claude_session_id → worker info.
 */
async function buildWorkerMap(sql: SqlClient): Promise<Map<string, WorkerMatch>> {
  const map = new Map<string, WorkerMatch>();
  try {
    const rows = await sql`
      SELECT id, claude_session_id, team, wish_slug, task_id, role
      FROM agents WHERE claude_session_id IS NOT NULL
    `;
    for (const row of rows) {
      map.set(row.claude_session_id, {
        agentId: row.id,
        team: row.team,
        wishSlug: row.wish_slug,
        taskId: row.task_id,
        role: row.role,
      });
    }
  } catch {
    // Best-effort
  }
  return map;
}

// ============================================================================
// Main Ingestion
// ============================================================================

/** Ensure a session record exists in PG. Returns the session row. */
async function ensureSession(
  sql: SqlClient,
  sessionId: string,
  jsonlPath: string,
  projectPath: string,
  workerMap: Map<string, WorkerMatch>,
): Promise<{ session: SessionRow; isNew: boolean }> {
  const existingRows = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
  if (existingRows.length > 0) return { session: existingRows[0], isNew: false };

  const worker = workerMap.get(sessionId);
  const status = worker ? 'active' : 'orphaned';
  await sql`
    INSERT INTO sessions (id, agent_id, team, wish_slug, task_id, role, project_path, jsonl_path, status, last_ingested_offset, total_turns)
    VALUES (${sessionId}, ${worker?.agentId ?? null}, ${worker?.team ?? null}, ${worker?.wishSlug ?? null}, ${worker?.taskId ?? null}, ${worker?.role ?? null}, ${projectPath}, ${jsonlPath}, ${status}, 0, 0)
    ON CONFLICT (id) DO NOTHING
  `;
  return {
    session: {
      id: sessionId,
      agent_id: worker?.agentId ?? null,
      team: worker?.team ?? null,
      wish_slug: worker?.wishSlug ?? null,
      task_id: worker?.taskId ?? null,
      role: worker?.role ?? null,
      project_path: projectPath,
      jsonl_path: jsonlPath,
      status,
      last_ingested_offset: 0,
      total_turns: 0,
    },
    isNew: !worker,
  };
}

/** Batch insert content rows to PG. */
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

/**
 * Ingest sessions — the main entry point called every 60s by the scheduler daemon.
 */
export async function ingestSessions(): Promise<{ ingested: number; orphaned: number }> {
  if (!(await isAvailable())) return { ingested: 0, orphaned: 0 };

  const { getConnection } = await import('./db.js');
  const sql = await getConnection();

  const jsonlFiles = discoverJsonlFiles();
  if (jsonlFiles.length === 0) return { ingested: 0, orphaned: 0 };

  const workerMap = await buildWorkerMap(sql);
  let totalIngested = 0;
  let totalOrphaned = 0;

  for (const { sessionId, jsonlPath, projectPath } of jsonlFiles) {
    try {
      const fileSize = statSync(jsonlPath).size;
      const { session, isNew } = await ensureSession(sql, sessionId, jsonlPath, projectPath, workerMap);
      if (isNew) totalOrphaned++;

      const offset = session.last_ingested_offset ?? 0;
      if (fileSize <= offset) continue;

      const newContent = readFileSync(jsonlPath, 'utf-8').slice(offset);
      if (!newContent.trim()) continue;

      const { rows, turnCount } = parseJsonlContent(newContent, sessionId, session.total_turns ?? 0);
      await batchInsertContent(sql, rows);
      totalIngested += rows.length;

      await sql`
        UPDATE sessions SET last_ingested_offset = ${fileSize}, total_turns = ${(session.total_turns ?? 0) + turnCount}, updated_at = now()
        WHERE id = ${sessionId}
      `;
    } catch {
      // Best-effort per session
    }
  }

  return { ingested: totalIngested, orphaned: totalOrphaned };
}
