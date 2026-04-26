import { useState } from 'react';
import { invoke } from '../../../lib/ipc';
import { palette } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';

// ============================================================================
// Theme tokens — sourced from genie-tokens via lib/theme
// ============================================================================

const t = {
  bg: palette.bg,
  bgCard: palette.bgRaised,
  border: palette.border,
  text: palette.text,
  textDim: palette.textDim,
  textMuted: palette.textMuted,
  purple: palette.accentBright,
  violet: palette.accent,
  emerald: palette.success,
  error: palette.error,
} as const;

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    backgroundColor: t.bg,
    color: t.text,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    padding: '48px',
  },
  card: {
    backgroundColor: t.bgCard,
    border: `1px solid ${t.border}`,
    borderRadius: '12px',
    padding: '40px',
    maxWidth: '480px',
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '24px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    color: t.text,
    margin: 0,
    textAlign: 'center' as const,
  },
  subtitle: {
    fontSize: '14px',
    color: t.textDim,
    margin: 0,
    textAlign: 'center' as const,
    lineHeight: 1.5,
  },
  buttonRow: {
    display: 'flex',
    gap: '12px',
  },
  button: {
    flex: 1,
    padding: '12px 20px',
    borderRadius: '8px',
    border: `1px solid ${t.border}`,
    backgroundColor: t.bgCard,
    color: t.text,
    fontSize: '14px',
    fontFamily: 'inherit',
    cursor: 'pointer',
    transition: 'border-color 0.15s ease',
  },
  buttonPrimary: {
    flex: 1,
    padding: '12px 20px',
    borderRadius: '8px',
    border: 'none',
    backgroundColor: t.violet,
    color: t.text,
    fontSize: '14px',
    fontFamily: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: '6px',
    border: `1px solid ${t.border}`,
    backgroundColor: t.bg,
    color: t.text,
    fontSize: '14px',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: t.textDim,
    marginBottom: '4px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  errorText: {
    fontSize: '13px',
    color: t.error,
  },
  stepDots: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'center',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: t.border,
  },
  dotActive: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: t.purple,
  },
  successIcon: {
    fontSize: '48px',
    textAlign: 'center' as const,
    color: t.emerald,
    lineHeight: 1,
  },
} as const;

// ============================================================================
// WizardView
// ============================================================================

type Step = 'welcome' | 'setup' | 'done';

export interface WizardViewProps extends AppComponentProps {}

export function WizardView({ windowId }: WizardViewProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!path.trim()) {
      setError('Path is required');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'new') {
        await invoke('init_workspace', { path: path.trim(), name: name.trim() || undefined });
      } else {
        await invoke('open_workspace', { path: path.trim() });
      }
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-window-id={windowId} style={styles.root}>
      <div style={styles.card}>
        {/* Step dots */}
        <div style={styles.stepDots}>
          <div style={step === 'welcome' ? styles.dotActive : styles.dot} />
          <div style={step === 'setup' ? styles.dotActive : styles.dot} />
          <div style={step === 'done' ? styles.dotActive : styles.dot} />
        </div>

        {step === 'welcome' && (
          <>
            <h1 style={styles.title}>Welcome to Genie</h1>
            <p style={styles.subtitle}>AI agent orchestration cockpit. Set up your workspace to get started.</p>
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.buttonPrimary}
                onClick={() => {
                  setMode('new');
                  setStep('setup');
                }}
              >
                New Installation
              </button>
              <button
                type="button"
                style={styles.button}
                onClick={() => {
                  setMode('existing');
                  setStep('setup');
                }}
              >
                Open Existing
              </button>
            </div>
          </>
        )}

        {step === 'setup' && (
          <>
            <h1 style={styles.title}>{mode === 'new' ? 'Create Workspace' : 'Open Workspace'}</h1>
            <p style={styles.subtitle}>
              {mode === 'new'
                ? 'Choose a directory for your new workspace.'
                : 'Enter the path to an existing workspace.'}
            </p>
            <label style={styles.field}>
              <span style={styles.label}>Path</span>
              <input
                style={styles.input}
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/user/projects/my-workspace"
              />
            </label>
            {mode === 'new' && (
              <label style={styles.field}>
                <span style={styles.label}>Name (optional)</span>
                <input
                  style={styles.input}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-workspace"
                />
              </label>
            )}
            {error && <p style={styles.errorText}>{error}</p>}
            <div style={styles.buttonRow}>
              <button type="button" style={styles.button} onClick={() => setStep('welcome')}>
                Back
              </button>
              <button type="button" style={styles.buttonPrimary} onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Setting up...' : mode === 'new' ? 'Create' : 'Open'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <p style={styles.successIcon}>{'\u2713'}</p>
            <h1 style={styles.title}>Ready</h1>
            <p style={styles.subtitle}>
              Your workspace is set up. You can now switch to the Agents view to start working.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
