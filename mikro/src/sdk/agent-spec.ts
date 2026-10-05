/**
 * `agent.yaml` parser — Wish B Group 3.
 *
 * Minimal schema matching the folder-based agent convention from
 * wish A (khal-os/brain `.agents/<name>/agent.yaml`). Only the fields
 * the SDK needs for plugin loading + runAgent wiring are parsed here;
 * extra YAML keys are preserved on the returned `extras` bag so
 * consumers can layer their own schema on top without forking this
 * parser.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";
import { isValidThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../gemini.js";

export interface AgentBudget {
	readonly maxCost?: number;
	readonly maxIterations?: number;
	readonly maxDepth?: number;
}

export interface AgentScope {
	readonly reads?: readonly string[];
	readonly writes?: readonly string[];
}

/**
 * Per-agent system-prompt assembly overrides — the `agent.yaml` equivalent of
 * mikro.yaml's `prompt:` block. `undefined` means "not declared", so the
 * ambient config decides.
 */
export interface AgentPrompt {
	/**
	 * Opt out of the appended REPL/FINAL termination protocol
	 * (`src/stop-protocol.ts`). Consumers apply it by writing
	 * `config.prompt.appendStopProtocol` (see `applyAgent` in
	 * `src/mcp/server.ts`), which is the same field mikro.yaml's
	 * `prompt.append-stop-protocol` writes — an agent's declaration simply
	 * outranks the ambient one.
	 */
	readonly appendStopProtocol?: boolean;
}

export interface AgentSpec {
	/** Agent directory on disk — parent of agent.yaml. All tool-file
	 *  resolutions are relative to this path. */
	readonly dir: string;
	readonly schemaVersion: number;
	readonly toolsApi: number;
	readonly shape: "single-step" | "loop" | "recurse";
	readonly model?: string;
	readonly tools: readonly string[];
	readonly systemPath?: string;
	/**
	 * Reasoning effort for this agent's own model calls — the `agent.yaml`
	 * equivalent of `mikro --thinking`. `undefined` means "not declared".
	 *
	 * Consumers apply it by writing `config.gemini.thinkingLevel`, the single
	 * field `llmComplete` turns into pi-ai's `reasoning` option (see
	 * `applyAgent` in `src/mcp/server.ts`). Two honest caveats:
	 *
	 * 1. Despite the `gemini.` prefix on the config field, pi-ai maps
	 *    `reasoning` on **every** api family it supports — OpenAI Responses
	 *    (`reasoning.effort`), OpenAI Completions and its deepseek / openrouter
	 *    / zai / together dialects (`reasoning_effort`), Google
	 *    (`thinkingConfig.thinkingLevel`), and Anthropic
	 *    (`thinking.budget_tokens`). This is not a Google-only knob.
	 * 2. The level is a **request, not a guarantee**. pi-ai's
	 *    `clampThinkingLevel` snaps it to the levels the resolved model
	 *    actually declares, searching *upward* first — so `minimal` on a model
	 *    whose floor is higher is silently raised, not lowered. Omitting the
	 *    field is likewise not "provider default": pi-ai then explicitly
	 *    *disables* reasoning on models that support it.
	 */
	readonly thinking?: ThinkingLevel;
	/**
	 * Sampling temperature for this agent's own model calls, `0`–`2` — the
	 * `agent.yaml` twin of `mikro --temperature`. `undefined` means "not
	 * declared", so the ambient config decides.
	 *
	 * Consumers apply it by writing `config.temperature`, the single field
	 * `llmComplete` turns into pi-ai's `temperature` option (see `applyAgent` in
	 * `src/mcp/server.ts`) — the same field mikro.yaml's top-level `temperature:`
	 * writes, so an agent's declaration simply outranks the ambient one.
	 *
	 * Two caveats, both the same shape as `thinking:`'s:
	 *
	 * 1. `0` is a **meaningful** value (greedy decoding), not a synonym for
	 *    unset. Every guard on this field is `!= null` / `!== undefined` and
	 *    never truthiness.
	 * 2. It is best-effort. pi-ai sends `temperature` on every api family and
	 *    drops it on exactly one — `anthropic-messages` — either when a
	 *    reasoning level is set or when the resolved model declares
	 *    `compat.supportsTemperature: false`. The guard belongs to the api,
	 *    not the model family: Claude reached via OpenRouter or Bedrock keeps
	 *    its temperature regardless. A declared temperature is a request, not
	 *    a guarantee.
	 */
	readonly temperature?: number;
	readonly scope?: AgentScope;
	readonly budget?: AgentBudget;
	/** System-prompt assembly overrides. `undefined` means "not declared". */
	readonly prompt?: AgentPrompt;
	/**
	 * Internal, undocumented: which runtime backend executes this agent's
	 * turns (wish mikro-v2-prime-backend). Absent means `mikro` — the legacy
	 * engine, which stays the default. Deliberately NOT part of the
	 * documented `agent.yaml` schema: it is a gate/experiment selector that
	 * may change without notice.
	 *
	 * - `mikro` — the legacy in-process engine (`rlmLoop`). The default.
	 * - `prime` — one `prime-agent` subprocess per turn
	 *   (`src/mcp/backends/prime.ts`).
	 * - `prime-sdk` — the same agent driven in-process through prime's
	 *   programmatic SDK (`src/mcp/backends/prime-sdk.ts`): no per-turn cold
	 *   start, plus custom tools, structured output, custom providers, and
	 *   sub-call depth, which the subprocess flag surface cannot express.
	 */
	readonly backend?: "mikro" | "prime" | "prime-sdk";
	/** Preserved unrecognised keys — consumers layer their own schema. */
	readonly extras: Readonly<Record<string, unknown>>;
}

