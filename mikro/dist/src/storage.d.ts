/**
 * PgStorage — embedded pgserve lifecycle, context ingestion, and query interface.
 *
 * Spawns pgserve as a child process (Bun-based TCP proxy over embedded PostgreSQL),
 * connects via node-postgres, and provides methods for context storage and retrieval.
 */
import type { StorageConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
declare const Client: typeof import("pg").Client;
/**
 * Compute adaptive chunk size based on provider limits and storage config.
 */
export declare function getChunkSize(provider: string, config: StorageConfig): number;
export declare class PgStorage {
    private process;
    private client;
    private port;
    private stopping;
    private cleanupRegistered;
    /**
     * Absolute path to the `.mikro-server.json` sidecar this instance wrote. Set
     * only when we spawned pgserve (owner mode) so `stop()` can clean it up.
     * Null when we attached to an existing instance (no ownership = no cleanup).
     */
    private sidecarPath;
    /** True when we connected to an existing pgserve via sidecar instead of spawning. */
    private attached;
    /** Connection string for the running pgserve instance */
    get connectionString(): string;
    /** Get the underlying pg Client (for observability recorder). */
    getClient(): InstanceType<typeof Client> | null;
    /**
     * Start pgserve and connect to it. For persistent-mode dataDirs where
     * another PgStorage instance already spawned pgserve (discovered via
     * `.mikro-server.json` sidecar), we attach as a second client instead of
     * trying to spawn a conflicting postmaster — postgres single-writer
     * semantics mean a second spawn on the same dataDir always fails with
     * "pre-existing shared memory block". Attaching lets `mikro stats`,
     * `mikro` query runs, and long-running SDK pipelines coexist cleanly.
     *
     * Returns the connection string once ready.
     */
    start(config: StorageConfig): Promise<string>;
    /**
     * Try to attach to an existing pgserve on this dataDir. Three levels of
     * discovery, in order:
     *
     *   1. `.mikro-server.json` sidecar (the happy path — spawner writes it
     *      after `waitForReady`, cleans it on stop).
     *   2. `postmaster.pid` fallback (postgres's own lockfile — present even
     *      if the mikro sidecar was never written or got unlinked before the
     *      pg process exited, e.g. orphaned pgserve after a crash).
     *
     * Returns the connection string on success, null to tell the caller to
     * proceed with a normal spawn. Silent on every failure path.
     */
    private tryAttachFromSidecar;
    /** Open a client at the given port; returns true and retains client on success. */
    private tryConnectAt;
    /** Write the server-info sidecar advertising our pgserve to future callers. */
    private writeSidecar;
    /**
     * Ingest a loaded context into the records table.
     * For JSONL: parses each line as JSON, extracts timestamp/type fields.
     * For other text: one record per line.
     */
    ingest(context: LoadedContext, sessionId?: string): Promise<number>;
    /**
     * Full-text search via tsvector.
     */
    search(pattern: string, limit?: number): Promise<Array<{
        line_num: number;
        content: string;
        rank: number;
    }>>;
    /**
     * Get records by line number range (inclusive).
     */
    slice(start: number, end: number): Promise<Array<{
        line_num: number;
        content: string;
    }>>;
    /**
     * Filter records by timestamp range.
     */
    timeRange(from: string, to: string): Promise<Array<{
        line_num: number;
        timestamp: string;
        content: string;
    }>>;
    /**
     * Count total records.
     */
    count(): Promise<number>;
    /**
     * Execute raw SQL (read-only). Supports parameterized queries.
     */
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
    /**
     * Stop pgserve: graceful 3s timeout, then SIGKILL.
     *
     * When this instance attached to an existing pgserve (via sidecar), only
     * the pg client is closed — the pgserve process belongs to someone else
     * and must not be killed.
     */
    stop(): Promise<void>;
    /** Find the pgserve CLI binary in node_modules */
    private findPgserveBin;
    /**
     * Wait for pgserve to accept connections (poll with backoff).
     * Throws if not ready within 10 seconds.
     */
    private waitForReady;
    /** Register process exit handlers for cleanup */
    private registerCleanup;
}
export interface ParseContextLineOptions {
    /** Source path for the line, when loaded from a directory context. */
    source?: string | null;
}
/**
 * Parse a single line of context data.
 * JSONL parsing is source-aware so markdown/code examples that happen to
 * start with "{" remain plain text instead of producing noisy warnings.
 */
export declare function parseContextLine(line: string, options?: ParseContextLineOptions): {
    timestamp: string | null;
    type: string | null;
    content: string;
};
export {};
//# sourceMappingURL=storage.d.ts.map