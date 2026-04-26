import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceConfig {
  name?: string;
  path?: string;
  pgUrl?: string;
  daemonPid?: number;
  tmuxSocket?: string;
}

export interface OtelConfig {
  enabled?: boolean;
  port?: number;
  logPrompts?: boolean;
}

interface WorkspaceTabProps {
  workspace: WorkspaceConfig;
  otel: OtelConfig;
  pgservePort?: number;
  dataDir?: string;
  onSave: (key: string, value: unknown) => Promise<void>;
  onTestPg: () => Promise<{ ok: boolean; message: string }>;
}

// ============================================================================
// Styles (shared)
// ============================================================================

const s = {
  section: { marginBottom: '24px' },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    color: theme.purple,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    marginBottom: '12px',
    paddingBottom: '6px',
    borderBottom: `1px solid ${theme.border}`,
  },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  label: { fontSize: '11px', color: theme.textDim },
  input: {
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: theme.fontFamily,
    backgroundColor: theme.bgCard,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  roInput: {
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: theme.fontFamily,
    backgroundColor: 'rgba(255,255,255,0.03)',
    color: theme.textDim,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: `1px solid ${theme.border}`,
  },
  toggleLabel: { fontSize: '12px', color: theme.text },
  toggleDesc: { fontSize: '10px', color: theme.textMuted },
  toggle: (on: boolean) => ({
    width: '36px',
    height: '20px',
    borderRadius: '10px',
    backgroundColor: on ? theme.violet : theme.border,
    border: 'none',
    cursor: 'pointer',
    position: 'relative' as const,
    transition: 'background-color 0.2s ease',
    flexShrink: 0,
  }),
  toggleKnob: (on: boolean) => ({
    position: 'absolute' as const,
    top: '2px',
    left: on ? '18px' : '2px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    backgroundColor: theme.text,
    transition: 'left 0.2s ease',
  }),
} as const;

function Toggle({
  label,
  desc,
  value,
  onChange,
}: { label: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={s.toggleRow}>
      <div>
        <div style={s.toggleLabel}>{label}</div>
        {desc && <div style={s.toggleDesc}>{desc}</div>}
      </div>
      <button
        type="button"
        style={s.toggle(value)}
        onClick={() => onChange(!value)}
        aria-pressed={value}
        aria-label={label}
      >
        <span style={s.toggleKnob(value)} />
      </button>
    </div>
  );
}

// ============================================================================
// DatabaseSection — extracted to reduce cognitive complexity
// ============================================================================

function DatabaseSection({
  pgUrl,
  onTestPg,
}: { pgUrl?: string; onTestPg: () => Promise<{ ok: boolean; message: string }> }) {
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const handleTestPg = useCallback(async () => {
    setTestStatus('testing');
    try {
      const result = await onTestPg();
      setTestStatus(result.ok ? 'ok' : 'error');
      setTestMsg(result.message);
    } catch (err) {
      setTestStatus('error');
      setTestMsg(err instanceof Error ? err.message : String(err));
    }
  }, [onTestPg]);

  const testColor = testStatus === 'ok' ? theme.success : testStatus === 'error' ? theme.error : theme.textMuted;

  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Database</div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
        <div style={{ ...s.field, flex: 1 }}>
          <label style={s.label} htmlFor="pg-url">
            PG URL
          </label>
          <div style={s.roInput}>{pgUrl ?? '--'}</div>
        </div>
        <button
          type="button"
          disabled={testStatus === 'testing'}
          onClick={handleTestPg}
          style={{
            padding: '6px 14px',
            fontSize: '11px',
            fontFamily: theme.fontFamily,
            backgroundColor: theme.bgCard,
            color: theme.textDim,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
      </div>
      {testStatus !== 'idle' && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: testColor }}>
          {testStatus === 'ok' ? '\u2713 ' : '\u2717 '}
          {testMsg}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// OtelSection — extracted to reduce cognitive complexity
// ============================================================================

function OtelSection({ otel, onSave }: { otel: OtelConfig; onSave: (key: string, value: unknown) => Promise<void> }) {
  const [otelDraft, setOtelDraft] = useState<OtelConfig>(otel);
  const [otelDirty, setOtelDirty] = useState(false);

  useEffect(() => {
    setOtelDraft(otel);
    setOtelDirty(false);
  }, [otel]);

  const updateOtel = useCallback((key: keyof OtelConfig, value: unknown) => {
    setOtelDraft((prev) => ({ ...prev, [key]: value }));
    setOtelDirty(true);
  }, []);

  const saveOtel = useCallback(async () => {
    await onSave('otel', otelDraft);
    setOtelDirty(false);
  }, [onSave, otelDraft]);

  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Observability (OTel)</div>
      <Toggle
        label="OTel Enabled"
        desc="Inject OpenTelemetry for spawned agents"
        value={otelDraft.enabled ?? true}
        onChange={(v) => updateOtel('enabled', v)}
      />
      <Toggle
        label="Log Prompts"
        desc="Log user prompts via OTel (internal agents)"
        value={otelDraft.logPrompts ?? true}
        onChange={(v) => updateOtel('logPrompts', v)}
      />
      <div style={{ marginTop: '12px', ...s.field, maxWidth: '200px' }}>
        <label style={s.label} htmlFor="otel-port">
          OTel Port
        </label>
        <input
          id="otel-port"
          type="number"
          style={s.input}
          value={otelDraft.port ?? ''}
          placeholder="auto (pgserve+1)"
          onChange={(e) => updateOtel('port', e.target.value ? Number(e.target.value) : undefined)}
        />
      </div>
      {otelDirty && (
        <div style={{ marginTop: '12px' }}>
          <button
            type="button"
            onClick={saveOtel}
            style={{
              padding: '8px 20px',
              fontSize: '12px',
              fontFamily: theme.fontFamily,
              backgroundColor: theme.violet,
              color: theme.bg,
              border: 'none',
              borderRadius: theme.radiusSm,
              cursor: 'pointer',
            }}
          >
            Save OTel Settings
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// WorkspaceTab
// ============================================================================

export function WorkspaceTab({ workspace, otel, pgservePort, dataDir, onSave, onTestPg }: WorkspaceTabProps) {
  return (
    <div>
      {/* Workspace Info */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Workspace</div>
        <div style={s.grid}>
          <div style={s.field}>
            <span style={s.label}>Name</span>
            <div style={s.roInput}>{workspace.name ?? '--'}</div>
          </div>
          <div style={s.field}>
            <span style={s.label}>Path</span>
            <div style={s.roInput}>{workspace.path ?? '--'}</div>
          </div>
        </div>
      </div>

      <DatabaseSection pgUrl={workspace.pgUrl} onTestPg={onTestPg} />

      {/* Daemon */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Daemon</div>
        <div style={s.grid}>
          <div style={s.field}>
            <span style={s.label}>Daemon PID</span>
            <div style={s.roInput}>{workspace.daemonPid ?? '--'}</div>
          </div>
          <div style={s.field}>
            <span style={s.label}>Tmux Socket</span>
            <div style={s.roInput}>{workspace.tmuxSocket ?? '--'}</div>
          </div>
          <div style={s.field}>
            <span style={s.label}>Pgserve Port</span>
            <div style={s.roInput}>{pgservePort ?? '--'}</div>
          </div>
          <div style={s.field}>
            <span style={s.label}>Data Directory</span>
            <div style={s.roInput}>{dataDir ?? '--'}</div>
          </div>
        </div>
      </div>

      <OtelSection otel={otel} onSave={onSave} />
    </div>
  );
}
