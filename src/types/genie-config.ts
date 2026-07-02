import { z } from 'zod';

/**
 * Genie Configuration Schema v2
 *
 * Stored at ~/.genie/config.json
 * Manages session configuration, terminal defaults, and shortcuts for the genie CLI.
 */

// Session configuration
const SessionConfigSchema = z.object({
  name: z.string().default('genie'),
  defaultWindow: z.string().default('shell'),
  autoCreate: z.boolean().default(true),
});

// Terminal configuration
export const TerminalConfigSchema = z.object({
  execTimeout: z.number().default(120000),
  readLines: z.number().default(100),
  worktreeBase: z.string().optional(),
});

// Logging configuration
const LoggingConfigSchema = z.object({
  tmuxDebug: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

// Shell configuration
const ShellConfigSchema = z.object({
  preference: z.enum(['auto', 'zsh', 'bash', 'fish']).default('auto'),
});

// Shortcuts configuration
export const ShortcutsConfigSchema = z.object({
  tmuxInstalled: z.boolean().default(false),
  shellInstalled: z.boolean().default(false),
});

// Codex integration configuration
const CodexConfigSchema = z.object({
  configured: z.boolean().default(false),
});

// Worker profile configuration
// Defines how to launch a Claude worker
// Uses preprocess to migrate legacy "claudio" launcher values to "claude"
const WorkerProfileSchema = z
  .object({
    /** Which binary to invoke */
    launcher: z.preprocess((val) => (val === 'claudio' ? 'claude' : val), z.literal('claude')),
    /** CLI arguments passed to Claude Code */
    claudeArgs: z.array(z.string()),
  })
  .passthrough();

// OTel observability configuration
const OtelConfigSchema = z.object({
  /** Whether OTel telemetry injection is enabled for spawned agents. Default: true. */
  enabled: z.boolean().default(true),
  /** Port for the OTLP HTTP/JSON receiver. Default: pgserve port + 1 (19643). */
  port: z.number().optional(),
  /** Whether to log user prompts via OTel. Default: true for internal agents. */
  logPrompts: z.boolean().default(true),
});

// Omni remote-approval configuration — the human-in-the-loop gate that lets a
// tool call be approved/denied from a phone via the Omni (WhatsApp) runner.
const OmniApprovalsConfigSchema = z.object({
  /**
   * Master switch for the PreToolUse approval handler. When false (default) the
   * `omni-approval` hook handler is NOT registered and the dispatcher output is
   * byte-identical to a build without Omni. When true, gated tool calls block
   * on a global-DB approval row resolved by the `omni serve` runner.
   */
  enabled: z.boolean().default(false),
  /** Regex source matched against tool_name to decide which calls to gate. */
  tools: z.string().default('^(Bash|Write|Edit|NotebookEdit)$'),
  /** Hook self-timeout budget (ms). MUST stay < the CC hook `timeout` (seconds). */
  pollBudgetMs: z.number().default(110_000),
  /** Poll interval while waiting for a resolution (ms). */
  pollIntervalMs: z.number().default(400),
  /** Approve/deny text tokens (case-insensitive). Empty → runner defaults. */
  approveTokens: z.array(z.string()).optional(),
  denyTokens: z.array(z.string()).optional(),
  /** Approve/deny reaction emoji. Empty → runner defaults. */
  approveReactions: z.array(z.string()).optional(),
  denyReactions: z.array(z.string()).optional(),
});

// Omni integration configuration
const OmniConfigSchema = z.object({
  apiUrl: z.string(),
  apiKey: z.string().optional(),
  defaultInstanceId: z.string().optional(),
  /** Executor type for the omni bridge: 'tmux' (default) or 'sdk'. */
  executor: z.enum(['tmux', 'sdk']).optional(),
  /** NATS server URL the `omni serve` runner connects to. */
  natsUrl: z.string().optional(),
  /** Omni instance id whose chat carries approval traffic. */
  instance: z.string().optional(),
  /** Chat/JID the approval-request messages are sent to and replies read from. */
  approvalChat: z.string().optional(),
  /** Remote-approval gate settings. */
  approvals: OmniApprovalsConfigSchema.optional(),
});

// Brain integration configuration (@khal-os/brain, enterprise)
const BrainConfigSchema = z.object({
  /**
   * Whether genie manages brain embedded in its own node_modules.
   *
   * - `true` (default) — `genie serve` auto-starts `startEmbeddedBrainServer` and
   *   `genie brain install` downloads the latest release tarball into node_modules.
   *   Best for non-technical users who want brain "just working".
   *
   * - `false` — genie skips all embedded brain lifecycle. Power-users install brain
   *   standalone (`bun install -g @khal-os/brain@next`) and run `brain serve` with
   *   their own settings (custom port, brain-path, dev channel, etc.).
   *   `genie brain install` becomes a no-op that points at the manual install command.
   */
  embedded: z.boolean().default(true),
  /**
   * Explicit brain vault paths to start with `genie serve`.
   *
   * - omitted - discover registered brains, then fall back to the legacy
   *   workspace/root brain vault if the registry is empty.
   * - non-empty array - start only these paths and do not consult the registry.
   * - empty array - force registry discovery (with legacy fallback if empty).
   */
  paths: z.array(z.string()).optional(),
});

// Council preset configuration
// Defines a pair of profiles for dual-model deliberation
const CouncilPresetSchema = z.object({
  /** Worker profile name for left pane */
  left: z.string(),
  /** Worker profile name for right pane */
  right: z.string(),
  /** Skill to load on both instances */
  skill: z.string().default('council'),
});

// Full genie configuration
export const GenieConfigSchema = z.object({
  version: z.number().default(2),
  session: SessionConfigSchema.default({}),
  terminal: TerminalConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  shell: ShellConfigSchema.default({}),
  shortcuts: ShortcutsConfigSchema.default({}),
  codex: CodexConfigSchema.optional(),
  installMethod: z.enum(['source', 'npm', 'bun']).optional(),
  // Release channel preference. Canonical values: 'latest' (stable),
  // 'homolog' (staging — middle tier in dev→homolog→stable promotion),
  // or 'dev' (pre-release). 'next' is accepted as a read-time alias for
  // 'dev' for configs written by pre-release-channel-dev binaries (where
  // the channel was named 'next' before the rename — see wish
  // release-channel-dev, decision #3). Writes always emit one of the
  // three canonical tokens; the 'next' alias never round-trips back to
  // disk. 'homolog' added 2026-05-12 per Felipe's cross-repo channel
  // taxonomy unification.
  updateChannel: z
    .enum(['latest', 'next', 'dev', 'homolog'])
    .default('latest')
    .transform((v) => (v === 'next' ? ('dev' as const) : v)),
  setupComplete: z.boolean().default(false),
  lastSetupAt: z.string().optional(),
  // Path to genie-cli source directory (for dev mode sync)
  sourcePath: z.string().optional(),
  // Worker profiles for different spawn configurations
  workerProfiles: z.record(z.string(), WorkerProfileSchema).optional(),
  // Default worker profile name to use when --profile is not specified
  defaultWorkerProfile: z.string().optional(),
  // Council presets for dual-model deliberation
  councilPresets: z.record(z.string(), CouncilPresetSchema).optional(),
  // Default council preset name
  defaultCouncilPreset: z.string().optional(),
  // Controls whether --system-prompt-file (replace CC default) or --append-system-prompt-file (preserve CC default) is used
  promptMode: z.enum(['append', 'system']).default('append'),
  // Whether task leaders should auto-merge PRs to dev (default: false — leave PR open for human)
  autoMergeDev: z.boolean().default(false),
  // Default project for task commands when outside any repo
  defaultProject: z.string().optional(),
  // OTel observability (optional — telemetry injection for spawned agents)
  otel: OtelConfigSchema.optional(),
  // Omni integration (optional — multi-channel messaging)
  omni: OmniConfigSchema.optional(),
  // Brain integration (optional — enterprise @khal-os/brain)
  brain: BrainConfigSchema.default({}),
});

// Inferred types
export type ShortcutsConfig = z.infer<typeof ShortcutsConfigSchema>;
export type GenieConfig = z.infer<typeof GenieConfigSchema>;
export type OmniConfig = z.infer<typeof OmniConfigSchema>;
