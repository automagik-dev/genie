import { useCallback, useState } from 'react';
import { invoke } from '../../lib/ipc';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface ApprovalData {
  id: string;
  executor_id: string;
  agent_name: string;
  tool_name: string;
  tool_input_preview: string;
  timeout_at: string;
  created_at: string;
}

type Decision = 'allow' | 'deny';
type CardState = 'pending' | 'resolving' | 'resolved' | 'error';

interface ApprovalMessageProps {
  approval: ApprovalData;
  /** Called after successful resolution so parent can update state. */
  onResolved?: (id: string, decision: Decision) => void;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function timeRemaining(timeoutAt: string): string {
  const ms = new Date(timeoutAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function resolvedBorderColor(decision: Decision | null): string {
  return decision === 'allow' ? theme.emerald : theme.error;
}

function headerLabel(isResolved: boolean, decision: Decision | null): string {
  if (!isResolved) return 'Approval Required';
  return decision === 'allow' ? 'Approved' : 'Denied';
}

// ============================================================================
// Sub-components (extracted to reduce cognitive complexity)
// ============================================================================

function ApprovalHeader({
  borderColor,
  label,
  timeoutAt,
  showTimeout,
}: { borderColor: string; label: string; timeoutAt: string; showTimeout: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: borderColor,
            flexShrink: 0,
            boxShadow: showTimeout ? `0 0 6px ${borderColor}66` : 'none',
          }}
        />
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: borderColor,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {label}
        </span>
      </div>
      {showTimeout && <span style={{ fontSize: '10px', color: theme.textMuted }}>{timeRemaining(timeoutAt)}</span>}
    </div>
  );
}

function ApprovalPreview({ preview }: { preview: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          color: theme.textDim,
          cursor: 'pointer',
          fontSize: '11px',
          fontFamily: theme.fontFamily,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <span
          style={{
            fontSize: '10px',
            transition: 'transform 0.15s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          {'\u25b6'}
        </span>
        Preview
      </button>
      {open && (
        <pre
          style={{
            marginTop: '6px',
            padding: '8px 10px',
            backgroundColor: theme.bg,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            fontSize: '11px',
            color: theme.textDim,
            overflow: 'auto',
            maxHeight: '200px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            lineHeight: 1.4,
          }}
        >
          {preview}
        </pre>
      )}
    </div>
  );
}

function ActionButtons({ isResolving, onResolve }: { isResolving: boolean; onResolve: (d: Decision) => void }) {
  const btnBase = {
    flex: 1,
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    borderRadius: theme.radiusSm,
    cursor: isResolving ? ('wait' as const) : ('pointer' as const),
    opacity: isResolving ? 0.6 : 1,
    transition: 'background-color 0.15s ease',
  };
  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
      <button
        type="button"
        onClick={() => onResolve('allow')}
        disabled={isResolving}
        style={{
          ...btnBase,
          border: `1px solid ${theme.emerald}`,
          backgroundColor: 'rgba(52, 211, 153, 0.1)',
          color: theme.emerald,
        }}
      >
        {isResolving ? '...' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={() => onResolve('deny')}
        disabled={isResolving}
        style={{
          ...btnBase,
          border: `1px solid ${theme.error}`,
          backgroundColor: 'rgba(248, 113, 113, 0.1)',
          color: theme.error,
        }}
      >
        {isResolving ? '...' : 'Deny'}
      </button>
    </div>
  );
}

// ============================================================================
// ApprovalMessage Component
// ============================================================================

export function ApprovalMessage({ approval, onResolved }: ApprovalMessageProps) {
  const [cardState, setCardState] = useState<CardState>('pending');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleResolve = useCallback(
    async (d: Decision) => {
      setCardState('resolving');
      setError(null);
      try {
        await invoke<{ ok: boolean }>('resolve_approval', {
          id: approval.id,
          decision: d,
          decided_by: 'app-user',
        });
        setDecision(d);
        setCardState('resolved');
        onResolved?.(approval.id, d);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setCardState('error');
      }
    },
    [approval.id, onResolved],
  );

  const isResolved = cardState === 'resolved';
  const borderColor = isResolved ? resolvedBorderColor(decision) : theme.warning;

  return (
    <div
      style={{
        backgroundColor: theme.bgCard,
        border: `1px solid ${borderColor}`,
        borderRadius: theme.radiusMd,
        padding: '14px 16px',
        fontFamily: theme.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        maxWidth: '520px',
        opacity: isResolved ? 0.7 : 1,
        transition: 'opacity 0.2s ease, border-color 0.2s ease',
      }}
    >
      <ApprovalHeader
        borderColor={borderColor}
        label={headerLabel(isResolved, decision)}
        timeoutAt={approval.timeout_at}
        showTimeout={!isResolved}
      />

      {/* Tool info */}
      <div style={{ fontSize: '13px', color: theme.text, lineHeight: 1.5 }}>
        <span style={{ color: theme.purple, fontWeight: 500 }}>{approval.agent_name}</span>
        {' wants to use '}
        <span style={{ color: theme.cyan, fontWeight: 500 }}>{approval.tool_name}</span>
      </div>

      {approval.tool_input_preview && <ApprovalPreview preview={approval.tool_input_preview} />}

      {!isResolved && <ActionButtons isResolving={cardState === 'resolving'} onResolve={handleResolve} />}

      {error && (
        <div style={{ fontSize: '11px', color: theme.error, padding: '4px 0' }}>Failed to resolve: {error}</div>
      )}

      <div style={{ fontSize: '10px', color: theme.textMuted, textAlign: 'right' }}>
        {formatTime(approval.created_at)}
      </div>
    </div>
  );
}
