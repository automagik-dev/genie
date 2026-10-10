/**
 * PgStorage — embedded pgserve lifecycle, context ingestion, and query interface.
 *
 * Spawns pgserve as a child process (Bun-based TCP proxy over embedded PostgreSQL),
 * connects via node-postgres, and provides methods for context storage and retrieval.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import pg from "pg";
import type { StorageConfig } from "./config.js";
import type { LoadedContext, ContextItem } from "./context.js";
import { PROVIDER_LIMITS } from "./cache.js";

const { Client } = pg;

/** Database name used for mikro context storage */
const MIKRO_DB = "mikro";

/** Schema DDL for the records table */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS records (
  line_num       INT PRIMARY KEY,
  timestamp      TIMESTAMPTZ,
  type           TEXT,
  source         TEXT,
  session_id     TEXT,
  content        TEXT NOT NULL,
  content_tsvector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', left(content, 500000))) STORED
);

CREATE INDEX IF NOT EXISTS idx_records_tsvector ON records USING GIN (content_tsvector);
CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records (timestamp) WHERE timestamp IS NOT NULL;
`;

/** Schema DDL for observability tables */
const OBSERVABILITY_DDL = `
CREATE TABLE IF NOT EXISTS mikro_sessions (
  id             TEXT PRIMARY KEY,
  query          TEXT NOT NULL,
  context_path   TEXT,
  model          TEXT NOT NULL,
  provider       TEXT NOT NULL,
  status         TEXT DEFAULT 'running',
  config         JSONB,
  started_at     TIMESTAMPTZ DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  iterations     INT,
  input_tokens   BIGINT DEFAULT 0,
  output_tokens  BIGINT DEFAULT 0,
  cached_tokens  BIGINT DEFAULT 0,
  total_cost     NUMERIC(10,6) DEFAULT 0,
  answer_length  INT,
  budget_hit     TEXT
);

