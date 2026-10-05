/**
 * Stats query functions for mikro observability data.
 *
 * Connects to the persistent pgserve data at ~/.mikro/data to query
 * mikro_sessions and mikro_events tables. Starts pgserve temporarily,
 * queries, then stops.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { PgStorage } from "./storage.js";
import { loadConfig } from "./config.js";

/** A session row from mikro_sessions */
export interface SessionRow {
  id: string;
  query: string;
  model: string;
  provider: string;
  status: string;
  iterations: number | null;
  input_tokens: number;
  output_tokens: number;
  total_cost: number;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

/** An event row from mikro_events */
export interface EventRow {
  id: number;
  iteration: number | null;
  kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  model: string | null;
  code: string | null;
  stdout: string | null;
  stderr: string | null;
  request_type: string | null;
  prompt_preview: string | null;
  duration_ms: number | null;
  is_error: boolean;
  error_message: string | null;
  created_at: string;
}

/** Cost breakdown row from v_cost_breakdown */
export interface CostRow {
  session_id: string;
  model: string;
  calls: number;
  total_input: number;
  total_output: number;
  total_cost: number;
  avg_duration_ms: number;
}

/** Tool usage row from v_repl_usage */
export interface ToolRow {
  session_id: string;
  request_type: string;
  calls: number;
  errors: number;
  avg_duration_ms: number;
}

/**
 * Check if persistent data directory exists.
 */
export async function hasStatsData(): Promise<boolean> {
  const config = await loadConfig(process.cwd());
  const dataDir = config.storage.dataDir.replace(/^~/, homedir());
  return existsSync(dataDir);
}

/**
 * Parse a "since" duration string (e.g., "24h", "7d", "30m") into a JS Date cutoff.
 */
function parseSinceCutoff(since: string): Date {
  const match = since.match(/^(\d+)([mhd])$/);
  if (!match) throw new Error(`Invalid --since format "${since}". Use Nh, Nd, or Nm (e.g., 24h, 7d, 30m).`);
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() - num * msMap[unit]);
}

/**
 * Create a temporary PgStorage connected to the configured data directory for querying stats.
 */
async function createStatsStorage(): Promise<PgStorage> {
  const config = await loadConfig(process.cwd());
  const storage = new PgStorage();
  await storage.start({
    ...config.storage,
    mode: "persistent",
    enabled: "always",
  });
  return storage;
}

/**
 * List recent runs.
 */
