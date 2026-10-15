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

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { loadConfig } from "../config.js";
import { rlmLoop } from "../rlm.js";
import { createEmitter, type EmitterAndStream } from "../sdk/emitter.js";
import { createTranslationContext, translateEvent } from "./session.js";
import { SessionStore, isValidSessionId, type StoredSession } from "./session-store.js";

/**
 * Per-session state. Group 3 makes this durable: the in-memory copy is a cache
 * over the on-disk `StoredSession` (see `session-store.ts`). `cwd` is the base
 * for config reload; `turns` is the conversation history threaded into each
 * follow-up prompt; `mcpServers` is the host-materialized MCP config (advertise/
 * store only — mikro has no MCP client).
 */
interface SessionState {
  /** Absolute working directory the session was created in. */
  cwd: string;
  /** Durable record backing this session (kept in sync on every turn). */
  record: StoredSession;
}

/**
 * How many prior turns are folded into a follow-up prompt's context preamble.
 * Bounded so a long conversation cannot grow the prompt without limit; the store
 * retains more (MAX_TURNS) for the record, but only the most-recent
 * PREAMBLE_TURNS are replayed to the model.
 */
const PREAMBLE_TURNS = 8;

/** Per-turn char caps for the resume preamble (independent of the store caps). */
const PREAMBLE_QUERY_CHARS = 2_000;
const PREAMBLE_ANSWER_CHARS = 4_000;

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
export function abortActivePrompt(active: ActivePrompt | null): boolean {
  if (!active) return false;
  active.abort.abort();
  if (!active.emitter.closed) active.emitter.close();
  return true;
}

/** Resolve the package version for `agentInfo`, best-effort. */
function resolveVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/src/acp/agent.js → ../../../package.json (repo/package root)
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Extract the plain-text prompt from a list of ACP content blocks. */
function extractPromptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * The mikro ACP agent. One instance per stdio connection.
 *
 * Single active session, serialized: `promptInFlight` guards the one-at-a-time
 * invariant. A second `session/prompt` that arrives while a run is in flight is
 * rejected with `RequestError.invalidRequest` (JSON-RPC -32600) — a clear,
 * documented rejection rather than a silent queue.
 */
export class MikroAcpAgent implements Agent {
  private readonly conn: AgentSideConnection;
  private readonly sessions = new Map<string, SessionState>();
  private readonly store = new SessionStore();
  private readonly version = resolveVersion();
  /** True while a `session/prompt` turn is executing. Serializes prompt turns. */
  private promptInFlight = false;
  /** Cancellation handle for the in-flight prompt turn, if any. */
  private activePrompt: ActivePrompt | null = null;

