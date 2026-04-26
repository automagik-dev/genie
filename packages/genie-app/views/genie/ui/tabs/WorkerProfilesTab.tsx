import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface WorkerProfile {
  launcher: string;
  claudeArgs: string[];
}

interface WorkerProfilesTabProps {
  profiles: Record<string, WorkerProfile>;
  defaultProfile?: string;
  onSave: (profiles: Record<string, WorkerProfile>, defaultProfile?: string) => Promise<void>;
}

// ============================================================================
// Styles
// ============================================================================

const s = {
  root: { display: 'flex', height: '100%' },
  listPanel: {
    width: '220px',
    borderRight: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  listHeader: {
    padding: '10px 12px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listTitle: { fontSize: '12px', fontWeight: 600, color: theme.text },
  row: (selected: boolean) => ({
    padding: '10px 12px',
    cursor: 'pointer',
    borderLeft: `3px solid ${selected ? theme.violet : 'transparent'}`,
    backgroundColor: selected ? theme.bgCardHover : 'transparent',
  }),
  rowName: (isDefault: boolean) => ({
    fontSize: '12px',
    color: isDefault ? theme.purple : theme.text,
    fontWeight: isDefault ? 600 : 500,
  }),
  formPanel: { flex: 1, padding: '20px', overflowY: 'auto' as const },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', marginBottom: '14px' },
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
} as const;

// ============================================================================
// WorkerProfilesTab
// ============================================================================

export function WorkerProfilesTab({ profiles, defaultProfile, onSave }: WorkerProfilesTabProps) {
  const [localProfiles, setLocalProfiles] = useState<Record<string, WorkerProfile>>(profiles);
  const [localDefault, setLocalDefault] = useState<string | undefined>(defaultProfile);
  const [selectedKey, setSelectedKey] = useState<string | null>(Object.keys(profiles)[0] ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    setLocalProfiles(profiles);
    setLocalDefault(defaultProfile);
    setDirty(false);
  }, [profiles, defaultProfile]);

  const selected = selectedKey ? localProfiles[selectedKey] : null;

  const updateSelected = useCallback(
    (patch: Partial<WorkerProfile>) => {
      if (!selectedKey) return;
      setLocalProfiles((prev) => ({
        ...prev,
        [selectedKey]: { ...prev[selectedKey], ...patch },
      }));
      setDirty(true);
    },
    [selectedKey],
  );

  const addProfile = useCallback(() => {
    const name = newName.trim();
    if (!name || localProfiles[name]) return;
    setLocalProfiles((prev) => ({
      ...prev,
      [name]: { launcher: 'claude', claudeArgs: [] },
    }));
    setSelectedKey(name);
    setNewName('');
    setDirty(true);
  }, [newName, localProfiles]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(localProfiles, localDefault);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [onSave, localProfiles, localDefault]);

  return (
    <div style={s.root}>
      {/* Left: profile list */}
      <div style={s.listPanel}>
        <div style={s.listHeader}>
          <span style={s.listTitle}>Profiles ({Object.keys(localProfiles).length})</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {Object.keys(localProfiles).length === 0 ? (
            <div style={{ padding: '12px', fontSize: '11px', color: theme.textMuted }}>No profiles</div>
          ) : (
            Object.keys(localProfiles).map((key) => (
              <button
                type="button"
                key={key}
                style={{
                  ...s.row(selectedKey === key),
                  border: 'none',
                  background: s.row(selectedKey === key).backgroundColor,
                  textAlign: 'left',
                  width: '100%',
                  font: 'inherit',
                  color: 'inherit',
                }}
                onClick={() => setSelectedKey(key)}
              >
                <div style={s.rowName(key === localDefault)}>{key}</div>
                {key === localDefault && <div style={{ fontSize: '10px', color: theme.purple }}>default</div>}
              </button>
            ))
          )}
        </div>
        {/* Add profile */}
        <div style={{ padding: '10px 12px', borderTop: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              style={{
                ...s.input,
                flex: 1,
                padding: '4px 8px',
                fontSize: '11px',
              }}
              placeholder="New profile name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addProfile()}
            />
            <button
              type="button"
              onClick={addProfile}
              disabled={!newName.trim()}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontFamily: theme.fontFamily,
                backgroundColor: theme.violet,
                color: theme.bg,
                border: 'none',
                borderRadius: theme.radiusSm,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Right: form */}
      <div style={s.formPanel}>
        {!selected || !selectedKey ? (
          <div style={{ color: theme.textMuted, fontSize: '13px' }}>Select a profile to edit</div>
        ) : (
          <>
            <div style={{ marginBottom: '20px', fontSize: '14px', fontWeight: 600, color: theme.text }}>
              {selectedKey}
            </div>

            <div style={s.field}>
              <label style={s.label} htmlFor="wp-launcher">
                Launcher
              </label>
              <input
                id="wp-launcher"
                style={s.input}
                value={selected.launcher}
                onChange={(e) => updateSelected({ launcher: e.target.value })}
              />
            </div>
            <div style={s.field}>
              <label style={s.label} htmlFor="wp-args">
                Claude Args (space-separated)
              </label>
              <input
                id="wp-args"
                style={s.input}
                value={selected.claudeArgs.join(' ')}
                placeholder="e.g. --verbose --model claude-opus-4-5"
                onChange={(e) =>
                  updateSelected({ claudeArgs: e.target.value ? e.target.value.split(/\s+/).filter(Boolean) : [] })
                }
              />
            </div>

            {/* Default profile selector */}
            <div style={{ ...s.field, marginTop: '20px' }}>
              <label style={s.label} htmlFor="wp-default">
                Default Profile
              </label>
              <select
                id="wp-default"
                style={{
                  ...s.input,
                  cursor: 'pointer',
                  appearance: 'auto' as const,
                }}
                value={localDefault ?? ''}
                onChange={(e) => {
                  setLocalDefault(e.target.value || undefined);
                  setDirty(true);
                }}
              >
                <option value="">-- none --</option>
                {Object.keys(localProfiles).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>

            {dirty && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  marginTop: '16px',
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
                {saving ? 'Saving...' : 'Save Profiles'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
