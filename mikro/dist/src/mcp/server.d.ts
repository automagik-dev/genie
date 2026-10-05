/**
 * `mikro mcp` — expose mikro to MCP clients (Claude Code, Codex, …).
 *
 * Why this exists: ACP's *client* is an editor and its *agent* is the AI tool,
 * so `mikro acp` is an Agent — and Claude Code and Codex are Agents too. Two
 * agents cannot drive each other over ACP. MCP is the protocol those harnesses
 * *do* speak as clients, which makes it the native way to hand mikro work.
 *
 *   claude mcp add mikro -- mikro mcp
 *
 * Every discovered `agent.yaml` microagent becomes its own tool, so the host
 * model sees `mikro_test_writer` / `mikro_triage` as distinct capabilities it
 * can delegate to, rather than one opaque escape hatch it has to be told how
 * to use. Each tool runs on whatever model its `agent.yaml` names — a local
 * `station/<model>` or a cheap cloud model — which is how repeatable work gets
 * moved off an expensive host model.
 *
 * Every result carries its own token/cost footer, so the offload is visible in
 * the transcript as it happens instead of having to be taken on faith.
 *
 * Two properties make this usable rather than merely present:
 *
 *   Live tool set — every `tools/list` AND every `tools/call` re-scans the
 *   agent roots, and both the advertised list and the dispatch table are built
 *   from that one scan. An agent directory authored mid-session is therefore
 *   listed *and* callable without a reconnect, and the server emits
 *   `notifications/tools/list_changed` when the set actually changes.
 *
 *   Agent-tool isomorphism — the surface mirrors the host's own Agent tool:
 *   `prompt` in, one final report out, a `session_id` to continue with. A
 *   follow-up resumes by replaying the session's bounded turn history into the
 *   new prompt (the mechanism `src/acp/agent.ts` uses); the Python REPL is
 *   rebuilt per call and its state is deliberately not promised across turns.
 *
 * stdout discipline: MCP stdio frames JSON-RPC on stdout, so all human/
 * diagnostic logging is redirected to stderr and the legacy backend runs
 * `rlmLoop` with `output: "json"` to keep it off its stream-mode stdout path —
 * the same contract `src/acp/agent.ts` follows.
 */
import { type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type MikroConfig } from "../config.js";
import { type Microagent } from "./agents.js";
import type { MicroagentResult, RuntimeBackend } from "./backend.js";
/**
 * Emits `notifications/progress` for a single tool call.
 *
 * This is load-bearing, not cosmetic: MCP clients time a request out (the
 * reference client defaults to 60s), and delegated mikro work — a recursive run
 * on a local model — routinely runs longer than that. Progress notifications
 * are what let a conforming client extend its deadline, and they surface the
 * delegated agent's iterations in the host transcript while it works.
 */
export type ProgressSink = (message: string) => void;
/**
 * Output contract. Declaring it is what makes `structuredContent` a stated
 * promise rather than an undocumented extra a client may drop — but it cuts
 * the other way too: once an `outputSchema` exists, `structuredContent` is a
 * channel a conforming client may read *instead of* `content` (the reference
 * client outright rejects a non-error result that omits it). So the answer
 * itself has to be part of the promise. A schema naming only `session_id`
 * describes a result whose entire payload the host is free to discard —
 * offloaded work that ran, cost money, and returned nothing the model can see.
 */
export declare function toolOutputSchema(): Tool["outputSchema"];
export declare function buildToolList(agents: readonly Microagent[]): Tool[];
/** One re-scan: what to advertise, what to dispatch on, and what changed. */
export interface AgentScan {
    readonly agents: readonly Microagent[];
    /** Call lookup, built from the SAME scan that produced `agents`. */
    readonly byToolName: ReadonlyMap<string, Microagent>;
    /** True when the advertised tool-name set differs from the previous scan. */
    readonly changed: boolean;
    /** Tool names present in the previous scan and gone from this one. */
    readonly removed: readonly string[];
}
/**
 * Re-scan the agent roots and diff the resulting tool-name set.
 *
 * The failure mode this designs out is a tool that is listed but not callable
 * (or callable but not listed): `agents` and `byToolName` come from one
 * `discoverAgents` call, so the advertised list and the dispatch table cannot
 * drift apart. The first refresh only seeds the baseline — it never reports a
 * change, or every connect would emit a spurious `list_changed`.
 *
 * Refreshes are serialized through a promise chain: a refresh does not call
 * `scan` until every earlier refresh has finished updating the baseline. That
 * is the actual guarantee — not merely that the diff and the baseline update
 * share a synchronous step, but that scans cannot complete out of order. Two
 * concurrent requests observing one new agent therefore report the change
 * exactly once, and a scan that started earlier can never overwrite the
 * baseline with its older tool set (which would report a live agent as
 * `removed`, evict its sessions, and then re-announce it on the next refresh).
 */
