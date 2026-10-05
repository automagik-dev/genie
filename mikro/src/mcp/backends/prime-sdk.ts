/**
 * Prime SDK backend — executes one delegated microagent turn IN-PROCESS
 * through the installed prime-agent package's programmatic SDK
 * (`createAgentSession`), instead of spawning its CLI once per turn.
 *
 * Default-off and additive: nothing selects this backend unless an agent
 * spec says `backend: prime-sdk`. `src/mcp/backends/prime.ts` is untouched.
 *
 * ## Why a second prime backend
 * `PrimeBackend` shells out to `prime-agent --mode json -p` per turn, which
 * costs ~942 ms of cold start before the first token and confines the
 * integration to whatever the CLI's flags expose. The installed package
 * (`prime-agent`, the fork of `@earendil-works/pi-coding-agent`, MIT) also
 * ships a programmatic entry point. Driving that in-process removes the
 * spawn and — the actual point — unlocks the capabilities the flag surface
 * simply does not have: custom tools, structured output, custom providers,
 * and a real sub-call depth knob.
 *
 * **The npm package named `@earendil-works/pi-coding-agent` is NOT this
 * SDK** — that is upstream pi (0.84.x), a different line. This module never
 * imports a bare specifier; it resolves the INSTALLED package root and
 * imports `<root>/dist/index.js` by absolute path, after asserting the
 * installed version matches the pin.
 *
 * ## Host contract
 * Identical to every other `RuntimeBackend`: one `MicroagentResult` with
 * `answer` / `iterations` / `budgetHit` / `usage`. The two designed aborts
 * keep legacy's classification — a deadline returns `TIMEOUT_ANSWER` (which
 * `isFailedRun` marks failed) and a ceiling returns normally with
 * `budgetHit` set (a success carrying a budget note in the footer).
 *
 * ## Delta vs `prime.ts` — what stopped being a loud reject
 * `prime.ts`'s header lists what the subprocess leg cannot honor. The
 * in-process leg honors all but one of them, and never by degrading
 * silently:
 *
 * | `prime.ts` rejects | here |
 * |---|---|
 * | `output.schema` | **honored** — the schema becomes `emit_done`'s parameter schema, so the model's structured payload is validated by prime's own tool-call layer before it reaches us, and the run's answer is that payload as JSON. |
 * | `budget.maxDepth` | **honored** — passed as `createAgentSession`'s first-class `rlmMaxDepth` option (see "Deviations" below). |
 * | `dict` context | **honored** — every context type is snapshotted to 0600 files under the run's scratch dir and named in the prompt, so there is no context shape left that cannot be mapped. |
 * | `station` provider, and every provider beyond Prime's catalog | **honored** — `khal` / `wafer` / `station` are emitted into a generated `models.json` under the scratch `agentDir`; `google`, `openrouter`, `deepseek`, and `openai-codex` resolve against Prime's built-in catalog under their own Mikro names. |
 * | gemini grounding flags | **still rejected** — `googleSearch`, `urlContext`, `codeExecution`, `computerUse`, `mapsGrounding`, `fileSearch`, `mediaResolution` are mikro-side request decoration prime cannot replicate. |
 * | `config.tools` (TOOLS.md) | **still rejected** — see below. |
 *
 * `config.tools` are TOOLS.md *Python source strings* injected into mikro's
 * own REPL (`ToolDef = {name, code}`). Prime's analogous surface is its
 * IPython kernel, and `createAgentSession` exposes no way to preload code
 * into it. Honoring them would mean inventing an unverified mechanism;
 * ignoring them would mean running an agent without the tools it declared.
 * So it stays a loud reject. Note this is the *config* tool list, which is
 * distinct from `agent.spec.tools` — those ARE honored, as custom tools.
 *
 * ## Spec tools → prime custom tools
 * `agent.spec.tools[]` names resolve through mikro's existing plugin loaders
 * (`src/sdk/tool-loader.ts` for `.mjs`/`.js`, `src/sdk/python-plugin.ts`
 * for `.py`) into a `ToolRegistry`, exactly as `runAgent` resolves them.
 * Each resolved handler is wrapped in a prime `ToolDefinition` whose
 * `parameters` is the registry's declared JSON Schema, or a permissive
 * object schema when the plugin declared none (the loaders attach no schema
 * today — see `docs/tool-authoring.md`). A name that resolves to no plugin
 * is passed through to prime's built-in allowlist if it names a built-in
 * (`ipython` / `bash` / `edit`), and otherwise fails loudly.
 *
 * ## `emit_done` — why the answer is a tool call
 * Every run registers an `emit_done` tool. Its `parameters` is the spec's
 * `output.schema` when there is one, else `{answer: string}`. The run's
 * answer is the arguments prime validated for that call. This is what makes
 * structured output real rather than a prompt-shaped hope: the schema is
 * enforced by prime's tool-call validation layer before `execute` runs.
 *
 * Two behaviors verified live against the installed 0.8.1 and pinned here:
 *
 * 1. `tools` is an allowlist that gates **custom** tools too, not just
 *    built-ins. `tools: []` silently disables `emit_done` and the model
 *    answers in prose instead. The allowlist therefore ALWAYS names
 *    `emit_done`. (Probed: with `tools: []` the tool was never called;
 *    with `tools: ["emit_done"]` it was.)
 * 2. A model may still decline to call it. With no `output.schema` that is
 *    survivable — the answer falls back to the final assistant text, which
 *    is what `prime.ts` would have returned anyway. With an `output.schema`
 *    it is not: there is no structured payload, so the run fails loudly
 *    rather than hand the host prose where a schema was promised.
 *
 * ## Budgets — mikro owns them
 * Mirrors `prime.ts` exactly. Turns are counted at `turn_start` against the
 * spec's iteration cap; usage accumulates against `maxCost` / `maxTokens`;
 * an mikro-owned wall clock (`MIKRO_MCP_RUN_TIMEOUT_MS`, default 300s)
 * bounds the run. A breach calls `session.abort()`.
 *
 * Usage is accumulated at `message_end` ONLY. Verified live: `message_end`
 * and the following `turn_end` carry the SAME assistant message object with
 * the same `usage`, so counting both would double every run's tokens and
 * cost, and fire cost ceilings at half their configured value.
 *
 * **Cost ceilings on custom providers.** Prime derives cost from the price
 * table declared in `models.json`, and mikro does not know per-model pricing
 * for `khal` / `wafer` / `station` here. A declared-zero price would make a
 * `budget.max_cost` ceiling silently un-fireable, so that combination is a
 * loud reject instead.
 *
 * ## Deviations from the brief (deliberate, each verified)
 * - **Version pin.** The subprocess and SDK are two compatibility surfaces
 *   (CLI JSON stream versus programmatic session API), but both target one
 *   deliberate prime-agent release through `EXPECTED_PRIME_VERSION`.
 * - **Sub-call depth.** The brief said to set a `RLM_MAX_DEPTH` env var.
 *   `createAgentSession` accepts `rlmMaxDepth` directly, so this uses that
 *   instead: `process.env` is process-global, and the MCP server runs turns
 *   concurrently, so an env var would race between two turns with different
 *   depth budgets and silently apply the wrong one.
 * - **Typebox.** The brief said tool `parameters` are TypeBox
 *   (`Type.Object(...)`). Verified: the installed `typebox@1.3.21`'s
 *   `Type.Object` returns a plain JSON Schema object carrying no symbols,
 *   and prime's `defineTool` is the identity function. So schemas are
 *   written as plain JSON Schema and mikro takes no typebox dependency.
 *
 * ## Inherent boundary
 * Prime's recursive `rlm()` children run on prime's own model defaults;
 * only their depth is steerable from here. Their usage is not reported on
 * the parent's event stream, so — as with `prime.ts` — footer totals cover
 * the parent's turns.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MikroConfig } from "../../config.js";
import type { ContextItem, LoadedContext } from "../../context.js";
import { TIMEOUT_ANSWER } from "../../rlm.js";
import { loadPythonPlugins } from "../../sdk/python-plugin.js";
import { loadPluginTools } from "../../sdk/tool-loader.js";
import { createToolRegistry, type ToolRegistry } from "../../sdk/tool-registry.js";
import type { Microagent } from "../agents.js";
import type { BackendRequest, MicroagentResult, RuntimeBackend } from "../backend.js";
import { DEFAULT_PRIME_DEADLINE_MS, EXPECTED_PRIME_VERSION } from "./prime.js";

/** The shared prime-agent release whose SDK surface this module targets. */
export const EXPECTED_PRIME_SDK_VERSION = EXPECTED_PRIME_VERSION;

