import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface CouncilPreset {
  left: string;
  right: string;
  skill: string;
}

interface CouncilPresetsTabProps {
  presets: Record<string, CouncilPreset>;
  defaultPreset?: string;
  onSave: (presets: Record<string, CouncilPreset>, defaultPreset?: string) => Promise<void>;
}

// ============================================================================
// Styles
// ============================================================================

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

// ============================================================================
// CouncilPresetsTab
// ============================================================================

export function CouncilPresetsTab({ presets, defaultPreset, onSave }: CouncilPresetsTabProps) {
  const [localPresets, setLocalPresets] = useState<Record<string, CouncilPreset>>(presets);
  const [localDefault, setLocalDefault] = useState<string | undefined>(defaultPreset);
  const [selectedKey, setSelectedKey] = useState<string | null>(Object.keys(presets)[0] ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    setLocalPresets(presets);
    setLocalDefault(defaultPreset);
    setDirty(false);
  }, [presets, defaultPreset]);

  const selected = selectedKey ? localPresets[selectedKey] : null;

  const updateSelected = useCallback(
    (patch: Partial<CouncilPreset>) => {
      if (!selectedKey) return;
      setLocalPresets((prev) => ({
        ...prev,
        [selectedKey]: { ...prev[selectedKey], ...patch },
      }));
      setDirty(true);
    },
    [selectedKey],
  );

  const addPreset = useCallback(() => {
    const name = newName.trim();
    if (!name || localPresets[name]) return;
    setLocalPresets((prev) => ({
      ...prev,
      [name]: { left: 'default', right: 'default', skill: 'council' },
    }));
    setSelectedKey(name);
    setNewName('');
    setDirty(true);
  }, [newName, localPresets]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(localPresets, localDefault);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [onSave, localPresets, localDefault]);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left: preset list */}
      <div
        style={{
          width: '220px',
          borderRight: `1px solid ${theme.border}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: `1px solid ${theme.border}`,
            fontSize: '12px',
            fontWeight: 600,
            color: theme.text,
          }}
        >
          Presets ({Object.keys(localPresets).length})
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {Object.keys(localPresets).length === 0 ? (
            <div style={{ padding: '12px', fontSize: '11px', color: theme.textMuted }}>No presets</div>
          ) : (
            Object.keys(localPresets).map((key) => (
              <button
                type="button"
                key={key}
                onClick={() => setSelectedKey(key)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  background: selectedKey === key ? theme.bgCardHover : 'transparent',
                  border: 'none',
                  borderLeft: `3px solid ${selectedKey === key ? theme.violet : 'transparent'}`,
                  textAlign: 'left',
                  width: '100%',
                  font: 'inherit',
                  color: 'inherit',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    color: key === localDefault ? theme.purple : theme.text,
                    fontWeight: key === localDefault ? 600 : 500,
                  }}
                >
                  {key}
                </div>
                {key === localDefault && <div style={{ fontSize: '10px', color: theme.purple }}>default</div>}
                <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>
                  {localPresets[key].left} \u00b7 {localPresets[key].right}
                </div>
              </button>
            ))
          )}
        </div>
        {/* Add preset */}
        <div style={{ padding: '10px 12px', borderTop: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              style={{ ...inputStyle, padding: '4px 8px', fontSize: '11px', flex: 1 }}
              placeholder="New preset name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPreset()}
            />
            <button
              type="button"
              onClick={addPreset}
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
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Right: form */}
      <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
        {!selected || !selectedKey ? (
          <div style={{ color: theme.textMuted, fontSize: '13px' }}>Select a preset to edit</div>
        ) : (
          <>
            <div style={{ marginBottom: '20px', fontSize: '14px', fontWeight: 600, color: theme.text }}>
              {selectedKey}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: theme.textDim }} htmlFor="cp-left">
                  Left Profile
                </label>
                <input
                  id="cp-left"
                  style={inputStyle}
                  value={selected.left}
                  onChange={(e) => updateSelected({ left: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: theme.textDim }} htmlFor="cp-right">
                  Right Profile
                </label>
                <input
                  id="cp-right"
                  style={inputStyle}
                  value={selected.right}
                  onChange={(e) => updateSelected({ right: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: theme.textDim }} htmlFor="cp-skill">
                  Skill
                </label>
                <input
                  id="cp-skill"
                  style={inputStyle}
                  value={selected.skill}
                  onChange={(e) => updateSelected({ skill: e.target.value })}
                />
              </div>
            </div>

            {/* Default preset selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '20px', maxWidth: '200px' }}>
              <label style={{ fontSize: '11px', color: theme.textDim }} htmlFor="cp-default">
                Default Preset
              </label>
              <select
                id="cp-default"
                style={{ ...inputStyle, cursor: 'pointer', appearance: 'auto' as const }}
                value={localDefault ?? ''}
                onChange={(e) => {
                  setLocalDefault(e.target.value || undefined);
                  setDirty(true);
                }}
              >
                <option value="">-- none --</option>
                {Object.keys(localPresets).map((k) => (
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
                  marginTop: '20px',
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
                {saving ? 'Saving...' : 'Save Presets'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
