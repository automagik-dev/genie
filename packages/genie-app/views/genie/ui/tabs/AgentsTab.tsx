import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface AgentTemplate {
  id: string;
  provider?: string;
  team?: string;
  role?: string;
  skill?: string;
  cwd?: string;
  extra_args?: string | string[];
  native_team_enabled?: boolean;
  auto_resume?: boolean;
  max_resume_attempts?: number;
  pane_color?: string;
  last_spawned_at?: string;
}

interface AgentsTabProps {
  templates: AgentTemplate[];
  onSave: (tpl: AgentTemplate) => Promise<void>;
  onCreate: () => void;
}

// ============================================================================
// Styles
// ============================================================================

const s = {
  root: {
    display: 'flex',
    height: '100%',
    gap: '0',
  },
  listPanel: {
    width: '260px',
    borderRight: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  listHeader: {
    padding: '12px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listTitle: { fontSize: '12px', fontWeight: 600, color: theme.text },
  listScroll: { flex: 1, overflowY: 'auto' as const },
  row: (selected: boolean) => ({
    padding: '10px 12px',
    cursor: 'pointer',
    borderLeft: `3px solid ${selected ? theme.violet : 'transparent'}`,
    backgroundColor: selected ? theme.bgCardHover : 'transparent',
    transition: 'background-color 0.1s',
  }),
  rowName: { fontSize: '12px', color: theme.text, fontWeight: 500 },
  rowMeta: { fontSize: '10px', color: theme.textMuted, marginTop: '2px' },
  formPanel: { flex: 1, padding: '20px', overflowY: 'auto' as const },
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
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' },
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
  select: {
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: theme.fontFamily,
    backgroundColor: theme.bgCard,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    outline: 'none',
    width: '100%',
    cursor: 'pointer',
    appearance: 'auto' as const,
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: `1px solid ${theme.border}`,
  },
  toggleLabel: { fontSize: '12px', color: theme.text },
} as const;

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={s.toggleRow}>
      <span style={s.toggleLabel}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-pressed={value}
        aria-label={label}
        style={{
          width: '36px',
          height: '20px',
          borderRadius: '10px',
          backgroundColor: value ? theme.violet : theme.border,
          border: 'none',
          cursor: 'pointer',
          position: 'relative',
          transition: 'background-color 0.2s',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: '2px',
            left: value ? '18px' : '2px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: theme.text,
            transition: 'left 0.2s',
          }}
        />
      </button>
    </div>
  );
}

// ============================================================================
// Template Edit Form
// ============================================================================

function getExtraArgsStr(extra_args: AgentTemplate['extra_args']): string {
  return Array.isArray(extra_args) ? extra_args.join(' ') : (extra_args ?? '');
}

function TemplateFormEmpty() {
  return (
    <div
      style={{
        ...s.formPanel,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.textMuted,
        fontSize: '13px',
      }}
    >
      Select a template to edit
    </div>
  );
}