/** The tool through which a run reports its final answer. */
export const EMIT_DONE_TOOL = "emit_done";

/** Prime built-in tool names a spec may opt into by naming them in `tools:`. */
const PRIME_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["ipython", "bash", "edit"]);

/** Providers prime resolves from its built-in catalog under the same name. */
const PRIME_BUILTIN_PROVIDERS: ReadonlySet<string> = new Set([
  "google",
  "openrouter",
  "deepseek",
  "openai-codex",
  "zai",
]);

/**
 * Custom providers this backend can describe to prime via a generated
 * `models.json`. `apiKeyEnv` is the NAME of the environment variable — the
 * generated file never contains a key value.
 */
interface CustomProviderSpec {
  readonly api: string;
  readonly baseUrl: () => string;
  readonly apiKeyEnv: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** True when mikro knows this provider is free (local), so a cost ceiling is meaningless anyway. */
  readonly keyless?: boolean;
}

const CUSTOM_PROVIDERS: Readonly<Record<string, CustomProviderSpec>> = {
  khal: {
    api: "openai-completions",
    baseUrl: () => process.env.KHAL_BASE_URL ?? "https://llm.khal.ai/v1",
    apiKeyEnv: "KHAL_API_KEY",
  },
  wafer: {
    api: "openai-completions",
    baseUrl: () => process.env.WAFER_BASE_URL ?? "https://pass.wafer.ai/v1",
    apiKeyEnv: "WAFER_API_KEY",
    // Zero-data-retention is a contractual requirement of this gateway, not
    // a preference: it ships on every request or the request must not be made.
    headers: { "Wafer-ZDR": "required" },
  },
  station: {
    api: "openai-completions",
    baseUrl: () =>
      process.env.STATION_BASE_URL ??
      process.env.LEMONADE_BASE_URL ??
      "http://localhost:13305/api/v1",
    // pi-ai requires an apiKey auth even for a keyless local gateway.
    apiKeyEnv: "STATION_API_KEY",
    keyless: true,
  },
};

// ── Structural view of the prime SDK ─────────────────────────────────────
//
// Declared structurally rather than imported: the package is resolved at
// runtime by absolute path, so there is no compile-time module to import
// types from, and a structural type is exactly what an injected test fake
// must satisfy.

