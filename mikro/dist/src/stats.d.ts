/**
 * Stats query functions for mikro observability data.
 *
 * Connects to the persistent pgserve data at ~/.mikro/data to query
 * mikro_sessions and mikro_events tables. Starts pgserve temporarily,
 * queries, then stops.
 */
import { PgStorage } from "./storage.js";
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
export declare function hasStatsData(): Promise<boolean>;
/**
 * List recent runs.
 */
export declare function listRuns(storage: PgStorage, limit?: number): Promise<SessionRow[]>;
/**
 * Get events for a specific run.
 */
export declare function getRun(storage: PgStorage, runId: string): Promise<EventRow[]>;
/**
 * Get cost breakdown by model.
 */
export declare function costBreakdown(storage: PgStorage, since?: string): Promise<CostRow[]>;
/**
 * Get tool/sub-call usage.
 */
export declare function toolUsage(storage: PgStorage, since?: string): Promise<ToolRow[]>;
/**
 * Format session rows as a terminal table.
 */
export declare function formatRunsTable(rows: SessionRow[]): string;
/**
 * Format event rows as a terminal table.
 */
export declare function formatEventsTable(rows: EventRow[]): string;
/**
 * Format cost breakdown as a terminal table.
 */
export declare function formatCostTable(rows: CostRow[]): string;
/**
 * Format tool usage as a terminal table.
 */
export declare function formatToolTable(rows: ToolRow[]): string;
/**
 * Run the stats command with parsed args.
 */
export declare function runStatsCommand(args: string[]): Promise<void>;
//# sourceMappingURL=stats.d.ts.map