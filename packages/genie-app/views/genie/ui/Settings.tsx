import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';
import { ErrorState } from '../../shared/ErrorState';
import { LoadingState } from '../../shared/LoadingState';

import { type AgentTemplate, AgentsTab } from './tabs/AgentsTab';
import { type CouncilPreset, CouncilPresetsTab } from './tabs/CouncilPresetsTab';
import { GeneralTab, type GenieSettings } from './tabs/GeneralTab';
import { type OmniConfig, OmniTab } from './tabs/OmniTab';
import { type RuleEntry, RulesTab } from './tabs/RulesTab';
import { type SkillEntry, SkillsTab } from './tabs/SkillsTab';
import { type WorkerProfile, WorkerProfilesTab } from './tabs/WorkerProfilesTab';
import { type OtelConfig, type WorkspaceConfig, WorkspaceTab } from './tabs/WorkspaceTab';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

// ============================================================================
// Types
// ============================================================================

interface FullConfig extends GenieSettings {
  workerProfiles?: Record<string, WorkerProfile>;
  defaultWorkerProfile?: string;
  councilPresets?: Record<string, CouncilPreset>;
  defaultCouncilPreset?: string;
  omni?: OmniConfig;
  otel?: OtelConfig;
}

type TabKey = 'general' | 'workspace' | 'agents' | 'skills' | 'rules' | 'workerProfiles' | 'councilPresets' | 'omni';

const FULL_HEIGHT_TABS = new Set<TabKey>(['agents', 'rules', 'workerProfiles', 'councilPresets']);

interface TabDef {
  key: TabKey;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'general', label: 'General' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'rules', label: 'Rules' },
  { key: 'workerProfiles', label: 'Worker Profiles' },
  { key: 'councilPresets', label: 'Council Presets' },
  { key: 'omni', label: 'Omni' },
];

// ============================================================================
// Toast Component
// ============================================================================

interface ToastProps {
  message: string;
  type: 'success' | 'error';
  onDismiss: () => void;
}

function Toast({ message, type, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '40px',
        right: '24px',
        padding: '10px 18px',
        backgroundColor: type === 'success' ? 'rgba(52, 211, 153, 0.15)' : 'rgba(248, 113, 113, 0.15)',
        border: `1px solid ${type === 'success' ? theme.success : theme.error}`,
        borderRadius: theme.radiusMd,
        fontSize: '12px',
        fontFamily: theme.fontFamily,
        color: type === 'success' ? theme.success : theme.error,
        zIndex: 9999,
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span>{type === 'success' ? '\u2713' : '\u2717'}</span>
      {message}
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: '14px',
          padding: '0 0 0 8px',
          fontFamily: theme.fontFamily,
        }}
        aria-label="Dismiss"
      >
        \u00d7
      </button>
    </div>
  );
}

// ============================================================================
// SettingsTabContent — extracted to reduce cognitive complexity
// ============================================================================

interface TabContentProps {
  activeTab: TabKey;
  config: FullConfig;
  workspace: WorkspaceConfig & { path?: string; pgservePort?: number; dataDir?: string };
  templates: AgentTemplate[];
  skills: SkillEntry[];
  rules: RuleEntry[];
  saving: boolean;
  saved: boolean;
  setConfig: React.Dispatch<React.SetStateAction<FullConfig>>;
  saveKey: (key: string, value: unknown) => Promise<void>;
  saveTemplate: (tpl: AgentTemplate) => Promise<void>;
  createTemplate: () => void;
  testPg: () => Promise<{ ok: boolean; message: string }>;
  saveWorkerProfiles: (profiles: Record<string, WorkerProfile>, defaultProfile?: string) => Promise<void>;
  saveCouncilPresets: (presets: Record<string, CouncilPreset>, defaultPreset?: string) => Promise<void>;
  saveOmni: (omni: OmniConfig) => Promise<void>;
}

