import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface SkillEntry {
  name: string;
  slug: string;
  description: string;
  path: string;
}

interface SkillsTabProps {
  skills: SkillEntry[];
}

// ============================================================================
// SkillsTab
// ============================================================================

export function SkillsTab({ skills }: SkillsTabProps) {
  return (
    <div>
      <div
        style={{
          marginBottom: '12px',
          fontSize: '11px',
          color: theme.textMuted,
          padding: '8px 12px',
          backgroundColor: theme.bgCard,
          borderRadius: theme.radiusSm,
          border: `1px solid ${theme.border}`,
        }}
      >
        Bundled skills scanned from the skills/ directory. Editing is available in V2 — modify skill files directly.
      </div>

      {skills.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: theme.textMuted, fontSize: '13px' }}>
          No skills found. Skills should be in the skills/ directory.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '10px',
          }}
        >
          {skills.map((skill) => (
            <div
              key={skill.slug}
              style={{
                padding: '12px 14px',
                backgroundColor: theme.bgCard,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusMd,
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(124, 58, 237, 0.15)',
                    color: theme.purple,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    flexShrink: 0,
                  }}
                >
                  {skill.slug}
                </span>
                <span style={{ fontSize: '12px', fontWeight: 600, color: theme.text }}>
                  {skill.name !== skill.slug ? skill.name : ''}
                </span>
              </div>
              {skill.description && (
                <p
                  style={{
                    fontSize: '11px',
                    color: theme.textDim,
                    margin: 0,
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {skill.description}
                </p>
              )}
              <div
                style={{
                  fontSize: '10px',
                  color: theme.textMuted,
                  fontFamily: theme.fontFamily,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginTop: '2px',
                }}
                title={skill.path}
              >
                {skill.path}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
