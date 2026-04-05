import type { ReactNode } from 'react';
import { theme } from '../../lib/theme';

// ============================================================================
// EmptyState — Follows @khal-os/ui EmptyState pattern
// ============================================================================

interface EmptyStateProps {
  /** Optional icon or emoji displayed above the title. */
  icon?: ReactNode;
  /** Primary message (e.g. "No agents found"). */
  title: string;
  /** Secondary explanatory text. */
  description?: string;
  /** Optional action element (e.g. a retry button or link). */
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '12px',
        padding: '48px',
        textAlign: 'center',
      }}
    >
      {icon && (
        <div
          style={{
            fontSize: '32px',
            color: theme.textMuted,
            marginBottom: '4px',
          }}
        >
          {icon}
        </div>
      )}
      <p style={{ fontSize: '14px', color: theme.textDim, margin: 0, fontWeight: 500 }}>{title}</p>
      {description && (
        <p
          style={{
            fontSize: '12px',
            color: theme.textMuted,
            margin: 0,
            maxWidth: '360px',
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: '8px' }}>{action}</div>}
    </div>
  );
}
