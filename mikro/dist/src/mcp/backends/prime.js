/**
 * Prime backend — executes one delegated microagent turn through the pinned,
 * installed prime-agent binary (wish mikro-v2-prime-backend, Group 2).
 *
 * Why a subprocess: prime-agent is not an npm SDK this repo may import — the
 * wish pins integration to the installed binary (`--mode json -p`), and a
 * spawn per turn is the only surface that exists. The daemon socket is never
 * touched and no prime-agent package is imported anywhere.
 *
 * ## Host contract
 * The result shape is exactly `MicroagentResult` (`src/mcp/backend.ts`):
 * `answer` from prime's final assistant message, `iterations` from prime's
 * turn count (prime has no iteration concept of its own — a turn is its
 * analog), `budgetHit` from this backend's own enforcement, `usage` from the
 * assistant messages' usage records. `isFailedRun` (`src/mcp/server.ts`)
 * classifies the two designed aborts the way it classifies legacy's: a
 * deadline kill returns `TIMEOUT_ANSWER` (failed run) and a ceiling kill
 * returns normally with `budgetHit` set (success with a budget note in the
 * footer).
 *
 * ## Mapping decisions
 * The wish is the governing artifact; every ambiguous mapping fails loudly —
 * no silent degradation.
 *
 * - model: Prime 0.8.1 accepts direct `google`, `openrouter`, `deepseek`,
 *   `prime-inference`, `openai-codex`, and `zai` provider/model pairs. Mikro's
 *   configured `khal` provider uses Prime's custom-provider contract. Unknown
 *   providers fail loudly.
 * - thinking: `config.gemini.thinkingLevel` (minimal|low|medium|high) is a
 *   subset of prime's `--thinking` levels; passed through verbatim.
 * - system: `config.system` (the agent's SYSTEM.md via `applyAgent`) and
 *   `config.criteria` are APPENDED to prime's base prompt via
 *   `--append-system-prompt` — never `--system-prompt`, which per Prime
 *   0.8.1 `--help` *replaces* the default system prompt. Replacing would
 *   strip prime's base RLM prompt and handicap the prime leg.
 * - context: `LoadedContext` items map to prime `@file` arguments at their
 *   original absolute paths (`BackendRequest.contextRoot` — the same files
 *   the caller named, so path citations stay resolvable). Every arg is the
 *   single `@<abs path>` form Prime 0.8.1's parser turns into fileArgs
 *   (contents inlined into the first user message): a plain path would
 *   instead become a message and spawn one garbage autonomous turn per file.
 *   Each mapped file's existence is pre-checked at spawn, so a missing
 *   @file — which prime answers with a hard `process.exit(1)` — surfaces as
 *   an actionable tool error before any child starts. A `dict` context
 *   throws.
 * - budget.maxCost / maxTokens: mikro-owned ceilings monitored from the
 *   assistant messages' usage records, mirroring `BudgetTracker`
 *   (`src/budget.ts`): totalCost ≥ maxCost → "max-cost", input+output
 *   tokens ≥ maxTokens → "max-tokens". A breach kills the subprocess AND its
 *   descendants and returns a normal result with the partial answer and
 *   `budgetHit` set — never a throw, matching legacy's non-throwing aborts.
 * - maxIterations (spec budget/shape): prime has no iteration concept, so
 *   the cap maps to a turn ceiling — when the (cap+1)th turn would start,
 *   the tree is killed and the run returns the last completed turn's answer
 *   with `budgetHit: "max-iterations"`. Documented deviation: legacy's loop
 *   bound ends gracefully with no budget note; prime has no stop signal
 *   other than the kill, so the truncation is marked in the footer.
 *   `isFailedRun` still classifies it as a success, matching legacy.
 * - deadline: an mikro-owned wall clock defaulting to rlmLoop's 300s and
 *   overridable with `MIKRO_MCP_RUN_TIMEOUT_MS` — the same override the
 *   legacy backend forwards to its engine. Expiry kills the tree and
 *   returns `TIMEOUT_ANSWER`, which `isFailedRun` classifies as failed,
 *   exactly like legacy's timeout.
 *
 * ## Loudly rejected (no silent degradation)
 * - `config.tools` (TOOLS.md REPL functions): Python REPL functions prime's
 *   environment does not have.
 * - `budget.maxDepth`: legacy enforces depth at sub-call time; the parent's
 *   prime stream carries no child-depth signal to enforce from.
 * - `output.schema`: prime has no structured-output flag.
 * - gemini feature flags (googleSearch, urlContext, codeExecution,
 *   computerUse, mapsGrounding, fileSearch, mediaResolution): mikro-side
 *   request decoration prime cannot replicate.
 * - `context` of type `dict`.
 *
 * `config.cache` / `storage` are deliberately NOT rejected: they are
 * already inert on the legacy MCP path (rlmLoop runs with cache and storage
 * mode off), so rejecting them here would make prime stricter than the
 * reference backend.
 *
 * ## Inherent subprocess boundary (not mapped; noted for Group 3)
 * - sub-call model: legacy re-pins sub-calls to the agent's model; prime's
 *   recursive children run on prime's own defaults — the CLI has no flag
 *   for it.
 * - child usage: legacy merges sub-call usage into the footer totals; the
 *   prime parent stream carries only its own turns' usage.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { TIMEOUT_ANSWER } from "../../rlm.js";
/** The exact prime-agent release both subprocess and SDK integrations target. */
export const EXPECTED_PRIME_VERSION = "0.8.1";
/** rlmLoop's default wall-clock cap, mirrored so the deadline default matches legacy. */
export const DEFAULT_PRIME_DEADLINE_MS = 300_000;
/** Host state required by Prime independent of the selected provider. */
const PRIME_ENV_ALLOWLIST = [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
    "PRIME_AGENT_CODING_AGENT_DIR",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];
