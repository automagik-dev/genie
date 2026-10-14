/**
 * ACP (Agent Client Protocol) stdio agent — wish mikro-acp-adapter, Group 1.
 *
 * Exposes `mikro acp`: a stdio JSON-RPC agent (per the Agent Client Protocol,
 * https://agentclientprotocol.com) that completes the handshake and drives the
 * REAL instrumented `rlmLoop` in-process for a prompt round-trip.
 *
 * Scope boundaries (see WISH.md):
 *   • Group 1 (this file): lifecycle skeleton — initialize / authenticate /
 *     session/new / session/load (clean-error stub) / session/prompt. On
 *     prompt it runs the real `rlmLoop` and streams a single end-of-run
 *     `agent_message_chunk` with the answer. Single active prompt turn,
 *     SERIALIZED: a concurrent `session/prompt` is REJECTED with a clear
 *     JSON-RPC error (documented choice — not queued).
 *   • Group 2: full AgentEvent → session/update translation (tool calls,
 *     thoughts, plans). The event drain loop below is the seam it hooks.
 *   • Group 3 (DONE): durable session/load + persistence. `initialize` now
 *     advertises `loadSession: true` + MCP-server support; sessions are backed
 *     by a durable per-session file (see `session-store.ts`) with RESTORE-ON-
 *     EMPTY, so a `session/load` + follow-up `session/prompt` survive an
 *     agent-process restart instead of throwing "Invalid params". Prompt turns
 *     thread prior-turn context so a session is genuinely multi-turn. Host MCP
 *     config is materialized + advertised (store-only; mikro has no MCP client —
 *     execution is a documented follow-on). Mid-run disconnect (stdin EOF /
 *     SIGTERM) reuses the cooperative cancel path to abort the active turn and
 *     close the emitter before exit (no orphaned children, emitter closed).
 *
 * SDK: @agentclientprotocol/sdk ^0.26.0 (same family pi-acp pins). Method
 * names map to the SDK's `Agent` interface members: initialize,
 * authenticate, newSession (session/new), loadSession (session/load),
 * prompt (session/prompt), cancel (session/cancel).
 *
 * stdout discipline: an ACP stdio agent owns stdout for framed JSON-RPC.
 * `runAcp()` reroutes console.* to stderr so no stray human/logging output
 * corrupts the protocol stream; the SDK writes frames via process.stdout
 * directly (unaffected). rlmLoop is driven with `output: "json"` so its
 * stream-mode stdout path is never taken.
 */
import { AgentSideConnection, type Agent, type AuthenticateRequest, type AuthenticateResponse, type CancelNotification, type InitializeRequest, type InitializeResponse, type LoadSessionRequest, type LoadSessionResponse, type NewSessionRequest, type NewSessionResponse, type PromptRequest, type PromptResponse } from "@agentclientprotocol/sdk";
import { type EmitterAndStream } from "../sdk/emitter.js";
/** Cancellation handle for the single in-flight prompt turn. */
interface ActivePrompt {
    readonly sessionId: string;
    readonly abort: AbortController;
    /** The run's live emitter, so disconnect can close it (drain unblocks). */
    readonly emitter: EmitterAndStream;
}
/**
 * Cooperative-cancel primitive shared by `session/cancel` and disconnect
 * shutdown. Aborts the in-flight turn (the drain loop stops forwarding
 * session/update and the turn resolves `cancelled`) and closes its emitter so
 * the `await drain` in `prompt()` unblocks immediately rather than dangling.
 * Idempotent and null-safe. Returns true if there was an active prompt to abort.
 */
export declare function abortActivePrompt(active: ActivePrompt | null): boolean;
/**
 * The mikro ACP agent. One instance per stdio connection.
 *
 * Single active session, serialized: `promptInFlight` guards the one-at-a-time
 * invariant. A second `session/prompt` that arrives while a run is in flight is
 * rejected with `RequestError.invalidRequest` (JSON-RPC -32600) — a clear,
 * documented rejection rather than a silent queue.
 */
export declare class MikroAcpAgent implements Agent {
    private readonly conn;
    private readonly sessions;
    private readonly store;
    private readonly version;
    /** True while a `session/prompt` turn is executing. Serializes prompt turns. */
    private promptInFlight;
    /** Cancellation handle for the in-flight prompt turn, if any. */
    private activePrompt;
    constructor(conn: AgentSideConnection);
    initialize(_params: InitializeRequest): Promise<InitializeResponse>;
    authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse>;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
    prompt(params: PromptRequest): Promise<PromptResponse>;
    cancel(params: CancelNotification): Promise<void>;
    /**
     * Disconnect hardening (stdin EOF / SIGTERM mid-run). Reuses the cooperative
     * cancel path: aborts the active prompt turn and closes its emitter so the
     * drain loop and its `await drain` unblock cleanly before the process exits —
     * no dangling async iterator, emitter closed. Returns true if a turn was
     * aborted (used by the shutdown handler to decide whether to grace-wait).
     */
    shutdown(): boolean;
    /** Best-effort model snapshot from a cwd's config for the stored record. */
    private configSnapshot;
}
/**
 * Fold prior turns into a follow-up prompt so a durable session is genuinely
 * multi-turn. The first turn of a session (no history) passes the query through
 * unchanged — the fast/default path is untouched. On a follow-up, the most-
 * recent PREAMBLE_TURNS turns are prepended as a bounded, clearly-delimited
 * transcript so the model can reference earlier context (the exact capability a
 * restart must preserve). Each field is char-capped so the preamble cannot grow
 * without bound.
 */
export declare function buildConversationalQuery(turns: ReadonlyArray<{
    query: string;
    answer: string;
}>, currentQuery: string): string;
/**
 * Bootstrap the stdio ACP connection and run until stdin closes.
 *
 * Reroutes console.* to stderr up front so the JSON-RPC frames the SDK writes
 * to stdout are never interleaved with stray logging.
 */
export declare function runAcp(): Promise<void>;
export {};
//# sourceMappingURL=agent.d.ts.map