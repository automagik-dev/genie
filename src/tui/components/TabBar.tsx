/** @jsxImportSource @opentui/react */
/** Horizontal tab bar: Projects | tmux | Executors — left/right to switch */

import { palette } from '../theme.js';

export type TabId = 'projects' | 'tmux' | 'claude';

export const TAB_ORDER: TabId[] = ['projects', 'tmux', 'claude'];

const TAB_LABELS: Record<TabId, string> = {
  projects: 'Projects',
  tmux: 'tmux',
  claude: 'Executors',
};

interface TabBarProps {
  activeTab: TabId;
  focused: boolean;
  gaps?: { orphanProcesses: number; orphanPanes: number; deadPanes: number };
}

function tabBadge(tab: TabId, gaps: TabBarProps['gaps']) {
  if (tab === 'claude') {
    const total = (gaps?.orphanProcesses ?? 0) + (gaps?.orphanPanes ?? 0);
    return total > 0 ? <span fg={palette.error}> {total}</span> : null;
  }
  if (tab === 'tmux') {
    const dead = gaps?.deadPanes ?? 0;
    return dead > 0 ? <span fg={palette.error}> {dead}\u2620</span> : null;
  }
  return null;
}

export function TabBar({ activeTab, focused, gaps }: TabBarProps) {
  return (
    <box height={1} flexDirection="row" width="100%" backgroundColor={palette.bgLight}>
      {TAB_ORDER.map((tab) => {
        const isActive = tab === activeTab;
        const bg = isActive ? palette.violet : palette.bgLight;
        const fg = isActive ? '#ffffff' : focused ? palette.textDim : palette.textMuted;

        return (
          <box key={tab} backgroundColor={bg} paddingX={1}>
            <text>
              <span fg={fg}>
                {isActive && focused ? '>' : ' '}
                {TAB_LABELS[tab]}
              </span>
              {tabBadge(tab, gaps)}
            </text>
          </box>
        );
      })}
    </box>
  );
}
