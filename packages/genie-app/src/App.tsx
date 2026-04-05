import { Suspense, useCallback, useEffect, useState } from 'react';
import { components } from '../components';
import { theme } from '../lib/theme';
import type { AppComponentProps } from '../lib/types';
import { LoadingState } from '../views/shared/LoadingState';

// ============================================================================
// Types
// ============================================================================

type ViewKey = keyof typeof components;

interface NavItem {
  key: ViewKey;
  label: string;
  icon: string;
  section: 'top' | 'bottom';
}

// ============================================================================
// Nav items — 9+ items per spec
// ============================================================================

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Command Center', icon: '\u25c6', section: 'top' },
  { key: 'agents', label: 'Fleet', icon: '\u25cb', section: 'top' },
  { key: 'sessions', label: 'Sessions', icon: '\u2261', section: 'top' },
  { key: 'tasks', label: 'Mission Control', icon: '\u2610', section: 'top' },
  { key: 'costs', label: 'Cost Intelligence', icon: '$', section: 'top' },
  { key: 'files', label: 'Files', icon: '\u2302', section: 'top' },
  { key: 'scheduler', label: 'Scheduler', icon: '\u231a', section: 'top' },
  { key: 'system', label: 'System', icon: '\u2699', section: 'top' },
  { key: 'settings', label: 'Settings', icon: '\u2630', section: 'bottom' },
];

const SIDEBAR_WIDTH_EXPANDED = 200;
const SIDEBAR_WIDTH_COLLAPSED = 56;
const COLLAPSE_BREAKPOINT = 1024;

// ============================================================================
// Sidebar Nav Item
// ============================================================================

interface SidebarNavItemProps {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onSelect: (key: ViewKey) => void;
}

function SidebarNavItem({ item, isActive, collapsed, onSelect }: SidebarNavItemProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      title={item.label}
      onClick={() => onSelect(item.key)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        height: '36px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: collapsed ? '0' : '0 16px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: theme.radiusSm,
        border: 'none',
        cursor: 'pointer',
        fontSize: collapsed ? '16px' : '13px',
        fontFamily: theme.fontFamily,
        backgroundColor: isActive ? theme.bgCardHover : hovered ? 'rgba(124, 58, 237, 0.08)' : 'transparent',
        color: isActive ? theme.purple : hovered ? theme.text : theme.textMuted,
        borderLeft: isActive ? `2px solid ${theme.violet}` : '2px solid transparent',
        transition: 'all 0.15s ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: '15px', minWidth: '20px', textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
      {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>}
    </button>
  );
}

// ============================================================================
// Status Bar (bottom)
// ============================================================================

interface AppStatusBarProps {
  activeView: string;
  agentCount: number | null;
  connected: boolean;
}

function AppStatusBar({ activeView, agentCount, connected }: AppStatusBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '28px',
        padding: '0 16px',
        borderTop: `1px solid ${theme.border}`,
        backgroundColor: theme.bgCard,
        fontSize: '11px',
        fontFamily: theme.fontFamily,
        gap: '16px',
        flexShrink: 0,
      }}
    >
      {/* Left: connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: theme.textMuted }}>
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: connected ? theme.emerald : theme.error,
          }}
        />
        <span>{connected ? 'pgserve connected' : 'pgserve disconnected'}</span>
      </div>

      {/* Center: view label */}
      <span
        style={{
          color: theme.purple,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {activeView}
      </span>

      {/* Right: agent count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: theme.textMuted }}>
        {agentCount !== null && (
          <span>
            <span style={{ color: theme.emerald, fontWeight: 500 }}>{agentCount}</span> agents
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// App Shell
// ============================================================================

export function App() {
  const [activeView, setActiveView] = useState<ViewKey>('dashboard');
  const [collapsed, setCollapsed] = useState(window.innerWidth < COLLAPSE_BREAKPOINT);
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [connected, setConnected] = useState(true);

  // Responsive collapse
  useEffect(() => {
    function handleResize() {
      setCollapsed(window.innerWidth < COLLAPSE_BREAKPOINT);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Poll for status bar data (pgserve status + agent count)
  useEffect(() => {
    let active = true;

    async function fetchStatus() {
      try {
        // Import dynamically to avoid circular deps
        const { invoke } = await import('../lib/ipc');
        const data = await invoke<{ agents: { online: number; total: number } }>('dashboard_stats');
        if (active) {
          setAgentCount(data.agents.total);
          setConnected(true);
        }
      } catch {
        if (active) setConnected(false);
      }
    }

    fetchStatus();
    const timer = setInterval(fetchStatus, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const handleNavSelect = useCallback((key: ViewKey) => {
    setActiveView(key);
  }, []);

  const ActiveComponent = components[activeView];
  const activeLabel = NAV_ITEMS.find((n) => n.key === activeView)?.label ?? activeView;
  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  const topItems = NAV_ITEMS.filter((i) => i.section === 'top');
  const bottomItems = NAV_ITEMS.filter((i) => i.section === 'bottom');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: theme.bg,
        color: theme.text,
        fontFamily: theme.fontFamily,
      }}
    >
      {/* Main area: sidebar + content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Collapsible Sidebar */}
        <nav
          data-nav
          style={{
            width: `${sidebarWidth}px`,
            minWidth: `${sidebarWidth}px`,
            backgroundColor: theme.bgCard,
            borderRight: `1px solid ${theme.border}`,
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 8px',
            gap: '2px',
            transition: 'width 0.2s ease, min-width 0.2s ease',
            overflow: 'hidden',
          }}
        >
          {/* Top items */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
            {topItems.map((item) => (
              <SidebarNavItem
                key={item.key}
                item={item}
                isActive={activeView === item.key}
                collapsed={collapsed}
                onSelect={handleNavSelect}
              />
            ))}
          </div>

          {/* Bottom items (e.g. Settings) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {bottomItems.map((item) => (
              <SidebarNavItem
                key={item.key}
                item={item}
                isActive={activeView === item.key}
                collapsed={collapsed}
                onSelect={handleNavSelect}
              />
            ))}
          </div>
        </nav>

        {/* View content */}
        <main style={{ flex: 1, overflow: 'hidden' }}>
          <Suspense fallback={<LoadingState message="Loading view..." />}>
            {ActiveComponent && (
              <ActiveComponent windowId="main" meta={{ navigate: handleNavSelect } as AppComponentProps['meta']} />
            )}
          </Suspense>
        </main>
      </div>

      {/* Status Bar */}
      <AppStatusBar activeView={activeLabel} agentCount={agentCount} connected={connected} />
    </div>
  );
}
