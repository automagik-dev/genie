import { z } from 'zod';

/**
 * Genie Configuration Schema
 *
 * Stored at ~/.genie/config.json
 * Manages hook presets and session configuration for the genie CLI.
 */

// Sandboxed preset configuration
export const SandboxedConfigSchema = z.object({
  allowedPaths: z.array(z.string()).default(['~/projects', '/tmp']),
});

// Audited preset configuration
export const AuditedConfigSchema = z.object({
  logPath: z.string().default('~/.genie/audit.log'),
});

// Supervised preset configuration
export const SupervisedConfigSchema = z.object({
  alwaysAsk: z.array(z.string()).default(['Write', 'Edit']),
});

// Collaborative preset configuration
export const CollaborativeConfigSchema = z.object({
  sessionName: z.string().default('genie'),
  windowName: z.string().default('shell'),
});

// Logging configuration
export const LoggingConfigSchema = z.object({
  tmuxDebug: z.boolean().default(false),
});

// Hook presets configuration
export const HooksConfigSchema = z.object({
  enabled: z.array(z.enum(['collaborative', 'supervised', 'sandboxed', 'audited'])).default([]),
  collaborative: CollaborativeConfigSchema.optional(),
  supervised: SupervisedConfigSchema.optional(),
  sandboxed: SandboxedConfigSchema.optional(),
  audited: AuditedConfigSchema.optional(),
});

// Session configuration
export const SessionConfigSchema = z.object({
  name: z.string().default('genie'),
  defaultWindow: z.string().default('shell'),
});

// Full genie configuration
export const GenieConfigSchema = z.object({
  hooks: HooksConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
});

// Inferred types
export type SandboxedConfig = z.infer<typeof SandboxedConfigSchema>;
export type AuditedConfig = z.infer<typeof AuditedConfigSchema>;
export type SupervisedConfig = z.infer<typeof SupervisedConfigSchema>;
export type CollaborativeConfig = z.infer<typeof CollaborativeConfigSchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type GenieConfig = z.infer<typeof GenieConfigSchema>;

// Preset names type
export type PresetName = 'collaborative' | 'supervised' | 'sandboxed' | 'audited';

// Preset description for UI
export interface PresetDescription {
  name: PresetName;
  title: string;
  what: string;
  why: string;
  how: string;
  recommended?: boolean;
}

export const PRESET_DESCRIPTIONS: PresetDescription[] = [
  {
    name: 'collaborative',
    title: 'Collaborative',
    what: 'All terminal commands run through tmux',
    why: 'You can watch AI work in real-time',
    how: 'Bash commands → term exec genie:shell',
    recommended: true,
  },
  {
    name: 'supervised',
    title: 'Supervised',
    what: 'File changes require your approval',
    why: 'Prevents accidental overwrites',
    how: 'Write/Edit tools always ask permission',
  },
  {
    name: 'sandboxed',
    title: 'Sandboxed',
    what: 'Restrict file access to specific directories',
    why: 'Protects sensitive areas of your system',
    how: 'Operations outside sandbox are blocked',
  },
  {
    name: 'audited',
    title: 'Audited',
    what: 'Log all AI tool usage to a file',
    why: 'Review what the AI did after a session',
    how: 'Every tool call → ~/.genie/audit.log',
  },
];
