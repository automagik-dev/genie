import { useState } from 'react';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface ToolCallCardProps {
  /** Tool name (e.g. "Bash", "Read", "Write", "Edit", "Glob", "Grep"). */
  toolName: string;
  /** Short preview of the tool input/command. */
  input?: string;
  /** Full tool output (collapsed by default). */
  output?: string;
  /** Whether the tool call succeeded or failed. */
  status?: 'success' | 'error';
  /** ISO timestamp. */
  timestamp?: string;
}

// ============================================================================
// Tool Icon Map
// ============================================================================

const TOOL_ICONS: Record<string, string> = {
  Bash: '\u2318', // terminal
  Read: '\u2630', // file (bars)
  Write: '\u270e', // pencil
  Edit: '\u2261', // diff (triple bar)
  Glob: '\u2315', // search
  Grep: '\u2315', // search
  TodoRead: '\u2611', // checkbox
  TodoWrite: '\u2612', // checkbox
};

function getToolIcon(name: string): string {
  // Match by prefix (e.g. "Bash" from "Bash (git push)")
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (name.toLowerCase().startsWith(key.toLowerCase())) return icon;
  }
  return '\u2699'; // gear fallback
}

function getToolColor(name: string): string {
  const lc = name.toLowerCase();
  if (lc.startsWith('bash')) return theme.warning; // amber
  if (lc.startsWith('read')) return theme.info; // blue/info
  if (lc.startsWith('write')) return theme.purple; // accent-bright
  if (lc.startsWith('edit')) return theme.emerald; // mint accent
  if (lc.startsWith('glob') || lc.startsWith('grep')) return theme.info; // info
  return theme.textDim;
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\u2026`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// ============================================================================
// ToolCallCard Component
// ============================================================================

export function ToolCallCard({ toolName, input, output, status = 'success', timestamp }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = getToolIcon(toolName);
  const color = getToolColor(toolName);
  const isFailed = status === 'error';

  return (
    <div
      style={{
        backgroundColor: theme.bgCard,
        border: `1px solid ${isFailed ? theme.error : theme.border}`,
        borderRadius: theme.radiusSm,
        overflow: 'hidden',
        fontSize: '12px',
        fontFamily: theme.fontFamily,
      }}
    >
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '6px 10px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: theme.fontFamily,
          color: theme.text,
          fontSize: '12px',
        }}
      >
        {/* Chevron */}
        <span
          style={{
            fontSize: '10px',
            color: theme.textMuted,
            transition: 'transform 0.15s ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        >
          {'\u25b6'}
        </span>

        {/* Tool icon */}
        <span style={{ color, flexShrink: 0 }}>{icon}</span>

        {/* Tool name */}
        <span style={{ color: theme.textDim, fontWeight: 500, flexShrink: 0 }}>{toolName}</span>

        {/* Input preview */}
        {input && (
          <span
            style={{
              color: theme.textMuted,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {truncate(input, 80)}
          </span>
        )}

        {/* Status indicator */}
        {isFailed && (
          <span
            style={{
              fontSize: '10px',
              color: theme.error,
              backgroundColor: 'rgba(248, 113, 113, 0.15)',
              padding: '1px 6px',
              borderRadius: '3px',
              flexShrink: 0,
            }}
          >
            failed
          </span>
        )}

        {/* Timestamp */}
        {timestamp && (
          <span style={{ fontSize: '10px', color: theme.textMuted, flexShrink: 0 }}>{formatTime(timestamp)}</span>
        )}
      </button>

      {/* Expanded output */}
      {expanded && output && (
        <div
          style={{
            padding: '8px 10px',
            borderTop: `1px solid ${theme.border}`,
            backgroundColor: isFailed ? 'rgba(248, 113, 113, 0.05)' : 'rgba(0, 0, 0, 0.15)',
            maxHeight: '300px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: isFailed ? theme.error : theme.textDim,
            fontSize: '11px',
            lineHeight: 1.5,
          }}
        >
          {output}
        </div>
      )}
    </div>
  );
}
