/**
 * Transcript normalization types.
 *
 * Input:  NormalizerEntry  — discriminated union matching Paperclip / session_content rows
 * Output: TranscriptBlock  — structured blocks for TUI rendering
 *
 * Ported from Paperclip ui/src/components/transcript/RunTranscriptView.tsx
 */

// ============================================================================
// Display density (controls truncation lengths in summaries)
// ============================================================================

export type TranscriptDensity = 'comfortable' | 'compact';

// ============================================================================
// Input: raw transcript entries (maps to session_content rows)
// ============================================================================

export type NormalizerEntry =
  | { kind: 'assistant'; ts: string; text: string; delta?: boolean }
  | { kind: 'thinking'; ts: string; text: string; delta?: boolean }
  | { kind: 'user'; ts: string; text: string }
  | { kind: 'tool_call'; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: 'tool_result'; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: 'init'; ts: string; model: string; sessionId: string }
  | {
      kind: 'result';
      ts: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      subtype: string;
      isError: boolean;
      errors: string[];
    }
  | { kind: 'stderr'; ts: string; text: string }
  | { kind: 'system'; ts: string; text: string }
  | { kind: 'stdout'; ts: string; text: string };

// ============================================================================
// Output: structured transcript blocks
// ============================================================================

export interface MessageBlock {
  type: 'message';
  role: 'assistant' | 'user';
  ts: string;
  text: string;
  streaming: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  ts: string;
  text: string;
  streaming: boolean;
}

export interface ToolBlock {
  type: 'tool';
  ts: string;
  endTs?: string;
  name: string;
  toolUseId?: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'error';
}

export interface ActivityBlock {
  type: 'activity';
  ts: string;
  activityId?: string;
  name: string;
  status: 'running' | 'completed';
}

export interface CommandGroupItem {
  ts: string;
  endTs?: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'error';
}

export interface CommandGroupBlock {
  type: 'command_group';
  ts: string;
  endTs?: string;
  items: CommandGroupItem[];
}

export interface ToolGroupItem {
  ts: string;
  endTs?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'error';
}

export interface ToolGroupBlock {
  type: 'tool_group';
  ts: string;
  endTs?: string;
  items: ToolGroupItem[];
}

export interface StderrGroupBlock {
  type: 'stderr_group';
  ts: string;
  endTs?: string;
  lines: Array<{ ts: string; text: string }>;
}

export interface StdoutBlock {
  type: 'stdout';
  ts: string;
  text: string;
}

export interface EventBlock {
  type: 'event';
  ts: string;
  label: string;
  tone: 'info' | 'warn' | 'error' | 'neutral';
  text: string;
  detail?: string;
}

export type TranscriptBlock =
  | MessageBlock
  | ThinkingBlock
  | ToolBlock
  | ActivityBlock
  | CommandGroupBlock
  | ToolGroupBlock
  | StderrGroupBlock
  | StdoutBlock
  | EventBlock;
