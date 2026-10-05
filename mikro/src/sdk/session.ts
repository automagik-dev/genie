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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventEmitter } from "./emitter.js";
import { iso, makeEvent } from "./events.js";
import type {
	SessionCloseEvent,
	SessionCloseReason,
	SessionOpenEvent,
} from "./events.js";

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
export function isSessionState(value: unknown): value is SessionState {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.sessionId !== "string" || v.sessionId.length === 0) return false;
	if (typeof v.iteration !== "number" || !Number.isInteger(v.iteration))
		return false;
	if (!Array.isArray(v.history)) return false;
	const b = v.budget as Record<string, unknown> | undefined;
	if (!b || typeof b !== "object") return false;
	if (typeof b.spent !== "number" || typeof b.limit !== "number") return false;
	if (typeof v.createdAt !== "string" || typeof v.updatedAt !== "string")
		return false;
	return true;
}

/** Safe id → filename transform. Matches the mikro naming style. */
function safeFilename(sessionId: string): string {
	const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-");
	return cleaned.length > 0 ? cleaned : "session";
}

/**
 * File-backed session store. Each session becomes a single JSON file
 * under `<baseDir>/<sessionId>.json`. Writes are atomic (tmp + rename)
 * so a crash mid-save cannot corrupt a previous snapshot.
 */
export function createFileSessionStore(baseDir: string): SessionStore {
	async function ensureDir(): Promise<void> {
		await mkdir(baseDir, { recursive: true });
	}

	function pathFor(sessionId: string): string {
		return join(baseDir, `${safeFilename(sessionId)}.json`);
	}

	return {
		async save(state) {
			if (!isSessionState(state)) {
				throw new TypeError("session store: invalid SessionState");
			}
			await ensureDir();
			const target = pathFor(state.sessionId);
			await mkdir(dirname(target), { recursive: true });
			const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
			await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
			const { rename } = await import("node:fs/promises");
			await rename(tmp, target);
		},
		async load(sessionId) {
			const target = pathFor(sessionId);
			try {
				const raw = await readFile(target, "utf8");
				const parsed = JSON.parse(raw);
				if (!isSessionState(parsed)) return null;
				return parsed;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") return null;
				throw err;
			}
		},
		async delete(sessionId) {
			const target = pathFor(sessionId);
			try {
				await rm(target);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw err;
			}
		},
		async list() {
			await ensureDir();
			const { readdir } = await import("node:fs/promises");
			const entries = await readdir(baseDir);
			return entries
				.filter((e) => e.endsWith(".json"))
				.map((e) => e.slice(0, -".json".length));
		},
	};
}

/**
 * Load a prior snapshot if one exists. Returns `null` when no session
 * is found. When `emit` is supplied, a `SessionOpen` event is emitted
 * with `resumed: true` (or `false` for fresh sessions — the caller
 * distinguishes by the return value being null).
 */
export async function resumeAgent(
	sessionId: string,
	store: SessionStore,
	emit?: EventEmitter,
): Promise<SessionState | null> {
	const state = await store.load(sessionId);
	if (emit) {
		const ev: SessionOpenEvent = makeEvent("SessionOpen", {
			sessionId,
			resumed: state !== null,
		} as Omit<SessionOpenEvent, "type" | "timestamp">);
		emit.emit(ev);
	}
	return state;
}

/**
 * Persist the given snapshot and emit `SessionClose`. The caller is
 * responsible for assembling a well-formed `SessionState` — `pauseAgent`
 * does not synthesize state from nowhere.
 */
export async function pauseAgent(
	state: SessionState,
	store: SessionStore,
	reason: SessionCloseReason = "pause",
	emit?: EventEmitter,
): Promise<void> {
	const stamped: SessionState = { ...state, updatedAt: iso() };
	await store.save(stamped);
	if (emit) {
		const ev: SessionCloseEvent = makeEvent("SessionClose", {
			sessionId: state.sessionId,
			reason,
		} as Omit<SessionCloseEvent, "type" | "timestamp">);
		emit.emit(ev);
	}
}
