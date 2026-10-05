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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { applyModelRef, loadConfig, type MikroConfig } from "../config.js";
import { loadContext, type LoadedContext } from "../context.js";
import { EMPTY_RESPONSES_BUDGET_HIT, TIMEOUT_ANSWER } from "../rlm.js";
import { REPL_RESERVED_NAMES } from "../repl.js";
import { resolvePythonScript } from "../sdk/python-plugin.js";
import { resolvePluginPath } from "../sdk/tool-loader.js";
import { VERSION } from "../version.js";
import { checkModelConfig } from "../llm.js";
import { discoverAgents, splitModel, type Microagent } from "./agents.js";
import type { MicroagentResult, RuntimeBackend } from "./backend.js";
import { LegacyMikroBackend } from "./backends/legacy.js";
import { PrimeBackend } from "./backends/prime.js";
import { PrimeSdkBackend } from "./backends/prime-sdk.js";

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

/** How often to tick when the run itself is emitting nothing. */
const HEARTBEAT_MS = 15_000;

/** Tool always present, so the server is useful before any agent is authored. */
const GENERIC_TOOL = "mikro_query";

/**
 * Input surface, deliberately isomorphic to the host's native Agent tool:
 * `prompt` in, one final report out, `session_id` to continue. Delegation that
 * pattern-matches the tool a host model already knows gets used; a new idiom
 * gets ignored.
 *
 * `query` remains as a deprecated alias for `prompt`. Both are *optional* in
 * the schema and exactly one is demanded at runtime: JSON Schema can only say
 * "exactly one of" via `anyOf`/`oneOf`, which several MCP hosts flatten or
 * reject outright, so the constraint lives in code and the error names
 * `prompt`.
 */
const PROMPT_PROPERTY = {
  type: "string",
  description:
    "The task for mikro to perform. Write it as a complete, standalone " +
    "instruction: the agent runs autonomously to completion and cannot ask " +
    "follow-up questions mid-run.",
} as const;

const QUERY_PROPERTY = {
  type: "string",
  description:
    "Deprecated alias for `prompt`, kept for existing callers. Pass one or " +
    "the other, never both.",
} as const;

const SESSION_ID_PROPERTY = {
  type: "string",
  description:
    "Continue an earlier call on this same tool: pass the `session_id` its " +
    "result returned. The prior turns are replayed into the new prompt, so " +
    "the follow-up can reference them. Omit to start a fresh session.",
} as const;

const CONTEXT_PROPERTY = {
  type: "string",
  description:
    "Optional path to a file or directory to load as context, relative to the " +
    "server's working directory. Equivalent to the CLI's --context.",
} as const;

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
export function toolOutputSchema(): Tool["outputSchema"] {
  return {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description:
          "The agent's final report, identical to the text block — the answer " +
          "followed by the token/cost footer. On a failed call this is the " +
          "error message instead of a report.",
      },
      session_id: {
        type: "string",
        description: "Pass this back as `session_id` to continue this session.",
      },
    },
    required: ["answer", "session_id"],
  };
}

function agentToolSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      prompt: PROMPT_PROPERTY,
      query: QUERY_PROPERTY,
      session_id: SESSION_ID_PROPERTY,
      context: CONTEXT_PROPERTY,
    },
    required: [],
  };
}

function genericToolSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      prompt: PROMPT_PROPERTY,
      query: QUERY_PROPERTY,
      session_id: SESSION_ID_PROPERTY,
      context: CONTEXT_PROPERTY,
      model: {
        type: "string",
        description:
          'Optional model override as "<provider>/<model>", e.g. ' +
          '"station/Brain-35B" to run locally at no marginal cost.',
      },
    },
    required: [],
  };
}