export declare function createAgentRegistry(scan: () => Promise<readonly Microagent[]>): {
    refresh: () => Promise<AgentScan>;
};
/** One completed exchange, replayed into a follow-up call on the session. */
export interface SessionTurn {
    readonly prompt: string;
    readonly answer: string;
}
export interface McpSession {
    readonly id: string;
    /**
     * The tool that created this session. A `session_id` is not portable: the
     * turns were produced by one agent's spec, so replaying them into another
     * agent would silently mix two identities.
     */
    readonly toolName: string;
    readonly turns: SessionTurn[];
    /** Epoch ms of the last use — drives both TTL expiry and LRU eviction. */
    lastUsedAt: number;
    /** True while a call on this session is in flight (serialize-and-reject). */
    busy: boolean;
}
export interface SessionStoreOptions {
    readonly ttlMs?: number;
    readonly maxSessions?: number;
    readonly maxTurns?: number;
    /** Test seam: injectable clock. */
    readonly now?: () => number;
    /** Test seam: injectable id source. */
    readonly newId?: () => string;
}
/**
 * In-process session map: `session_id` → bounded turn history.
 *
 * Bounded three ways, because an MCP server outlives any single conversation:
 * a TTL retires idle sessions, a size cap with LRU eviction bounds the map,
 * and a per-session turn cap bounds each entry. Nothing is persisted — a
 * server restart starts every conversation over, which is the honest contract
 * given the REPL is rebuilt per call anyway.
 */
export declare class McpSessionStore {
    private readonly sessions;
    private readonly ttlMs;
    private readonly maxSessions;
    private readonly maxTurns;
    private readonly now;
    private readonly newId;
    constructor(options?: SessionStoreOptions);
    get size(): number;
    create(toolName: string): McpSession;
    /** Live session, or undefined when it is unknown or has expired. */
    get(id: string): McpSession | undefined;
    /** Append a completed turn, dropping the oldest beyond the cap. */
    record(session: McpSession, turn: SessionTurn): void;
    delete(id: string): boolean;
    /**
     * Drop every session bound to a tool that no longer exists. An agent deleted
     * mid-session leaves its sessions unreachable — "Unknown tool" is the answer
     * a caller gets, so keeping the orphans would only hold memory.
     */
    evictTools(toolNames: Iterable<string>): number;
    private sweep;
    /** Evict least-recently-used sessions until there is room for one more. */
    private evictToCap;
}
/**
 * Fold prior turns into a follow-up prompt.
 *
 * Same mechanism as ACP's `buildConversationalQuery` (`src/acp/agent.ts`) and
 * for the same reason: a fresh `rlmLoop` — and therefore a fresh Python REPL —
 * runs on every call, so conversation continuity is carried by replaying the
 * transcript, not by holding interpreter state. Live REPL variables are
 * explicitly *not* promised across a resume. Each field is char-capped so the
 * preamble cannot grow without bound.
 */
export declare function buildResumeQuery(turns: readonly SessionTurn[], prompt: string): string;
/**
 * Iteration cap implied by an agent's spec.
 *
 * `shape: single-step` means exactly one pass — without this the agent
 * inherits rlmLoop's 30-iteration default and loops long past the point of
 * usefulness (observed: a single-step triage agent burning 30 iterations and
 * 157s, and getting the answer wrong). An explicit `budget.max_iterations`
 * always wins over the shape default.
 */
export declare function agentMaxIterations(agent: Microagent): number | undefined;
/**
 * Apply an agent's `agent.yaml` to the ambient config for one run.
 *
 * An agent's `model:` re-pins the sub-call model too. Spreading `config.model`
 * alone kept the *ambient* `mikro.yaml`'s `sub-call-model` while replacing
 * provider and model, so an agent declaring `khal/deepseek-v4-flash` under a
 * root whose yaml says `sub-call-model: gemini-3.1-flash-lite-preview`
 * composed `provider: khal` with a Google model id, and every bare
 * `llm_query(p)` came back `Unknown model "gemini-3.1-flash-lite-preview" for
 * provider "khal"`. `agent.yaml` has no sub-call-model key of its own, so the
 * agent's model is the only sensible default.
 */
export declare function applyAgent(config: MikroConfig, agent: Microagent): MikroConfig;
/**
 * Validate each discovered agent's `model:` pin against the runtime it will
 * actually run on, so `tools/list` never advertises a tool whose first call
 * is guaranteed to fail with "Unknown model". Only the pi-ai backed backend
 * (`mikro`, the default) resolves models this way; other backends own their
 * model universe and are left alone. The config is re-read per scan so a
 * newly declared provider heals a degraded agent on the next request.
 */