/** Backends a spec may name. Pinned here so the error text can list them. */
const VALID_BACKENDS: readonly NonNullable<AgentSpec["backend"]>[] = [
	"mikro",
	"prime",
	"prime-sdk",
] as const;

/**
 * Inclusive bounds for `temperature:`. Kept local rather than imported from
 * `src/config.ts` so this parser stays free of the project config loader —
 * the same reason `VALID_BACKENDS` is spelled out here. The canonical
 * definition (and the reason the ceiling is 2) is `TEMPERATURE_MIN` /
 * `TEMPERATURE_MAX` in `src/config.ts`; keep the two in step.
 */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

const VALID_SHAPES: readonly AgentSpec["shape"][] = [
	"single-step",
	"loop",
	"recurse",
] as const;

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const v of value) {
		if (typeof v !== "string") continue;
		if (v.length === 0) continue;
		out.push(v);
	}
	return out;
}

function parseBudget(raw: unknown): AgentBudget | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const b = raw as Record<string, unknown>;
	const out: AgentBudget = {
		maxCost: asNumber(b.max_cost ?? b.maxCost),
		maxIterations: asNumber(b.max_iterations ?? b.maxIterations),
		maxDepth: asNumber(b.max_depth ?? b.maxDepth),
	};
	if (
		out.maxCost === undefined &&
		out.maxIterations === undefined &&
		out.maxDepth === undefined
	) {
		return undefined;
	}
	return out;
}

/**
 * Parse the `prompt:` block. Kebab-case is the documented spelling (it matches
 * mikro.yaml's `prompt.append-stop-protocol`); the snake_case and camelCase
 * spellings are accepted the way `budget:` accepts both of its own.
 *
 * A non-boolean value throws rather than being ignored, for the same reason
 * `thinking:` and `backend:` throw: silently keeping the default here would
 * look exactly like a working opt-out.
 */
function parsePrompt(raw: unknown): AgentPrompt | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const p = raw as Record<string, unknown>;
	const value =
		p["append-stop-protocol"] ?? p.append_stop_protocol ?? p.appendStopProtocol;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(
			`agent.yaml: prompt.append-stop-protocol must be true or false, got ${JSON.stringify(value)}`,
		);
	}
	return { appendStopProtocol: value };
}

function parseScope(raw: unknown): AgentScope | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const s = raw as Record<string, unknown>;
	const reads = asStringArray(s.reads);
	const writes = asStringArray(s.writes);
	if (!reads && !writes) return undefined;
	return { reads, writes };
}

/**
 * Parse a raw YAML string into an `AgentSpec`. `dir` is the agent's
 * filesystem directory — used later by the tool loader to resolve
 * plugin file paths. Throws on schema violations with a precise
 * message identifying the offending key.
 */
