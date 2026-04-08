import { useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface RuleEntry {
  name: string;
  path: string;
  content: string;
  source?: string;
}

interface RulesTabProps {
  rules: RuleEntry[];
}

// ============================================================================
// RulesTab
// ============================================================================

export function RulesTab({ rules }: RulesTabProps) {
  const [selected, setSelected] = useState<RuleEntry | null>(null);

  const getFirstHeading = (content: string): string => {
    const headingMatch = content.match(/^#{1,3}\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim();
    const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('---'));
    return lines[0]?.trim().slice(0, 80) ?? '';
  };

  return (
    <div style={{ display: 'flex', height: '100%', gap: '0' }}>
      {/* Left: rule list */}
      <div
        style={{
          width: '260px',
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
          Rules ({rules.length})
        </div>
        <div
          style={{
            padding: '8px 10px',
            fontSize: '10px',
            color: theme.textMuted,
            backgroundColor: theme.bgCard,
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          Edit rules in ~/.claude/rules/ or ~/.genie/rules/
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rules.length === 0 ? (
            <div style={{ padding: '16px', fontSize: '12px', color: theme.textMuted }}>
              No rules found. Add .md files to ~/.claude/rules/ or ~/.genie/rules/
            </div>
          ) : (
            rules.map((rule) => (
              <button
                type="button"
                key={rule.path}
                onClick={() => setSelected(rule)}
                style={{
                  border: 'none',
                  background: 'none',
                  textAlign: 'left' as const,
                  width: '100%',
                  font: 'inherit',
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderLeft: `3px solid ${selected?.path === rule.path ? theme.violet : 'transparent'}`,
                  backgroundColor: selected?.path === rule.path ? theme.bgCardHover : 'transparent',
                  transition: 'background-color 0.1s',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    color: theme.text,
                    fontWeight: 500,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span
                    style={{
                      fontSize: '9px',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      backgroundColor:
                        rule.source === 'claude' ? 'rgba(34, 211, 238, 0.15)' : 'rgba(124, 58, 237, 0.15)',
                      color: rule.source === 'claude' ? theme.cyan : theme.purple,
                      flexShrink: 0,
                    }}
                  >
                    {rule.source ?? 'genie'}
                  </span>
                  {rule.name}
                </div>
                <div
                  style={{
                    fontSize: '10px',
                    color: theme.textMuted,
                    marginTop: '2px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {getFirstHeading(rule.content)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right: preview */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selected ? (
          <>
            <div
              style={{
                padding: '10px 16px',
                borderBottom: `1px solid ${theme.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: '13px', fontWeight: 600, color: theme.text }}>{selected.name}.md</span>
              <span style={{ fontSize: '10px', color: theme.textMuted }}>{selected.path}</span>
            </div>
            <pre
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px',
                margin: 0,
                fontSize: '12px',
                fontFamily: theme.fontFamily,
                color: theme.textDim,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {selected.content}
            </pre>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.textMuted,
              fontSize: '13px',
            }}
          >
            Select a rule to preview
          </div>
        )}
      </div>
    </div>
  );
}
