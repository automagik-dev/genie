import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface GenieSettings {
  version?: number;
  session?: { name?: string; defaultWindow?: string; autoCreate?: boolean };
  terminal?: { execTimeout?: number; readLines?: number; worktreeBase?: string };
  shell?: { preference?: 'auto' | 'zsh' | 'bash' | 'fish' };
  logging?: { tmuxDebug?: boolean; verbose?: boolean };
  updateChannel?: 'latest' | 'next';
  installMethod?: 'source' | 'npm' | 'bun';
  promptMode?: 'append' | 'system';
  autoMergeDev?: boolean;
  defaultProject?: string;
}

interface GeneralTabProps {
  config: GenieSettings;
  onChange: (patch: Partial<GenieSettings>) => void;
  onSave: (key: string, value: unknown) => Promise<void>;
  saving: boolean;
  saved: boolean;
}

interface SectionProps {
  draft: GenieSettings;
  update: (path: string, value: unknown) => void;
}

// ============================================================================
// Styles
// ============================================================================

const s = {
  section: {
    marginBottom: '24px',
  },
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
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  label: {
    fontSize: '11px',
    color: theme.textDim,
  },
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
  toggleLabel: {
    fontSize: '12px',
    color: theme.text,
  },
  toggleDesc: {
    fontSize: '10px',
    color: theme.textMuted,
  },
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

// ============================================================================
// Toggle Component
// ============================================================================

function Toggle({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
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
// Section Components
// ============================================================================

function SessionSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Session</div>
      <div style={s.grid}>
        <div style={s.field}>
          <label style={s.label} htmlFor="session-name">
            Session Name
          </label>
          <input
            id="session-name"
            style={s.input}
            value={draft.session?.name ?? 'genie'}
            onChange={(e) => update('session.name', e.target.value)}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="session-window">
            Default Window
          </label>
          <input
            id="session-window"
            style={s.input}
            value={draft.session?.defaultWindow ?? 'shell'}
            onChange={(e) => update('session.defaultWindow', e.target.value)}
          />
        </div>
      </div>
      <div style={{ marginTop: '8px' }}>
        <Toggle
          label="Auto Create"
          desc="Automatically create session on startup"
          value={draft.session?.autoCreate ?? true}
          onChange={(v) => update('session.autoCreate', v)}
        />
      </div>
    </div>
  );
}

function TerminalSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Terminal</div>
      <div style={s.grid}>
        <div style={s.field}>
          <label style={s.label} htmlFor="exec-timeout">
            Exec Timeout (ms)
          </label>
          <input
            id="exec-timeout"
            type="number"
            style={s.input}
            value={draft.terminal?.execTimeout ?? 120000}
            onChange={(e) => update('terminal.execTimeout', Number(e.target.value))}
          />
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="read-lines">
            Read Lines
          </label>
          <input
            id="read-lines"
            type="number"
            style={s.input}
            value={draft.terminal?.readLines ?? 100}
            onChange={(e) => update('terminal.readLines', Number(e.target.value))}
          />
        </div>
        <div style={{ ...s.field, gridColumn: '1 / -1' }}>
          <label style={s.label} htmlFor="worktree-base">
            Worktree Base
          </label>
          <input
            id="worktree-base"
            style={s.input}
            value={draft.terminal?.worktreeBase ?? ''}
            placeholder="e.g. ~/worktrees"
            onChange={(e) => update('terminal.worktreeBase', e.target.value || undefined)}
          />
        </div>
      </div>
    </div>
  );
}

function ShellSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Shell</div>
      <div style={{ maxWidth: '240px' }}>
        <div style={s.field}>
          <label style={s.label} htmlFor="shell-pref">
            Shell Preference
          </label>
          <select
            id="shell-pref"
            style={s.select}
            value={draft.shell?.preference ?? 'auto'}
            onChange={(e) => update('shell.preference', e.target.value)}
          >
            <option value="auto">Auto-detect</option>
            <option value="zsh">zsh</option>
            <option value="bash">bash</option>
            <option value="fish">fish</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function LoggingSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Logging</div>
      <Toggle
        label="Tmux Debug"
        desc="Enable verbose tmux command logging"
        value={draft.logging?.tmuxDebug ?? false}
        onChange={(v) => update('logging.tmuxDebug', v)}
      />
      <Toggle
        label="Verbose"
        desc="Enable verbose CLI output"
        value={draft.logging?.verbose ?? false}
        onChange={(v) => update('logging.verbose', v)}
      />
    </div>
  );
}

function UpdatesSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Updates</div>
      <div style={s.grid}>
        <div style={s.field}>
          <label style={s.label} htmlFor="update-channel">
            Update Channel
          </label>
          <select
            id="update-channel"
            style={s.select}
            value={draft.updateChannel ?? 'latest'}
            onChange={(e) => update('updateChannel', e.target.value)}
          >
            <option value="latest">latest (stable)</option>
            <option value="next">next (dev builds)</option>
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="install-method">
            Install Method
          </label>
          <select
            id="install-method"
            style={s.select}
            value={draft.installMethod ?? ''}
            onChange={(e) => update('installMethod', e.target.value || undefined)}
          >
            <option value="">-- unset --</option>
            <option value="source">source</option>
            <option value="npm">npm</option>
            <option value="bun">bun</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function PromptsSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Prompts</div>
      <div style={{ maxWidth: '240px' }}>
        <div style={s.field}>
          <label style={s.label} htmlFor="prompt-mode">
            Prompt Mode
          </label>
          <select
            id="prompt-mode"
            style={s.select}
            value={draft.promptMode ?? 'append'}
            onChange={(e) => update('promptMode', e.target.value)}
          >
            <option value="append">append (preserve CC default)</option>
            <option value="system">system (replace CC default)</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function ProjectSection({ draft, update }: SectionProps) {
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>Project</div>
      <Toggle
        label="Auto-merge to Dev"
        desc="Task leaders auto-merge approved PRs to dev branch"
        value={draft.autoMergeDev ?? false}
        onChange={(v) => update('autoMergeDev', v)}
      />
      <div style={{ marginTop: '12px', ...s.field }}>
        <label style={s.label} htmlFor="default-project">
          Default Project
        </label>
        <input
          id="default-project"
          style={s.input}
          value={draft.defaultProject ?? ''}
          placeholder="e.g. my-project"
          onChange={(e) => update('defaultProject', e.target.value || undefined)}
        />
      </div>
    </div>
  );
}

function SaveButton({
  dirty,
  saving,
  saved,
  onSave,
}: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <div style={{ paddingTop: '8px' }}>
      <button
        type="button"
        disabled={!dirty || saving}
        onClick={onSave}
        style={{
          padding: '8px 20px',
          fontSize: '12px',
          fontFamily: theme.fontFamily,
          backgroundColor: dirty ? theme.violet : theme.bgCard,
          color: dirty ? theme.bg : theme.textMuted,
          border: `1px solid ${dirty ? theme.violet : theme.border}`,
          borderRadius: theme.radiusSm,
          cursor: dirty ? 'pointer' : 'default',
          transition: 'all 0.2s ease',
        }}
      >
        {saving ? 'Saving...' : saved && !dirty ? 'Saved' : 'Save Changes'}
      </button>
    </div>
  );
}

// ============================================================================
// GeneralTab
// ============================================================================

export function GeneralTab({ config, onChange, onSave, saving, saved }: GeneralTabProps) {
  const [draft, setDraft] = useState<GenieSettings>(config);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(config);
    setDirty(false);
  }, [config]);

  const update = useCallback(
    (path: string, value: unknown) => {
      const parts = path.split('.');
      const patch = { ...draft };
      // biome-ignore lint/suspicious/noExplicitAny: deep update
      let cur: any = patch;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...(cur[parts[i]] ?? {}) };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      setDraft(patch);
      onChange(patch);
      setDirty(true);
    },
    [draft, onChange],
  );

  const handleSaveAll = useCallback(async () => {
    const keys: (keyof GenieSettings)[] = [
      'session',
      'terminal',
      'shell',
      'logging',
      'updateChannel',
      'installMethod',
      'promptMode',
      'autoMergeDev',
      'defaultProject',
    ];
    for (const key of keys) {
      if (draft[key] !== undefined) {
        await onSave(key, draft[key]);
      }
    }
    setDirty(false);
  }, [draft, onSave]);

  return (
    <div>
      <SessionSection draft={draft} update={update} />
      <TerminalSection draft={draft} update={update} />
      <ShellSection draft={draft} update={update} />
      <LoggingSection draft={draft} update={update} />
      <UpdatesSection draft={draft} update={update} />
      <PromptsSection draft={draft} update={update} />
      <ProjectSection draft={draft} update={update} />
      <SaveButton dirty={dirty} saving={saving} saved={saved} onSave={handleSaveAll} />
    </div>
  );
}