  constructor(conn: AgentSideConnection) {
    this.conn = conn;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // Group 3: session/load is durable (restore-on-empty from disk), so we
        // advertise it truthfully. A host will now offer session resume.
        loadSession: true,
        // MCP-server support. mikro MATERIALIZES + STORES host MCP config
        // (advertise-only): a host may pass `mcpServers` on session/new and
        // session/load and mikro will persist them, but mikro has no MCP CLIENT
        // yet — executing tools against those servers is a documented follow-on.
        // We advertise the stdio/http/sse transports the host may hand us; the
        // `_meta` note marks the store-only status so a strict host is not misled.
        mcpCapabilities: {
          http: true,
          sse: true,
          _meta: {
            "mikro/mcp": "store-and-advertise-only; no MCP client execution yet",
          },
        },
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
      // No authentication required: the local station provider needs no keys.
      authMethods: [],
      agentInfo: { name: "mikro", version: this.version },
    };
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // No auth methods advertised; nothing to do. Present so clients that call
    // it unconditionally get a clean success.
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw RequestError.invalidParams(undefined, "newSession requires an absolute cwd");
    }
    const sessionId = randomUUID();
    // Materialize the host MCP config (store/advertise only — see initialize).
    const mcpServers: McpServer[] = Array.isArray(params.mcpServers)
      ? params.mcpServers
      : [];
    // Snapshot the resolved model config for the record (resume reloads from cwd).
    const snapshot = await this.configSnapshot(cwd);
    const record = await this.store.create(sessionId, cwd, mcpServers, snapshot);
    this.sessions.set(sessionId, { cwd, record });
    return { sessionId };
  }

  async loadSession(
    params: LoadSessionRequest,
  ): Promise<LoadSessionResponse> {
    // RESTORE-ON-EMPTY. In-memory first; on a miss (the agent process was
    // restarted since the session was created — the multi-turn bug the
    // pi-in-Tidewave patches fixed) rehydrate from the durable store. Only a
    // session that was NEVER created (no file on disk) is a genuine bad id.
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw RequestError.invalidParams(undefined, "session/load requires a sessionId");
    }
    // A session id is always a UUID minted by session/new. Reject anything else
    // (notably a host-supplied traversal string like "../escape") BEFORE it can
    // reach the store and read a StoredSession-shaped file outside the store dir.
    if (!isValidSessionId(sessionId)) {
      throw RequestError.invalidParams(
        undefined,
        `session/load requires a valid session id`,
      );
    }
    if (!this.sessions.has(sessionId)) {
      const record = await this.store.load(sessionId);
      if (!record) {
        // Nothing on disk — the id was never issued (or its file is gone).
        throw RequestError.invalidParams(
          undefined,
          `unknown sessionId: ${sessionId}`,
        );
      }
      // If the host re-supplies MCP config on load, refresh the stored copy so a
      // resumed session tracks the host's current servers (store/advertise only).
      if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
        record.mcpServers.length = 0;
        record.mcpServers.push(...params.mcpServers);
      }
      this.sessions.set(sessionId, { cwd: record.cwd, record });
    }
    // No mode/config-option state to hand back; a bare success is the signal
    // the session is live and a follow-up session/prompt will be honored.
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `unknown sessionId: ${params.sessionId}`,
      );
    }

    // Single active session, serialized. Reject a concurrent prompt turn with
    // a clear JSON-RPC error (documented choice: reject, do not queue).
    if (this.promptInFlight) {
      throw RequestError.invalidRequest(
        undefined,
        "a prompt is already in flight; mikro acp serializes prompt turns (single active session)",
      );
    }

    const query = extractPromptText(params.prompt);
    if (query.length === 0) {
      throw RequestError.invalidParams(undefined, "prompt contained no text content");
    }

    this.promptInFlight = true;
    const abort = new AbortController();
    // The instrumented rlmLoop seam: subscribe a caller-created emitter
    // BEFORE the run starts, then drive the REAL loop in-process. Group 2
    // translates each AgentEvent into session/update notifications LIVE, as
    // it arrives — the drain loop below is the translation site. A translator
    // throw or a client-side send failure never kills the run. The emitter is
    // registered on activePrompt so a disconnect can close it (unblocks drain).
    const emitter = createEmitter();
    this.activePrompt = { sessionId: params.sessionId, abort, emitter };
    try {
      // Load the project config from the session cwd, exactly as the CLI does.
      const config = await loadConfig(session.cwd);

      // Thread prior-turn context: a follow-up prompt in a durable session
      // resumes with the earlier turns folded into the query, so a session is
      // genuinely multi-turn (and survives an agent restart via restore-on-empty).
      const effectiveQuery = buildConversationalQuery(session.record.turns, query);
      const ctx = createTranslationContext(params.sessionId);
      let messageChunksSent = 0;
      const drain = (async () => {
        for await (const ev of emitter) {
          // Cooperative cancel: once aborted, stop forwarding updates. The
          // rlmLoop keeps running in-process (it exposes no abort option;
          // see cancel()), but the client sees no further output.
          if (abort.signal.aborted) break;
          let updates;
          try {
            updates = translateEvent(ev, ctx);
          } catch (translateErr) {
            // Forward-compat: a translator fault must not crash the drain.
            const m =
              translateErr instanceof Error
                ? translateErr.message
                : String(translateErr);
            process.stderr.write(`mikro acp: translate error: ${m}\n`);
            continue;
          }
          for (const update of updates) {
            if (abort.signal.aborted) break;
            // Only a genuine ANSWER chunk (shared answer messageId) suppresses
            // the end-of-run backstop. A root/unknown Error surfaced by
            // translateError is also an agent_message_chunk but carries an
            // `error:` messageId — counting it would let an error-then-empty-
            // answer turn skip the backstop and yield no actual answer chunk.
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              update.messageId === `answer:${params.sessionId}`
            )
              messageChunksSent++;
            try {
              await this.conn.sessionUpdate({
                sessionId: params.sessionId,
                update,
              });
            } catch {
              // Client stream gone — stop draining; the run still completes.
              return;
            }
          }
        }
      })();

      // Wrap the run so a failing run fails only THIS prompt, never the agent
      // process. output: "json" keeps rlmLoop off its stream-mode stdout path.
      //
      // A recursive turn (parent iterations + a child spawn that itself takes
      // tens of seconds) can exceed rlmLoop's 300s default wall-clock cap. The
      // client owns turn duration (it can session/cancel), so an ACP-hosted run
      // honors an optional MIKRO_ACP_RUN_TIMEOUT_MS override for the loop's
      // internal timeout. Unset → rlmLoop's own default applies (unchanged for
      // the fast non-recursive path). Additive; rlm.ts untouched.
      const runTimeoutMs = Number(process.env.MIKRO_ACP_RUN_TIMEOUT_MS);
      const result = await rlmLoop(effectiveQuery, null, config, {
        emitter,
        output: "json",
        ...(Number.isFinite(runTimeoutMs) && runTimeoutMs > 0
          ? { timeout: runTimeoutMs }
          : {}),
      });
      await drain; // emitter is closed by rlmLoop when the run finishes.

      // Persist the completed turn to the durable store BEFORE returning, so a
      // follow-up prompt (even after an agent restart + session/load) resumes
      // with this turn's context. A non-cancelled turn with an answer is
      // recorded; a cancelled turn is not (its answer stream was cut). The
      // ORIGINAL `query` is stored — not `effectiveQuery` — so the preamble is
      // rebuilt fresh each turn rather than compounding.
      if (!abort.signal.aborted) {
        const answer = result.answer ?? "";
        try {
          await this.store.appendTurn(session.record, query, answer);
        } catch (persistErr) {
          // Persistence failure must not fail the prompt turn; the client still
          // gets its answer. It only degrades a later restart's resume fidelity.
          const m = persistErr instanceof Error ? persistErr.message : String(persistErr);
          process.stderr.write(`mikro acp: session persist failed: ${m}\n`);
        }
      }

      // Invariant backstop: some rlmLoop exit paths (e.g. the consecutive-empty
      // abort) return an answer WITHOUT emitting EmitDone, so no answer chunk
      // was streamed. If nothing reached the client as a message chunk, send
      // the final answer once so a prompt turn always yields an answer.
      if (!abort.signal.aborted && messageChunksSent === 0) {
        const answer = result.answer ?? "";
        if (answer.length > 0) {
          await this.conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: answer },
              messageId: `answer:${params.sessionId}`,
            },
          });
        }
      }

      // A cancelled turn reports `cancelled`; a normal turn reports `end_turn`.
      return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
    } catch (err) {
      // A RequestError propagates as a structured JSON-RPC error; any other
      // failure is surfaced as an internal error scoped to this prompt turn.
      if (err instanceof RequestError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw RequestError.internalError(undefined, `rlmLoop failed: ${message}`);
    } finally {
      this.promptInFlight = false;
      this.activePrompt = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    // Cooperative cancellation. rlmLoop exposes no AbortSignal option in
    // RLMOptions (src/rlm.ts) and this file is forbidden from refactoring it,
    // so the minimal correct hook is to abort at the ACP boundary: the drain
    // loop stops forwarding session/update notifications and the prompt turn
    // resolves with stopReason "cancelled". LIMITATION: the underlying rlmLoop
    // continues to completion in-process (its work is not interrupted); only
    // the client-visible update stream is cut. Threading a real AbortSignal
    // into rlmLoop is a documented follow-up (a tiny additive RLMOptions.signal
    // that llmComplete's existing abortController would honor).
    const active = this.activePrompt;
    if (active && active.sessionId === params.sessionId) {
      abortActivePrompt(active);
    }
  }

  /**
   * Disconnect hardening (stdin EOF / SIGTERM mid-run). Reuses the cooperative
   * cancel path: aborts the active prompt turn and closes its emitter so the
   * drain loop and its `await drain` unblock cleanly before the process exits —
   * no dangling async iterator, emitter closed. Returns true if a turn was
   * aborted (used by the shutdown handler to decide whether to grace-wait).
   */
  shutdown(): boolean {
    return abortActivePrompt(this.activePrompt);
  }

  /** Best-effort model snapshot from a cwd's config for the stored record. */
  private async configSnapshot(
    cwd: string,
  ): Promise<{ provider: string; model: string } | null> {
    try {
      const config = await loadConfig(cwd);
      return { provider: config.model.provider, model: config.model.model };
    } catch {
      return null;
    }
  }
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
export function buildConversationalQuery(
  turns: ReadonlyArray<{ query: string; answer: string }>,
  currentQuery: string,
): string {
  if (turns.length === 0) return currentQuery;
  const recent = turns.slice(Math.max(0, turns.length - PREAMBLE_TURNS));
  const lines: string[] = [
    "This is a continuing conversation. Earlier turns in this session (for context — do not repeat them unless the new request asks you to):",
    "",
  ];
  recent.forEach((t, i) => {
    lines.push(`--- Turn ${i + 1} ---`);
    lines.push(`User: ${truncate(t.query, PREAMBLE_QUERY_CHARS)}`);
    lines.push(`Assistant: ${truncate(t.answer, PREAMBLE_ANSWER_CHARS)}`);
    lines.push("");
  });
  lines.push("Now respond to this new request, drawing on the conversation above when relevant:");
  lines.push(currentQuery);
  return lines.join("\n");
}

/** Single-line-safe char cap with an ellipsis marker. */
function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * Bootstrap the stdio ACP connection and run until stdin closes.
 *
 * Reroutes console.* to stderr up front so the JSON-RPC frames the SDK writes
 * to stdout are never interleaved with stray logging.
 */
export async function runAcp(): Promise<void> {
  // ── stdout discipline ────────────────────────────────────────────────
  // Any human/diagnostic logging (ours or a dependency's) must go to stderr;
  // stdout is reserved for framed JSON-RPC written by the SDK.
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(
      `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
  };
  console.log = toStderr as typeof console.log;
  console.info = toStderr as typeof console.info;
  console.debug = toStderr as typeof console.debug;
  console.warn = toStderr as typeof console.warn;

  // ── stdio streams (newline-delimited JSON over stdin/stdout) ─────────
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve) => {
        if (!process.stdout.writable) return resolve();
        process.stdout.write(chunk, () => resolve());
      });
    },
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) =>
        controller.enqueue(new Uint8Array(chunk)),
      );
      process.stdin.on("end", () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      process.stdin.on("error", (err) => controller.error(err));
    },
  });

  const stream = ndJsonStream(output, input);
  // Hold a reference to the agent so a disconnect can abort the active turn and
  // so the connection is not GC'd while stdin is open.
  let agentRef: MikroAcpAgent | null = null;
  const _conn = new AgentSideConnection((conn) => {
    agentRef = new MikroAcpAgent(conn);
    return agentRef;
  }, stream);
  void _conn;

  // ── disconnect hardening ─────────────────────────────────────────────
  // stdin EOF / SIGTERM / SIGINT mid-run: reuse the cooperative cancel path to
  // abort the active prompt turn and close its emitter (drain unblocks) BEFORE
  // exiting — no dangling async iterator, emitter closed. The python REPL child
  // rlmLoop spawns is NOT detached, so it shares this process group; killing the
  // group on the way out reaps it rather than orphaning it. (When the host
  // signals the whole group itself, the child already receives it; the explicit
  // group-kill covers the stdin-EOF case where no signal reaches children.)
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      agentRef?.shutdown();
    } catch {
      // never let cleanup throw out of the signal handler
    }
    // Best-effort: signal the process group so a mid-run python REPL child is
    // terminated rather than orphaned. Throws (EPERM/ESRCH) if we are not the
    // group leader — harmless; the host's own group signal then covers it.
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      // not a group leader, or nothing else in the group — nothing to do
    }
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Do not crash if the client closes stdout early.
  process.stdout.on("error", shutdown);

  process.stdin.resume();

  // Keep the event loop alive until stdin ends (shutdown() exits the process).
  await new Promise<void>(() => {});
}