/** Spawn-style description: what it is, how to prompt it, what comes back. */
function describeAgent(agent: Microagent): string {
  const model = agent.spec.model ? ` Runs on ${agent.spec.model}.` : "";
  const backend = agent.spec.backend ?? "mikro";
  const declaredTools = agent.spec.tools.length
    ? `Tools: ${agent.spec.tools.join(", ")}.`
    : "Tools: none declared.";
  const suffix = `Backend: ${backend}. ${declaredTools}`;
  if (agent.unavailable) {
    return (
      `UNAVAILABLE — "${agent.name}" cannot run: ${agent.unavailable} ` +
      `${agent.summary}${model} ${suffix}`
    );
  }
  return (
    `Launch the "${agent.name}" mikro agent to handle a task autonomously. ` +
    `${agent.summary}${model} Give it a complete, standalone prompt — it runs ` +
    `to completion and returns a single final report, and cannot ask ` +
    `follow-up questions mid-run. The result carries the tokens and cost it ` +
    `used plus a session_id; pass that session_id back to this tool to ` +
    `continue the conversation. ` +
    `(mikro microagent "${agent.name}", shape=${agent.spec.shape}` +
    `${agent.spec.thinking ? `, thinking=${agent.spec.thinking}` : ""}) ` +
    suffix
  );
}

const GENERIC_DESCRIPTION =
  "Launch a general-purpose mikro agent to handle a self-contained task " +
  "autonomously (RLM loop: Python REPL plus recursion). Use it to offload " +
  "work you would otherwise grind through inline — analysis over a large " +
  "body of files, repeated extraction, wide searches. Give it a complete, " +
  "standalone prompt: it runs to completion and returns a single final " +
  "report, and cannot ask follow-up questions mid-run. The result carries " +
  "the tokens and cost it used plus a session_id; pass that session_id back " +
  "to this tool to continue the conversation.";

export function buildToolList(agents: readonly Microagent[]): Tool[] {
  const tools: Tool[] = [
    {
      name: GENERIC_TOOL,
      description: GENERIC_DESCRIPTION,
      inputSchema: genericToolSchema(),
      outputSchema: toolOutputSchema(),
    },
  ];

  for (const agent of agents) {
    tools.push({
      name: agent.toolName,
      description: describeAgent(agent),
      inputSchema: agentToolSchema(),
      outputSchema: toolOutputSchema(),
    });
  }

  return tools;
}