export interface PrimeSdkToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly details: unknown;
  readonly terminate?: boolean;
}

export interface PrimeSdkToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ): Promise<PrimeSdkToolResult>;
}

export interface PrimeSdkUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cost?: { readonly total?: number };
}

export interface PrimeSdkMessage {
  readonly role?: string;
  readonly content?: string | ReadonlyArray<{ type?: string; text?: string }>;
  readonly usage?: PrimeSdkUsage;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

export interface PrimeSdkEvent {
  readonly type?: string;
  readonly message?: PrimeSdkMessage;
  readonly toolName?: string;
}

export interface PrimeSdkSession {
  subscribe(listener: (event: PrimeSdkEvent) => void): unknown;
  prompt(text: string): Promise<unknown>;
  abort(): void;
  dispose(): void;
}

export interface PrimeSdkModel {
  readonly provider: string;
  readonly id: string;
  readonly maxTokens?: number;
}

export interface PrimeSdkModelRegistry {
  find(provider: string, modelId: string): PrimeSdkModel | undefined;
  getError?(): string | undefined;
}

/** Exactly the SDK surface this backend touches — the contract a fake must meet. */
export interface PrimeSdkModule {
  getAgentDir(): string;
  defineTool(tool: PrimeSdkToolDefinition): PrimeSdkToolDefinition;
  readonly AuthStorage: { create(path?: string): unknown };
  readonly ModelRegistry: {
    create(authStorage: unknown, modelsJsonPath?: string): PrimeSdkModelRegistry;
  };
  readonly SettingsManager: {
    inMemory(settings?: Record<string, unknown>): unknown;
    create(cwd: string, agentDir?: string): unknown;
  };
  readonly SessionManager: { inMemory(): unknown };
  readonly DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(): Promise<unknown>;
  };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PrimeSdkSession }>;
}

/** Resolves the prime SDK module. Injected in tests; memoized in production. */
export type PrimeSdkLoader = () => Promise<PrimeSdkModule>;

// ── Plan: the argv analog ────────────────────────────────────────────────

/** One tool offered to the model. `handler` is absent for `emit_done`. */
export interface PrimeSdkPlannedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler?: (args: unknown) => Promise<unknown>;
}

/** A `models.json` document, exactly as prime validates it. */
export interface PrimeModelsJson {
  readonly providers: Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * Everything one in-process run needs — this backend's analog of `prime.ts`'s
 * argv. Built before the SDK is touched so tests can assert on the mapping
 * without a session.
 */
export interface PrimeSdkPlan {
  /** 0700 per-run scratch dir for context and generated provider overrides. */
  readonly scratchDir: string;
  /** Where the agent works — the server's cwd, never the scratch dir. */
  readonly cwd: string;
  readonly query: string;
  /** Appended AFTER prime's base prompt — never replacing it. */
  readonly appendSystemPrompt: string;
  readonly provider: string;
  readonly modelId: string;
  /** Provider-level output cap for each root call. */
  readonly maxOutputTokens: number | null;
  readonly thinkingLevel: string | null;
  /** `budget.max_depth`, passed as `rlmMaxDepth`. */
  readonly rlmMaxDepth: number | null;
  /** Generated only for a custom provider; `null` for prime's built-ins. */
  readonly modelsJson: PrimeModelsJson | null;
  /** Context snapshots written 0600 under `<scratchDir>/context/`. */
  readonly contextSnapshots: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  /** `emit_done` first, then the spec's resolved custom tools. */
  readonly tools: readonly PrimeSdkPlannedTool[];
  /** Built-in prime tools the spec opted into. */
  readonly builtinTools: readonly string[];
  /** The spec's `output.schema`, when it declared one. */
  readonly answerSchema: Record<string, unknown> | null;
}

// ── Engine seam ──────────────────────────────────────────────────────────

/** Budgets this backend enforces on the run. Mirrors `PrimeRunLimits`. */
export interface PrimeSdkRunLimits {
  readonly deadlineMs: number;
  readonly maxCost: number | null;
  readonly maxTokens: number | null;
  readonly maxTurns: number | null;
}

/** The raw material of one run. Mirrors `PrimeRunResult`. */
export interface PrimeSdkRunResult {
  readonly answer: string;
  readonly turns: number;
  readonly budgetHit: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalCost: number;
  };
}

/**
 * Run one plan to completion (or to a designed abort). In production this is
 * {@link runSdkSession}; the backend-contract harness injects a scripted
 * engine, exactly as it does for `PrimeBackend`.
 */
export type PrimeSdkEngine = (
  plan: PrimeSdkPlan,
  emit: (message: string) => void,
  limits: PrimeSdkRunLimits
) => Promise<PrimeSdkRunResult>;

/** Optional hermetic provider-payload transform, implemented as an inline Prime extension. */
export type PrimeSdkProviderPayloadTransform = (
  payload: unknown,
  plan: PrimeSdkPlan
) => unknown | Promise<unknown>;

export interface PrimeSdkBackendOptions {
  /** Test seam: the SDK module. Supplying it skips root resolution and the version pin. */
  readonly loader?: PrimeSdkLoader;
  /** Test seam: replaces the whole run engine (contract harness). */
  readonly engine?: PrimeSdkEngine;
  /** Pinned version to assert (default: {@link EXPECTED_PRIME_SDK_VERSION}). */
  readonly expectedVersion?: string;
  /** Explicit prime package root; overrides `MIKRO_PRIME_AGENT_ROOT` and PATH discovery. */
  readonly primeRoot?: string;
  /** Canonical Prime config dir; defaults to the SDK's getAgentDir(), exactly like the CLI. */
  readonly primeAgentDir?: string;
  /** Inline-only transform; host extension discovery remains disabled. */
  readonly providerPayloadTransform?: PrimeSdkProviderPayloadTransform;
}