export declare function validateAgentModels(cwd: string, agents: readonly Microagent[]): Promise<Microagent[]>;
/**
 * Mark default-backend agents whose declared tools cannot be exposed safely.
 * This is a resolution-only discovery probe: plugins are neither imported nor
 * spawned here. A prior unavailability cause (notably a bad model pin) wins.
 */
export declare function validateAgentTools(cwd: string, agents: readonly Microagent[]): Promise<Microagent[]>;
/**
 * Result of a call that never reached a session: bad arguments, unknown tool,
 * unusable `session_id`. No `structuredContent`, because there is no session id
 * to put in it and the declared schema requires one — legal precisely because
 * these are all `isError`, and the schema binds only non-error results.
 */
export declare function textResult(text: string, isError?: boolean): CallToolResult;
/**
 * Result of a call that reached a session, success or failure alike. Declaring
 * `outputSchema` obliges a non-error result to carry `structuredContent`; an
 * error carries it too, so a caller can retry on the same session.
 *
 * `answer` is the *same string* as the text block, byte for byte, rather than
 * the bare answer with the footer stripped. Two reasons: a host that reads the
 * structured channel and ignores `content` must still see the token/cost
 * footer, or the offload stops being visible in the transcript — the property
 * this server exists to preserve; and one string mirrored into both channels
 * cannot drift, where two derived strings eventually do.
 */
export declare function sessionResult(text: string, sessionId: string, isError?: boolean): CallToolResult;
/**
 * Did `rlmLoop` hand back a failure instead of an answer?
 *
 * Only rlmLoop's `throw` path reaches the catch in the call handler. Its two
 * non-throwing failures — the consecutive-empty-response abort and the
 * wall-clock timeout — *return* normally with their reason as the answer
 * (`src/rlm.ts`). Reported as a success, the host model reads "Error: aborted
 * after 3 consecutive empty LLM responses" as the delegated agent's report.
 * `src/cli.ts` treats the first of those as a failed run (exit 1 on
 * `budgetHit === "empty_responses"`); this is the MCP equivalent, keyed off the
 * same field.
 *
 * Each abort is matched by its own exact signal, because neither one alone
 * covers both:
 *
 *   - the empty-response abort sets `budgetHit = "empty_responses"`;
 *   - the timeout preserves whatever `budgetHit` the run had accumulated
 *     (usually none) and is identified by its verbatim answer.
 *
 * What must NOT be used is a prefix test on the answer. `answer` is the model's
 * own final text, and a report that legitimately opens with `Error: …` is a
 * normal outcome, not a failure — quoting the failing line out of a log is the
 * entire job of the shipped `log-triage` recipe. Flagging that as `isError`
 * hands the host a paid, correct run marked failed, which it may discard or
 * retry at double the cost.
 *
 * A genuine `max-cost`/`max-tokens`/`max-depth` budget hit is deliberately not
 * a failure either: it forces a real final answer — a shorter report — and
 * stays `isError: false`.
 */
export declare function isFailedRun(result: Pick<MicroagentResult, "answer" | "budgetHit">): boolean;
export interface TurnOutcome {
    readonly answer: string;
    readonly text: string;
    /** True when the run hit one of the backend's designed aborts (see {@link isFailedRun}). */
    readonly failed: boolean;
}
/**
 * The backend a turn runs on.
 *
 * `mikro_query` (the generic tool) has no agent spec and therefore no
 * `backend` field: it always runs on the legacy backend, unconditionally —
 * there is no selection path for it. Agents default to `mikro` unless their
 * spec names another backend.
 */
export declare function selectBackend(agent: Microagent | undefined): RuntimeBackend;
/**
 * Run one turn on one backend. `query` is already the resume-folded prompt;
 * `prompt` is the caller's own text, which is what gets recorded as the turn
 * (a preamble must never be replayed inside the next preamble).
 *
 * `backend`/`agent` are the seam: the server no longer calls `rlmLoop` — it
 * asks the selected backend to run, and the backend owns the engine. The
 * backend emits bare progress messages ("iteration 3"); this wrapper owns the
 * label prefix, the last-progress clock, and the idle heartbeat, so liveness
 * and presentation stay server concerns while event translation stays the
 * backend's.
 */
export declare function runTurn(backend: RuntimeBackend, agent: Microagent | undefined, config: MikroConfig, label: string, query: string, sessionId: string, contextPath: string | undefined, cwd: string, progress?: ProgressSink, maxIterations?: number): Promise<TurnOutcome>;
/**
 * Run the MCP server on stdio until the client disconnects.
 *
 * @param cwd Working directory used for agent discovery, config loading, and
 *            relative `context` arguments.
 */
export declare function runMcp(cwd?: string): Promise<void>;
//# sourceMappingURL=server.d.ts.map