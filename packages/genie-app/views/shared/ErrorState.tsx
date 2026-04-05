import { theme } from '../../lib/theme';

// ============================================================================
// ErrorState — Error display with service reference and retry button
// ============================================================================

interface ErrorStateProps {
  /** The error message to display. */
  message: string;
  /** Optional service or subject reference (e.g. "dashboard.stats"). */
  service?: string;
  /** Called when the user clicks the retry button. Omit to hide the button. */
  onRetry?: () => void;
}

export function ErrorState({ message, service, onRetry }: ErrorStateProps) {
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
      {/* Icon */}
      <div
        style={{
          fontSize: '28px',
          color: theme.error,
          marginBottom: '4px',
        }}
      >
        {'\u26a0'}
      </div>

      {/* Title */}
      <p style={{ fontSize: '14px', color: theme.error, margin: 0, fontWeight: 600 }}>Something went wrong</p>

      {/* Message */}
      <p
        style={{
          fontSize: '12px',
          color: theme.textDim,
          margin: 0,
          maxWidth: '480px',
          lineHeight: 1.5,
        }}
      >
        {message}
      </p>

      {/* Service reference */}
      {service && (
        <p
          style={{
            fontSize: '11px',
            color: theme.textMuted,
            margin: 0,
            fontFamily: theme.fontFamily,
          }}
        >
          Service: {service}
        </p>
      )}

      {/* Retry button */}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: '8px',
            padding: '6px 20px',
            borderRadius: theme.radiusSm,
            border: `1px solid ${theme.border}`,
            backgroundColor: 'transparent',
            color: theme.textDim,
            fontSize: '12px',
            fontFamily: theme.fontFamily,
            cursor: 'pointer',
            transition: 'border-color 0.15s ease, color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = theme.violet;
            e.currentTarget.style.color = theme.text;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = theme.border;
            e.currentTarget.style.color = theme.textDim;
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}
