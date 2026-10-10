/**
 * Durable ACP session persistence — wish mikro-acp-adapter, Group 3.
 *
 * The Group 1 agent kept sessions in an in-memory `Map`. That is the exact
 * shape of the multi-turn bug the pi-in-Tidewave patches fixed: a host restarts
 * the agent process between turns, the map is empty, `session/load` (or the
 * `session/prompt` that follows it) can find nothing, and the client gets
 * "Invalid params". This module gives every ACP session a durable, per-session
 * file so a `session/load` after an agent-process restart rehydrates
 * (RESTORE-ON-EMPTY) and a follow-up `session/prompt` resumes with the prior
 * turns' context instead of throwing.
 *
 * ── STORE LOCATION (mikro convention) ─────────────────────────────────────────
 * mikro already persists per-run artifacts under `~/.mikro/sessions/<runId>/`
 * (see `src/session.ts`) and global settings under `~/.mikro/settings.json`
 * (see `src/settings.ts`). ACP sessions follow the same root: one JSON file per
 * ACP session at `~/.mikro/acp-sessions/<sessionId>.json`. The base directory is
 * overridable via `MIKRO_ACP_SESSIONS_DIR` (hermetic tests + the multiturn smoke
 * point it at a temp dir so the two agent spawns share a store without touching
 * the real home).
 *
 * ── BOUNDED GROWTH / PRUNE POLICY ────────────────────────────────────────────
 * A conversation could otherwise grow a session file without bound. Three caps:
 *   • Per-turn:  each stored turn's query/answer is capped at MAX_FIELD_CHARS
 *                (32 KB) so one pathological turn cannot bloat the file.
 *   • Per-file:  only the most-recent MAX_TURNS turns are persisted; older
 *                turns are dropped from the head. The resume preamble uses at
 *                most PREAMBLE_TURNS of those (see agent.ts), so this is a
 *                superset of what a resume needs.
 *   • Per-dir:   on each `create`, the acp-sessions directory is pruned to at
 *                most MAX_SESSION_FILES files, deleting the oldest by mtime.
 * All three are documented and unit-tested.
 *
 * ── ATOMICITY ────────────────────────────────────────────────────────────────
 * Each save writes a sibling temp file and `rename()`s it into place, so a
 * crash mid-write leaves the previous good file intact rather than a truncated
 * JSON blob that would re-introduce the "Invalid params" failure on load.
 */
import type { McpServer } from "@agentclientprotocol/sdk";
/** On-disk schema version. Bump if the record shape changes incompatibly. */
export declare const STORE_VERSION: 1;
/** Max turns retained in a session file. Older turns drop from the head. */
export declare const MAX_TURNS = 100;
/** Max session files kept in the store dir; oldest-by-mtime pruned on create. */
export declare const MAX_SESSION_FILES = 500;
/** One conversation turn: the user query and the agent's settled answer. */
export interface StoredTurn {
    readonly query: string;
    readonly answer: string;
    readonly timestamp: string;
}
/**
 * A durable ACP session record. Carries everything needed to resume a session
 * after an agent-process restart: the conversation history (turns), the cwd the
 * session was created in (config is reloaded from there — the mikro source of
 * truth), the host-supplied MCP server config (STORE/advertise only — mikro has
 * no MCP client; execution is a documented follow-on), and a config snapshot
 * for the record.
 */
export interface StoredSession {
    readonly version: typeof STORE_VERSION;
    readonly sessionId: string;
    readonly cwd: string;
    readonly createdAt: string;
    updatedAt: string;
    /** Host MCP servers materialized at session creation (advertise/store only). */
    readonly mcpServers: McpServer[];
    /** Informational snapshot of the model config resolved from `cwd`. */
    readonly configSnapshot: {
        provider: string;
        model: string;
    } | null;
    /** Conversation history, oldest-first, capped at MAX_TURNS. */
    turns: StoredTurn[];
}
/** Resolve the acp-sessions base directory (env-overridable for tests/smoke). */
export declare function storeDir(): string;
/** True iff `id` is a canonical UUID string (a path-safe session id). */
export declare function isValidSessionId(id: string): boolean;
/**
 * A durable store over `~/.mikro/acp-sessions/`. One instance per agent process;
 * cheap to construct (no I/O until a method is called).
 */
export declare class SessionStore {
    /** Persist a freshly created session, pruning the dir to MAX_SESSION_FILES. */
    create(sessionId: string, cwd: string, mcpServers: McpServer[], configSnapshot: {
        provider: string;
        model: string;
    } | null): Promise<StoredSession>;
    /**
     * Load a session from disk, or `null` if the file is missing/unreadable/
     * corrupt. A `null` here is what lets the agent treat an unknown-after-restart
     * id as "never existed" (a genuine bad id) vs. "restored from disk".
     */
    load(sessionId: string): Promise<StoredSession | null>;
    /**
     * Append a completed turn and persist. Enforces per-turn and per-file caps.
     * Returns the updated record so the caller can keep the in-memory copy in sync.
     */
    appendTurn(session: StoredSession, query: string, answer: string): Promise<StoredSession>;
    /** Atomic write: temp file + rename so a crash never leaves a partial file. */
    private write;
    /** Prune the store dir to at most MAX_SESSION_FILES, oldest-by-mtime first. */
    private pruneDir;
}
//# sourceMappingURL=session-store.d.ts.map