/** Kill reasons this backend owns — each a designed, non-throwing abort. */
type KillReason = "deadline" | "max-cost" | "max-tokens" | "max-turns";

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Text content of an assistant message — concatenated `text` parts. */
function textOf(message: PrimeSdkMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

function isAssistant(message: unknown): message is PrimeSdkMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as PrimeSdkMessage).role === "assistant"
  );
}

// ── Package resolution + version pin ─────────────────────────────────────

/**
 * Locate the INSTALLED prime-agent package root.
 *
 * `MIKRO_PRIME_AGENT_ROOT` wins; otherwise the `prime-agent` binary is found
 * on PATH and followed to its real path — `<root>/dist/bundle/cli.js` — whose
 * grandparent directory is the package root.
 */
export function resolvePrimeRoot(): string {
  const override = process.env.MIKRO_PRIME_AGENT_ROOT;
  if (override) return override;

  const probe = spawnSync("which", ["prime-agent"], { encoding: "utf8" });
  const binary = (probe.stdout ?? "").trim();
  if (probe.status !== 0 || binary.length === 0) {
    throw new Error(
      "prime-sdk backend: prime-agent is not on PATH, so its SDK cannot be located. " +
        `Install prime-agent ${EXPECTED_PRIME_SDK_VERSION}, set MIKRO_PRIME_AGENT_ROOT to the ` +
        "installed package root, or switch the agent back to `backend: mikro`."
    );
  }

  // `which` yields the launcher; the real file is <root>/dist/bundle/cli.js.
  const real = spawnSync("readlink", ["-f", binary], { encoding: "utf8" });
  const resolved = (real.stdout ?? "").trim() || binary;
  return join(dirname(resolved), "..", "..");
}

/**
 * Assert the installed package is the pinned version and return its root.
 * Reports to stderr AND throws, so the failure is visible in the server log
 * and surfaces as a clean tool error — same discipline as `prime.ts`.
 */
export function assertPinnedSdkVersion(root: string, expected: string): void {
  const manifestPath = join(root, "package.json");
  const failWith = (message: string): never => {
    process.stderr.write(`mikro: ${message}\n`);
    throw new Error(message);
  };

  if (!existsSync(manifestPath)) {
    failWith(
      `prime-sdk backend: no package.json at "${manifestPath}" — "${root}" is not an installed ` +
        "prime-agent package root. Set MIKRO_PRIME_AGENT_ROOT to the right directory, or switch " +
        "the agent back to `backend: mikro`."
    );
  }

  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch (err) {
    return void failWith(
      `prime-sdk backend: cannot read "${manifestPath}": ` +
        `${err instanceof Error ? err.message : String(err)}.`
    );
  }

  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (version !== expected) {
    failWith(
      `prime-sdk backend: "${root}" is not the pinned prime-agent ${expected}: ` +
        `its package.json reports ${version ? `"${version}"` : "no version"}. ` +
        "mikro pins this backend to an exact SDK version — upgrades are deliberate events. " +
        `(The subprocess backend pins ${EXPECTED_PRIME_VERSION}; the two are separate ` +
        "compatibility surfaces — the programmatic session API versus the CLI JSON stream.) " +
        "Move the pin as a recorded decision, or switch the agent back to `backend: mikro`."
    );
  }
}

/**
 * The production loader: resolve the root, assert the pin, import
 * `<root>/dist/index.js` by absolute file URL. Memoized — the import and
 * the pin check happen once per process.
 */
export function createPrimeSdkLoader(options: PrimeSdkBackendOptions = {}): PrimeSdkLoader {
  let cached: Promise<PrimeSdkModule> | undefined;
  return () => {
    cached ??= (async () => {
      const root = options.primeRoot ?? resolvePrimeRoot();
      assertPinnedSdkVersion(root, options.expectedVersion ?? EXPECTED_PRIME_SDK_VERSION);
      const entry = join(root, "dist", "index.js");
      if (!existsSync(entry)) {
        throw new Error(
          `prime-sdk backend: the installed prime-agent has no SDK entry point at "${entry}". ` +
            "Reinstall prime-agent, or switch the agent back to `backend: mikro`."
        );
      }
      return (await import(pathToFileURL(entry).href)) as unknown as PrimeSdkModule;
    })();
    return cached;
  };
}

// ── Config mapping ───────────────────────────────────────────────────────

/**
 * Reject every mikro feature the in-process prime leg cannot honor. Far
 * shorter than `prime.ts`'s list — see the delta table in the module header.
 */