// ── Live tool set ─────────────────────────────────────────────────────────

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
export function createAgentRegistry(scan: () => Promise<readonly Microagent[]>): {
  refresh: () => Promise<AgentScan>;
} {
  let previous: Set<string> | undefined;
  /** Tail of the serialization chain; never rejects, so one failure can't wedge it. */
  let queue: Promise<void> = Promise.resolve();

  async function scanAndApply(): Promise<AgentScan> {
    const agents = await scan();
    const byToolName = new Map(agents.map((a) => [a.toolName, a]));
    const current = new Set(byToolName.keys());

    const baseline = previous;
    previous = current;

    if (!baseline) {
      return { agents, byToolName, changed: false, removed: [] };
    }

    const removed = [...baseline].filter((name) => !current.has(name));
    const added = [...current].filter((name) => !baseline.has(name));
    return {
      agents,
      byToolName,
      changed: removed.length > 0 || added.length > 0,
      removed,
    };
  }

  return {
    refresh(): Promise<AgentScan> {
      const next = queue.then(scanAndApply);
      queue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────

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

/** Sessions are advisory: losing one costs a fresh start, never correctness. */
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 64;
/** Turns retained per session; also the number replayed on a follow-up. */
const MAX_SESSION_TURNS = 8;
const REPLAY_PROMPT_CHARS = 2_000;
const REPLAY_ANSWER_CHARS = 4_000;

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
export class McpSessionStore {
  private readonly sessions = new Map<string, McpSession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxTurns: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.maxTurns = options.maxTurns ?? MAX_SESSION_TURNS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `sess_${randomBytes(8).toString("hex")}`);
  }

  get size(): number {
    return this.sessions.size;
  }

  create(toolName: string): McpSession {
    this.sweep();
    this.evictToCap();
    const session: McpSession = {
      id: this.newId(),
      toolName,
      turns: [],
      lastUsedAt: this.now(),
      busy: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Live session, or undefined when it is unknown or has expired. */
  get(id: string): McpSession | undefined {
    this.sweep();
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = this.now();
    return session;
  }

  /** Append a completed turn, dropping the oldest beyond the cap. */
  record(session: McpSession, turn: SessionTurn): void {
    session.turns.push(turn);
    if (session.turns.length > this.maxTurns) {
      session.turns.splice(0, session.turns.length - this.maxTurns);
    }
    session.lastUsedAt = this.now();
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * Drop every session bound to a tool that no longer exists. An agent deleted
   * mid-session leaves its sessions unreachable — "Unknown tool" is the answer
   * a caller gets, so keeping the orphans would only hold memory.
   */
  evictTools(toolNames: Iterable<string>): number {
    const doomed = new Set(toolNames);
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (doomed.has(session.toolName)) {
        this.sessions.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      // An in-flight call keeps its session alive regardless of age.
      if (!session.busy && session.lastUsedAt <= cutoff) this.sessions.delete(id);
    }
  }

  /** Evict least-recently-used sessions until there is room for one more. */
  private evictToCap(): void {
    if (this.sessions.size < this.maxSessions) return;
    const candidates = [...this.sessions.values()]
      .filter((s) => !s.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const victim of candidates) {
      if (this.sessions.size < this.maxSessions) break;
      this.sessions.delete(victim.id);
    }
    // If every session is busy the cap yields rather than killing a live call;
    // in-flight calls are bounded by the host's own concurrency.
  }
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
export function buildResumeQuery(
  turns: readonly SessionTurn[],
  prompt: string
): string {
  if (turns.length === 0) return prompt;
  const lines: string[] = [
    "This is a continuing conversation. Earlier turns in this session (for context — do not repeat them unless the new request asks you to):",
    "",
  ];
  turns.forEach((turn, i) => {
    lines.push(`--- Turn ${i + 1} ---`);
    lines.push(`User: ${truncate(turn.prompt, REPLAY_PROMPT_CHARS)}`);
    lines.push(`Assistant: ${truncate(turn.answer, REPLAY_ANSWER_CHARS)}`);
    lines.push("");
  });
  lines.push(
    "Now respond to this new request, drawing on the conversation above when relevant:"
  );
  lines.push(prompt);
  return lines.join("\n");
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * Iteration cap implied by an agent's spec.
 *
 * `shape: single-step` means exactly one pass — without this the agent
 * inherits rlmLoop's 30-iteration default and loops long past the point of
 * usefulness (observed: a single-step triage agent burning 30 iterations and
 * 157s, and getting the answer wrong). An explicit `budget.max_iterations`
 * always wins over the shape default.
 */
export function agentMaxIterations(agent: Microagent): number | undefined {
  const explicit = agent.spec.budget?.maxIterations;
  if (explicit !== undefined) return explicit;
  return agent.spec.shape === "single-step" ? 1 : undefined;
}

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
export function applyAgent(config: MikroConfig, agent: Microagent): MikroConfig {
  const next: MikroConfig = { ...config };

  // Unchanged from before: a model string with no provider prefix is ignored.
  if (agent.spec.model && splitModel(agent.spec.model)) {
    next.model = applyModelRef(config.model, agent.spec.model);
  }

  if (agent.system) {
    next.system = agent.system;
  }

  if (agent.spec.budget?.maxCost !== undefined) {
    next.budget = { ...config.budget, maxCost: agent.spec.budget.maxCost };
  }

  // A declared `thinking:` writes the one field `--thinking` writes
  // (src/cli.ts) — `config.gemini.thinkingLevel`, which rlmLoop hands to
  // `llmComplete` as `options.thinkingLevel` and which becomes pi-ai's
  // `reasoning`. Reusing that field rather than adding a per-agent channel is
  // the point: there is a single answer to "what effort is this call running
  // at", and the agent's declaration simply outranks the ambient mikro.yaml the
  // same way the flag does.
  //
  // `next` is a shallow copy, so `next.gemini` still aliases the caller's
  // object — clone it or this override leaks into every later ambient run.
  if (agent.spec.thinking) {
    next.gemini = { ...config.gemini, thinkingLevel: agent.spec.thinking };
  }

  // A declared `temperature:` writes the one field `--temperature` writes —
  // `config.temperature`, which rlmLoop hands to `llmComplete` and which
  // becomes pi-ai's `temperature`. Same single-answer rule as `thinking:`
  // above: the agent's declaration outranks the ambient mikro.yaml, and there
  // is no second per-agent channel.
  //
  // No clone, unlike `gemini` above and for the same reason `validate` needs
  // none: this is a scalar on the shallow copy, so there is no shared object to
  // write *through* to the ambient config.
  //
  // `!= null` and never truthiness. `temperature: 0` is greedy decoding — the
  // most likely value a committee gate pins to — and `if (agent.spec.temperature)`
  // would silently hand that run the ambient temperature instead.
  if (agent.spec.temperature != null) {
    next.temperature = agent.spec.temperature;
  }

  // A microagent is contracted by its OWN `VALIDATE.md` or by nothing at all.
  // Unconditional, and that is the point: `if (agent.validate)` could only
  // ever *raise* a contract, never clear one, so an uncontracted agent invoked
  // from inside a repo that ships `.mikro/VALIDATE.md` would be judged — and,
  // now that `rlmLoop` enforces the schema, flagged — against a contract its
  // author never wrote. Ambient inheritance is wrong for the same reason the
  // model pin is: an agent is a portable pack, not a resident of the caller's
  // repo. CLI runs are unaffected; they read the project file directly.
  //
  // No clone needed, unlike `budget`/`gemini` above: this assigns a whole
  // reference on the shallow copy and the object behind it is readonly all the
  // way down (`ValidateConfig`, `src/config.ts`), so nothing here is ever
  // written *through* to the ambient config.
  next.validate = agent.validate ?? null;

  // `prompt.append-stop-protocol` in agent.yaml outranks the ambient
  // mikro.yaml, same precedence as `thinking:`. Cloned for the same aliasing
  // reason — `next` is shallow, so mutating `next.prompt` in place would leak
  // the opt-out into every later ambient run.
  if (agent.spec.prompt?.appendStopProtocol !== undefined) {
    next.prompt = {
      ...config.prompt,
      appendStopProtocol: agent.spec.prompt.appendStopProtocol,
    };
  }

  return next;
}

/**
 * Validate each discovered agent's `model:` pin against the runtime it will
 * actually run on, so `tools/list` never advertises a tool whose first call
 * is guaranteed to fail with "Unknown model". Only the pi-ai backed backend
 * (`mikro`, the default) resolves models this way; other backends own their
 * model universe and are left alone. The config is re-read per scan so a
 * newly declared provider heals a degraded agent on the next request.
 */
export async function validateAgentModels(
  cwd: string,
  agents: readonly Microagent[]
): Promise<Microagent[]> {
  if (agents.length === 0) return [];
  let config: MikroConfig;
  try {
    config = await loadConfig(cwd);
  } catch (err: unknown) {
    // A broken mikro.yaml fails every run the same way; let the call surface it.
    process.stderr.write(
      `mikro mcp: could not load config for model validation: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return [...agents];
  }
  return agents.map((agent) => {
    if ((agent.spec.backend ?? "mikro") !== "mikro") return agent;
    const problem = checkModelConfig(applyAgent(config, agent).model);
    if (!problem) return agent;
    return {
      ...agent,
      unavailable:
        `${problem} Fix the agent's model: pin or declare the provider in config, then retry.`,
    };
  });
}

// Python hard keywords only: soft keywords such as match, case, and type
// remain valid function names. See Python's lexical-analysis reference.
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/**
 * Mark default-backend agents whose declared tools cannot be exposed safely.
 * This is a resolution-only discovery probe: plugins are neither imported nor
 * spawned here. A prior unavailability cause (notably a bad model pin) wins.
 */
export async function validateAgentTools(
  cwd: string,
  agents: readonly Microagent[]
): Promise<Microagent[]> {
  if (agents.length === 0) return [];

  let collisions = new Set<string>();
  try {
    const config = await loadConfig(cwd);
    collisions = new Set(config.tools.map((tool) => tool.name.normalize("NFKC")));
  } catch {
    // Model validation reports config failures. Tool-file and reserved-name
    // checks remain useful even when TOOLS.md cannot be loaded.
  }

  return Promise.all(
    agents.map(async (agent) => {
      if ((agent.spec.backend ?? "mikro") !== "mikro" || agent.unavailable) {
        return agent;
      }

      const pythonNames = new Map<string, string>();
      for (const name of agent.spec.tools) {
        // Use Python's Unicode identifier classes without a `$` anchor, which
        // would also accept a trailing newline in JavaScript.
        if (!/^[_\p{XID_Start}]/u.test(name) || /[^\p{XID_Continue}]/u.test(name) || PYTHON_KEYWORDS.has(name)) {
          return {
            ...agent,
            unavailable:
              `${JSON.stringify(name)} is not a valid Python tool name — use a Python identifier that is not a keyword, and rename the tool and its file.`,
          };
        }
        // Python normalizes identifiers; the REPL discards private names.
        const pythonName = name.normalize("NFKC");
        if (REPL_RESERVED_NAMES.has(pythonName) || pythonName.startsWith("_")) {
          return {
            ...agent,
            unavailable:
              `"${name}" is a reserved REPL name — rename the tool and its file.`,
          };
        }
        if (collisions.has(pythonName)) {
          return {
            ...agent,
            unavailable:
              `"${name}" collides with a TOOLS.md tool — rename one of them.`,
          };
        }
        const previous = pythonNames.get(pythonName);
        if (previous !== undefined && previous !== name) {
          return {
            ...agent,
            unavailable:
              `"${name}" has the same Python name as "${previous}" — rename one of the tools and its file.`,
          };
        }
        pythonNames.set(pythonName, name);
      }

      const missing: string[] = [];
      for (const name of agent.spec.tools) {
        const [{ path }, pythonPath] = await Promise.all([
          resolvePluginPath(agent.dir, name),
          resolvePythonScript(agent.dir, name),
        ]);
        if (path === null && pythonPath === null) missing.push(name);
      }
      if (missing.length === 0) return agent;

      const example = missing.length === 1 ? missing[0] : "<name>";
      return {
        ...agent,
        unavailable:
          `missing tools: ${missing.join(", ")} — add tools/${example}.{mjs,js,py} ` +
          `to ${agent.dir} or remove the declaration, then retry.`,
      };
    })
  );
}

function applyModelOverride(config: MikroConfig, model: string): MikroConfig {
  if (!splitModel(model)) return config;
  return { ...config, model: applyModelRef(config.model, model) };
}

function formatCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatFooter(
  label: string,
  config: MikroConfig,
  result: MicroagentResult,
  elapsedMs: number,
  sessionId: string
): string {
  const tokensIn = result.usage.inputTokens.toLocaleString("en-US");
  const tokensOut = result.usage.outputTokens.toLocaleString("en-US");
  const model = `${config.model.provider}/${config.model.model}`;
  const seconds = (elapsedMs / 1000).toFixed(1);
  const budget = result.budgetHit ? ` · budget hit: ${result.budgetHit}` : "";
  // The flag rides the footer rather than `structuredContent`, which stays
  // exactly `{answer, session_id}`. The key is spelled as it is in
  // `--output json` so one grep finds it on either surface.
  const validation = result.validationFailed ? " · validation_failed: true" : "";

  // The session id is echoed in prose as well as structuredContent: a host
  // that renders only the text block still shows the model how to follow up.
  return (
    `mikro · ${label} · ${model} · ${result.iterations} iteration` +
    `${result.iterations === 1 ? "" : "s"} · ${tokensIn} in / ${tokensOut} out ` +
    `· ${formatCost(result.usage.totalCost)} · ${seconds}s${budget}${validation}` +
    ` · session ${sessionId}`
  );
}

/**
 * Result of a call that never reached a session: bad arguments, unknown tool,
 * unusable `session_id`. No `structuredContent`, because there is no session id
 * to put in it and the declared schema requires one — legal precisely because
 * these are all `isError`, and the schema binds only non-error results.
 */
export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** Trimmed string argument; "" when absent, blank, or not a string. */
function readArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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
export function sessionResult(
  text: string,
  sessionId: string,
  isError = false
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { answer: text, session_id: sessionId },
    isError,
  };
}

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
export function isFailedRun(
  result: Pick<MicroagentResult, "answer" | "budgetHit">
): boolean {
  return result.budgetHit === EMPTY_RESPONSES_BUDGET_HIT || result.answer === TIMEOUT_ANSWER;
}

export interface TurnOutcome {
  readonly answer: string;
  readonly text: string;
  /** True when the run hit one of the backend's designed aborts (see {@link isFailedRun}). */
  readonly failed: boolean;
}

/**
 * Backends wired to this build, keyed by the agent-spec `backend` field
 * (internal and undocumented — `src/sdk/agent-spec.ts`). A `Map`, not a
 * plain object record: a forged `backend: "constructor"` must resolve to
 * "not wired", never to a truthy prototype property that is not a backend.
 */
const BACKENDS: ReadonlyMap<string, RuntimeBackend> = new Map([
  ["mikro", new LegacyMikroBackend()],
]);

/**
 * The prime backend, constructed lazily on first selection. Its constructor
 * runs the version-pin check (`prime-agent --version` === 0.7.2), and a
 * server that never selects prime must not pay for that — nor fail to start
 * on a machine without the binary. A spec naming a backend this build has
 * not wired fails loudly at call time, the same "no silent degradation"
 * rule the spec parser applies to typos.
 */
let primeBackend: PrimeBackend | undefined;

/**
 * The in-process prime backend (`src/mcp/backends/prime-sdk.ts`), also
 * constructed lazily. Its constructor is cheap by design — package
 * resolution, the version pin, and the dynamic `import()` all happen inside
 * the memoized loader on the first turn — but it stays lazy for the same
 * reason `primeBackend` does: a build that never selects it must not depend
 * on prime-agent being installed.
 */
let primeSdkBackend: PrimeSdkBackend | undefined;

/**
 * The backend a turn runs on.
 *
 * `mikro_query` (the generic tool) has no agent spec and therefore no
 * `backend` field: it always runs on the legacy backend, unconditionally —
 * there is no selection path for it. Agents default to `mikro` unless their
 * spec names another backend.
 */
export function selectBackend(agent: Microagent | undefined): RuntimeBackend {
  const selected = agent?.spec.backend ?? "mikro";
  const backend =
    BACKENDS.get(selected) ??
    (selected === "prime"
      ? (primeBackend ??= new PrimeBackend())
      : selected === "prime-sdk"
        ? (primeSdkBackend ??= new PrimeSdkBackend())
        : undefined);
  if (!backend) {
    throw new Error(
      `agent "${agent?.name ?? "mikro_query"}": backend "${selected}" is not wired into this build`
    );
  }
  return backend;
}

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
export async function runTurn(
  backend: RuntimeBackend,
  agent: Microagent | undefined,
  config: MikroConfig,
  label: string,
  query: string,
  sessionId: string,
  contextPath: string | undefined,
  cwd: string,
  progress?: ProgressSink,
  maxIterations?: number
): Promise<TurnOutcome> {
  let context: LoadedContext | null = null;
  const contextRoot = contextPath ? resolve(cwd, contextPath) : undefined;
  if (contextRoot) {
    const contextOpts = config.contextConfig
      ? {
          extensions: config.contextConfig.extensions,
          exclude: config.contextConfig.exclude,
        }
      : undefined;
    context = await loadContext(contextRoot, contextOpts);
  }

  let lastProgressAt = Date.now();
  const emit = progress
    ? (message: string) => {
        lastProgressAt = Date.now();
        progress(`${label} · ${message}`);
      }
    : (_message: string) => {};

  const started = Date.now();

  // Heartbeat. Event-driven progress alone is not enough: a `single-step`
  // agent emits exactly one IterationStart and then goes quiet for the whole
  // call, so a slow local model silently blows past the client's deadline —
  // observed as MCP -32001 on a 402-line log. Tick on a timer so liveness does
  // not depend on the agent's shape. `unref` so it can never hold the process
  // open.
  let heartbeat: NodeJS.Timeout | undefined;
  if (progress) {
    heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs < HEARTBEAT_MS) return; // real events already kept it alive
      emit(`working ${Math.round((Date.now() - started) / 1000)}s`);
    }, HEARTBEAT_MS);
    heartbeat.unref();
  }

  try {
    const result = await backend.run(
      agent,
      {
        query,
        context,
        config,
        cwd,
        contextRoot,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      },
      emit
    );

    const footer = formatFooter(label, config, result, Date.now() - started, sessionId);
    return {
      answer: result.answer,
      text: `${result.answer}\n\n---\n${footer}`,
      failed: isFailedRun(result),
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/**
 * Run the MCP server on stdio until the client disconnects.
 *
 * @param cwd Working directory used for agent discovery, config loading, and
 *            relative `context` arguments.
 */
export async function runMcp(cwd: string = process.cwd()): Promise<void> {
  // ── stdout discipline ──────────────────────────────────────────────────
  // stdout is reserved for framed JSON-RPC. Anything human-readable — ours or
  // a dependency's — goes to stderr.
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(
      `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`
    );
  };
  console.log = toStderr as typeof console.log;
  console.info = toStderr as typeof console.info;
  console.debug = toStderr as typeof console.debug;
  console.warn = toStderr as typeof console.warn;

  const registry = createAgentRegistry(async () =>
    validateAgentTools(cwd, await validateAgentModels(cwd, await discoverAgents(cwd)))
  );
  const sessions = new McpSessionStore();

  // Seed the baseline before connecting, so the first tools/list is not
  // reported as a change.
  const initial = await registry.refresh();
  process.stderr.write(
    `mikro mcp: ${initial.agents.length} microagent${initial.agents.length === 1 ? "" : "s"} discovered` +
      `${initial.agents.length ? ` (${initial.agents.map((a) => a.name).join(", ")})` : ""}\n`
  );
  for (const agent of initial.agents) {
    if (agent.unavailable) {
      process.stderr.write(
        `mikro mcp: agent "${agent.name}" is UNAVAILABLE — ${agent.unavailable}\n`
      );
    }
  }

  const server = new Server(
    { name: "mikro", version: VERSION },
    // listChanged is declared because it is genuinely emitted — a capability
    // claimed and never honored is worse than none at all.
    { capabilities: { tools: { listChanged: true } } }
  );

  /**
   * Re-scan on every request. Agents are directories an agent (human or model)
   * creates mid-session, so a tool set frozen at connect time is wrong within
   * seconds; the client is told about a change even when it learned of it by
   * asking, because the *call* path re-scans too.
   */
  const refresh = async (): Promise<AgentScan> => {
    const scan = await registry.refresh();
    if (scan.changed) {
      if (scan.removed.length > 0) sessions.evictTools(scan.removed);
      try {
        await server.sendToolListChanged();
      } catch {
        // Not connected yet, or the client went away — never fail the request.
      }
    }
    return scan;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const scan = await refresh();
    return { tools: buildToolList(scan.agents) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Only emit progress when the client asked for it by supplying a token.
    const progressToken = extra._meta?.progressToken;
    let step = 0;
    const progress: ProgressSink | undefined =
      progressToken === undefined
        ? undefined
        : (message: string) => {
            step += 1;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress: step, message },
              })
              .catch(() => {
                // Client vanished or stopped listening — never fail the run.
              });
          };

    // Dispatch off the SAME scan that feeds tools/list: an agent authored a
    // moment ago is callable on its first appearance, and one deleted a moment
    // ago is not callable even though the client's cached list still shows it.
    const scan = await refresh();
    const agent = name === GENERIC_TOOL ? undefined : scan.byToolName.get(name);
    if (name !== GENERIC_TOOL && !agent) {
      // Agent deleted mid-session: "Unknown tool" wins over any session the
      // caller may hold, and the orphaned sessions go with it.
      sessions.evictTools([name]);
      return textResult(`Unknown tool: ${name}`, true);
    }
    if (agent?.unavailable) {
      // Refuse up front: the run would die on its first model call with the
      // same message, after paying for context loading and a REPL spawn.
      return textResult(`mikro ${name} cannot run: ${agent.unavailable}`, true);
    }

    const promptArg = readArg(args?.prompt);
    const queryArg = readArg(args?.query);
    if (promptArg && queryArg) {
      return textResult(
        `${name}: pass "prompt" on its own — "query" is a deprecated alias for ` +
          `"prompt", so supplying both is ambiguous.`,
        true
      );
    }
    const prompt = promptArg || queryArg;
    if (!prompt) {
      return textResult(
        `${name}: "prompt" is required and must be a non-empty string ` +
          `("query" is still accepted as a deprecated alias).`,
        true
      );
    }

    const contextPath = readArg(args?.context);

    // ── session resolution ────────────────────────────────────────────────
    const requestedSession = readArg(args?.session_id);
    let session: McpSession;
    if (requestedSession) {
      const existing = sessions.get(requestedSession);
      if (!existing) {
        return textResult(
          `${name}: unknown or expired session_id "${requestedSession}". Sessions ` +
            `are in-process and time-limited; omit session_id to start a new one.`,
          true
        );
      }
      if (existing.toolName !== name) {
        return textResult(
          `${name}: session_id "${requestedSession}" belongs to ${existing.toolName}. ` +
            `A session cannot be moved between tools — omit session_id to start ` +
            `one on ${name}.`,
          true
        );
      }
      if (existing.busy) {
        return textResult(
          `${name}: session ${requestedSession} is busy — a call on it is already ` +
            `in flight. mikro serializes calls per session; retry once it returns.`,
          true
        );
      }
      session = existing;
    } else {
      session = sessions.create(name);
    }

    session.busy = true;
    try {
      const baseConfig = await loadConfig(cwd);
      // Resume is conversation replay, not REPL state: every call builds a
      // fresh rlmLoop, and the prior turns ride in with the prompt.
      const query = buildResumeQuery(session.turns, prompt);

      let outcome: TurnOutcome;
      if (agent) {
        outcome = await runTurn(
          selectBackend(agent),
          agent,
          applyAgent(baseConfig, agent),
          `agent=${agent.name}`,
          query,
          session.id,
          contextPath,
          cwd,
          progress,
          agentMaxIterations(agent)
        );
      } else {
        const override = readArg(args?.model);
        const config = override ? applyModelOverride(baseConfig, override) : baseConfig;
        outcome = await runTurn(
          selectBackend(undefined),
          undefined,
          config,
          "query",
          query,
          session.id,
          contextPath,
          cwd,
          progress
        );
      }

      // The turn is recorded either way: an aborted turn is still history the
      // follow-up may need to reference, and the caller was told it happened.
      sessions.record(session, { prompt, answer: outcome.answer });
      return sessionResult(outcome.text, session.id, outcome.failed);
    } catch (err) {
      // A failing run must fail only this tool call, never the server process.
      // The session survives so the caller can retry on it.
      const message = err instanceof Error ? err.message : String(err);
      return sessionResult(`mikro ${name} failed: ${message}`, session.id, true);
    } finally {
      session.busy = false;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Do not crash if the client closes the pipe early.
  process.stdout.on("error", () => process.exit(0));
}