function SettingsTabContent({
  activeTab,
  config,
  workspace,
  templates,
  skills,
  rules,
  saving,
  saved,
  setConfig,
  saveKey,
  saveTemplate,
  createTemplate,
  testPg,
  saveWorkerProfiles,
  saveCouncilPresets,
  saveOmni,
}: TabContentProps) {
  switch (activeTab) {
    case 'general':
      return (
        <GeneralTab
          config={config}
          onChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
          onSave={saveKey}
          saving={saving}
          saved={saved}
        />
      );
    case 'workspace':
      return (
        <WorkspaceTab
          workspace={workspace}
          otel={config.otel ?? {}}
          pgservePort={workspace.pgservePort}
          dataDir={workspace.dataDir}
          onSave={saveKey}
          onTestPg={testPg}
        />
      );
    case 'agents':
      return <AgentsTab templates={templates} onSave={saveTemplate} onCreate={createTemplate} />;
    case 'skills':
      return <SkillsTab skills={skills} />;
    case 'rules':
      return <RulesTab rules={rules} />;
    case 'workerProfiles':
      return (
        <WorkerProfilesTab
          profiles={config.workerProfiles ?? {}}
          defaultProfile={config.defaultWorkerProfile}
          onSave={saveWorkerProfiles}
        />
      );
    case 'councilPresets':
      return (
        <CouncilPresetsTab
          presets={config.councilPresets ?? {}}
          defaultPreset={config.defaultCouncilPreset}
          onSave={saveCouncilPresets}
        />
      );
    case 'omni':
      return <OmniTab omni={config.omni ?? null} onSave={saveOmni} />;
    default:
      return null;
  }
}

// ============================================================================
// Settings Component (main export)
// ============================================================================