export function assertSupportedConfig(config: MikroConfig, agentName: string | undefined): void {
  const who = agentName ? `agent "${agentName}"` : "this run";
  const reject = (field: string, why: string): never => {
    throw new Error(
      `prime-sdk backend: ${who} declares ${field}, which the prime-sdk leg cannot honor (${why}). ` +
        "Remove it from the agent/config or switch the agent back to `backend: mikro`."
    );
  };

  if (config.tools && config.tools.length > 0) {
    reject(
      "custom REPL tools (TOOLS.md)",
      "they are Python source injected into mikro's own REPL, and createAgentSession exposes no " +
        "way to preload code into prime's IPython kernel — declare them as agent.yaml `tools:` " +
        "plugins instead, which this backend maps to prime custom tools"
    );
  }

  const gemini = config.gemini;
  if (gemini) {
    if (gemini.googleSearch) reject("gemini.google-search", "prime has no googleSearch flag");
    if (gemini.urlContext) reject("gemini.url-context", "prime has no urlContext flag");
    if (gemini.codeExecution) reject("gemini.code-execution", "prime has no codeExecution flag");
    if (gemini.computerUse) reject("gemini.computer-use", "prime has no computerUse flag");
    if (gemini.mapsGrounding) reject("gemini.maps-grounding", "prime has no mapsGrounding flag");
    if (gemini.fileSearch) reject("gemini.file-search", "prime has no fileSearch flag");
    if (gemini.mediaResolution != null) {
      reject("gemini.media-resolution", "prime has no mediaResolution flag");
    }
  }

  // A cost ceiling that can never fire is worse than no ceiling: it reads as
  // enforced. Prime computes cost from the models.json price table, and mikro
  // has no pricing for these gateways here.
  const provider = config.model.provider;
  const custom = CUSTOM_PROVIDERS[provider];
  if (custom && !custom.keyless && config.budget?.maxCost != null) {
    throw new Error(
      `prime-sdk backend: ${who} sets budget.max_cost on provider "${provider}", whose ` +
        "per-model pricing mikro cannot declare to prime — prime would compute every call as $0 " +
        "and the ceiling would never fire. Drop budget.max_cost, use budget.max_tokens instead, " +
        "or switch the agent back to `backend: mikro`."
    );
  }
}

