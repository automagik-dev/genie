import { theme } from '../../lib/theme';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: theme.textMuted,
        fontSize: '14px',
        fontFamily: theme.fontFamily,
      }}
    >
      {message}
    </div>
  );
}
