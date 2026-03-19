/**
 * Transcript — Provider-agnostic transcript reading.
 *
 * Normalizes conversation logs from Claude Code and Codex into a
 * unified `TranscriptEntry` format with filtering and NDJSON output.
 *
 * Usage:
 *   const entries = await readTranscript(worker, { last: 10, roles: ['assistant'] });
 */

import type { Agent } from './agent-registry.js';
import type { ProviderName } from './provider-adapters.js';

// ============================================================================
// Types
// ============================================================================

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';

export interface TranscriptEntry {
  /** Normalized role */
  role: TranscriptRole;
  /** ISO timestamp */
  timestamp: string;
  /** Extracted text content */
  text: string;
  /** Tool call details (when role === 'tool_call') */
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  /** Provider that produced this entry */
  provider: ProviderName;
  /** Model name if available */
  model?: string;
  /** Token usage if available */
  usage?: { input: number; output: number };
  /** Raw entry for --raw mode */
  raw: Record<string, unknown>;
}

export interface TranscriptFilter {
  /** Return only last N entries (applied after role/since filtering) */
  last?: number;
  /** Only entries after this ISO timestamp */
  since?: string;
  /** Only entries matching these roles */
  roles?: TranscriptRole[];
}

export interface TranscriptProvider {
  /** Find the log file path for a worker */
  discoverLogPath(worker: Agent): Promise<string | null>;
  /** Read entries from a log file */
  readEntries(logPath: string): Promise<TranscriptEntry[]>;
}

// ============================================================================
// Filter
// ============================================================================

/**
 * Apply filters to transcript entries. Order: since → roles → last.
 */
export function applyFilter(entries: TranscriptEntry[], filter?: TranscriptFilter): TranscriptEntry[] {
  if (!filter) return entries;

  let result = entries;

  if (filter.since) {
    const sinceMs = new Date(filter.since).getTime();
    result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  }

  if (filter.roles && filter.roles.length > 0) {
    const roles = new Set(filter.roles);
    result = result.filter((e) => roles.has(e.role));
  }

  if (filter.last && filter.last > 0) {
    result = result.slice(-filter.last);
  }

  return result;
}

// ============================================================================
// Dispatch
// ============================================================================

let _claudeProvider: TranscriptProvider | undefined;
let _codexProvider: TranscriptProvider | undefined;

async function getClaudeProvider(): Promise<TranscriptProvider> {
  if (!_claudeProvider) {
    const mod = await import('./claude-logs.js');
    _claudeProvider = mod.claudeTranscriptProvider;
  }
  return _claudeProvider;
}

async function getCodexProvider(): Promise<TranscriptProvider> {
  if (!_codexProvider) {
    const mod = await import('./codex-logs.js');
    _codexProvider = mod.codexTranscriptProvider;
  }
  return _codexProvider;
}

/**
 * Get the transcript provider for a worker based on its provider field.
 * Defaults to Claude for legacy workers without a provider field.
 */
export async function getProvider(worker: Agent): Promise<TranscriptProvider> {
  const provider = worker.provider ?? 'claude';
  if (provider === 'codex') return getCodexProvider();
  return getClaudeProvider();
}

/**
 * Read transcript entries for a worker with optional filtering.
 * Discovers the log file, reads entries, and applies filters.
 */
export async function readTranscript(worker: Agent, filter?: TranscriptFilter): Promise<TranscriptEntry[]> {
  const provider = await getProvider(worker);
  const logPath = await provider.discoverLogPath(worker);
  if (!logPath) return [];

  const entries = await provider.readEntries(logPath);
  return applyFilter(entries, filter);
}
