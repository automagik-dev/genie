/**
 * Session API — Wish B Group 2.
 *
 * A session is the unit of resumable agent work. The SDK persists a
 * snapshot (`SessionState`) after each iteration so a crashed or
 * paused agent can pick up where it left off. Two public entry points:
 *
 *   resumeAgent(sessionId, store) — load the snapshot if it exists.
 *   pauseAgent(sessionId, store)  — checkpoint + emit SessionClose.
 *
 * The rlm.ts instrumentation that actually calls these (every
 * iteration) lands in a later slice; this PR ships the shape + a
 * file-backed store + tests. Budget is snapshotted alongside history
 * so `budget.spent` is preserved across the session boundary
 * (WISH.md G2 acceptance criterion 4).
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L136-158.
 */
import type { EventEmitter } from "./emitter.js";
import type { SessionCloseReason } from "./events.js";
export interface HistoryTurn {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
}
/**
 * Budget snapshot. Mirrors `budget.ts#BudgetState`'s public shape at
 * the shallowest level needed to resume — we deliberately do NOT
 * import `budget.ts` here to keep the SDK surface additive.
 */
export interface BudgetSnapshot {
    readonly spent: number;
    readonly limit: number;
    readonly currency: "usd" | "tokens";
}
export interface SessionState {
    readonly sessionId: string;
    readonly iteration: number;
    readonly history: readonly HistoryTurn[];
    readonly budget: BudgetSnapshot;
    /** Opaque REPL snapshot — left unstructured for the loader plumbing. */
    readonly replState?: unknown;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/**
 * Pluggable persistence. Default implementation is file-backed
 * (below); a pgserve-backed store can implement the same interface
 * when that lands. Keeping the interface narrow means callers never
 * depend on a specific backend.
 */
export interface SessionStore {
    save(state: SessionState): Promise<void>;
    load(sessionId: string): Promise<SessionState | null>;
    delete(sessionId: string): Promise<void>;
    list(): Promise<readonly string[]>;
}
/** Validate that the given value looks like a `SessionState`. */
export declare function isSessionState(value: unknown): value is SessionState;
/**
 * File-backed session store. Each session becomes a single JSON file
 * under `<baseDir>/<sessionId>.json`. Writes are atomic (tmp + rename)
 * so a crash mid-save cannot corrupt a previous snapshot.
 */
export declare function createFileSessionStore(baseDir: string): SessionStore;
/**
 * Load a prior snapshot if one exists. Returns `null` when no session
 * is found. When `emit` is supplied, a `SessionOpen` event is emitted
 * with `resumed: true` (or `false` for fresh sessions — the caller
 * distinguishes by the return value being null).
 */
export declare function resumeAgent(sessionId: string, store: SessionStore, emit?: EventEmitter): Promise<SessionState | null>;
/**
 * Persist the given snapshot and emit `SessionClose`. The caller is
 * responsible for assembling a well-formed `SessionState` — `pauseAgent`
 * does not synthesize state from nowhere.
 */
export declare function pauseAgent(state: SessionState, store: SessionStore, reason?: SessionCloseReason, emit?: EventEmitter): Promise<void>;
//# sourceMappingURL=session.d.ts.map