/** Build the `models.json` document for a custom provider, or null for a built-in. */
export function buildModelsJson(
  provider: string,
  modelId: string,
  agentName: string | undefined
): PrimeModelsJson | null {
  if (PRIME_BUILTIN_PROVIDERS.has(provider)) return null;
  const spec = CUSTOM_PROVIDERS[provider];
  if (!spec) {
    const who = agentName ? `agent "${agentName}"` : "this run";
    throw new Error(
      `prime-sdk backend: ${who} is pinned to model "${provider}/${modelId}", and "${provider}" is ` +
        `neither one of prime's built-in providers (${[...PRIME_BUILTIN_PROVIDERS].join(", ")}) ` +
        `nor one mikro can describe to prime (${Object.keys(CUSTOM_PROVIDERS).join(", ")}). ` +
        "Re-pin the agent's model, or switch the agent back to `backend: mikro`."
    );
  }
  return {
    providers: {
      [provider]: {
        api: spec.api,
        baseUrl: spec.baseUrl(),
        // The NAME of the env var, never its value: this file lands on disk.
        apiKey: spec.apiKeyEnv,
        ...(spec.headers ? { headers: { ...spec.headers } } : {}),
        models: [
          {
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
      },
    },
  };
}

/** Sanitize a context item's relative path into safe join segments. */
function sanitizeSegments(relativePath: string): string[] {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Snapshot the loaded context into files under the run's scratch dir.
 *
 * Unlike `prime.ts`, which hands prime `@<abs path>` arguments pointing at
 * the caller's originals, the SDK has no `@file` argument parser — so the
 * content mikro already loaded is written out and named in the prompt. That
 * is also why `dict` contexts work here and not there: a snapshot has a
 * shape, an `@file` argument needs a pre-existing path.
 */
export function planContextSnapshots(
  context: LoadedContext | null,
  scratchDir: string
): Array<{ path: string; content: string }> {
  if (!context) return [];
  const root = join(scratchDir, "context");
  if (context.type === "string") {
    return [{ path: join(root, "context.md"), content: String(context.content) }];
  }
  if (context.type === "list") {
    const items = context.content as ReadonlyArray<ContextItem>;
    return items.map((item) => ({
      path: join(root, ...sanitizeSegments(item.path)),
      content: item.content,
    }));
  }
  // dict — a keyed bag; each key becomes a file.
  const entries = Object.entries(context.content as unknown as Record<string, unknown>);
  return entries.map(([key, value]) => ({
    path: join(root, ...sanitizeSegments(`${key}.md`)),
    content: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }));
}

/** The microagent role appended AFTER prime's base prompt (never replacing it). */
function buildAppendedRole(
  agent: Microagent | undefined,
  config: MikroConfig,
  contextNote: string | null,
  hasSchema: boolean
): string {
  const who = agent ? `the mikro microagent "${agent.name}"` : "an mikro microagent";
  const parts: string[] = [
    `You are operating as ${who}, dispatched by an mikro MCP host to complete one delegated task. ` +
      "Work autonomously to completion — you cannot ask the host follow-up questions mid-run.",
    `## Reporting your answer\n\nWhen you are done, call the \`${EMIT_DONE_TOOL}\` tool exactly once. ` +
      (hasSchema
        ? "Its arguments are the structured result the host requires; they are validated against " +
          "the host's schema, so every required field must be present and correctly typed."
        : "Pass your complete final report as the `answer` argument: self-contained, and written " +
          "for the host's user.") +
      ` The run ends when \`${EMIT_DONE_TOOL}\` returns.`,
  ];
  if (contextNote) parts.push(contextNote);
  if (config.system) parts.push(`## Agent instructions\n\n${config.system}`);
  if (config.criteria) {
    parts.push(
      `## Output criteria\n\nWhen providing your final answer, follow these criteria:\n${config.criteria}`
    );
  }
  return parts.join("\n\n");
}

/**
 * Resolve `agent.spec.tools[]` into prime custom tools through mikro's own
 * plugin loaders, plus the built-in names the spec opted into.
 */
async function planSpecTools(
  agent: Microagent | undefined
): Promise<{ custom: PrimeSdkPlannedTool[]; builtin: string[] }> {
  const names = agent?.spec.tools ?? [];
  if (names.length === 0) return { custom: [], builtin: [] };

  const registry: ToolRegistry = createToolRegistry();
  const mjs = await loadPluginTools(agent!.spec, registry);
  const py = await loadPythonPlugins(agent!.spec, registry);

  const custom: PrimeSdkPlannedTool[] = [];
  const builtin: string[] = [];
  const unresolved: string[] = [];

  for (const name of names) {
    const handler = registry.get(name);
    if (handler) {
      const schema = registry.describe(name);
      custom.push({
        name,
        description: schema?.description ?? `The mikro "${name}" tool, provided by the host.`,
        // When no sidecar schema is present, a permissive object is the honest
        // fallback: it lets the model call the tool with the arguments the
        // plugin documents, rather than pretending to a precision mikro has
        // not declared.
        parameters: schema?.parameters ?? { type: "object", additionalProperties: true },
        handler: (args: unknown) =>
          Promise.resolve(
            handler(args, {
              tool: name,
              sessionId: "prime-sdk",
              iteration: 0,
              signal: new AbortController().signal,
            })
          ),
      });
      continue;
    }
    if (PRIME_BUILTIN_TOOLS.has(name)) {
      builtin.push(name);
      continue;
    }
    unresolved.push(name);
  }

  if (unresolved.length > 0) {
    throw new Error(
      `prime-sdk backend: agent "${agent!.name}" declares tool(s) ` +
        `${unresolved.map((n) => `"${n}"`).join(", ")} that resolve to no plugin under ` +
        `${join(agent!.spec.dir, "tools")} and name no prime built-in ` +
        `(${[...PRIME_BUILTIN_TOOLS].join(", ")}). Add the plugin file, remove the declaration, ` +
        "or switch the agent back to `backend: mikro`. " +
        `(loaded: ${[...mjs.loaded, ...py.loaded].join(", ") || "none"})`
    );
  }
  return { custom, builtin };
}

/** Resolve the wall-clock deadline — legacy's override, same default. */
function sdkDeadlineMs(): number {
  const ms = Number(process.env.MIKRO_MCP_RUN_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PRIME_DEADLINE_MS;
}

/** Build the run plan. Touches the SDK not at all — only maps mikro onto it. */
export async function buildPlan(
  scratchDir: string,
  agent: Microagent | undefined,
  request: BackendRequest
): Promise<PrimeSdkPlan> {
  const config = request.config;
  assertSupportedConfig(config, agent?.name);

  const provider = config.model.provider;
  const modelId = config.model.model;
  const modelsJson = buildModelsJson(provider, modelId, agent?.name);

  const contextSnapshots = planContextSnapshots(request.context, scratchDir);
  const contextNote =
    contextSnapshots.length > 0
      ? `## Caller-provided context\n\nThe host wrote ${contextSnapshots.length} file(s) for this ` +
        `task:\n${contextSnapshots.map((s) => `- ${s.path}`).join("\n")}\nRead them before answering.`
      : null;

  const answerSchema = config.output?.schema ?? null;
  const { custom, builtin } = await planSpecTools(agent);

  const emitDone: PrimeSdkPlannedTool = {
    name: EMIT_DONE_TOOL,
    description: answerSchema
      ? "Report the final structured result. Call exactly once, when the task is complete."
      : "Report the final answer. Call exactly once, when the task is complete.",
    parameters: answerSchema ?? {
      type: "object",
      required: ["answer"],
      properties: {
        answer: {
          type: "string",
          description: "The complete final report, written for the host's user.",
        },
      },
    },
  };

  return {
    scratchDir,
    cwd: request.cwd,
    query: request.query,
    appendSystemPrompt: buildAppendedRole(agent, config, contextNote, answerSchema !== null),
    provider,
    modelId,
    maxOutputTokens: request.maxOutputTokens ?? null,
    thinkingLevel: config.gemini?.thinkingLevel ?? null,
    rlmMaxDepth: config.budget?.maxDepth ?? null,
    modelsJson,
    contextSnapshots,
    tools: [emitDone, ...custom],
    builtinTools: builtin,
    answerSchema,
  };
}

// ── Scratch materialization ──────────────────────────────────────────────

/** Create the per-run scratch directory, owner-only. */
export function createScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikro-prime-sdk-"));
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Write the plan's files into the scratch dir: `models.json` when a custom
 * provider needs one, and every context snapshot. All 0600 — the scratch dir
 * carries a generated provider config and the caller's context, neither of
 * which any other user on the box has business reading.
 */
export function materializePlan(plan: PrimeSdkPlan): void {
  if (plan.modelsJson) {
    const path = join(plan.scratchDir, "models.json");
    writeFileSync(path, `${JSON.stringify(plan.modelsJson, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  for (const snapshot of plan.contextSnapshots) {
    mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
    writeFileSync(snapshot.path, snapshot.content, { mode: 0o600 });
    chmodSync(snapshot.path, 0o600);
  }
}

// ── The real engine ──────────────────────────────────────────────────────

/**
 * Run one plan through a real prime agent session, enforcing the mikro-owned
 * budgets from the event stream and aborting the session on breach.
 */
export function runSdkSession(
  load: PrimeSdkLoader,
  plan: PrimeSdkPlan,
  emit: (message: string) => void,
  limits: PrimeSdkRunLimits,
  configuredPrimeAgentDir?: string,
  providerPayloadTransform?: PrimeSdkProviderPayloadTransform
): Promise<PrimeSdkRunResult> {
  return (async () => {
    const sdk = await load();
    materializePlan(plan);
    const primeAgentDir = configuredPrimeAgentDir ?? sdk.getAgentDir();

    // Match the CLI's canonical config inputs. Scratch is used only when Mikro
    // generated a per-run custom-provider override; built-in providers must see
    // the same evolving models.json catalog the CLI sees.
    const authStorage = sdk.AuthStorage.create(join(primeAgentDir, "auth.json"));
    const modelRegistry = sdk.ModelRegistry.create(
      authStorage,
      plan.modelsJson
        ? join(plan.scratchDir, "models.json")
        : join(primeAgentDir, "models.json")
    );
    const model = modelRegistry.find(plan.provider, plan.modelId);
    if (!model) {
      const registryError = modelRegistry.getError?.();
      throw new Error(
        `prime-sdk backend: prime cannot resolve model "${plan.provider}/${plan.modelId}". ` +
          (registryError ? `models.json error: ${registryError}. ` : "") +
          "Re-pin the agent's model, or switch the agent back to `backend: mikro`."
      );
    }
    // Registry models are shared catalog values. Clone rather than mutate so
    // concurrent turns with different provider output caps cannot race.
    const sessionModel = plan.maxOutputTokens === null
      ? model
      : { ...model, maxTokens: plan.maxOutputTokens };

    let turns = 0;
    let lastTurnText: string | null = null;
    let lastText = "";
    let lastProviderError: string | null = null;
    let emitDoneArgs: Record<string, unknown> | null = null;
    let killed: KillReason | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, totalCost: 0 };

    const customTools = plan.tools.map((tool) =>
      sdk.defineTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_toolCallId, params) => {
          if (tool.name === EMIT_DONE_TOOL) {
            // Prime validated `params` against `parameters` before calling us,
            // so this is the schema-checked payload — the run's answer.
            emitDoneArgs = params;
            return {
              content: [{ type: "text" as const, text: "Answer recorded. The run is complete." }],
              details: {},
              terminate: true,
            };
          }
          const result = await tool.handler!(params);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          return { content: [{ type: "text" as const, text }], details: result };
        },
      })
    );

    const settingsManager = sdk.SettingsManager.create(plan.cwd, primeAgentDir);
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: plan.cwd,
      agentDir: plan.scratchDir,
      settingsManager,
      // Host hermeticity, mirroring prime.ts's -nc/-ne/-ns/-np: no AGENTS.md,
      // extension, skill, prompt template, or theme from the host machine
      // participates in the run.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      bundledSkillsDir: null,
      extensionFactories: providerPayloadTransform
        ? [
            (api: {
              on(
                event: "before_provider_request",
                handler: (event: { payload: unknown }) => unknown | Promise<unknown>
              ): void;
            }) => {
              api.on("before_provider_request", (event) =>
                providerPayloadTransform(event.payload, plan)
              );
            },
          ]
        : [],
      // Appended, never `systemPrompt` — replacing would strip prime's base
      // prompt and handicap the leg, the same reason prime.ts uses
      // --append-system-prompt.
      appendSystemPrompt: [plan.appendSystemPrompt],
    });
    await resourceLoader.reload();

    const { session } = await sdk.createAgentSession({
      cwd: plan.cwd,
      agentDir: primeAgentDir,
      authStorage,
      modelRegistry,
      model: sessionModel,
      ...(plan.thinkingLevel ? { thinkingLevel: plan.thinkingLevel } : {}),
      // The allowlist MUST name emit_done: it gates custom tools too, and an
      // empty list silently disables the answer channel (verified live).
      tools: [EMIT_DONE_TOOL, ...plan.tools.slice(1).map((t) => t.name), ...plan.builtinTools],
      customTools,
      resourceLoader,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(),
      ...(plan.rlmMaxDepth !== null ? { rlmMaxDepth: plan.rlmMaxDepth } : {}),
      telemetryDisabled: true,
    });

    const breach = (reason: KillReason): void => {
      if (killed) return; // first breach wins
      killed = reason;
      try {
        session.abort();
      } catch {
        // Already finishing — the prompt promise is the only resolver.
      }
    };

    session.subscribe((event: PrimeSdkEvent) => {
      switch (event.type) {
        case "turn_start":
          // Turns are prime's analog of legacy iterations. Break when the
          // (cap+1)th turn would start, so the reported answer is the last
          // COMPLETED turn's.
          if (limits.maxTurns !== null && turns >= limits.maxTurns) {
            breach("max-turns");
            return;
          }
          emit(`iteration ${turns + 1}`);
          break;
        case "turn_end":
          // Prime may still emit the aborted turn's terminal event after the
          // (cap+1)th turn_start triggered abort. That turn never completed
          // within Mikro's budget and must not inflate the reported count.
          if (killed === "max-turns" && limits.maxTurns !== null && turns >= limits.maxTurns) {
            break;
          }
          turns += 1;
          if (isAssistant(event.message)) lastTurnText = textOf(event.message);
          break;
        case "message_update":
          if (isAssistant(event.message)) lastText = textOf(event.message);
          break;
        case "message_end":
          if (isAssistant(event.message)) {
            lastText = textOf(event.message);
            if (
              (event.message.stopReason === "error" || event.message.stopReason === "aborted") &&
              typeof event.message.errorMessage === "string"
            ) {
              lastProviderError = event.message.errorMessage;
            }
            // Usage is read HERE ONLY. The following turn_end carries the same
            // message object with the same usage — counting both would double
            // every total and halve every cost ceiling.
            const u = event.message.usage;
            if (u) {
              usage.inputTokens += num(u.input);
              usage.outputTokens += num(u.output);
              usage.totalCost += num(u.cost?.total);
            }
            if (limits.maxCost !== null && usage.totalCost >= limits.maxCost) {
              breach("max-cost");
            } else if (
              limits.maxTokens !== null &&
              usage.inputTokens + usage.outputTokens >= limits.maxTokens
            ) {
              breach("max-tokens");
            }
          }
          break;
        case "tool_execution_start":
          if (typeof event.toolName === "string" && event.toolName.length > 0) {
            emit(`tool ${event.toolName}`);
          }
          break;
        default:
          break;
      }
    });

    let deadlineTimer: NodeJS.Timeout | undefined = setTimeout(
      () => breach("deadline"),
      limits.deadlineMs
    );
    try {
      await session.prompt(plan.query);
    } catch (err) {
      // An abort we asked for is a designed stop, not a failure; anything
      // else is a real error and must reach the host.
      if (!killed) throw err;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      try {
        session.dispose();
      } catch {
        // Disposal is best-effort; the scratch dir is removed either way.
      }
    }

    /** The answer the model reported, or null when it never called emit_done. */
    const reported = (): string | null => {
      if (emitDoneArgs === null) return null;
      if (plan.answerSchema) return JSON.stringify(emitDoneArgs);
      const answer = (emitDoneArgs as { answer?: unknown }).answer;
      return typeof answer === "string" ? answer : JSON.stringify(emitDoneArgs);
    };

    if (killed) {
      switch (killed) {
        case "deadline":
          // Legacy's timeout answer, so isFailedRun classifies it as failed.
          return { answer: TIMEOUT_ANSWER, turns, budgetHit: null, usage: { ...usage } };
        case "max-cost":
        case "max-tokens":
          return {
            answer:
              (reported() ?? lastText).trim() ||
              `Error: budget hit: ${killed} before the model produced any output`,
            turns,
            budgetHit: killed,
            usage: { ...usage },
          };
        case "max-turns":
          return {
            answer:
              (reported() ?? lastTurnText ?? lastText).trim() ||
              `Error: iteration cap reached: the run exceeded ${limits.maxTurns} turn(s) without producing a report`,
            turns,
            budgetHit: "max-iterations",
            usage: { ...usage },
          };
      }
    }

    const answer = reported();
    if (answer === null) {
      if (lastProviderError !== null) {
        throw new Error(`prime-sdk provider error: ${lastProviderError}`);
      }
      if (plan.answerSchema) {
        // A schema was promised to the host. Prose is not that, and quietly
        // returning it would be exactly the silent degradation this backend
        // exists to avoid.
        throw new Error(
          `prime-sdk backend: the run finished without calling \`${EMIT_DONE_TOOL}\`, so it ` +
            "produced no structured output for the declared `output.schema`. Re-run, relax the " +
            "schema, or switch the agent back to `backend: mikro`."
        );
      }
      // No schema: the final assistant text is exactly what the subprocess
      // backend would have returned, so fall back to it rather than fail.
      return {
        answer: lastTurnText ?? lastText,
        turns,
        budgetHit: null,
        usage: { ...usage },
      };
    }

    return { answer, turns, budgetHit: null, usage: { ...usage } };
  })();
}

// ── Backend ──────────────────────────────────────────────────────────────

export class PrimeSdkBackend implements RuntimeBackend {
  private readonly engine: PrimeSdkEngine;

  constructor(options: PrimeSdkBackendOptions = {}) {
    if (options.engine) {
      this.engine = options.engine;
    } else {
      // Root resolution, the version pin, and the dynamic import all happen
      // inside the loader on first use — a server that constructs this
      // backend but never runs a turn must not pay for them, and must not
      // fail to start on a machine without prime-agent.
      const load = options.loader ?? createPrimeSdkLoader(options);
      this.engine = (plan, emit, limits) =>
        runSdkSession(
          load,
          plan,
          emit,
          limits,
          options.primeAgentDir,
          options.providerPayloadTransform
        );
    }
  }

  async run(
    agent: Microagent | undefined,
    request: BackendRequest,
    emit: (message: string) => void
  ): Promise<MicroagentResult> {
    const limits: PrimeSdkRunLimits = {
      deadlineMs: sdkDeadlineMs(),
      maxCost: request.config.budget?.maxCost ?? null,
      maxTokens: request.config.budget?.maxTokens ?? null,
      maxTurns: request.maxIterations !== undefined ? request.maxIterations : null,
    };

    const scratchDir = createScratchDir();
    try {
      const plan = await buildPlan(scratchDir, agent, request);
      const result = await this.engine(plan, emit, limits);
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
    } finally {
      // The scratch dir holds the caller's context and a generated provider
      // config. It never outlives the turn, on any exit path.
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}