export function Settings({ windowId }: AppComponentProps) {
  const nats = useNats();

  // Data state
  const [config, setConfig] = useState<FullConfig>({});
  const [workspace, setWorkspace] = useState<
    WorkspaceConfig & { path?: string; pgservePort?: number; dataDir?: string }
  >({});
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [rules, setRules] = useState<RuleEntry[]>([]);

  // UI state
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ---- Data Fetching ----

  const fetchAll = useCallback(async () => {
    try {
      const [settingsData, templatesData, skillsData, rulesData] = await Promise.all([
        nats.request<{ config: FullConfig; workspace: Record<string, unknown> }>(GENIE_SUBJECTS.settings.get(ORG_ID)),
        nats.request<AgentTemplate[]>(GENIE_SUBJECTS.settings.templates(ORG_ID)),
        nats.request<SkillEntry[]>(GENIE_SUBJECTS.settings.skills(ORG_ID)),
        nats.request<RuleEntry[]>(GENIE_SUBJECTS.settings.rules(ORG_ID)),
      ]);

      const cfg = (settingsData?.config ?? {}) as FullConfig;
      const ws = (settingsData?.workspace ?? {}) as WorkspaceConfig & {
        path?: string;
        pgservePort?: number;
        dataDir?: string;
      };

      setConfig(cfg);
      setWorkspace(ws);
      setTemplates(Array.isArray(templatesData) ? templatesData : []);
      setSkills(Array.isArray(skillsData) ? skillsData : []);
      setRules(Array.isArray(rulesData) ? rulesData : []);
      setLoadState('ready');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoadState('error');
    }
  }, [nats]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ---- Save Helpers ----

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  const saveKey = useCallback(
    async (key: string, value: unknown): Promise<void> => {
      setSaving(true);
      try {
        const result = await nats.request<{ ok: boolean; error?: string }>(GENIE_SUBJECTS.settings.set(ORG_ID), {
          key,
          value,
        });
        if (result?.ok) {
          setSaved(true);
          showToast(`Saved ${key}`, 'success');
          setTimeout(() => setSaved(false), 2000);
        } else {
          showToast(`Failed to save ${key}: ${result?.error ?? 'unknown error'}`, 'error');
        }
      } catch (err) {
        showToast(`Error saving ${key}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        setSaving(false);
      }
    },
    [nats, showToast],
  );

  const saveTemplate = useCallback(
    async (tpl: AgentTemplate): Promise<void> => {
      setSaving(true);
      try {
        const result = await nats.request<{ ok: boolean; error?: string }>(
          GENIE_SUBJECTS.settings.templateSave(ORG_ID),
          tpl,
        );
        if (result?.ok) {
          showToast(`Saved template ${tpl.id}`, 'success');
          // Refresh templates list
          const fresh = await nats.request<AgentTemplate[]>(GENIE_SUBJECTS.settings.templates(ORG_ID));
          setTemplates(Array.isArray(fresh) ? fresh : []);
        } else {
          showToast(`Failed to save template: ${result?.error ?? 'unknown error'}`, 'error');
        }
      } catch (err) {
        showToast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        setSaving(false);
      }
    },
    [nats, showToast],
  );

  const testPg = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const result = await nats.request<{ ok: boolean; message: string }>(GENIE_SUBJECTS.settings.testPg(ORG_ID));
      return result ?? { ok: false, message: 'No response from backend' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }, [nats]);

  const saveWorkerProfiles = useCallback(
    async (profiles: Record<string, WorkerProfile>, defaultProfile?: string): Promise<void> => {
      await saveKey('workerProfiles', profiles);
      if (defaultProfile !== undefined) {
        await saveKey('defaultWorkerProfile', defaultProfile);
      }
      setConfig((prev) => ({ ...prev, workerProfiles: profiles, defaultWorkerProfile: defaultProfile }));
    },
    [saveKey],
  );

  const saveCouncilPresets = useCallback(
    async (presets: Record<string, CouncilPreset>, defaultPreset?: string): Promise<void> => {
      await saveKey('councilPresets', presets);
      if (defaultPreset !== undefined) {
        await saveKey('defaultCouncilPreset', defaultPreset);
      }
      setConfig((prev) => ({ ...prev, councilPresets: presets, defaultCouncilPreset: defaultPreset }));
    },
    [saveKey],
  );

  const saveOmni = useCallback(
    async (omni: OmniConfig): Promise<void> => {
      await saveKey('omni', omni);
      setConfig((prev) => ({ ...prev, omni }));
    },
    [saveKey],
  );

  const createTemplate = useCallback(() => {
    const newId = `template-${Date.now()}`;
    saveTemplate({ id: newId, provider: 'claude', team: '', role: '', skill: '', cwd: '', extra_args: [] });
  }, [saveTemplate]);

  // ---- Render ----

  if (loadState === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading settings..." />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={loadError ?? 'Failed to load settings'} service="settings.get" onRetry={fetchAll} />
      </div>
    );
  }

  const isFullHeight = FULL_HEIGHT_TABS.has(activeTab);
  const tabContentStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: isFullHeight ? '0' : '20px',
    height: isFullHeight ? '100%' : undefined,
  };

  return (
    <div
      data-window-id={windowId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: theme.bg,
        color: theme.text,
        fontFamily: theme.fontFamily,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 20px 0',
          borderBottom: `1px solid ${theme.border}`,
          flexShrink: 0,
        }}
      >
        <h1
          style={{
            fontSize: '16px',
            fontWeight: 600,
            color: theme.text,
            margin: '0 0 12px',
          }}
        >
          Settings
        </h1>

        {/* Tab bar */}
        <div
          style={{
            display: 'flex',
            gap: '0',
            overflowX: 'auto',
          }}
        >
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '7px 14px',
                fontSize: '12px',
                fontFamily: theme.fontFamily,
                color: activeTab === tab.key ? theme.text : theme.textMuted,
                backgroundColor: 'transparent',
                border: 'none',
                borderBottom: `2px solid ${activeTab === tab.key ? theme.violet : 'transparent'}`,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.15s ease, border-color 0.15s ease',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div style={tabContentStyle}>
        <SettingsTabContent
          activeTab={activeTab}
          config={config}
          workspace={workspace}
          templates={templates}
          skills={skills}
          rules={rules}
          saving={saving}
          saved={saved}
          setConfig={setConfig}
          saveKey={saveKey}
          saveTemplate={saveTemplate}
          createTemplate={createTemplate}
          testPg={testPg}
          saveWorkerProfiles={saveWorkerProfiles}
          saveCouncilPresets={saveCouncilPresets}
          saveOmni={saveOmni}
        />
      </div>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}
