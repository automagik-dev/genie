/**
 * Codex Log Discovery and Parsing — TranscriptProvider adapter.
 *
 * Codex stores session logs as JSONL at:
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl
 *
 * Thread metadata lives in SQLite:
 *   ~/.codex/state_5.sqlite (table: threads, column: rollout_path)
 *
 * Event types in JSONL:
 *   - session_meta: Session initialization
 *   - response_item: Model messages (user, assistant, tool calls, reasoning)
 *   - event_msg: Turn lifecycle (user_message, agent_message, task_complete, etc.)
 *   - turn_context: Per-turn workspace metadata
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from './agent-registry.js';
import type { TranscriptEntry, TranscriptProvider } from './transcript.js';

// ============================================================================
// Paths
// ============================================================================

function getCodexDir(): string {
  return join(homedir(), '.codex');
}

function getSessionsDir(): string {
  return join(getCodexDir(), 'sessions');
}

function getStateDbPath(): string {
  return join(getCodexDir(), 'state_5.sqlite');
}

// ============================================================================
// Log Discovery
// ============================================================================

/**
 * Discover the Codex log file for a worker via SQLite thread lookup.
 * Falls back to scanning session directories by date.
 */
async function discoverLogPath(worker: Agent): Promise<string | null> {
  const cwd = worker.worktree || worker.repoPath;
  const sqlitePath = await discoverViaSqlite(cwd);
  if (sqlitePath) {
    try {
      await access(sqlitePath);
      return sqlitePath;
    } catch {
      // Stale path — fall through to scan
    }
  }
  return discoverViaScan(cwd);
}

/**
 * Query ~/.codex/state_5.sqlite for the most recent thread matching the CWD.
 */
async function discoverViaSqlite(cwd: string): Promise<string | null> {
  try {
    const { Database } = await import('bun:sqlite');
    const dbPath = getStateDbPath();
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query('SELECT rollout_path FROM threads WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1')
        .get(cwd) as { rollout_path: string } | null;
      return row?.rollout_path ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** List subdirectories matching a regex pattern, sorted descending. */
async function listDirsDesc(parent: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(parent);
  return entries
    .filter((d) => pattern.test(d))
    .sort()
    .reverse();
}

/**
 * Scan ~/.codex/sessions/ directories for the most recent JSONL matching a CWD.
 */
async function discoverViaScan(cwd: string): Promise<string | null> {
  const sessionsDir = getSessionsDir();
  try {
    const years = await listDirsDesc(sessionsDir, /^\d{4}$/);
    for (const year of years.slice(0, 2)) {
      const result = await scanYear(join(sessionsDir, year), cwd);
      if (result) return result;
    }
  } catch {
    // Sessions directory doesn't exist
  }
  return null;
}

async function scanYear(yearDir: string, cwd: string): Promise<string | null> {
  const months = await listDirsDesc(yearDir, /^\d{2}$/);
  for (const month of months.slice(0, 2)) {
    const result = await scanMonth(join(yearDir, month), cwd);
    if (result) return result;
  }
  return null;
}

async function scanMonth(monthDir: string, cwd: string): Promise<string | null> {
  const days = await listDirsDesc(monthDir, /^\d{2}$/);
  for (const day of days.slice(0, 3)) {
    const result = await scanDay(join(monthDir, day), cwd);
    if (result) return result;
  }
  return null;
}

async function scanDay(dayDir: string, cwd: string): Promise<string | null> {
  const files = (await readdir(dayDir))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();
  for (const file of files.slice(0, 5)) {
    const filePath = join(dayDir, file);
    const meta = await readSessionMeta(filePath);
    if (meta?.cwd === cwd) return filePath;
  }
  return null;
}

/**
 * Read the first line of a JSONL file to extract session_meta CWD.
 */
async function readSessionMeta(filePath: string): Promise<{ cwd: string } | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const nlIdx = content.indexOf('\n');
    const firstLine = nlIdx === -1 ? content : content.slice(0, nlIdx);
    const entry = JSON.parse(firstLine);
    if (entry.type === 'session_meta' && entry.payload?.cwd) {
      return { cwd: entry.payload.cwd };
    }
  } catch {
    // Invalid file
  }
  return null;
}

// ============================================================================
// Entry Parsing
// ============================================================================

