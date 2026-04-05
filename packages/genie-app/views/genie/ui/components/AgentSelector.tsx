import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface AgentRow {
  id: string;
  custom_name: string | null;
  role: string | null;
  team: string | null;
  state: string;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  sidebar: {
    width: '200px',
    minWidth: '150px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    borderRight: `1px solid ${theme.border}`,
  },
  header: {
    padding: '8px 12px',
    fontSize: '11px',
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: `1px solid ${theme.border}`,
    backgroundColor: theme.bgCard,
    flexShrink: 0,
  },
  list: {
    flex: 1,
    overflow: 'auto',
    backgroundColor: theme.bgCard,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    cursor: 'pointer',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    backgroundColor: 'transparent',
    fontFamily: theme.fontFamily,
    fontSize: '12px',
    color: theme.textDim,
  },
} as const;

// ============================================================================
// AgentSelector Component
// ============================================================================

interface AgentSelectorProps {
  agents: AgentRow[];
  selectedName: string | null;
  onSelect: (name: string, brainPath: string) => void;
}

const BRAIN_SUBPATH = 'brain';

export function AgentSelector({ agents, selectedName, onSelect }: AgentSelectorProps) {
  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>Agents</div>
      <div style={styles.list}>
        {agents.length === 0 && (
          <div
            style={{
              padding: '16px',
              fontSize: '12px',
              color: theme.textMuted,
              textAlign: 'center',
            }}
          >
            No agents
          </div>
        )}
        {agents.map((agent) => {
          const name = agent.custom_name ?? agent.role ?? agent.id;
          const isActive = name === selectedName;
          return (
            <button
              key={agent.id}
              type="button"
              style={{
                ...styles.row,
                backgroundColor: isActive ? `${theme.violet}22` : 'transparent',
                color: isActive ? theme.text : theme.textDim,
                borderLeft: isActive ? `2px solid ${theme.violet}` : '2px solid transparent',
                transition: 'background-color 0.1s ease, color 0.1s ease',
              }}
              onClick={() => {
                const brainPath = `/home/genie/workspace/agents/${name}/${BRAIN_SUBPATH}`;
                onSelect(name, brainPath);
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = theme.bgCardHover;
                  e.currentTarget.style.color = theme.text;
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = theme.textDim;
                }
              }}
            >
              <span style={{ fontSize: '12px' }}>{agent.state === 'working' ? '\ud83d\udfe2' : '\u26aa'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: isActive ? 600 : 400,
                    fontSize: '12px',
                  }}
                >
                  {name}
                </div>
                {agent.role && <div style={{ fontSize: '10px', color: theme.textMuted }}>{agent.role}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