export function parseAgentSpec(yamlText: string, dir: string): AgentSpec {
	let raw: unknown;
	try {
		raw = yaml.load(yamlText);
	} catch (err) {
		throw new Error(
			`agent.yaml: parse error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("agent.yaml: expected a YAML mapping at the top level");
	}
	const r = raw as Record<string, unknown>;

	const schemaVersion = asNumber(r.schema_version ?? r.schemaVersion) ?? 1;
	const toolsApi = asNumber(r.tools_api ?? r.toolsApi) ?? 1;

	const shapeRaw = asString(r.shape) ?? "single-step";
	if (!VALID_SHAPES.includes(shapeRaw as AgentSpec["shape"])) {
		throw new Error(
			`agent.yaml: shape must be one of ${VALID_SHAPES.join(" | ")}, got "${shapeRaw}"`,
		);
	}

	const tools = asStringArray(r.tools) ?? [];

	const systemPath = asString(r.system);

	// `thinking:` is validated rather than passed through, because a typo has no
	// safe fallback: an unrecognised level reaching pi-ai is clamped to some
	// arbitrary supported level instead of being rejected, so `thinking: hgih`
	// would run at whatever effort the model happens to floor at and look like
	// it worked. Fail loudly at parse time — which is discovery time for
	// `mikro mcp` — the way `shape` does.
	const thinkingRaw = asString(r.thinking);
	if (thinkingRaw !== undefined && !isValidThinkingLevel(thinkingRaw)) {
		throw new Error(
			`agent.yaml: thinking must be one of ${THINKING_LEVELS.join(" | ")}, ` +
				`got "${thinkingRaw}"`,
		);
	}

	// `temperature:` is validated rather than passed through for the same
	// reason as `thinking:` — but with a sharper edge. A null value is "unset"
	// (the convention `prompt:` and mikro.yaml already use), while *anything
	// else* that is not a finite number in range throws: an out-of-range or
	// misspelled temperature that fell back to unset would look exactly like a
	// working pin, and pinning sampling is the entire point of declaring it.
	//
	// `asNumber` is the right gate here: it returns `0` (unlike a truthiness
	// check) and rejects NaN/Infinity, which would otherwise pass the range
	// comparison — `NaN >= 0` and `NaN <= 2` are both false, so a bare
	// range test alone would let NaN through as "in range: no".
	const temperatureRaw = r.temperature;
	let temperature: number | undefined;
	if (temperatureRaw !== undefined && temperatureRaw !== null) {
		const parsed = asNumber(temperatureRaw);
		if (
			parsed === undefined ||
			parsed < TEMPERATURE_MIN ||
			parsed > TEMPERATURE_MAX
		) {
			throw new Error(
				`agent.yaml: temperature must be a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}, ` +
					`got ${JSON.stringify(temperatureRaw)}`,
			);
		}
		temperature = parsed;
	}

	// Same validate-don't-ignore rule as `thinking:`: a typo'd backend would
	// silently fall back to the legacy engine and look like it worked, which
	// is exactly the silent degradation a selection field must not allow.
	const backendRaw = asString(r.backend);
	if (
		backendRaw !== undefined &&
		backendRaw !== "mikro" &&
		backendRaw !== "prime" &&
		backendRaw !== "prime-sdk"
	) {
		throw new Error(
			`agent.yaml: backend must be one of ${VALID_BACKENDS.join(" | ")}, got "${backendRaw}"`,
		);
	}

	// Build the "extras" bag by stripping the known keys from r.
	const known = new Set([
		"schema_version",
		"schemaVersion",
		"tools_api",
		"toolsApi",
		"shape",
		"model",
		"tools",
		"system",
		"thinking",
		"temperature",
		"scope",
		"budget",
		"backend",
		"prompt",
	]);
	const extras: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(r)) {
		if (!known.has(k)) extras[k] = v;
	}

	return {
		dir,
		schemaVersion,
		toolsApi,
		shape: shapeRaw as AgentSpec["shape"],
		model: asString(r.model),
		tools,
		systemPath,
		thinking: thinkingRaw as ThinkingLevel | undefined,
		temperature,
		scope: parseScope(r.scope),
		budget: parseBudget(r.budget),
		prompt: parsePrompt(r.prompt),
		backend: backendRaw as AgentSpec["backend"] | undefined,
		extras,
	};
}

/**
 * Load + parse an agent directory's `agent.yaml`. Convenience wrapper
 * around `readFile` + `parseAgentSpec`. The returned `AgentSpec.dir`
 * is the absolute path of the supplied `agentDir` so downstream
 * plugin-path resolution has an anchor regardless of cwd.
 */
export async function loadAgentSpec(agentDir: string): Promise<AgentSpec> {
	const abs = isAbsolute(agentDir) ? agentDir : resolve(agentDir);
	const text = await readFile(join(abs, "agent.yaml"), "utf8");
	return parseAgentSpec(text, abs);
}

/**
 * Resolve an agent-relative path to an absolute path. Exported so the
 * tool loader + consumers share a single resolution convention.
 */
export function resolveAgentPath(spec: AgentSpec, relative: string): string {
	if (isAbsolute(relative)) return relative;
	return resolve(dirname(join(spec.dir, "_")), relative);
}
