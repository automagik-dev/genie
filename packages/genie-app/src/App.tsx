import { Suspense, useState } from 'react';
import { components } from '../components';
import { StatusBar } from '../lib/StatusBar';
import { theme } from '../lib/theme';

type ViewKey = keyof typeof components;

const NAV_ITEMS: Array<{ key: ViewKey; label: string; icon: string }> = [
  { key: 'dashboard', label: 'Dashboard', icon: '\u25c6' },
  { key: 'agents', label: 'Agents', icon: '\u25cb' },
  { key: 'tasks', label: 'Tasks', icon: '\u2610' },
  { key: 'terminal', label: 'Terminal', icon: '>' },
  { key: 'activity', label: 'Activity', icon: '\u2022' },
];

export function App() {
  const [activeView, setActiveView] = useState<ViewKey>('dashboard');

  const ActiveComponent = components[activeView];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: theme.bg }}>
      {/* Main area: sidebar + content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar nav */}
        <nav
          data-nav
          style={{
            width: '56px',
            minWidth: '56px',
            backgroundColor: theme.bgCard,
            borderRight: `1px solid ${theme.border}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: '12px',
            gap: '4px',
          }}
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.key;
            return (
              <button
                key={item.key}
                type="button"
                title={item.label}
                onClick={() => setActiveView(item.key)}
                style={{
                  width: '40px',
                  height: '40px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: theme.radiusSm,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontFamily: theme.fontFamily,
                  backgroundColor: isActive ? theme.bgCardHover : 'transparent',
                  color: isActive ? theme.purple : theme.textMuted,
                  borderLeft: isActive ? `2px solid ${theme.violet}` : '2px solid transparent',
                  transition: 'all 0.1s ease',
                }}
              >
                {item.icon}
              </button>
            );
          })}
        </nav>

        {/* View content */}
        <main style={{ flex: 1, overflow: 'hidden' }}>
          <Suspense
            fallback={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: theme.textMuted,
                  fontSize: '14px',
                }}
              >
                Loading...
              </div>
            }
          >
            {ActiveComponent && <ActiveComponent windowId="main" />}
          </Suspense>
        </main>
      </div>

      {/* Status bar */}
      <StatusBar activeView={activeView} />
    </div>
  );
}
