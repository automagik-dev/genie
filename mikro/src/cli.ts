#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  applyModelRef,
  applyTemperatureOverride,
  loadConfig,
  parseTemperatureFlag,
  type ToolsLevel,
} from "./config.js";
import { isValidThinkingLevel, checkFutureFlags, type ThinkingLevel } from "./gemini.js";
import { scaffold, needsScaffold } from "./scaffold.js";
import { loadContext, loadContextFromStdin } from "./context.js";
import { EMPTY_RESPONSES_BUDGET_HIT, rlmLoop } from "./rlm.js";
import { outputResult, buildStats, emitStats } from "./output.js";
import { createLogger } from "./logger.js";
import { checkPythonVersion } from "./detect.js";
import { estimateTokens, validateContextSize } from "./cache.js";
import { runBatch } from "./batch.js";
import { loadSettings, saveSettings, injectApiKeysToEnv, formatValue, parseSettingValue, getSettingsPath, type GlobalSettings } from "./settings.js";
import { printMikroCliSchema } from "./schema.js";
import { checkModelConfig, formatModelRef } from "./llm.js";
import { customProviderKeySource } from "./custom-providers.js";
import type { MikroConfig } from "./config.js";

/**
 * Apply model overrides from global settings (~/.mikro/settings.json).
 * Priority: CLI flags > settings.json > mikro.yaml > hardcoded defaults.
 *
 * This ensures `mikro config set model.provider openai` actually takes effect
 * even when a local mikro.yaml exists with its own model defaults.
 */
/** Module-level ref so helper functions can apply overrides without re-loading. */
let _globalSettings: GlobalSettings = {};

/**
 * Apply model overrides from global settings (~/.mikro/settings.json).
 * Priority: CLI flags > settings.json > mikro.yaml > hardcoded defaults.
 *
 * This ensures `mikro config set model.provider openai` actually takes effect
 * even when a local mikro.yaml exists with its own model defaults.
 */
function applySettingsModelOverrides(config: MikroConfig, settings?: GlobalSettings): void {
  const s = settings ?? _globalSettings;
  const provider = s["model.provider"];
  const model = s["model.model"];
  const subCallModel = s["model.sub-call-model"];
  if (typeof provider === "string" && provider) {
    config.model.provider = provider;
  }
  if (typeof model === "string" && model) {
    config.model.model = model;
  }
  if (typeof subCallModel === "string" && subCallModel) {
    config.model.subCallModel = subCallModel;
  }
}

const HELP = `mikro — RLM algorithm CLI for coding agents

Usage:
  mikro "query" [options]          Run an RLM query
  mikro init [--template default|code] [--dir <path>]  Scaffold .mikro/ config
  mikro cache [options]           Pre-warm cache or estimate context size
  mikro batch <file> [options]    Bulk interrogation from questions file
  mikro benchmark <mode> [options]  Run benchmarks (cost or oolong)
  mikro stats [options]           Query run history and cost breakdowns
  mikro doctor                    Health check: providers, config
  mikro update [--force]          Fetch latest main commit for a git install
  mikro migrate [--apply]         Find legacy rlmx artifacts (config dirs, .mcp.json,
                                  Claude plugin registration) and rewrite them for mikro.
                                  Dry-run unless --apply; --root <dir> adds scan roots,
                                  --exclude <substr> skips paths (backups), --depth <n>,
                                  --rc also rewrites ~/.rlmx / RLMX_* in shell rc files
  mikro acp                       Run as a stdio ACP agent (EXPERIMENTAL)
  mikro mcp [--dir <path>]        Run as a stdio MCP server (agents as tools)

Options:
  --context <path>        Path to context (directory or file)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Working directory for init and mcp (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version
  --schema                Output machine-readable CLI schema JSON

  --stats                 Emit JSON stats to stderr (or include in --output json)
  --log <path>            Write structured JSONL log to file
  --tools <level>         Tool level: core (default), standard, full
  --max-cost <n>          Maximum USD spend per run
  --max-tokens <n>        Maximum total tokens per run
  --max-depth <n>         Maximum recursive rlm_query depth
  --model <ref>           Model for this run: "provider/model" or a bare model id
  --ext <list>            File extensions for context dirs (comma-separated)
  --thinking <level>      Thinking level: minimal, low, medium, high (Gemini 3)
  --temperature <n>       Sampling temperature, 0-2 (default: unset, provider decides)
  --cache                 Enable cache mode (full context in system prompt for provider caching)
  --no-session            Disable auto-save of session data
  --estimate              Show context size and cost estimate without caching (cache command)
  --parallel <n>          Concurrent questions for batch command (default: 1)
  --batch-api             Use Gemini Batch API for 50% cost reduction (batch command)

Config:
  .mikro/                   Config directory (run "mikro init" to create)
    mikro.yaml              Config (model, budget, context, storage, etc.)
    SYSTEM.md              System prompt
    CRITERIA.md            Output criteria
    TOOLS.md               Custom Python tools

Examples:
  mikro "How does IPC work?" --context ./docs/
  mikro "Summarize this" --context paper.md --output json --stats
  mikro "Analyze code" --context ./src/ --tools full --ext .ts,.js
  mikro "Quick question" --max-cost 0.10 --max-tokens 5000
  mikro init --template code --dir ./my-project
  echo "data" | mikro "Analyze this" --log run.jsonl
  mikro cache --context ./docs/ --estimate
  mikro cache --context ./docs/
  mikro batch questions.txt --context ./docs/ --cache --max-cost 1.00
  mikro batch questions.txt --context ./src/ --max-iterations 3

  mikro config set GEMINI_API_KEY <key>   Set API key
  mikro config set model.provider google  Set default provider
  mikro config get model.provider         Get a setting
  mikro config list                       Show all settings
  mikro config delete <key>               Remove a setting
  mikro config path                       Show settings file path
`;

