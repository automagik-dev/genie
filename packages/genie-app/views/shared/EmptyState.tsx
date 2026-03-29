import { theme } from '../../lib/theme';

interface EmptyStateProps {
  title?: string;
  message?: string;
}

export function EmptyState({ title = 'Nothing here', message = 'No data to display.' }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '8px',
        padding: '48px',
      }}
    >
      <p style={{ fontSize: '14px', color: theme.textDim, margin: 0, fontWeight: 500 }}>{title}</p>
      <p style={{ fontSize: '12px', color: theme.textMuted, margin: 0 }}>{message}</p>
    </div>
  );
}
