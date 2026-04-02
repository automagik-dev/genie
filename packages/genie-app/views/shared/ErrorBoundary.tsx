import { Component, type ReactNode } from 'react';
import { theme } from '../../lib/theme';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

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
            fontFamily: theme.fontFamily,
          }}
        >
          <p style={{ fontSize: '14px', color: theme.error, margin: 0, fontWeight: 600 }}>Something went wrong</p>
          <p
            style={{
              fontSize: '12px',
              color: theme.textDim,
              margin: 0,
              maxWidth: '480px',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: '8px',
              padding: '6px 16px',
              borderRadius: theme.radiusSm,
              border: `1px solid ${theme.border}`,
              backgroundColor: 'transparent',
              color: theme.textDim,
              fontSize: '12px',
              fontFamily: theme.fontFamily,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
