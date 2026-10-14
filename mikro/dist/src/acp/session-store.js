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
import { mkdir, writeFile, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
/** On-disk schema version. Bump if the record shape changes incompatibly. */
export const STORE_VERSION = 1;
/** Max chars persisted per turn field (query / answer). Bounds a single turn. */
const MAX_FIELD_CHARS = 32_768;
/** Max turns retained in a session file. Older turns drop from the head. */
export const MAX_TURNS = 100;
/** Max session files kept in the store dir; oldest-by-mtime pruned on create. */
export const MAX_SESSION_FILES = 500;
/** Resolve the acp-sessions base directory (env-overridable for tests/smoke). */
export function storeDir() {
    const override = process.env.MIKRO_ACP_SESSIONS_DIR;
    if (override && override.length > 0)
        return override;
    return join(homedir(), ".mikro", "acp-sessions");
}
/**
 * Canonical UUID shape guard (8-4-4-4-12 hex, any version/variant). A session id
 * is only ever a UUID minted by `randomUUID()`, so anything else — notably a
 * host-supplied `session/load` value containing `/` or `..` — is rejected. This
 * is the single source of truth for the path-traversal defense: `sessionPath`
 * refuses to build a path from a non-UUID id, and `agent.loadSession` rejects a
 * non-UUID `session/load` with -32602 before ever touching the store.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** True iff `id` is a canonical UUID string (a path-safe session id). */
export function isValidSessionId(id) {
    return SESSION_ID_RE.test(id);
}
/** Absolute path to a session's file. `sessionId` is a UUID, so path-safe. */
function sessionPath(sessionId) {
    // Defense in depth: a session id is ALWAYS a UUID. A non-UUID here — a
    // host-supplied traversal string, or a poisoned record's internal id — must
    // never be turned into a filesystem path, or a write/appendTurn could land
    // OUTSIDE the store dir (path traversal).
    if (!isValidSessionId(sessionId)) {
        throw new Error(`refusing to build a session path from a non-UUID sessionId: ${sessionId}`);
    }
    return join(storeDir(), `${sessionId}.json`);
}
/** Truncate a persisted field with a self-describing marker. */
function capField(text) {
    if (text.length <= MAX_FIELD_CHARS)
        return text;
    const omitted = text.length - MAX_FIELD_CHARS;
    return `${text.slice(0, MAX_FIELD_CHARS)}\n…[mikro: truncated ${omitted} chars]`;
}
/**
 * A durable store over `~/.mikro/acp-sessions/`. One instance per agent process;
 * cheap to construct (no I/O until a method is called).
 */
export class SessionStore {
    /** Persist a freshly created session, pruning the dir to MAX_SESSION_FILES. */
    async create(sessionId, cwd, mcpServers, configSnapshot) {
        const now = new Date().toISOString();
        const record = {
            version: STORE_VERSION,
            sessionId,
            cwd,
            createdAt: now,
            updatedAt: now,
            mcpServers,
            configSnapshot,
            turns: [],
        };
        await this.write(record);
        await this.pruneDir();
        return record;
    }
    /**
     * Load a session from disk, or `null` if the file is missing/unreadable/
     * corrupt. A `null` here is what lets the agent treat an unknown-after-restart
     * id as "never existed" (a genuine bad id) vs. "restored from disk".
     */
    async load(sessionId) {
        // A non-UUID id is never a real session file: reject before touching the
        // filesystem so a traversal string can't read outside the store dir.
        if (!isValidSessionId(sessionId))
            return null;
        let raw;
        try {
            raw = await readFile(sessionPath(sessionId), "utf-8");
        }
        catch {
            return null; // missing — not an error; caller decides.
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return null; // corrupt (e.g. a crash before atomic rename landed).
        }
        if (!isStoredSession(parsed))
            return null;
        // A record whose INTERNAL id is not the requested UUID is corrupt/poisoned
        // (a valid-named file whose sessionId encodes `../..`): refuse it so a
        // later appendTurn can't write OUTSIDE the store dir.
        if (parsed.sessionId !== sessionId)
            return null;
        return parsed;
    }
    /**
     * Append a completed turn and persist. Enforces per-turn and per-file caps.
     * Returns the updated record so the caller can keep the in-memory copy in sync.
     */
    async appendTurn(session, query, answer) {
        session.turns.push({
            query: capField(query),
            answer: capField(answer),
            timestamp: new Date().toISOString(),
        });
        // Per-file cap: keep only the most-recent MAX_TURNS.
        if (session.turns.length > MAX_TURNS) {
            session.turns = session.turns.slice(session.turns.length - MAX_TURNS);
        }
        session.updatedAt = new Date().toISOString();
        await this.write(session);
        return session;
    }
    /** Atomic write: temp file + rename so a crash never leaves a partial file. */
    async write(record) {
        const dir = storeDir();
        await mkdir(dir, { recursive: true });
        const finalPath = sessionPath(record.sessionId);
        const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
        await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
        await rename(tmpPath, finalPath);
    }
    /** Prune the store dir to at most MAX_SESSION_FILES, oldest-by-mtime first. */
    async pruneDir() {
        const dir = storeDir();
        let entries;
        try {
            entries = (await readdir(dir)).filter((f) => f.endsWith(".json"));
        }
        catch {
            return; // dir gone — nothing to prune.
        }
        if (entries.length <= MAX_SESSION_FILES)
            return;
        const withMtime = await Promise.all(entries.map(async (f) => {
            try {
                const s = await stat(join(dir, f));
                return { f, mtime: s.mtimeMs };
            }
            catch {
                return { f, mtime: Number.POSITIVE_INFINITY }; // skip on error
            }
        }));
        withMtime.sort((a, b) => a.mtime - b.mtime); // oldest first
        const excess = withMtime.slice(0, withMtime.length - MAX_SESSION_FILES);
        await Promise.all(excess.map(({ f }) => unlink(join(dir, f)).catch(() => { })));
    }
}
/** Structural guard: is `value` a well-formed StoredSession record? */
function isStoredSession(value) {
    if (value === null || typeof value !== "object")
        return false;
    const v = value;
    if (v.version !== STORE_VERSION)
        return false;
    if (typeof v.sessionId !== "string" || typeof v.cwd !== "string")
        return false;
    if (typeof v.createdAt !== "string" || typeof v.updatedAt !== "string")
        return false;
    if (!Array.isArray(v.turns))
        return false;
    if (!Array.isArray(v.mcpServers))
        return false;
    for (const t of v.turns) {
        if (t === null || typeof t !== "object")
            return false;
        const turn = t;
        if (typeof turn.query !== "string" || typeof turn.answer !== "string")
            return false;
    }
    return true;
}
//# sourceMappingURL=session-store.js.map