export interface CliFlagSchema {
  name: string;
  aliases?: string[];
  type: "boolean" | "string" | "number" | "list";
  default?: string | number | boolean | string[] | null;
  choices?: string[];
  description: string;
  appliesTo?: string[];
}

export interface ExitCodeSchema {
  code: number;
  meaning: string;
}

export interface JsonSchema {
  $schema?: string;
  type: string;
  description?: string;
  required?: string[];
  properties: Record<string, unknown>;
  additionalProperties?: boolean;
}

export interface MikroCliSchema {
  schemaVersion: 1;
  command: "mikro";
  flags: CliFlagSchema[];
  output: JsonSchema;
  exitCodes: ExitCodeSchema[];
}

export const MIKRO_CLI_SCHEMA: MikroCliSchema = {
  schemaVersion: 1,
  command: "mikro",
  flags: [
    {
      name: "--schema",
      type: "boolean",
      default: false,
      description: "Print this machine-readable CLI schema as JSON and exit.",
    },
    {
      name: "--context",
      type: "string",
      default: null,
      description: "Path to context directory or file loaded for a query, cache warmup, or batch run.",
      appliesTo: ["query", "cache", "batch"],
    },
    {
      name: "--output",
      type: "string",
      default: "text",
      choices: ["text", "json", "stream"],
      description: "Output mode. json emits a single JSON object; stream emits JSONL iteration/final events.",
      appliesTo: ["query"],
    },
    {
      name: "--verbose",
      type: "boolean",
      default: false,
      description: "Show iteration progress and diagnostic messages on stderr.",
    },
    {
      name: "--max-iterations",
      type: "number",
      default: 30,
      description: "Maximum RLM iterations for query or batch runs.",
      appliesTo: ["query", "batch"],
    },
    {
      name: "--timeout",
      type: "number",
      default: 300000,
      description: "Timeout in milliseconds for query, cache, or batch execution.",
    },
    {
      name: "--dir",
      type: "string",
      default: "current working directory",
      description: "Directory for initialization or config discovery; Juice loads its explicit project binding here.",
      appliesTo: ["init", "juice provision", "juice catalog", "juice usage", "juice analyze"],
    },
    {
      name: "--help",
      aliases: ["-h"],
      type: "boolean",
      default: false,
      description: "Show help text and exit.",
    },
    {
      name: "--version",
      aliases: ["-v"],
      type: "boolean",
      default: false,
      description: "Show mikro version and exit.",
    },
    {
      name: "--stats",
      type: "boolean",
      default: false,
      description: "Emit JSON stats to stderr, or include stats in --output json responses.",
      appliesTo: ["query"],
    },
    {
      name: "--log",
      type: "string",
      default: null,
      description: "Write structured JSONL run logs to the given path.",
      appliesTo: ["query"],
    },
    {
      name: "--tools",
      type: "string",
      default: null,
      choices: ["core", "standard", "full"],
      description: "Tool level exposed to the RLM runtime.",
      appliesTo: ["query", "cache", "batch", "benchmark"],
    },
    {
      name: "--max-cost",
      type: "number",
      default: null,
      description: "Maximum USD spend per run.",
      appliesTo: ["query", "batch"],
    },
    {
      name: "--max-tokens",
      type: "number",
      default: null,
      description: "Maximum total tokens per run.",
      appliesTo: ["query", "batch"],
    },
    {
      name: "--max-depth",
      type: "number",
      default: null,
      description: "Maximum recursive rlm_query depth.",
      appliesTo: ["query", "batch"],
    },
    {
      name: "--model",
      type: "string",
      default: null,
      description:
        'Query model: "provider/model", or a bare id; overrides config and recursive children. Manual JEV requires an explicit version or documented alias.',
      appliesTo: ["query", "jev"],
    },
    {
      name: "--ext",
      type: "list",
      default: null,
      description: "Comma-separated file extensions for context directories.",
      appliesTo: ["query", "cache", "batch"],
    },
    {
      name: "--thinking",
      type: "string",
      default: null,
      choices: ["minimal", "low", "medium", "high"],
      description: "Gemini 3 thinking level override.",
      appliesTo: ["query"],
    },
    {
      name: "--temperature",
      type: "number",
      default: null,
      description:
        "Sampling temperature, 0-2. Outranks agent.yaml and mikro.yaml's top-level `temperature:`. Unset sends no temperature at all, leaving the provider's own behaviour in place. Best-effort: pi/ai sends it on every api family and drops it only on the `anthropic-messages` api — when a reasoning level is set, or when the model declares `compat.supportsTemperature: false`. Claude reached via OpenRouter or Bedrock is not subject to that guard.",
      appliesTo: ["query"],
    },
    {
      name: "--cache",
      type: "boolean",
      default: false,
      description: "Enable cache mode, injecting full context into the system prompt for provider caching.",
      appliesTo: ["query", "batch"],
    },
    {
      name: "--no-session",
      type: "boolean",
      default: false,
      description: "Disable automatic session persistence after query runs.",
      appliesTo: ["query"],
    },
    {
      name: "--estimate",
      type: "boolean",
      default: false,
      description: "Estimate context size and cost without warming cache.",
      appliesTo: ["cache"],
    },
    {
      name: "--parallel",
      type: "number",
      default: 1,
      description: "Number of concurrent questions for the batch command.",
      appliesTo: ["batch"],
    },
    {
      name: "--batch-api",
      type: "boolean",
      default: false,
      description: "Use Gemini Batch API for batch runs where available.",
      appliesTo: ["batch"],
    },
    {
      name: "--template",
      type: "string",
      default: "default",
      choices: ["default", "code"],
      description: "Template used by the init command.",
      appliesTo: ["init"],
    },
    {
      name: "--force",
      aliases: ["-f"],
      type: "boolean",
      default: false,
      description: "Allow mikro update to reset a dirty managed checkout to origin/main.",
      appliesTo: ["update"],
    },
    {
      name: "--origin",
      type: "string",
      description: "Explicit Juice HTTPS origin; requires project, key alias, epoch and file instead of --dir.",
      appliesTo: ["juice provision", "juice catalog", "juice usage", "juice analyze"],
    },
    {
      name: "--project",
      type: "string",
      description: "Local project identity bound to the selected private Juice key.",
      appliesTo: ["juice provision", "juice catalog", "juice usage", "juice analyze"],
    },
    {
      name: "--key-alias",
      type: "string",
      description: "Non-secret alias for the selected Juice project key.",
      appliesTo: ["juice provision", "juice catalog", "juice usage", "juice analyze"],
    },
    {
      name: "--key-epoch",
      type: "string",
      description: "Explicit local key epoch recorded in Juice catalog and viewer provenance.",
      appliesTo: ["juice provision", "juice catalog", "juice usage", "juice analyze"],
    },
    {
      name: "--key-file",
      type: "string",
      description: "Absolute private credential file; JEV requires exactly one key file or key environment reference.",
      appliesTo: ["juice provision", "juice catalog", "juice usage", "juice analyze", "jev"],
    },
    {
      name: "--key-env",
      type: "string",
      description: "Environment variable name holding the JEV credential, never the credential value.",
      appliesTo: ["jev"],
    },
    {
      name: "--management-key-file",
      type: "string",
      description: "Private management credential file; exactly one management file or environment reference is required.",
      appliesTo: ["juice provision"],
    },
    {
      name: "--management-key-env",
      type: "string",
      description: "Environment variable name holding the Juice management credential.",
      appliesTo: ["juice provision"],
    },
    {
      name: "--range",
      type: "string",
      description: "Required viewer range: today, yesterday, 5h through 24h, 1d through 30d, or custom.",
      appliesTo: ["juice usage", "juice analyze"],
    },
    {
      name: "--unit",
      type: "string",
      choices: ["hour", "day"],
      description: "Required custom-range unit; rejected for non-custom ranges.",
      appliesTo: ["juice usage", "juice analyze"],
    },
    {
      name: "--start",
      type: "string",
      description: "Required custom-range start date or RFC3339 hour; rejected for other ranges.",
      appliesTo: ["juice usage", "juice analyze"],
    },
    {
      name: "--end",
      type: "string",
      description: "Required custom-range end date or RFC3339 hour; rejected for other ranges.",
      appliesTo: ["juice usage", "juice analyze"],
    },
    {
      name: "--endpoint",
      type: "string",
      description: "Required sanctioned JEV HTTPS /v1/systemone URL; no credentials, query or fragment in the URL.",
      appliesTo: ["jev"],
    },
    {
      name: "--input",
      type: "string",
      description: "Required caller-approved sanitized JEV JSON input, at most 1 MiB; one request, no retry.",
      appliesTo: ["jev"],
    },
  ],
  output: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description: "Object emitted by `mikro --output json`. When --stats is set, stats is included.",
    required: ["answer", "references", "usage", "iterations", "model"],
    additionalProperties: true,
    properties: {
      answer: { type: "string", description: "Final answer text." },
      references: { type: "array", items: { type: "string" }, description: "Referenced files or sources." },
      usage: {
        type: "object",
        required: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalCost", "llmCalls"],
        properties: {
          inputTokens: { type: "number" },
          outputTokens: { type: "number" },
          cacheReadTokens: { type: "number" },
          cacheWriteTokens: { type: "number" },
          totalCost: { type: "number" },
          llmCalls: { type: "number" },
        },
      },
      usageBreakdown: { type: "object", description: "Optional root/child/total usage split." },
      iterations: { type: "number" },
      model: { type: "string" },
      budgetHit: { type: ["string", "null"], description: "Budget or abort reason, when applicable." },
      geminiCounts: { type: "object", description: "Gemini battery call counts, when available." },
      geminiBatteriesUsed: { type: "array", items: { type: "string" } },
      stats: { type: "object", description: "Run statistics included with --stats and --output json." },
    },
  },
  exitCodes: [
    { code: 0, meaning: "success" },
    { code: 1, meaning: "general error, validation error, missing query, missing provider key warning, or empty-response abort" },
    { code: 130, meaning: "terminated by SIGINT" },
    { code: 143, meaning: "terminated by SIGTERM" },
  ],
};

export function printMikroCliSchema(): void {
  console.log(JSON.stringify(MIKRO_CLI_SCHEMA, null, 2));
}