interface CliOptions {
  query: string | null;
  command: "query" | "init" | "help" | "version" | "schema" | "cache" | "batch" | "config" | "benchmark" | "stats" | "doctor" | "update" | "migrate" | "acp" | "mcp";
  context: string | null;
  output: "text" | "json" | "stream";
  verbose: boolean;
  maxIterations: number;
  timeout: number;
  dir: string;
  stats: boolean;
  log: string | null;
  tools: ToolsLevel | null;
  maxCost: number | null;
  maxTokens: number | null;
  maxDepth: number | null;
  model: string | null;
  ext: string[] | null;
  thinking: ThinkingLevel | null;
  /** Parsed `--temperature`. `null` means the flag was not given. */
  temperature: number | null;
  cache: boolean;
  estimate: boolean;
  batchFile: string | null;
  parallel: number;
  batchApi: boolean;
  noSession: boolean;
  template: string;
}

function parseCliArgs(args: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args,
    options: {
      context: { type: "string" },
      output: { type: "string", default: "text" },
      verbose: { type: "boolean", default: false },
      "max-iterations": { type: "string", default: "30" },
      timeout: { type: "string", default: "300000" },
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      schema: { type: "boolean", default: false },
      stats: { type: "boolean", default: false },
      log: { type: "string" },
      tools: { type: "string" },
      "max-cost": { type: "string" },
      "max-tokens": { type: "string" },
      "max-depth": { type: "string" },
      model: { type: "string" },
      ext: { type: "string" },
      thinking: { type: "string" },
      temperature: { type: "string" },
      cache: { type: "boolean", default: false },
      estimate: { type: "boolean", default: false },
      parallel: { type: "string", default: "1" },
      "batch-api": { type: "boolean", default: false },
      "no-session": { type: "boolean", default: false },
      template: { type: "string", default: "default" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.schema) {
    return {
      query: null, command: "schema", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, model: null, ext: null, thinking: null, temperature: null, cache: false, estimate: false,
      batchFile: null, parallel: 1, batchApi: false, noSession: false, template: "default",
    };
  }

  if (values.help) {
    return {
      query: null, command: "help", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, model: null, ext: null, thinking: null, temperature: null, cache: false, estimate: false,
      batchFile: null, parallel: 1, batchApi: false, noSession: false, template: "default",
    };
  }

  if (values.version) {
    return {
      query: null, command: "version", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, model: null, ext: null, thinking: null, temperature: null, cache: false, estimate: false,
      batchFile: null, parallel: 1, batchApi: false, noSession: false, template: "default",
    };
  }

  const command = positionals[0] === "init" ? "init"
    : positionals[0] === "cache" ? "cache"
    : positionals[0] === "batch" ? "batch"
    : positionals[0] === "config" ? "config"
    : positionals[0] === "benchmark" ? "benchmark"
    : positionals[0] === "stats" ? "stats"
    : positionals[0] === "doctor" ? "doctor"
    : positionals[0] === "update" ? "update"
    : positionals[0] === "migrate" || positionals[0] === "upgrade" ? "migrate"
    : positionals[0] === "acp" ? "acp"
    : positionals[0] === "mcp" ? "mcp"
    : "query";
  const query = command === "query" ? positionals[0] ?? null : null;
  const batchFile = command === "batch" ? positionals[1] ?? null : null;
  const dir = (values.dir as string) || process.cwd();

  const outputMode = values.output as string;
  if (outputMode && !["text", "json", "stream"].includes(outputMode)) {
    console.error(`Error: --output must be text, json, or stream (got "${outputMode}")`);
    process.exit(1);
  }

  // Validate --tools
  const toolsRaw = values.tools as string | undefined;
  if (toolsRaw && !["core", "standard", "full"].includes(toolsRaw)) {
    console.error(`Error: --tools must be core, standard, or full (got "${toolsRaw}")`);
    process.exit(1);
  }

  // Validate --thinking
  const thinkingRaw = values.thinking as string | undefined;
  if (thinkingRaw && !isValidThinkingLevel(thinkingRaw)) {
    console.error(`Error: --thinking must be minimal, low, medium, or high (got "${thinkingRaw}")`);
    process.exit(1);
  }

  // Validate --temperature. `parseArgs` hands string-typed flags back as
  // strings, so this parses before range-checking; `parseTemperatureFlag`
  // rejects NaN/Infinity too, which a bare `<`/`>` pair would wave through.
  let temperature: number | null = null;
  try {
    temperature = parseTemperatureFlag(values.temperature as string | undefined);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Parse --ext
  const extRaw = values.ext as string | undefined;
  const ext = extRaw
    ? extRaw.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`))
    : null;

  return {
    query,
    command,
    context: (values.context as string) || null,
    output: (outputMode as "text" | "json" | "stream") || "text",
    verbose: values.verbose as boolean,
    maxIterations: parseInt(values["max-iterations"] as string, 10) || 30,
    timeout: parseInt(values.timeout as string, 10) || 300000,
    dir: resolve(dir),
    stats: values.stats as boolean,
    log: (values.log as string) || null,
    tools: (toolsRaw as ToolsLevel) || null,
    maxCost: values["max-cost"] ? parseFloat(values["max-cost"] as string) : null,
    maxTokens: values["max-tokens"] ? parseInt(values["max-tokens"] as string, 10) : null,
    maxDepth: values["max-depth"] ? parseInt(values["max-depth"] as string, 10) : null,
    model: (values.model as string) || null,
    ext,
    thinking: (thinkingRaw as ThinkingLevel) || null,
    temperature,
    cache: values.cache as boolean,
    estimate: values.estimate as boolean,
    batchFile,
    parallel: parseInt(values.parallel as string, 10) || 1,
    batchApi: values["batch-api"] as boolean,
    noSession: values["no-session"] as boolean,
    template: (values.template as string) || "default",
  };
}

async function runInit(dir: string, template: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    const created = await scaffold(dir, template);
    if (created.length === 0) {
      console.log("Config already exists in", dir);
    } else {
      console.log(`Created ${created.join(", ")} in .mikro/ (${dir})`);
    }
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runQuery(opts: CliOptions): Promise<void> {
  const configDir = process.cwd();
  const startTime = Date.now();

  // Check Python version at startup
  try {
    const pyVersion = await checkPythonVersion();
    if (!pyVersion.valid) {
      console.error(
        `Error: mikro requires Python 3.10+, found ${pyVersion.version}.\n` +
        `Please upgrade Python and try again.`
      );
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Auto-scaffold on first run
  if (await needsScaffold(configDir)) {
    if (opts.verbose) {
      console.error("mikro: auto-scaffolding config files...");
    }
    const created = await scaffold(configDir, "default");
    if (opts.verbose && created.length > 0) {
      console.error(`  Created: ${created.join(", ")}`);
    }
  }

  // Load config
  const config = await loadConfig(configDir);
  applySettingsModelOverrides(config);

  // --model outranks settings.json and mikro.yaml. This is also how a parent
  // pins a recursive child: buildRlmChildArgs emits --model on the child argv,
  // so rlm_query() no longer depends on the child re-deriving a model from
  // whatever config happens to sit at its cwd or in its inherited HOME.
  if (opts.model) {
    config.model = applyModelRef(config.model, opts.model);
  }

  // Apply CLI overrides to config
  if (opts.thinking) {
    config.gemini.thinkingLevel = opts.thinking;
  }
  // `--temperature` outranks both `agent.yaml` and mikro.yaml's top-level
  // `temperature:`. Routed through the shared helper so the `!= null` guard —
  // the one that keeps `--temperature 0` from being dropped as falsy — has a
  // single definition rather than a copy per surface.
  applyTemperatureOverride(config, opts.temperature);
  if (opts.cache) {
    config.cache.enabled = true;
  }
  if (opts.tools) {
    config.toolsLevel = opts.tools;
  }

  // Warn about future flags
  const futureWarnings = checkFutureFlags(config.gemini);
  for (const w of futureWarnings) {
    console.error(`mikro: ${w}`);
  }

  if (opts.maxCost !== null) {
    config.budget.maxCost = opts.maxCost;
  }
  if (opts.maxTokens !== null) {
    config.budget.maxTokens = opts.maxTokens;
  }
  if (opts.maxDepth !== null) {
    config.budget.maxDepth = opts.maxDepth;
  }

  // Set up logger
  const logger = createLogger(opts.log ?? undefined);
  logger.runStart({
    query: opts.query ?? "(stdin)",
    model: formatModelRef(config.model.provider, config.model.model),
    tools_level: config.toolsLevel,
    context_type: opts.context ? "path" : "none",
  });

  // Load context if provided, with extension overrides
  let context = null;
  if (opts.context) {
    const contextPath = resolve(opts.context);
    const contextOpts = opts.ext
      ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
      : config.contextConfig
        ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
        : undefined;
    context = await loadContext(contextPath, contextOpts);
    if (opts.verbose) {
      console.error(`mikro: loaded context — ${context.metadata}`);
    }
  }

  // Validate context size and auto-adjust cache/storage modes
  let storageMode = false;
  if (context) {
    const validation = validateContextSize(context, config.model.provider);
    if (!validation.valid) {
      // Context exceeds model limit — disable cache mode if it was enabled
      if (opts.cache || config.cache.enabled) {
        console.error(
          `mikro: context exceeds model limit (~${validation.estimatedTokens.toLocaleString()} tokens > ${validation.limit.toLocaleString()}), disabling cache mode`
        );
        opts.cache = false;
        config.cache.enabled = false;
      }
      // Signal storage mode when enabled is 'auto' or 'always'
      if (config.storage.enabled === "auto" || config.storage.enabled === "always") {
        storageMode = true;
        console.error(
          `mikro: storage mode activated for large context (~${validation.estimatedTokens.toLocaleString()} tokens)`
        );
      }
    }
  }
  // Force storage mode when explicitly set to 'always'
  if (config.storage.enabled === "always" && !storageMode) {
    storageMode = true;
    if (opts.verbose) {
      console.error("mikro: storage mode forced (storage.enabled: always)");
    }
  }

  // Startup preparation is complete; stdin/model work must not own the
  // installation mutex for the lifetime of a query.
  signalCliReady();

  // Read query from stdin if not provided as argument
  let query = opts.query;
  if (!query && !process.stdin.isTTY) {
    const stdinCtx = await loadContextFromStdin();
    query = stdinCtx.content as string;
  }

  if (!query) {
    console.error("Error: no query provided");
    process.exit(1);
  }

  // Run RLM loop
  const result = await rlmLoop(query, context, config, {
    maxIterations: opts.maxIterations,
    timeout: opts.timeout,
    verbose: opts.verbose,
    output: opts.output,
    cache: opts.cache,
    storageMode,
    logger,
  });

  const timeMs = Date.now() - startTime;

  // Log run end
  logger.runEnd({
    iterations: result.iterations,
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    total_cost: result.usage.totalCost,
    time_ms: timeMs,
    budget_hit: result.budgetHit ?? null,
    answer_length: result.answer.length,
  });
  logger.close();

  // Build stats if requested
  if (opts.stats) {
    const stats = buildStats(result, {
      time_ms: timeMs,
      tools_level: config.toolsLevel,
      budget_hit: result.budgetHit,
      run_id: logger.runId,
      cache_enabled: opts.cache,
      thinking_level: config.gemini.thinkingLevel ?? undefined,
      gemini_batteries_used: result.geminiBatteriesUsed,
      thought_signatures_circulated: result.geminiCounts?.thoughtSignatures,
      web_search_calls: result.geminiCounts?.webSearch,
      fetch_url_calls: result.geminiCounts?.fetchUrl,
      code_executions_server_side: result.geminiCounts?.codeExecutionsServerSide,
      image_generations: result.geminiCounts?.generateImage,
    });
    // For JSON output, stats are included in the response
    if (opts.output === "json") {
      outputResult(result, opts.output, stats);
    } else {
      outputResult(result, opts.output);
      emitStats(stats);
    }
  } else {
    outputResult(result, opts.output);
  }

  // Save session (unless --no-session)
  if (!opts.noSession) {
    try {
      const { saveSession } = await import("./session.js");
      await saveSession({
        runId: logger.runId,
        query: opts.query ?? "(stdin)",
        contextPath: opts.context,
        model: formatModelRef(config.model.provider, config.model.model),
        answer: result.answer,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedTokens: result.usage.cacheReadTokens,
          totalCost: result.usage.totalCost,
          iterations: result.iterations,
          timeMs: timeMs,
          model: formatModelRef(config.model.provider, config.model.model),
        },
        config: config as unknown as Record<string, unknown>,
        logPath: opts.log,
      });
    } catch (err: unknown) {
      console.error(`mikro: session save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Exit with non-zero code on empty response abort (issue #14)
  if (result.budgetHit === EMPTY_RESPONSES_BUDGET_HIT) {
    process.exit(1);
  }
}

// Rough cost estimate per 1M input tokens by provider (USD)
const COST_PER_1M_INPUT: Record<string, number> = {
  anthropic: 3.0,    // Claude Sonnet ~$3/M input
  openai: 2.5,       // GPT-4o ~$2.50/M input
  google: 0.075,     // Gemini 2.0 Flash — very cheap
  "amazon-bedrock": 3.0,
};

async function runCache(opts: CliOptions): Promise<void> {
  if (!opts.context) {
    console.error("Error: --context is required for the cache command.");
    console.error("Usage: mikro cache --context <path> [--estimate]");
    process.exit(1);
  }

  // Load config
  const configDir = process.cwd();
  const config = await loadConfig(configDir);
  applySettingsModelOverrides(config);

  // Apply CLI overrides
  if (opts.tools) {
    config.toolsLevel = opts.tools;
  }

  const provider = config.model.provider;
  const model = config.model.model;

  // Load context
  const contextPath = resolve(opts.context);
  const contextOpts = opts.ext
    ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
    : config.contextConfig
      ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
      : undefined;
  const context = await loadContext(contextPath, contextOpts);

  // Validate context size
  const validation = validateContextSize(context, provider);

  if (!validation.valid) {
    console.error(`Error: ${validation.message}`);
    process.exit(1);
  }

  // Estimate cost
  const costPer1M = COST_PER_1M_INPUT[provider] ?? 3.0;
  const estimatedCost = (validation.estimatedTokens / 1_000_000) * costPer1M;
  const ttl = config.cache.ttl ?? (config.cache.retention === "long" ? 3600 : 300);

  if (opts.estimate) {
    // Print stats and exit — no actual caching
    console.log("mikro cache estimate");
    console.log("---");
    console.log(`  context:          ${opts.context}`);
    console.log(`  metadata:         ${context.metadata}`);
    console.log(`  estimated tokens: ${validation.estimatedTokens.toLocaleString()}`);
    console.log(`  provider limit:   ${validation.limit.toLocaleString()} tokens`);
    console.log(`  utilization:      ${((validation.estimatedTokens / validation.limit) * 100).toFixed(1)}%`);
    console.log(`  provider:         ${provider}`);
    console.log(`  model:            ${model}`);
    console.log(`  ttl:              ${ttl}s`);
    console.log(`  estimated cost:   $${estimatedCost.toFixed(4)}`);
    return;
  }

  // Warmup: run a minimal rlmLoop with cache enabled
  console.error(`mikro: warming cache for ${opts.context} (~${validation.estimatedTokens.toLocaleString()} tokens)`);

  config.cache.enabled = true;
  signalCliReady();

  try {
    await rlmLoop("warmup", context, config, {
      maxIterations: 1,
      timeout: opts.timeout,
      verbose: opts.verbose,
      output: "text",
      cache: true,
    });
  } catch {
    // Warmup may produce a minimal/empty result — that's OK
    // The goal is just to prime the provider's cache
  }

  console.error("mikro: cache warmup complete");
  console.error(`  provider:         ${provider}`);
  console.error(`  model:            ${model}`);
  console.error(`  estimated tokens: ${validation.estimatedTokens.toLocaleString()}`);
  console.error(`  ttl:              ${ttl}s`);
  console.error(`  estimated cost:   $${estimatedCost.toFixed(4)}`);
}

async function runBatchCommand(opts: CliOptions): Promise<void> {
  if (!opts.batchFile) {
    console.error("Error: batch command requires a questions file path.");
    console.error("Usage: mikro batch <questions.txt> [--context <path>] [--max-cost <n>]");
    process.exit(1);
  }

  const configDir = process.cwd();

  // Load config
  const config = await loadConfig(configDir);
  applySettingsModelOverrides(config);

  // Apply CLI overrides to config
  config.cache.enabled = true; // batch always uses cache
  if (opts.tools) {
    config.toolsLevel = opts.tools;
  }
  if (opts.maxCost !== null) {
    config.budget.maxCost = opts.maxCost;
  }
  if (opts.maxTokens !== null) {
    config.budget.maxTokens = opts.maxTokens;
  }
  if (opts.maxDepth !== null) {
    config.budget.maxDepth = opts.maxDepth;
  }

  // Load context if provided
  let context = null;
  if (opts.context) {
    const contextPath = resolve(opts.context);
    const contextOpts = opts.ext
      ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
      : config.contextConfig
        ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
        : undefined;
    context = await loadContext(contextPath, contextOpts);
    if (opts.verbose) {
      console.error(`mikro batch: loaded context — ${context.metadata}`);
    }
  }

  // Validate context size and auto-adjust cache/storage mode for batch
  let batchCache = true;
  let batchStorageMode = false;
  if (context) {
    const validation = validateContextSize(context, config.model.provider);
    if (!validation.valid) {
      console.error(
        `mikro: context exceeds model limit (~${validation.estimatedTokens.toLocaleString()} tokens > ${validation.limit.toLocaleString()}), disabling cache mode`
      );
      batchCache = false;
      config.cache.enabled = false;
      if (config.storage.enabled === "auto" || config.storage.enabled === "always") {
        batchStorageMode = true;
        console.error(
          `mikro: storage mode activated for batch (~${validation.estimatedTokens.toLocaleString()} tokens)`
        );
      }
    }
  }
  // Force storage mode when explicitly set to 'always'
  if (config.storage.enabled === "always" && !batchStorageMode) {
    batchStorageMode = true;
  }

  if (opts.verbose) {
    console.error(`mikro batch: processing ${opts.batchFile}`);
  }

  signalCliReady();
  await runBatch(resolve(opts.batchFile), context, config, {
    maxIterations: opts.maxIterations,
    timeout: opts.timeout,
    verbose: opts.verbose,
    cache: batchCache,
    storageMode: batchStorageMode,
    maxCost: opts.maxCost ?? undefined,
    parallel: opts.parallel,
  });
}

const CONFIG_HELP = `mikro config — manage global settings

Usage:
  mikro config set <key> <value>   Set a setting
  mikro config get <key>           Get a setting value
  mikro config list                Show all settings (API keys masked)
  mikro config delete <key>        Remove a setting
  mikro config path                Show settings file path

Keys:
  API keys:    GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, ...
  Model:       model.provider, model.model, model.sub_call_model
  Budget:      budget.max_cost, budget.max_tokens, budget.max_depth
  Gemini:      gemini.thinking_level, gemini.google_search, gemini.code_execution
  General:     tools_level, cache.retention

Settings file: ~/.mikro/settings.json
`;

async function runConfig(args: string[]): Promise<void> {
  const action = args[0];
  const key = args[1];
  const value = args.slice(2).join(" ");

  switch (action) {
    case "set": {
      if (!key || !value) {
        console.error("Usage: mikro config set <key> <value>");
        process.exit(1);
      }
      const settings = await loadSettings();
      settings[key] = parseSettingValue(value);
      await saveSettings(settings);
      console.log(`Set ${key} = ${formatValue(key, settings[key])}`);
      break;
    }

    case "get": {
      if (!key) {
        console.error("Usage: mikro config get <key>");
        process.exit(1);
      }
      const settings = await loadSettings();
      if (!(key in settings)) {
        console.error(`Key "${key}" not found in settings.`);
        process.exit(1);
      }
      console.log(formatValue(key, settings[key]));
      break;
    }

    case "list": {
      const settings = await loadSettings();
      const keys = Object.keys(settings);
      if (keys.length === 0) {
        console.log("No settings configured. Use: mikro config set <key> <value>");
        return;
      }
      for (const k of keys) {
        console.log(`${k} = ${formatValue(k, settings[k])}`);
      }
      break;
    }

    case "delete": {
      if (!key) {
        console.error("Usage: mikro config delete <key>");
        process.exit(1);
      }
      const settings = await loadSettings();
      if (!(key in settings)) {
        console.error(`Key "${key}" not found in settings.`);
        process.exit(1);
      }
      delete settings[key];
      await saveSettings(settings);
      console.log(`Deleted ${key}`);
      break;
    }

    case "path":
      console.log(getSettingsPath());
      break;

    default:
      console.log(CONFIG_HELP);
      break;
  }
}

async function runBenchmarkCommand(opts: CliOptions, args: string[]): Promise<void> {
  const mode = args[0];
  const configDir = process.cwd();
  const config = await loadConfig(configDir);
  applySettingsModelOverrides(config);

  if (opts.tools) config.toolsLevel = opts.tools;

  if (mode === "cost") {
    const { runCostBenchmark, formatBenchmarkTable, saveBenchmarkResults } = await import("./benchmark.js");
    const outputIdx = args.indexOf("--output");
    const outputFormat = outputIdx >= 0 && args[outputIdx + 1] === "json" ? "json" as const : "table" as const;
    signalCliReady();
    const results = await runCostBenchmark(config, { outputFormat });
    if (outputFormat === "json") {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.error(formatBenchmarkTable(results));
    }
    const savedPath = await saveBenchmarkResults(results);
    console.error(`Results saved to ${savedPath}`);
  } else if (mode === "oolong") {
    const samplesIdx = args.indexOf("--samples");
    const samples = samplesIdx >= 0 ? parseInt(args[samplesIdx + 1], 10) : 5;
    const idxArgIdx = args.indexOf("--idx");
    const idx = idxArgIdx >= 0 ? parseInt(args[idxArgIdx + 1], 10) : undefined;

    const { runOolongBenchmark, formatBenchmarkTable, saveBenchmarkResults } = await import("./benchmark.js");
    signalCliReady();
    const results = await runOolongBenchmark(config, { samples, idx });
    console.error(formatBenchmarkTable(results));
    const savedPath = await saveBenchmarkResults(results);
    console.error(`Results saved to ${savedPath}`);
  } else {
    console.log(`mikro benchmark — compare RLM vs direct LLM\n\nUsage:\n  mikro benchmark cost                     Run cost benchmark with built-in dataset\n  mikro benchmark cost --output json       Output results as JSON\n  mikro benchmark oolong                   Run Oolong Synth (auto-installs HF datasets)\n  mikro benchmark oolong --samples 5       Run N samples (default 5)\n  mikro benchmark oolong --idx 42          Run specific sample by index`);
  }
}

/**
 * mikro doctor — report health of providers and config.
 *
 * Exit codes:
 *   0 = all nominal
 *   1 = at least one provider API key is missing (warning)
 */
async function runDoctor(): Promise<void> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  // dist/src/cli.js → ../../package.json
  const pkg = require("../../package.json") as { version: string };

  // Load config from cwd (falls back to defaults if no .mikro/mikro.yaml)
  const configDir = process.cwd();
  const config = await loadConfig(configDir);
  applySettingsModelOverrides(config);

  // Settings file presence
  const settingsPath = getSettingsPath();
  const { access } = await import("node:fs/promises");
  let settingsExists = false;
  try {
    await access(settingsPath);
    settingsExists = true;
  } catch {
    // missing
  }

  // Active template — inferred from whether .mikro exists; we report the default
  // the user selects at init (wish scope: print template only when determinable).
  // With no easy on-disk marker, we just show "default" as the library default.
  const activeTemplate = config.configSource === "yaml" ? "(from mikro.yaml)" : "default";

  // Provider key status — mirrors settings.ENV_KEY_MAP
  const providerKeys: { label: string; envVar: string }[] = [
    { label: "google   ", envVar: "GEMINI_API_KEY" },
    { label: "openai   ", envVar: "OPENAI_API_KEY" },
    { label: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    { label: "groq     ", envVar: "GROQ_API_KEY" },
    { label: "xai      ", envVar: "XAI_API_KEY" },
    { label: "openrouter", envVar: "OPENROUTER_API_KEY" },
  ];

  let anyKeyMissing = false;
  for (const { envVar } of providerKeys) {
    if (!process.env[envVar]) anyKeyMissing = true;
  }

  // Config-declared providers (mikro.yaml / settings.json `providers`) — the
  // whole point of listing them here is that a `<id>/<model>` pin which
  // fails as "unknown model" is diagnosable from this screen alone.
  const customProviders = config.providers;
  const configuredModelProblem = checkModelConfig(config.model);

  // ─── Output ────────────────────────────────────────────
  console.log(`mikro ${pkg.version}`);
  console.log(`node: ${process.version}`);
  console.log("");

  console.log("LLM providers:");
  for (const { label, envVar } of providerKeys) {
    const set = Boolean(process.env[envVar]);
    console.log(`  ${label} : ${envVar} set (${set ? "yes" : "no"})`);
  }
  console.log("");

  console.log("Config-declared providers:");
  if (customProviders.length === 0) {
    console.log("  (none — declare under providers: in .mikro/mikro.yaml or ~/.mikro/settings.json)");
  }
  for (const p of customProviders) {
    const source = customProviderKeySource(p);
    const keyText =
      p.apiKeyEnv.length === 0
        ? "keyless"
        : source
          ? `${source} set (yes)`
          : `${p.apiKeyEnv.join("|")} set (no)`;
    const modelIds = p.models.map((m) => m.id);
    console.log(`  ${p.id} : ${p.api} @ ${p.baseUrl} · key ${keyText}`);
    console.log(`    models : ${modelIds.length ? modelIds.join(", ") : "(none declared)"}`);
  }
  console.log("");

  console.log("Configured model:");
  console.log(`  ${config.model.provider}/${config.model.model} : ${configuredModelProblem ? `UNRESOLVABLE — ${configuredModelProblem}` : "resolves"}`);
  console.log("");

  console.log("Config:");
  console.log(`  ${settingsPath} (${settingsExists ? "exists" : "missing"})`);
  console.log(`  Active template: ${activeTemplate}`);

  // ─── Exit code ────────────────────────────────────────
  // Exit 1 — at least one provider API key missing (warning)
  if (anyKeyMissing) {
    process.exit(1);
  }

  // Exit 0 — nominal
}

/**
 * `mikro migrate [--apply] [--root <dir>]... [--depth <n>] [--json]`
 *
 * Dry-run prints the plan; `--apply` performs it. See src/migrate.ts for the
 * artifact types covered and why the scan is bounded rather than machine-wide.
 */
async function runMigrate(args: string[]): Promise<void> {
  const { scanLegacy, applyPlan, formatPlan } = await import("./migrate.js");
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const rc = args.includes("--rc");
  const roots: string[] = [];
  const exclude: string[] = [];
  let maxDepth: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) roots.push(args[++i]);
    else if (args[i] === "--exclude" && args[i + 1]) exclude.push(args[++i]);
    else if (args[i] === "--depth" && args[i + 1]) maxDepth = Number(args[++i]);
  }
  const plan = await scanLegacy({
    roots: roots.length ? [...roots, process.cwd(), homedir()] : undefined,
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : undefined,
    exclude,
    rewriteRc: rc,
  });
  if (json) {
    console.log(JSON.stringify({ roots: plan.roots, actions: plan.actions.map(({ kind, path, detail, reportOnly }) => ({ kind, path, detail, reportOnly: Boolean(reportOnly) })) }, null, 2));
  } else {
    console.log(formatPlan(plan));
  }
  const writable = plan.actions.filter((a) => a.apply).length;
  if (!apply) {
    if (writable > 0) console.log(`\n${writable} change${writable === 1 ? "" : "s"} pending — re-run with --apply to perform them.`);
    return;
  }
  const done = await applyPlan(plan);
  console.log(`\napplied ${done.length} change${done.length === 1 ? "" : "s"}.`);
  if (done.some((a) => a.kind === "rewrite-claude-plugin")) {
    console.log("Claude Code plugin registration rewritten — restart Claude Code (or /reload-plugins) to pick it up.");
  }
}

/**
 * Installs made before bin/mikro.mjs existed symlink `~/.local/bin/mikro`
 * straight at `dist/src/cli.js`, which cannot start without node_modules. If
 * the symlink points into *this* checkout's dist, move it to the launcher so
 * the self-heal applies without re-running scripts/install.sh.
 */
async function repointLauncher(root: string): Promise<void> {
  const { lstat, readlink, symlink, unlink } = await import("node:fs/promises");
  const { join, resolve: resolvePath } = await import("node:path");
  const link = process.env.MIKRO_BIN_DIR ? join(process.env.MIKRO_BIN_DIR, "mikro") : join(homedir(), ".local", "bin", "mikro");
  const launcher = join(root, "bin", "mikro.mjs");
  try {
    if (!(await lstat(link)).isSymbolicLink()) return;
    const target = resolvePath(join(link, ".."), await readlink(link));
    if (target !== resolvePath(join(root, "dist", "src", "cli.js"))) return;
    await unlink(link);
    await symlink(launcher, link);
    console.log(`launcher: ${link} → ${launcher}`);
  } catch {
    // No symlink, or not ours — leave it alone.
  }
}

async function runUpdate(args: string[]): Promise<void> {
  const force = args.includes("--force") || args.includes("-f");
  const { dirname, resolve: resolvePath } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { runManaged } = await import(pathToFileURL(join(root, "bin", "install-state.mjs")).href);
  const status = await runManaged(root, "update", force ? ["--force"] : []);
  if (status !== 0) throw Object.assign(new Error("mikro update failed"), { exitCode: status });
  await repointLauncher(root);
}

// The launcher holds install ownership through startup, not command lifetime.
// Updates delegate ownership to their mutation worker instead.
export let installOperation = false;
let signalCliReady: () => void;
export const cliReady = new Promise<void>((resolveReady) => { signalCliReady = resolveReady; });
async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  installOperation = opts.command === "update";

  // Load global settings and inject API keys before any command
  const globalSettings = await loadSettings();
  _globalSettings = globalSettings;
  injectApiKeysToEnv(globalSettings);

  switch (opts.command) {
    case "help":
      console.log(HELP);
      break;

    case "version": {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      // dist/src/cli.js → ../../package.json
      const pkg = require("../../package.json");
      console.log(`mikro v${pkg.version}`);
      break;
    }

    case "schema":
      printMikroCliSchema();
      break;

    case "init":
      await runInit(opts.dir, opts.template);
      break;

    case "cache":
      await runCache(opts);
      break;

    case "batch":
      await runBatchCommand(opts);
      break;

    case "config":
      await runConfig(process.argv.slice(3));
      break;

    case "benchmark":
      await runBenchmarkCommand(opts, process.argv.slice(3));
      break;

    case "stats": {
      const { runStatsCommand } = await import("./stats.js");
      await runStatsCommand(process.argv.slice(3));
      break;
    }

    case "doctor":
      await runDoctor();
      break;

    case "update":
      await runUpdate(process.argv.slice(3));
      break;

    case "migrate":
      await runMigrate(process.argv.slice(3));
      break;

    case "acp": {
      const { runAcp } = await import("./acp/agent.js");
      // runAcp sets up stdio synchronously before waiting for disconnect.
      const running = runAcp();
      signalCliReady();
      await running;
      break;
    }

    case "mcp": {
      // `--dir` is the server's cwd contract. An MCP host spawns the server
      // from its own directory, and agent discovery, loadConfig, relative
      // `context` arguments and the REPL cwd must all agree on one root —
      // so chdir once, up front, and let every downstream default follow.
      const target = resolve(opts.dir);
      const { existsSync, statSync } = await import("node:fs");
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        console.error(`Error: --dir must be an existing directory (got "${opts.dir}")`);
        process.exit(1);
      }
      process.chdir(target);
      const { runMcp } = await import("./mcp/server.js");
      await runMcp();
      break;
    }

    case "query":
      if (!opts.query && process.stdin.isTTY) {
        console.log(HELP);
        process.exit(1);
      }
      await runQuery(opts);
      break;
  }
}

void main().then(signalCliReady!).catch((err) => {
  console.error("mikro error:", err.message);
  process.exit(err.exitCode ?? 1);
});