CREATE TABLE IF NOT EXISTS mikro_events (
  id             BIGSERIAL PRIMARY KEY,
  session_id     TEXT REFERENCES mikro_sessions(id),
  iteration      INT,
  kind           TEXT NOT NULL,
  input_tokens   INT,
  output_tokens  INT,
  cost           NUMERIC(10,6),
  model          TEXT,
  code           TEXT,
  stdout         TEXT,
  stderr         TEXT,
  request_type   TEXT,
  prompt_preview TEXT,
  duration_ms    INT,
  is_error       BOOLEAN DEFAULT false,
  error_message  TEXT,
  data           JSONB,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE VIEW v_cost_breakdown AS
SELECT session_id, model,
  COUNT(*) AS calls,
  SUM(input_tokens) AS total_input,
  SUM(output_tokens) AS total_output,
  SUM(cost) AS total_cost,
  AVG(duration_ms)::INT AS avg_duration_ms
FROM mikro_events WHERE kind = 'llm_call'
GROUP BY session_id, model;

CREATE OR REPLACE VIEW v_repl_usage AS
SELECT session_id, request_type,
  COUNT(*) AS calls,
  SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS errors,
  AVG(duration_ms)::INT AS avg_duration_ms
FROM mikro_events WHERE kind IN ('sub_call', 'pg_query', 'repl_exec')
GROUP BY session_id, request_type;
`;

/** Resolve ~ in paths to the user's home directory */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Find a free TCP port by binding to port 0 and reading the assigned port.
 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to get free port")));
      }
    });
    srv.on("error", reject);
  });
}

/**
 * Compute adaptive chunk size based on provider limits and storage config.
 */
export function getChunkSize(provider: string, config: StorageConfig): number {
  if (config.chunkSize) return config.chunkSize;
  const limit = PROVIDER_LIMITS[provider] ?? 128000;
  return Math.floor(limit * config.chunkUtilization * config.charsPerToken);
}

/**
 * PgStorage manages an embedded pgserve instance for large context handling.
 */
/** Filename for the server-info sidecar inside a persistent-mode dataDir. */
const SERVER_SIDECAR = ".mikro-server.json";

/** Shape of the server-info sidecar written by the process that spawned pgserve. */
interface ServerSidecar {
  port: number;
  pid: number;
  startedAt: string;
}

export class PgStorage {
  private process: ChildProcess | null = null;
  private client: InstanceType<typeof Client> | null = null;
  private port = 0;
  private stopping = false;
  private cleanupRegistered = false;
  /**
   * Absolute path to the `.mikro-server.json` sidecar this instance wrote. Set
   * only when we spawned pgserve (owner mode) so `stop()` can clean it up.
   * Null when we attached to an existing instance (no ownership = no cleanup).
   */
  private sidecarPath: string | null = null;
  /** True when we connected to an existing pgserve via sidecar instead of spawning. */
  private attached = false;

  /** Connection string for the running pgserve instance */
  get connectionString(): string {
    return `postgresql://postgres:postgres@127.0.0.1:${this.port}/${MIKRO_DB}`;
  }

  /** Get the underlying pg Client (for observability recorder). */
  getClient(): InstanceType<typeof Client> | null {
    return this.client;
  }

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
  async start(config: StorageConfig): Promise<string> {
    // Attempt sidecar attach first (persistent mode only — memory mode
    // is ephemeral per-process, no coordination needed).
    if (config.mode === "persistent") {
      const attached = await this.tryAttachFromSidecar(config);
      if (attached) return attached;
    }

    // Resolve pgserve binary path
    const pgserveBin = this.findPgserveBin();

    // Spawn with port-collision retry. findFreePort picks an available
    // port, but between "kernel assigned port N" and "pgserve bound port
    // N" there's a race window where another process can steal N. If
    // config.port is 0 (auto-assign), retry up to 3 times with fresh
    // ports. If the caller pinned a port (config.port != 0), don't retry
    // — a pinned conflict is a real configuration error.
    const maxAttempts = config.port === 0 ? 3 : 1;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const requestedPort = config.port === 0 ? await findFreePort() : config.port;
      const args: string[] = [];
      args.push("--port", String(requestedPort));
      if (config.mode === "persistent") {
        const dataDir = expandHome(config.dataDir);
        mkdirSync(dataDir, { recursive: true });
        args.push("--data", dataDir);
      }
      // memory mode: no --data flag = in-memory (pgserve default)
      args.push("--log", "error");
      args.push("--no-cluster");
      args.push("--no-stats");

      this.process = spawn(pgserveBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      // Drain stdio so the 64KB pipe buffers never fill — during WAL
      // recovery of existing persistent-mode data, postgres writes
      // kilobytes of startup logs to stderr. If those pipes aren't
      // drained, the child blocks on write() and exits -2 before the
      // TCP listener comes up (bug #80).
      this.process.stdout?.on("data", () => { /* drain */ });
      this.process.stderr?.on("data", () => { /* drain */ });

      if (!this.cleanupRegistered) {
        this.registerCleanup();
        this.cleanupRegistered = true;
      }

      this.port = requestedPort;
      try {
        await this.waitForReady();
        lastErr = null;
        break; // success — proceed to connect+schema
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Clean the failed child so the next attempt starts from a known state
        try { this.process.kill("SIGKILL"); } catch { /* may already be dead */ }
        this.process = null;
        this.port = 0;
        if (attempt === maxAttempts) throw lastErr;
        // small backoff so stdio/shmem can settle before the next attempt
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    // Connect pg client and create schema
    this.client = new Client({ connectionString: this.connectionString });
    await this.client.connect();
    await this.client.query(SCHEMA_DDL);
    await this.client.query(OBSERVABILITY_DDL);

    // Publish server-info sidecar so other consumers on this dataDir can
    // attach instead of fighting over postmaster.pid + shmem. Only writes
    // for persistent mode — memory mode is per-process and non-sharable.
    if (config.mode === "persistent") {
      this.writeSidecar(expandHome(config.dataDir));
    }

    return this.connectionString;
  }

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
  private async tryAttachFromSidecar(config: StorageConfig): Promise<string | null> {
    const dataDir = expandHome(config.dataDir);

    // Level 1: mikro sidecar
    const sidecarPath = join(dataDir, SERVER_SIDECAR);
    if (existsSync(sidecarPath)) {
      let info: ServerSidecar | null = null;
      try {
        info = JSON.parse(readFileSync(sidecarPath, "utf-8")) as ServerSidecar;
      } catch {
        try { unlinkSync(sidecarPath); } catch { /* race */ }
      }
      if (info && info.port && info.pid) {
        const alive = (() => {
          try { process.kill(info!.pid, 0); return true; } catch { return false; }
        })();
        if (!alive) {
          try { unlinkSync(sidecarPath); } catch { /* race */ }
        } else {
          const connected = await this.tryConnectAt(info.port);
          if (connected) return this.connectionString;
        }
      }
    }

    // Level 2: postmaster.pid fallback — postgres writes this before our
    // sidecar even exists, and keeps it while alive. Format (7 lines):
    //   pid / dataDir / startEpoch / port / socketPath / listenAddr / shmem / status
    // We just need the pid (line 1) and port (line 4).
    const postmasterPid = join(dataDir, "postmaster.pid");
    if (existsSync(postmasterPid)) {
      try {
        const lines = readFileSync(postmasterPid, "utf-8").split("\n");
        const pid = parseInt(lines[0]?.trim() ?? "", 10);
        const port = parseInt(lines[3]?.trim() ?? "", 10);
        if (pid > 0 && port > 0) {
          try { process.kill(pid, 0); } catch { return null; }
          const connected = await this.tryConnectAt(port);
          if (connected) return this.connectionString;
        }
      } catch { /* unparseable — fall through to spawn */ }
    }

    return null;
  }

  /** Open a client at the given port; returns true and retains client on success. */
  private async tryConnectAt(port: number): Promise<boolean> {
    this.port = port;
    const client = new Client({ connectionString: this.connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } catch {
      this.port = 0;
      try { await client.end(); } catch { /* noop */ }
      return false;
    }
    this.client = client;
    this.attached = true;
    return true;
  }

  /** Write the server-info sidecar advertising our pgserve to future callers. */
  private writeSidecar(dataDir: string): void {
    const path = join(dataDir, SERVER_SIDECAR);
    const payload: ServerSidecar = {
      port: this.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      this.sidecarPath = path;
    } catch {
      // advisory — attachment is a nice-to-have, not a hard requirement
    }
  }

  /**
   * Ingest a loaded context into the records table.
   * For JSONL: parses each line as JSON, extracts timestamp/type fields.
   * For other text: one record per line.
   */
  async ingest(context: LoadedContext, sessionId?: string): Promise<number> {
    if (!this.client) throw new Error("PgStorage not started");

    // Clear stale records so re-runs with different context don't keep old data
    await this.client.query("TRUNCATE records");

    // Collect all lines from context, tracking source file when available
    let lines: Array<{ text: string; source: string | null }>;
    if (context.type === "list") {
      const items = context.content as ContextItem[];
      lines = items.flatMap((item) =>
        item.content.split("\n").map((text) => ({ text, source: item.path }))
      );
    } else {
      lines = (context.content as string)
        .split("\n")
        .map((text) => ({ text, source: null }));
    }

    // Batch insert using multi-row VALUES
    const BATCH_SIZE = 500;
    let ingested = 0;

    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      const batch = lines.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < batch.length; j++) {
        const lineNum = i + j;
        const { text, source } = batch[j];
        if (text.trim() === "") continue;

        const { timestamp, type, content } = parseContextLine(text, { source });
        const idx = values.length;
        placeholders.push(
          `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6})`
        );
        values.push(lineNum, timestamp, type, source, sessionId ?? null, content);
      }

      if (placeholders.length > 0) {
        await this.client.query(
          `INSERT INTO records (line_num, timestamp, type, source, session_id, content)
           VALUES ${placeholders.join(", ")}`,
          values
        );
        ingested += placeholders.length;
      }
    }

    return ingested;
  }

  /**
   * Full-text search via tsvector.
   */
  async search(
    pattern: string,
    limit = 20
  ): Promise<Array<{ line_num: number; content: string; rank: number }>> {
    if (!this.client) throw new Error("PgStorage not started");

    // Convert pattern to tsquery: split words and join with &
    const tsquery = pattern
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter(Boolean)
      .join(" & ");

    if (!tsquery) return [];

    const result = await this.client.query(
      `SELECT line_num, source, content, ts_rank(content_tsvector, to_tsquery('english', $1)) AS rank
       FROM records
       WHERE content_tsvector @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [tsquery, limit]
    );

    return result.rows.map((r) => ({
      line_num: r.line_num,
      source: r.source,
      content: r.content,
      rank: parseFloat(r.rank),
    }));
  }

  /**
   * Get records by line number range (inclusive).
   */
  async slice(
    start: number,
    end: number
  ): Promise<Array<{ line_num: number; content: string }>> {
    if (!this.client) throw new Error("PgStorage not started");

    const result = await this.client.query(
      `SELECT line_num, source, content FROM records
       WHERE line_num >= $1 AND line_num < $2
       ORDER BY line_num`,
      [start, end]
    );

    return result.rows;
  }

  /**
   * Filter records by timestamp range.
   */
  async timeRange(
    from: string,
    to: string
  ): Promise<
    Array<{ line_num: number; timestamp: string; content: string }>
  > {
    if (!this.client) throw new Error("PgStorage not started");

    const result = await this.client.query(
      `SELECT line_num, timestamp, content FROM records
       WHERE timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
       ORDER BY timestamp`,
      [from, to]
    );

    return result.rows;
  }

  /**
   * Count total records.
   */
  async count(): Promise<number> {
    if (!this.client) throw new Error("PgStorage not started");
    const result = await this.client.query("SELECT COUNT(*)::int AS cnt FROM records");
    return result.rows[0].cnt;
  }

  /**
   * Execute raw SQL (read-only). Supports parameterized queries.
   */
  async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    if (!this.client) throw new Error("PgStorage not started");

    // Wrap in read-only transaction for safety
    await this.client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const result = params
        ? await this.client.query(sql, params)
        : await this.client.query(sql);
      await this.client.query("COMMIT");
      return result.rows;
    } catch (err) {
      await this.client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  /**
   * Stop pgserve: graceful 3s timeout, then SIGKILL.
   *
   * When this instance attached to an existing pgserve (via sidecar), only
   * the pg client is closed — the pgserve process belongs to someone else
   * and must not be killed.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    // Close pg client (always — whether owner or attached)
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // Ignore client close errors
      }
      this.client = null;
    }

    // Kill pgserve process — ONLY if we spawned it (not attached mode).
    const proc = this.process;
    if (proc && proc.pid && !proc.killed) {
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already dead
          }
          resolve();
        }, 3000);

        proc.once("exit", () => {
          clearTimeout(forceKillTimer);
          resolve();
        });

        try {
          proc.kill("SIGTERM");
        } catch {
          clearTimeout(forceKillTimer);
          resolve();
        }
      });
    }

    // Clean up the server-info sidecar so stale entries don't mislead the
    // next caller. Only the owner removes it; attached instances leave it
    // alone (the owner is still running).
    if (this.sidecarPath) {
      try { unlinkSync(this.sidecarPath); } catch { /* may already be gone */ }
      this.sidecarPath = null;
    }

    this.process = null;
    this.attached = false;
    this.stopping = false;
  }

  // ─── Private helpers ──────────────────────────────────────

  /** Find the pgserve CLI binary in node_modules */
  private findPgserveBin(): string {
    // Try package-relative first (works for global installs), then cwd fallback
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgBin = join(__dirname, "..", "..", "node_modules", ".bin", "pgserve");
    if (existsSync(pkgBin)) return pkgBin;

    // Fallback: resolve from cwd (works for local dev)
    return resolve("node_modules", ".bin", "pgserve");
  }

  /**
   * Wait for pgserve to accept connections (poll with backoff).
   * Throws if not ready within 10 seconds.
   */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastError: Error | null = null;

    // Also capture process errors
    const procError = new Promise<never>((_, reject) => {
      if (!this.process) return;
      this.process.once("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(new Error(`pgserve exited with code ${code}`));
        }
      });
      this.process.once("error", (err) => {
        reject(new Error(`pgserve spawn error: ${err.message}`));
      });
    });

    while (Date.now() < deadline) {
      // Fail fast if the process already exited
      if (this.process && typeof this.process.exitCode === 'number') {
        throw new Error(`pgserve exited with code ${this.process.exitCode} before becoming ready`);
      }

      try {
        const testClient = new Client({
          connectionString: this.connectionString,
          connectionTimeoutMillis: 1000,
        });
        await Promise.race([testClient.connect(), procError]);
        await testClient.end();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    throw new Error(
      `pgserve did not become ready within 10s: ${lastError?.message ?? "unknown error"}`
    );
  }

  /** Register process exit handlers for cleanup */
  private registerCleanup(): void {
    const cleanup = () => {
      // Remove the server-info sidecar FIRST so another process that wakes
      // up right after us doesn't try to attach to a server we're about to
      // kill. Best-effort — any failure here is inconsequential.
      if (this.sidecarPath) {
        try { unlinkSync(this.sidecarPath); } catch { /* gone already */ }
        this.sidecarPath = null;
      }
      if (this.process && this.process.pid && !this.process.killed) {
        try {
          this.process.kill("SIGKILL");
        } catch {
          // Best effort
        }
      }
    };

    process.once("exit", cleanup);
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(128 + 15);
    });
    process.once("SIGINT", () => {
      cleanup();
      process.exit(128 + 2);
    });
    process.once("uncaughtException", (err) => {
      console.error("mikro: uncaught exception, cleaning up pgserve:", err.message);
      cleanup();
      process.exit(1);
    });
  }
}

// ─── Line parsing ───────────────────────────────────────

/** Common timestamp field names in JSONL data */
const TIMESTAMP_FIELDS = [
  "timestamp",
  "ts",
  "time",
  "datetime",
  "date",
  "created_at",
  "createdAt",
  "@timestamp",
];

/** Common type/category field names in JSONL data */
const TYPE_FIELDS = ["type", "kind", "level", "severity", "category", "event"];

export interface ParseContextLineOptions {
  /** Source path for the line, when loaded from a directory context. */
  source?: string | null;
}

/**
 * Parse a single line of context data.
 * JSONL parsing is source-aware so markdown/code examples that happen to
 * start with "{" remain plain text instead of producing noisy warnings.
 */
export function parseContextLine(
  line: string,
  options: ParseContextLineOptions = {}
): {
  timestamp: string | null;
  type: string | null;
  content: string;
} {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return { timestamp: null, type: null, content: trimmed };
  }

  const source = options.source ?? null;
  const shouldParseJsonl = source === null || source.toLowerCase().endsWith(".jsonl");
  if (!shouldParseJsonl) {
    return { timestamp: null, type: null, content: trimmed };
  }

  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) {
      return { timestamp: null, type: null, content: trimmed };
    }

    // Extract timestamp
    let timestamp: string | null = null;
    for (const field of TIMESTAMP_FIELDS) {
      if (obj[field] !== undefined && obj[field] !== null) {
        timestamp = String(obj[field]);
        break;
      }
    }

    // Extract type
    let type: string | null = null;
    for (const field of TYPE_FIELDS) {
      if (obj[field] !== undefined && obj[field] !== null) {
        type = String(obj[field]);
        break;
      }
    }

    return { timestamp, type, content: trimmed };
  } catch {
    // Malformed JSONL in an actual JSONL source — log warning and treat as plain text
    process.stderr.write(
      `mikro: warning: skipping malformed JSONL line: ${trimmed.slice(0, 80)}...\n`
    );
    return { timestamp: null, type: null, content: trimmed };
  }
}