function TemplateForm({
  template,
  onSave,
}: {
  template: AgentTemplate | null;
  onSave: (tpl: AgentTemplate) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentTemplate | null>(template);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(template);
    setSaved(false);
  }, [template]);

  const update = useCallback(<K extends keyof AgentTemplate>(key: K, value: AgentTemplate[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await onSave(draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }, [draft, onSave]);

  if (!draft) {
    return <TemplateFormEmpty />;
  }

  const extraArgsStr = getExtraArgsStr(draft.extra_args);
  const saveLabel = saving ? 'Saving...' : saved ? 'Saved \u2713' : 'Save Template';

  return (
    <div style={s.formPanel}>
      <div style={s.sectionTitle}>Edit Template: {draft.id}</div>

      <div style={s.grid}>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-id">
            ID
          </label>
          <input id="tpl-id" style={s.input} value={draft.id} onChange={(e) => update('id', e.target.value)} />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-provider">
            Provider
          </label>
          <select
            id="tpl-provider"
            style={s.select}
            value={draft.provider ?? 'claude'}
            onChange={(e) => update('provider', e.target.value)}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="claude-sdk">claude-sdk</option>
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-team">
            Team
          </label>
          <input
            id="tpl-team"
            style={s.input}
            value={draft.team ?? ''}
            onChange={(e) => update('team', e.target.value)}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-role">
            Role
          </label>
          <input
            id="tpl-role"
            style={s.input}
            value={draft.role ?? ''}
            onChange={(e) => update('role', e.target.value)}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-skill">
            Skill
          </label>
          <input
            id="tpl-skill"
            style={s.input}
            value={draft.skill ?? ''}
            placeholder="e.g. engineer"
            onChange={(e) => update('skill', e.target.value)}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-cwd">
            Working Directory
          </label>
          <input
            id="tpl-cwd"
            style={s.input}
            value={draft.cwd ?? ''}
            placeholder="e.g. ~/projects/my-app"
            onChange={(e) => update('cwd', e.target.value)}
          />
        </div>
        <div style={{ ...s.field, gridColumn: '1 / -1' }}>
          <label style={s.label} htmlFor="tpl-extra-args">
            Extra Args (space-separated)
          </label>
          <input
            id="tpl-extra-args"
            style={s.input}
            value={extraArgsStr}
            placeholder="e.g. --verbose --no-color"
            onChange={(e) => update('extra_args', e.target.value ? e.target.value.split(/\s+/).filter(Boolean) : [])}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-pane-color">
            Pane Color
          </label>
          <input
            id="tpl-pane-color"
            style={s.input}
            value={draft.pane_color ?? ''}
            placeholder="e.g. cyan"
            onChange={(e) => update('pane_color', e.target.value)}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="tpl-max-resume">
            Max Resume Attempts
          </label>
          <input
            id="tpl-max-resume"
            type="number"
            style={s.input}
            value={draft.max_resume_attempts ?? ''}
            placeholder="e.g. 3"
            onChange={(e) => update('max_resume_attempts', e.target.value ? Number(e.target.value) : undefined)}
          />
        </div>
      </div>

      <Toggle
        label="Native Team Enabled"
        value={draft.native_team_enabled ?? false}
        onChange={(v) => update('native_team_enabled', v)}
      />
      <Toggle label="Auto Resume" value={draft.auto_resume ?? false} onChange={(v) => update('auto_resume', v)} />

      <div style={{ marginTop: '16px' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
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
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// AgentsTab
// ============================================================================

export function AgentsTab({ templates, onSave, onCreate }: AgentsTabProps) {
  const [selected, setSelected] = useState<AgentTemplate | null>(null);

  const handleSave = useCallback(
    async (tpl: AgentTemplate) => {
      await onSave(tpl);
      // Update local selection
      setSelected(tpl);
    },
    [onSave],
  );

  return (
    <div style={s.root}>
      {/* Left: template list */}
      <div style={s.listPanel}>
        <div style={s.listHeader}>
          <span style={s.listTitle}>Templates ({templates.length})</span>
          <button
            type="button"
            onClick={onCreate}
            style={{
              padding: '3px 10px',
              fontSize: '11px',
              fontFamily: theme.fontFamily,
              backgroundColor: theme.violet,
              color: theme.bg,
              border: 'none',
              borderRadius: theme.radiusSm,
              cursor: 'pointer',
            }}
          >
            + New
          </button>
        </div>
        <div style={s.listScroll}>
          {templates.length === 0 ? (
            <div style={{ padding: '16px', fontSize: '12px', color: theme.textMuted }}>No templates found</div>
          ) : (
            templates.map((tpl) => (
              <button
                type="button"
                key={tpl.id}
                style={{
                  ...s.row(selected?.id === tpl.id),
                  border: 'none',
                  background: 'none',
                  textAlign: 'left' as const,
                  width: '100%',
                  font: 'inherit',
                }}
                onClick={() => setSelected(tpl)}
              >
                <div style={s.rowName}>{tpl.id}</div>
                <div style={s.rowMeta}>
                  {[tpl.provider ?? 'claude', tpl.role, tpl.skill].filter(Boolean).join(' \u00b7 ')}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right: edit form */}
      <TemplateForm template={selected} onSave={handleSave} />
    </div>
  );
}
