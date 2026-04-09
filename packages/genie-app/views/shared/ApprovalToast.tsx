import { useEffect, useState } from 'react';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface ApprovalToastData {
  id: string;
  agent_name: string;
  tool_name: string;
  tool_input_preview?: string;
  timeout_at: string;
  created_at: string;
}

interface ApprovalToastProps {
  approval: ApprovalToastData;
  onDismiss: (id: string) => void;
  onViewInChat?: (id: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

const AUTO_DISMISS_MS = 10_000;

// ============================================================================
// ApprovalToast Component
// ============================================================================

export function ApprovalToast({ approval, onDismiss, onViewInChat }: ApprovalToastProps) {
  const [opacity, setOpacity] = useState(0);
  const [exiting, setExiting] = useState(false);

  // Fade in on mount
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpacity(1));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Auto-dismiss after 10s
  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(approval.id), 200);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [approval.id, onDismiss]);

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(() => onDismiss(approval.id), 200);
  };

  return (
    <div
      style={{
        opacity: exiting ? 0 : opacity,
        transform: exiting ? 'translateX(20px)' : opacity === 1 ? 'translateX(0)' : 'translateX(20px)',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
        backgroundColor: theme.bgCard,
        border: `1px solid ${theme.warning}`,
        borderRadius: theme.radiusMd,
        padding: '12px 16px',
        minWidth: '280px',
        maxWidth: '360px',
        boxShadow: `0 4px 16px rgba(0, 0, 0, 0.4), 0 0 0 1px ${theme.border}`,
        fontFamily: theme.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: theme.warning,
              flexShrink: 0,
              boxShadow: `0 0 6px ${theme.warning}66`,
            }}
          />
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: theme.warning,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Approval Required
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: theme.textMuted,
            cursor: 'pointer',
            fontSize: '14px',
            padding: '0 2px',
            lineHeight: 1,
            fontFamily: theme.fontFamily,
          }}
        >
          {'\u00d7'}
        </button>
      </div>

      {/* Agent + tool info */}
      <div style={{ fontSize: '13px', color: theme.text, lineHeight: 1.4 }}>
        <span style={{ color: theme.purple, fontWeight: 500 }}>{approval.agent_name}</span>
        {' wants to use '}
        <span style={{ color: theme.cyan, fontWeight: 500 }}>{approval.tool_name}</span>
      </div>

      {/* View in Chat link */}
      {onViewInChat && (
        <button
          type="button"
          onClick={() => onViewInChat(approval.id)}
          style={{
            background: 'none',
            border: 'none',
            color: theme.violet,
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: theme.fontFamily,
            padding: 0,
            textAlign: 'left',
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
          }}
        >
          View in Chat
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Toast Container — renders multiple toasts stacked vertically
// ============================================================================

interface ApprovalToastContainerProps {
  toasts: ApprovalToastData[];
  onDismiss: (id: string) => void;
  onViewInChat?: (id: string) => void;
}

export function ApprovalToastContainer({ toasts, onDismiss, onViewInChat }: ApprovalToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: 'auto',
      }}
    >
      {toasts.map((toast) => (
        <ApprovalToast key={toast.id} approval={toast} onDismiss={onDismiss} onViewInChat={onViewInChat} />
      ))}
    </div>
  );
}