/** Credentials admitted for each selected Prime provider. */
const PRIME_PROVIDER_CREDENTIALS = {
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    zai: ["ZAI_API_KEY"],
    "prime-inference": ["PRIME_API_KEY"],
    khal: ["KHAL_API_KEY", "MIKRO_KHAL_API_KEY"],
};
/** Build the least-privilege environment handed to the Prime subprocess. */
export function buildPrimeChildEnv(source, provider) {
    const child = {
        DO_NOT_TRACK: "1",
        PRIME_AGENT_TELEMETRY: "0",
    };
    for (const name of PRIME_ENV_ALLOWLIST) {
        const value = source[name];
        if (value !== undefined)
            child[name] = value;
    }
    for (const name of PRIME_PROVIDER_CREDENTIALS[provider] ?? []) {
        const value = source[name];
        if (value !== undefined)
            child[name] = value;
    }
    return child;
}
const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
function isAssistant(message) {
    return (typeof message === "object" &&
        message !== null &&
        message.role === "assistant");
}
/** Text content of an assistant message — concatenated `text` parts. */
function textOf(message) {
    const content = message.content;
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    let out = "";
    for (const part of content) {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            out += part.text;
        }
    }
    return out;
}
/**
 * The real engine: spawn the binary, parse the JSONL event stream, enforce
 * the mikro-owned budgets, and kill the whole process tree on breach.
 */