interface CodexRawEntry {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

type EntryBase = { provider: 'codex'; raw: Record<string, unknown> };

function parseEventMsg(payload: Record<string, unknown>, ts: string, base: EntryBase): TranscriptEntry[] {
  if (payload.type === 'user_message') {
    const text = String(payload.message ?? '');
    return text ? [{ ...base, role: 'user', timestamp: ts, text }] : [];
  }
  if (payload.type === 'agent_message') {
    const text = String(payload.message ?? '');
    return text ? [{ ...base, role: 'assistant', timestamp: ts, text }] : [];
  }
  return [];
}

function parseResponseMessage(payload: Record<string, unknown>, ts: string, base: EntryBase): TranscriptEntry[] {
  const role = payload.role as string;
  const text = extractCodexContent(payload.content);
  if (!text) return [];

  if (role === 'user') return [{ ...base, role: 'user', timestamp: ts, text }];
  if (role === 'developer') return [{ ...base, role: 'system', timestamp: ts, text }];
  if (role === 'assistant') return [{ ...base, role: 'assistant', timestamp: ts, text }];
  return [];
}

function parseFunctionCall(payload: Record<string, unknown>, ts: string, base: EntryBase): TranscriptEntry[] {
  const name = String(payload.name ?? payload.type);
  const callId = String(payload.call_id ?? '');
  let input: Record<string, unknown> = {};
  try {
    input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : {};
  } catch {
    input = { raw: payload.arguments };
  }
  const cmdText = input.command ? String(Array.isArray(input.command) ? input.command.join(' ') : input.command) : name;
  return [
    {
      ...base,
      role: 'tool_call',
      timestamp: ts,
      text: `${name}: ${cmdText.slice(0, 200)}`,
      toolCall: { id: callId, name, input },
    },
  ];
}

function parseWebSearch(payload: Record<string, unknown>, ts: string, base: EntryBase): TranscriptEntry[] {
  const action = payload.action as Record<string, unknown> | undefined;
  const query = String(action?.query ?? 'web search');
  return [
    {
      ...base,
      role: 'tool_call',
      timestamp: ts,
      text: `web_search: ${query.slice(0, 200)}`,
      toolCall: { id: '', name: 'web_search', input: { query } },
    },
  ];
}

function parseResponseItem(payload: Record<string, unknown>, ts: string, base: EntryBase): TranscriptEntry[] {
  if (payload.type === 'message') return parseResponseMessage(payload, ts, base);
  if (payload.type === 'function_call' || payload.type === 'shell') return parseFunctionCall(payload, ts, base);
  if (payload.type === 'function_call_output') {
    const output = String(payload.output ?? '').slice(0, 500);
    return [{ ...base, role: 'tool_result' as const, timestamp: ts, text: output }];
  }
  if (payload.type === 'web_search_call') return parseWebSearch(payload, ts, base);
  return [];
}

/**
 * Parse a single Codex JSONL line into TranscriptEntry items.
 */
function parseCodexLine(line: string): TranscriptEntry[] {
  if (!line.trim()) return [];

  let raw: CodexRawEntry;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }

  if (!raw.type || !raw.timestamp) return [];

  const base: EntryBase = { provider: 'codex', raw: raw as unknown as Record<string, unknown> };

  if (!raw.payload || typeof raw.payload !== 'object') return [];

  if (raw.type === 'event_msg') return parseEventMsg(raw.payload, raw.timestamp, base);
  if (raw.type === 'response_item') return parseResponseItem(raw.payload, raw.timestamp, base);
  return [];
}

/**
 * Extract text from Codex content array.
 */
function extractCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object') {
      if ('text' in item) parts.push(String(item.text));
      else if ('input_text' in item) parts.push(String((item as { input_text: string }).input_text));
    }
  }
  return parts.join(' ');
}

// ============================================================================
// Provider
// ============================================================================

/**
 * Read all transcript entries from a Codex JSONL log file.
 */
async function readEntries(logPath: string): Promise<TranscriptEntry[]> {
  let content: string;
  try {
    content = await readFile(logPath, 'utf-8');
  } catch {
    return [];
  }

  return content.split('\n').flatMap(parseCodexLine);
}

/**
 * Codex transcript provider.
 * Discovers logs via SQLite thread lookup or directory scan.
 */
export const codexTranscriptProvider: TranscriptProvider = {
  discoverLogPath,
  readEntries,
};

// Exported for testing
export { parseCodexLine, extractCodexContent };