export async function listRuns(storage: PgStorage, limit = 20): Promise<SessionRow[]> {
  const rows = await storage.query(
    `SELECT id, query, model, provider, status, iterations,
            input_tokens::int, output_tokens::int, total_cost::float,
            started_at::text, ended_at::text,
            EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))::int * 1000 AS duration_ms
     FROM mikro_sessions
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows as SessionRow[];
}

/**
 * Get events for a specific run.
 */
export async function getRun(storage: PgStorage, runId: string): Promise<EventRow[]> {
  const rows = await storage.query(
    `SELECT id, iteration, kind, input_tokens, output_tokens, cost::float,
            model, code, stdout, stderr, request_type, prompt_preview,
            duration_ms, is_error, error_message, created_at::text
     FROM mikro_events
     WHERE session_id = $1
     ORDER BY id`,
    [runId]
  );
  return rows as EventRow[];
}

/**
 * Get cost breakdown by model.
 */
export async function costBreakdown(storage: PgStorage, since?: string): Promise<CostRow[]> {
  if (since) {
    const cutoff = parseSinceCutoff(since);
    const rows = await storage.query(
      `SELECT e.session_id, e.model,
              COUNT(*)::int AS calls,
              SUM(e.input_tokens)::int AS total_input,
              SUM(e.output_tokens)::int AS total_output,
              SUM(e.cost)::float AS total_cost,
              AVG(e.duration_ms)::int AS avg_duration_ms
       FROM mikro_events e
       WHERE e.created_at >= $1 AND e.kind = 'llm_call'
       GROUP BY e.session_id, e.model
       ORDER BY total_cost DESC`,
      [cutoff.toISOString()]
    );
    return rows as CostRow[];
  }
  const rows = await storage.query(
    `SELECT e.session_id, e.model,
            COUNT(*)::int AS calls,
            SUM(e.input_tokens)::int AS total_input,
            SUM(e.output_tokens)::int AS total_output,
            SUM(e.cost)::float AS total_cost,
            AVG(e.duration_ms)::int AS avg_duration_ms
     FROM mikro_events e
     WHERE e.kind = 'llm_call'
     GROUP BY e.session_id, e.model
     ORDER BY total_cost DESC`
  );
  return rows as CostRow[];
}

/**
 * Get tool/sub-call usage.
 */
export async function toolUsage(storage: PgStorage, since?: string): Promise<ToolRow[]> {
  if (since) {
    const cutoff = parseSinceCutoff(since);
    const rows = await storage.query(
      `SELECT e.session_id, e.request_type,
              COUNT(*)::int AS calls,
              SUM(CASE WHEN e.is_error THEN 1 ELSE 0 END)::int AS errors,
              AVG(e.duration_ms)::int AS avg_duration_ms
       FROM mikro_events e
       WHERE e.created_at >= $1 AND e.kind IN ('sub_call', 'pg_query', 'repl_exec')
       GROUP BY e.session_id, e.request_type
       ORDER BY calls DESC`,
      [cutoff.toISOString()]
    );
    return rows as ToolRow[];
  }
  const rows = await storage.query(
    `SELECT e.session_id, e.request_type,
            COUNT(*)::int AS calls,
            SUM(CASE WHEN e.is_error THEN 1 ELSE 0 END)::int AS errors,
            AVG(e.duration_ms)::int AS avg_duration_ms
     FROM mikro_events e
     WHERE e.kind IN ('sub_call', 'pg_query', 'repl_exec')
     GROUP BY e.session_id, e.request_type
     ORDER BY calls DESC`
  );
  return rows as ToolRow[];
}

// ─── Formatting ─────────────────────────────────────────

function pad(s: string, len: number, right = false): string {
  return right ? s.padStart(len) : s.padEnd(len);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatCost(n: number): string {
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format session rows as a terminal table.
 */
export function formatRunsTable(rows: SessionRow[]): string {
  if (rows.length === 0) return "No runs found.";

  const header = [
    pad("ID", 10),
    pad("Query", 30),
    pad("Model", 25),
    pad("Iter", 5, true),
    pad("Cost", 10, true),
    pad("Status", 10),
    pad("Duration", 10, true),
  ].join("  ");

  const sep = "-".repeat(header.length);

  const lines = rows.map((r) => [
    pad(r.id.slice(0, 8) + "..", 10),
    pad(truncate(r.query, 30), 30),
    pad(truncate(r.model, 25), 25),
    pad(r.iterations !== null ? String(r.iterations) : "-", 5, true),
    pad(formatCost(r.total_cost), 10, true),
    pad(r.status, 10),
    pad(formatDuration(r.duration_ms), 10, true),
  ].join("  "));

  return [header, sep, ...lines].join("\n");
}

/**
 * Format event rows as a terminal table.
 */
export function formatEventsTable(rows: EventRow[]): string {
  if (rows.length === 0) return "No events found for this run.";

  const header = [
    pad("#", 4, true),
    pad("Iter", 5, true),
    pad("Kind", 12),
    pad("In", 8, true),
    pad("Out", 8, true),
    pad("Cost", 10, true),
    pad("Time", 8, true),
    pad("Detail", 40),
  ].join("  ");

  const sep = "-".repeat(header.length);

  const lines = rows.map((r) => {
    let detail = "";
    if (r.kind === "llm_call") detail = r.model ?? "";
    else if (r.kind === "repl_exec") detail = truncate(r.code ?? "", 40);
    else if (r.kind === "sub_call") detail = r.request_type ?? "";

    return [
      pad(String(r.id), 4, true),
      pad(r.iteration !== null ? String(r.iteration) : "-", 5, true),
      pad(r.kind, 12),
      pad(r.input_tokens !== null ? String(r.input_tokens) : "-", 8, true),
      pad(r.output_tokens !== null ? String(r.output_tokens) : "-", 8, true),
      pad(r.cost !== null ? formatCost(r.cost) : "-", 10, true),
      pad(formatDuration(r.duration_ms), 8, true),
      pad(truncate(detail, 40), 40),
    ].join("  ");
  });

  return [header, sep, ...lines].join("\n");
}

/**
 * Format cost breakdown as a terminal table.
 */
export function formatCostTable(rows: CostRow[]): string {
  if (rows.length === 0) return "No cost data found.";

  const header = [
    pad("Model", 30),
    pad("Calls", 6, true),
    pad("Input", 10, true),
    pad("Output", 10, true),
    pad("Cost", 12, true),
    pad("Avg Time", 10, true),
  ].join("  ");

  const sep = "-".repeat(header.length);

  const lines = rows.map((r) => [
    pad(truncate(r.model, 30), 30),
    pad(String(r.calls), 6, true),
    pad(r.total_input.toLocaleString(), 10, true),
    pad(r.total_output.toLocaleString(), 10, true),
    pad(formatCost(r.total_cost), 12, true),
    pad(formatDuration(r.avg_duration_ms), 10, true),
  ].join("  "));

  return [header, sep, ...lines].join("\n");
}

/**
 * Format tool usage as a terminal table.
 */
export function formatToolTable(rows: ToolRow[]): string {
  if (rows.length === 0) return "No tool usage data found.";

  const header = [
    pad("Type", 20),
    pad("Calls", 6, true),
    pad("Errors", 7, true),
    pad("Avg Time", 10, true),
  ].join("  ");

  const sep = "-".repeat(header.length);

  const lines = rows.map((r) => [
    pad(r.request_type ?? "-", 20),
    pad(String(r.calls), 6, true),
    pad(String(r.errors), 7, true),
    pad(formatDuration(r.avg_duration_ms), 10, true),
  ].join("  "));

  return [header, sep, ...lines].join("\n");
}

/**
 * Run the stats command with parsed args.
 */
export async function runStatsCommand(args: string[]): Promise<void> {
  // Check for data
  if (!(await hasStatsData())) {
    console.log("No stats yet. Run a query first.");
    return;
  }

  // Parse args
  const runIdx = args.indexOf("--run");
  const runId = runIdx >= 0 ? args[runIdx + 1] : undefined;
  const costsFlag = args.includes("--costs");
  const toolsFlag = args.includes("--tools");
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const outputIdx = args.indexOf("--output");
  const jsonOutput = outputIdx >= 0 && args[outputIdx + 1] === "json";

  // Start temporary pgserve for querying
  let storage: PgStorage | undefined;
  try {
    storage = await createStatsStorage();

    if (runId) {
      const events = await getRun(storage, runId);
      if (jsonOutput) {
        console.log(JSON.stringify(events, null, 2));
      } else {
        console.log(formatEventsTable(events));
      }
    } else if (costsFlag) {
      const costs = await costBreakdown(storage, since);
      if (jsonOutput) {
        console.log(JSON.stringify(costs, null, 2));
      } else {
        console.log(formatCostTable(costs));
      }
    } else if (toolsFlag) {
      const tools = await toolUsage(storage, since);
      if (jsonOutput) {
        console.log(JSON.stringify(tools, null, 2));
      } else {
        console.log(formatToolTable(tools));
      }
    } else {
      const runs = await listRuns(storage);
      if (jsonOutput) {
        console.log(JSON.stringify(runs, null, 2));
      } else {
        console.log(formatRunsTable(runs));
      }
    }
  } finally {
    if (storage) await storage.stop();
  }
}