function spawnPrimeRun(argv, emit, limits, environment) {
    return new Promise((resolve, reject) => {
        const binaryPath = argv[0];
        const child = spawn(binaryPath, argv.slice(1), {
            // Own process group: the budget kill takes the tree, descendants included.
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: environment,
        });
        let settled = false;
        let killed = null;
        let turns = 0;
        let lastTurnText = null;
        let lastText = "";
        let agentEnded = false;
        let finalMessage = null;
        let malformedLines = 0;
        let stderrTail = "";
        const usage = { inputTokens: 0, outputTokens: 0, totalCost: 0 };
        const killResult = (reason) => {
            switch (reason) {
                case "deadline":
                    // Legacy's timeout preserves whatever budgetHit had accumulated
                    // (usually none); ceiling kills return immediately, so it is null here.
                    return { answer: TIMEOUT_ANSWER, turns, budgetHit: null, usage: { ...usage } };
                case "max-cost":
                case "max-tokens":
                    return {
                        answer: lastText.trim() ||
                            `Error: budget hit: ${reason} before the model produced any output`,
                        turns,
                        budgetHit: reason,
                        usage: { ...usage },
                    };
                case "max-turns":
                    return {
                        answer: (lastTurnText ?? lastText).trim() ||
                            `Error: iteration cap reached: the run exceeded ${limits.maxTurns} turn(s) without producing a report`,
                        turns,
                        budgetHit: "max-iterations",
                        usage: { ...usage },
                    };
            }
        };
        const killTree = () => {
            if (typeof child.pid !== "number")
                return;
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch {
                // Already gone — the close handler resolves the run.
            }
        };
        let deadlineTimer;
        let failsafeTimer;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            if (failsafeTimer)
                clearTimeout(failsafeTimer);
            resolve(result);
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            if (failsafeTimer)
                clearTimeout(failsafeTimer);
            reject(err);
        };
        const breach = (reason) => {
            if (killed)
                return; // first breach wins
            killed = reason;
            killTree();
            // SIGKILL cannot be ignored, but the close handler is the only
            // resolver — never leave a run hanging on a lost close event.
            failsafeTimer = setTimeout(() => settle(killResult(reason)), 2_000);
        };
        deadlineTimer = setTimeout(() => breach("deadline"), limits.deadlineMs);
        const handleEvent = (event) => {
            switch (event.type) {
                case "turn_start":
                    // The iteration cap: turns are prime's analog of legacy iterations.
                    // Kill when the (cap+1)th turn would start, so the reported answer
                    // is the last COMPLETED turn's — legacy's loop-bound answer.
                    if (limits.maxTurns !== null && turns >= limits.maxTurns) {
                        breach("max-turns");
                        return;
                    }
                    emit(`iteration ${turns + 1}`);
                    break;
                case "turn_end":
                    turns += 1;
                    if (isAssistant(event.message))
                        lastTurnText = textOf(event.message);
                    break;
                case "message_update":
                    if (isAssistant(event.message))
                        lastText = textOf(event.message);
                    break;
                case "message_end":
                    if (isAssistant(event.message)) {
                        lastText = textOf(event.message);
                        const u = event.message.usage;
                        if (u) {
                            usage.inputTokens += num(u.input);
                            usage.outputTokens += num(u.output);
                            usage.totalCost += num(u.cost?.total);
                        }
                        if (limits.maxCost !== null && usage.totalCost >= limits.maxCost) {
                            breach("max-cost");
                        }
                        else if (limits.maxTokens !== null &&
                            usage.inputTokens + usage.outputTokens >= limits.maxTokens) {
                            breach("max-tokens");
                        }
                    }
                    break;
                case "tool_execution_start":
                    if (typeof event.toolName === "string" && event.toolName.length > 0) {
                        emit(`tool ${event.toolName}`);
                    }
                    break;
                case "agent_end": {
                    agentEnded = true;
                    const messages = Array.isArray(event.messages) ? event.messages : [];
                    for (let i = messages.length - 1; i >= 0; i -= 1) {
                        if (isAssistant(messages[i])) {
                            finalMessage = messages[i];
                            break;
                        }
                    }
                    break;
                }
                default:
                    // session / agent_start / message_start / tool_execution_update/end
                    break;
            }
        };
        // stdout discipline: parse every line, skip non-JSON lines, and keep the
        // stream drained until the process closes — closing stdout early EPIPEs
        // the child (observed live).
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                malformedLines += 1;
                return;
            }
            handleEvent(event);
        });
        // stderr must drain too — a full pipe buffer blocks the child. Keep the
        // last 4 KiB for error reports.
        child.stderr.on("data", (chunk) => {
            stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
        });
        child.on("error", (err) => fail(err));
        child.on("close", (code, signal) => {
            if (settled)
                return;
            if (killed) {
                settle(killResult(killed));
                return;
            }
            if (!agentEnded) {
                const tail = stderrTail.trim();
                const malformed = malformedLines > 0 ? `; ${malformedLines} non-JSON stdout line(s)` : "";
                fail(new Error(`prime backend: prime-agent exited before reporting agent_end ` +
                    `(code ${code ?? "null"}, signal ${signal ?? "none"})` +
                    `${tail ? `; stderr: ${tail}` : ""}${malformed}`));
                return;
            }
            // Final answer = text content of the final assistant message
            // (agent_end's message list, falling back to the last turn_end and the
            // streamed text); usage = the run total over every assistant message.
            const answer = finalMessage ? textOf(finalMessage) : (lastTurnText ?? lastText);
            if (finalMessage?.stopReason === "error" || finalMessage?.errorMessage) {
                const model = [finalMessage.provider, finalMessage.model].filter(Boolean).join("/");
                fail(new Error(`prime backend: prime-agent model run failed${model ? ` (${model})` : ""}: ` +
                    `${finalMessage.errorMessage?.trim() || "unknown model error"}`));
                return;
            }
            if (!answer.trim()) {
                fail(new Error("prime backend: prime-agent reported agent_end without a final text answer. " +
                    "The run cannot be treated as successful; inspect the Prime JSON event stream."));
                return;
            }
            settle({
                answer,
                turns,
                budgetHit: null,
                usage: { ...usage },
            });
        });
    });
}
/**
 * Version-pin check at backend startup: `prime-agent --version` must report
 * exactly the pinned version. Reports to stderr AND throws, so the failure
 * is visible in the server log and surfaces as a clean tool error.
 */
