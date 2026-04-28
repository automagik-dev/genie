import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface OmniConfig {
  apiUrl: string;
  apiKey?: string;
  defaultInstanceId?: string;
  executor?: 'tmux' | 'sdk';
}

interface OmniTabProps {
  omni: OmniConfig | null;
  onSave: (config: OmniConfig) => Promise<void>;
}

// ============================================================================
// OmniTab
// ============================================================================

export function OmniTab({ omni, onSave }: OmniTabProps) {
  const [draft, setDraft] = useState<OmniConfig>(
    omni ?? { apiUrl: '', apiKey: '', defaultInstanceId: '', executor: 'tmux' },
  );
  const [showKey, setShowKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (omni) {
      setDraft(omni);
      setDirty(false);
    }
  }, [omni]);

  const update = useCallback(<K extends keyof OmniConfig>(key: K, value: OmniConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(draft);
      setSaved(true);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [onSave, draft]);

  const _inputStyle = {
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
  };

  const _labelStyle = { fontSize: '11px', color: theme.textDim };

  if (!omni) {
    return (
      <div>
        <div
          style={{
            marginBottom: '16px',
            padding: '10px 14px',
            backgroundColor: 'rgba(251, 191, 36, 0.1)',
            border: `1px solid ${theme.warning}`,
            borderRadius: theme.radiusSm,
            fontSize: '12px',
            color: theme.warning,
          }}
        >
          Omni integration is not configured. Fill in the settings below to enable multi-channel messaging.
        </div>
        <OmniForm draft={draft} showKey={showKey} onToggleKey={() => setShowKey((v) => !v)} onUpdate={update} />
        {dirty && <SaveButton saving={saving} saved={saved} onSave={handleSave} />}
      </div>
    );
  }

  return (
    <div>
      <OmniForm draft={draft} showKey={showKey} onToggleKey={() => setShowKey((v) => !v)} onUpdate={update} />
      {dirty && <SaveButton saving={saving} saved={saved} onSave={handleSave} />}
    </div>
  );
}

// ============================================================================
// Internal sub-components
// ============================================================================

function OmniForm({
  draft,
  showKey,
  onToggleKey,
  onUpdate,
}: {
  draft: OmniConfig;
  showKey: boolean;
  onToggleKey: () => void;
  onUpdate: <K extends keyof OmniConfig>(key: K, value: OmniConfig[K]) => void;
}) {
  const inputStyle = {
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
  };
  const labelStyle = { fontSize: '11px', color: theme.textDim };
  const fieldStyle = { display: 'flex', flexDirection: 'column' as const, gap: '4px', marginBottom: '14px' };

  return (
    <div>
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="omni-url">
          API URL
        </label>
        <input
          id="omni-url"
          style={inputStyle}
          value={draft.apiUrl}
          placeholder="https://your-omni-instance.com"
          onChange={(e) => onUpdate('apiUrl', e.target.value)}
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="omni-key">
          API Key{' '}
          <button
            type="button"
            onClick={onToggleKey}
            style={{
              background: 'none',
              border: 'none',
              color: theme.textMuted,
              fontSize: '10px',
              cursor: 'pointer',
              padding: '0 4px',
              fontFamily: theme.fontFamily,
            }}
          >
            {showKey ? 'hide' : 'show'}
          </button>
        </label>
        <input
          id="omni-key"
          style={inputStyle}
          type={showKey ? 'text' : 'password'}
          value={draft.apiKey ?? ''}
          placeholder="sk-..."
          onChange={(e) => onUpdate('apiKey', e.target.value)}
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="omni-instance">
          Default Instance ID
        </label>
        <input
          id="omni-instance"
          style={inputStyle}
          value={draft.defaultInstanceId ?? ''}
          placeholder="e.g. whatsapp-main"
          onChange={(e) => onUpdate('defaultInstanceId', e.target.value)}
        />
      </div>

      <div style={{ ...fieldStyle, maxWidth: '200px' }}>
        <label style={labelStyle} htmlFor="omni-executor">
          Executor
        </label>
        <select
          id="omni-executor"
          style={{ ...inputStyle, cursor: 'pointer', appearance: 'auto' as const }}
          value={draft.executor ?? 'tmux'}
          onChange={(e) => onUpdate('executor', e.target.value as 'tmux' | 'sdk')}
        >
          <option value="tmux">tmux (default)</option>
          <option value="sdk">sdk</option>
        </select>
      </div>
    </div>
  );
}

function SaveButton({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={saving}
      style={{
        marginTop: '4px',
        padding: '8px 20px',
        fontSize: '12px',
        fontFamily: theme.fontFamily,
        backgroundColor: theme.violet,
        color: theme.bg,
        border: 'none',
        borderRadius: theme.radiusSm,
        cursor: saving ? 'default' : 'pointer',
      }}
    >
      {saving ? 'Saving...' : saved ? 'Saved \u2713' : 'Save Omni Config'}
    </button>
  );
}
