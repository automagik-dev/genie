import { useState } from 'react';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatBubbleProps {
  /** Message role: user (right/blue), assistant (left/green), system (centered/gray). */
  role: ChatRole;
  /** Message text content (markdown-like plain text). */
  content: string;
  /** If set, renders as a tool-call card instead of a chat bubble. */
  toolName?: string;
  /** ISO timestamp of the message. */
  timestamp?: string;
  /** Whether the content is fully expanded (for long messages). */
  isExpanded?: boolean;
  /** Optional children rendered below content (e.g. nested tool calls). */
  children?: React.ReactNode;
}

// ============================================================================
// Helpers
// ============================================================================

const MAX_COLLAPSED_LENGTH = 600;

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function truncateContent(text: string, expanded: boolean): string {
  if (expanded || text.length <= MAX_COLLAPSED_LENGTH) return text;
  return `${text.slice(0, MAX_COLLAPSED_LENGTH)}\u2026`;
}

// ============================================================================
// Styles
// ============================================================================

const bubbleBase = {
  maxWidth: '75%',
  padding: '10px 14px',
  borderRadius: '12px',
  fontSize: '13px',
  lineHeight: 1.55,
  fontFamily: theme.fontFamily,
  wordBreak: 'break-word' as const,
  whiteSpace: 'pre-wrap' as const,
  position: 'relative' as const,
};

const userBubble = {
  ...bubbleBase,
  backgroundColor: theme.info,
  color: theme.text,
  borderBottomRightRadius: '4px',
};

const assistantBubble = {
  ...bubbleBase,
  backgroundColor: theme.bgCard,
  color: theme.emerald,
  borderBottomLeftRadius: '4px',
  border: `1px solid ${theme.borderActive}`,
};

const systemBubble = {
  ...bubbleBase,
  maxWidth: '85%',
  backgroundColor: theme.bgCard,
  color: theme.textMuted,
  border: `1px solid ${theme.border}`,
  fontSize: '12px',
  fontStyle: 'italic' as const,
  textAlign: 'center' as const,
};

const ROLE_STYLES: Record<ChatRole, React.CSSProperties> = {
  user: userBubble,
  assistant: assistantBubble,
  system: systemBubble,
};

const ROW_ALIGN: Record<ChatRole, React.CSSProperties> = {
  user: { display: 'flex', justifyContent: 'flex-end', padding: '2px 16px' },
  assistant: { display: 'flex', justifyContent: 'flex-start', padding: '2px 16px' },
  system: { display: 'flex', justifyContent: 'center', padding: '2px 16px' },
};

// ============================================================================
// ChatBubble Component
// ============================================================================

export function ChatBubble({ role, content, timestamp, isExpanded: controlledExpanded, children }: ChatBubbleProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const needsTruncation = content.length > MAX_COLLAPSED_LENGTH;

  return (
    <div style={ROW_ALIGN[role]}>
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '75%' }}>
        {/* Bubble */}
        <div style={ROLE_STYLES[role]}>
          {truncateContent(content, expanded)}
          {needsTruncation && !expanded && (
            <button
              type="button"
              onClick={() => setLocalExpanded(true)}
              style={{
                display: 'inline',
                background: 'none',
                border: 'none',
                color: role === 'user' ? theme.text : role === 'assistant' ? theme.emerald : theme.textDim,
                fontSize: '12px',
                cursor: 'pointer',
                padding: '0 0 0 4px',
                fontFamily: theme.fontFamily,
              }}
            >
              show more
            </button>
          )}
        </div>

        {/* Timestamp */}
        {timestamp && (
          <span
            style={{
              fontSize: '10px',
              color: theme.textMuted,
              marginTop: '2px',
              textAlign: role === 'user' ? 'right' : role === 'system' ? 'center' : 'left',
              padding: '0 4px',
            }}
          >
            {formatTime(timestamp)}
          </span>
        )}

        {/* Nested children (tool call cards) */}
        {children && (
          <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>{children}</div>
        )}
      </div>
    </div>
  );
}
