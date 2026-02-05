import { z } from 'zod';

/**
 * Genie Configuration Schema v2
 *
 * Stored at ~/.genie/config.json
 * Manages session configuration, terminal defaults, and shortcuts for the genie CLI.
 */

// Session configuration
export const SessionConfigSchema = z.object({
  name: z.string().default('genie'),
  defaultWindow: z.string().default('shell'),
  autoCreate: z.boolean().default(true),
});

// Terminal configuration
export const TerminalConfigSchema = z.object({
  execTimeout: z.number().default(120000),
  readLines: z.number().default(100),
  worktreeBase: z.string().default('.worktrees'),
});

// Logging configuration
export const LoggingConfigSchema = z.object({
  tmuxDebug: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

// Shell configuration
export const ShellConfigSchema = z.object({
  preference: z.enum(['auto', 'zsh', 'bash', 'fish']).default('auto'),
});

// Shortcuts configuration
export const ShortcutsConfigSchema = z.object({
  tmuxInstalled: z.boolean().default(false),
  shellInstalled: z.boolean().default(false),
});

// Claudio integration configuration
export const ClaudioConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

// Worker profile configuration
// Defines how to launch a Claude worker
export const WorkerProfileSchema = z.object({
  /** Which binary to invoke: 'claude' (direct) or 'claudio' (via LLM router) */
  launcher: z.enum(['claude', 'claudio']),
  /** Claudio profile name (required if launcher is 'claudio') */
  claudioProfile: z.string().optional(),
  /** CLI arguments passed to Claude Code */
  claudeArgs: z.array(z.string()),
});

// Full genie configuration
export const GenieConfigSchema = z.object({
  version: z.number().default(2),
  session: SessionConfigSchema.default({}),
  terminal: TerminalConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  shell: ShellConfigSchema.default({}),
  shortcuts: ShortcutsConfigSchema.default({}),
  claudio: ClaudioConfigSchema.optional(),
  installMethod: z.enum(['source', 'npm', 'bun']).optional(),
  setupComplete: z.boolean().default(false),
  lastSetupAt: z.string().optional(),
  // Path to genie-cli source directory (for dev mode sync)
  sourcePath: z.string().optional(),
  // Worker profiles for different spawn configurations
  workerProfiles: z.record(z.string(), WorkerProfileSchema).optional(),
  // Default worker profile name to use when --profile is not specified
  defaultWorkerProfile: z.string().optional(),
});

// Legacy v1 config schema (for migration)
export const GenieConfigV1Schema = z.object({
  session: z.object({
    name: z.string().default('genie'),
    defaultWindow: z.string().default('shell'),
  }).default({}),
  logging: z.object({
    tmuxDebug: z.boolean().default(false),
  }).default({}),
  installMethod: z.enum(['source', 'npm', 'bun']).optional(),
});

// Inferred types
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type TerminalConfig = z.infer<typeof TerminalConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type ShellConfig = z.infer<typeof ShellConfigSchema>;
export type ShortcutsConfig = z.infer<typeof ShortcutsConfigSchema>;
export type ClaudioConfig = z.infer<typeof ClaudioConfigSchema>;
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;
export type GenieConfig = z.infer<typeof GenieConfigSchema>;
export type GenieConfigV1 = z.infer<typeof GenieConfigV1Schema>;
