/** @jsxImportSource @opentui/react */
/** Horizontal tab bar: Projects | tmux | Claude — left/right to switch */

import { palette } from '../theme.js';

export type TabId = 'projects' | 'tmux' | 'claude';

export const TAB_ORDER: TabId[] = ['projects', 'tmux', 'claude'];

const TAB_LABELS: Record<TabId, string> = {
  projects: 'Projects',
  tmux: 'tmux',
  claude: 'Claude',
};

interface TabBarProps {
  activeTab: TabId;
  focused: boolean;
  gaps?: { orphanProcesses: number; orphanPanes: number };
}

export function TabBar({ activeTab, focused, gaps }: TabBarProps) {
  const totalGaps = (gaps?.orphanProcesses ?? 0) + (gaps?.orphanPanes ?? 0);

  return (
    <box height={1} flexDirection="row" width="100%" backgroundColor={palette.bgLight}>
      {TAB_ORDER.map((tab) => {
        const isActive = tab === activeTab;
        const bg = isActive ? palette.violet : palette.bgLight;
        const fg = isActive ? '#ffffff' : focused ? palette.textDim : palette.textMuted;

        // Show gap count badge on Claude tab
        const badge = tab === 'claude' && totalGaps > 0 ? <span fg={palette.error}> {totalGaps}</span> : null;

        return (
          <box key={tab} backgroundColor={bg} paddingX={1}>
            <text>
              <span fg={fg}>
                {isActive && focused ? '>' : ' '}
                {TAB_LABELS[tab]}
              </span>
              {badge}
            </text>
          </box>
        );
      })}
    </box>
  );
}