function assertPinnedVersion(binaryPath, expected) {
    const failWith = (message) => {
        process.stderr.write(`mikro: ${message}\n`);
        throw new Error(message);
    };
    let probe;
    try {
        probe = spawnSync(binaryPath, ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    }
    catch (err) {
        failWith(`prime backend: cannot run "${binaryPath}": ${err instanceof Error ? err.message : String(err)}. ` +
            `The prime backend executes microagent turns through the installed prime-agent binary; ` +
            `install prime-agent ${expected} and restart mikro mcp, or switch the agent back to \`backend: mikro\`.`);
        return;
    }
    if (probe.error) {
        failWith(`prime backend: cannot run "${binaryPath}": ${probe.error.message}. ` +
            `The prime backend executes microagent turns through the installed prime-agent binary; ` +
            `install prime-agent ${expected} and restart mikro mcp, or switch the agent back to \`backend: mikro\`.`);
        return;
    }
    // The real binary reports the version on stderr; accept either stream.
    const reported = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    if (probe.status !== 0 || reported !== expected) {
        failWith(`prime backend: "${binaryPath}" is not the pinned prime-agent ${expected}: ` +
            `\`prime-agent --version\` reported ${reported ? `"${reported}"` : "nothing"}. ` +
            `mikro pins this backend to an exact binary version — upgrades are deliberate events. ` +
            `Run \`prime-agent update\` to move the pin as a recorded decision, or switch the agent back to \`backend: mikro\`.`);
    }
}
/**
 * Map mikro's model addressing onto prime 0.8.1's advertised providers. Fails loudly
 * for every mikro provider prime cannot address — a spec that says "run on X"
 * must never silently run on another model.
 */
function mapPrimeModel(model, agentName) {
    const who = agentName ? `agent "${agentName}"` : "this run";
    switch (model.provider) {
        case "google":
            return { provider: "google", model: model.model };
        case "openrouter":
            return { provider: "openrouter", model: model.model };
        case "deepseek":
            return { provider: "deepseek", model: model.model };
        case "prime-inference":
            return { provider: "prime-inference", model: model.model };
        case "openai-codex":
            return { provider: "openai-codex", model: model.model };
        case "zai":
            return { provider: "zai", model: model.model };
        case "khal":
            return { provider: "khal", model: model.model };
        default:
            throw new Error(`prime backend: ${who} is pinned to mikro model "${model.provider}/${model.model}", ` +
                `which the Mikro Prime adapter for prime-agent 0.8.1 cannot address — it supports ` +
                `\`google\`, \`openrouter\`, \`deepseek\`, \`prime-inference\`, \`openai-codex\`, \`zai\`, and the configured \`khal\` provider. ` +
                `Re-pin the agent to one of those providers, ` +
                `or switch the agent back to \`backend: mikro\`.`);
    }
}
/** Reject every mikro feature the prime leg cannot honor — never degrade silently. */
function assertSupportedConfig(config, agentName) {
    const who = agentName ? `agent "${agentName}"` : "this run";
    const reject = (field, why) => {
        throw new Error(`prime backend: ${who} declares ${field}, which the prime leg cannot honor (${why}). ` +
            `Remove it from the agent/config or switch the agent back to \`backend: mikro\`.`);
    };
    if (config.tools && config.tools.length > 0) {
        reject("custom REPL tools (TOOLS.md)", "they are Python REPL functions prime's environment does not have");
    }
    if ((config.output?.schema ?? null) !== null) {
        reject("a structured output schema", "prime has no structured-output flag");
    }
    if (config.budget?.maxDepth != null) {
        reject("budget.max_depth", "depth is enforced at sub-call time and the parent's prime stream carries no child-depth signal");
    }
    const gemini = config.gemini;
    if (gemini) {
        if (gemini.googleSearch)
            reject("gemini.google-search", "prime has no googleSearch flag");
        if (gemini.urlContext)
            reject("gemini.url-context", "prime has no urlContext flag");
        if (gemini.codeExecution)
            reject("gemini.code-execution", "prime has no codeExecution flag");
        if (gemini.computerUse)
            reject("gemini.computer-use", "prime has no computerUse flag");
        if (gemini.mapsGrounding)
            reject("gemini.maps-grounding", "prime has no mapsGrounding flag");
        if (gemini.fileSearch)
            reject("gemini.file-search", "prime has no fileSearch flag");
        if (gemini.mediaResolution != null) {
            reject("gemini.media-resolution", "prime has no mediaResolution flag");
        }
    }
}
/** Sanitize a context item's relative path into safe join segments. */
function sanitizeSegments(relativePath) {
    return relativePath
        .split("/")
        .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
/**
 * Map the loaded context onto Prime `@file` arguments — each in the single
 * `@<abs path>` form Prime 0.8.1 parses into fileArgs — at their original
 * absolute paths (the same files the caller named), so path citations stay
 * resolvable. The `@` prefix is the contract itself, not decoration: a plain
 * path becomes a message and prime runs one autonomous turn per path string.
 *
 * Every mapped file is also existence-checked here, before any spawn: prime
 * answers a missing @file with a hard `process.exit(1)`, so a dead file
 * surfaces as an actionable tool error instead of a cryptic child exit.
 * `dict` contexts and contexts without a root cannot be mapped — fail
 * loudly rather than degrade.
 */
function resolveContextFiles(context, contextRoot) {
    if (!context)
        return [];
    if (!contextRoot) {
        throw new Error("prime backend: context was loaded without a root path and cannot be mapped to prime @file arguments. " +
            "Pass the context through a filesystem path, or switch the agent back to `backend: mikro`.");
    }
    const toFileArg = (absolutePath) => {
        if (!existsSync(absolutePath)) {
            throw new Error(`prime backend: context file "${absolutePath}" does not exist — a missing @file argument ` +
                `makes prime-agent exit(1) at startup. Re-create the file or re-load the context, ` +
                `or switch the agent back to \`backend: mikro\`.`);
        }
        return `@${absolutePath}`;
    };
    if (context.type === "string")
        return [toFileArg(contextRoot)];
    if (context.type === "list") {
        const items = context.content;
        return items.map((item) => toFileArg(join(contextRoot, ...sanitizeSegments(item.path))));
    }
    throw new Error(`prime backend: context type "${context.type}" cannot be mapped to prime @file arguments. ` +
        `Pass a file or directory as the context, or switch the agent back to \`backend: mikro\`.`);
}
/** The microagent role appended AFTER prime's base prompt (never replacing it). */
function buildAppendedRole(agent, config, contextNote) {
    const who = agent ? `the mikro microagent "${agent.name}"` : "an mikro microagent";
    const parts = [
        `You are operating as ${who}, dispatched by an mikro MCP host to complete one delegated task. ` +
            `Work autonomously to completion — you cannot ask the host follow-up questions mid-run — and ` +
            `end with your final report: the complete answer to the task, self-contained and written for the host's user.`,
    ];
    if (contextNote)
        parts.push(contextNote);
    if (config.system)
        parts.push(`## Agent instructions\n\n${config.system}`);
    if (config.criteria) {
        parts.push(`## Output criteria\n\nWhen providing your final answer, follow these criteria:\n${config.criteria}`);
    }
    return parts.join("\n\n");
}
/** Resolve the wall-clock deadline — legacy's override, same default. */
function primeDeadlineMs() {
    const ms = Number(process.env.MIKRO_MCP_RUN_TIMEOUT_MS);
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PRIME_DEADLINE_MS;
}
function buildArgv(binaryPath, agent, request) {
    const config = request.config;
    assertSupportedConfig(config, agent?.name);
    const mapped = mapPrimeModel(config.model, agent?.name);
    const contextFiles = resolveContextFiles(request.context, request.contextRoot);
    const contextNote = contextFiles.length > 0
        ? `## Caller-provided context\n\nThe host attached ${contextFiles.length} file(s) to this task: ${contextFiles.join(", ")}. Read them before answering.`
        : null;
    const role = buildAppendedRole(agent, config, contextNote);
    const argv = [
        binaryPath,
        "--mode", "json",
        "-p",
        "--no-session",
        "--cwd", request.cwd,
        // Host hermeticity: no AGENTS.md/CLAUDE.md, extension, skill, or prompt
        // template from the host machine participates in the run.
        "-nc", "-ne", "-ns", "-np",
        "--provider", mapped.provider,
        "--model", mapped.model,
    ];
    if (config.gemini?.thinkingLevel)
        argv.push("--thinking", config.gemini.thinkingLevel);
    argv.push("--append-system-prompt", role);
    argv.push(...contextFiles, "--", request.query);
    return argv;
}
export class PrimeBackend {
    binaryPath;
    engine;
    constructor(options = {}) {
        this.binaryPath =
            options.binaryPath ?? process.env.MIKRO_PRIME_BINARY_PATH ?? "prime-agent";
        const environment = options.environment ?? buildPrimeChildEnv;
        this.engine =
            options.engine ??
                ((argv, emit, limits) => {
                    const providerIndex = argv.indexOf("--provider");
                    const provider = providerIndex >= 0 ? argv[providerIndex + 1] : undefined;
                    if (!provider)
                        throw new Error("prime backend: internal error: spawn argv has no --provider");
                    return spawnPrimeRun(argv, emit, limits, environment(process.env, provider));
                });
        // Backend startup: the version pin is asserted once per instance. The
        // server constructs this lazily on first prime selection (selectBackend),
        // so a machine without prime-agent never pays for it — and the injected
        // engine seam skips it entirely.
        if (!options.engine)
            assertPinnedVersion(this.binaryPath, options.expectedVersion ?? EXPECTED_PRIME_VERSION);
    }
    async run(agent, request, emit) {
        const limits = {
            deadlineMs: primeDeadlineMs(),
            maxCost: request.config.budget?.maxCost ?? null,
            maxTokens: request.config.budget?.maxTokens ?? null,
            maxTurns: request.maxIterations !== undefined ? request.maxIterations : null,
        };
        const result = await this.engine(buildArgv(this.binaryPath, agent, request), emit, limits);
        return {
            answer: result.answer,
            iterations: result.turns,
            budgetHit: result.budgetHit,
            usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalCost: result.usage.totalCost,
            },
        };
    }
}
//# sourceMappingURL=prime.js.map