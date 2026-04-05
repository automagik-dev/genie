import { useState } from 'react';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

interface KpiBreakdownItem {
  label: string;
  value: string | number;
  color?: string;
}

interface KpiCardProps {
  title: string;
  value: string | number;
  breakdown?: KpiBreakdownItem[];
  trend?: 'up' | 'down' | 'flat';
  trendLabel?: string;
  accentColor?: string;
  onClick?: () => void;
}

// ============================================================================
// Trend Arrow
// ============================================================================

const TREND_ARROWS: Record<string, string> = {
  up: '\u2191',
  down: '\u2193',
  flat: '\u2192',
};

const TREND_COLORS: Record<string, string> = {
  up: theme.emerald,
  down: theme.error,
  flat: theme.textMuted,
};

// ============================================================================
// KpiCard
// ============================================================================

export function KpiCard({ title, value, breakdown, trend, trendLabel, accentColor, onClick }: KpiCardProps) {
  const [hovered, setHovered] = useState(false);
  const accent = accentColor ?? theme.purple;
  const clickable = typeof onClick === 'function';

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (clickable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: hovered ? theme.bgCardHover : theme.bgCard,
        border: `1px solid ${hovered && clickable ? accent : theme.border}`,
        borderRadius: theme.radiusMd,
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color 0.15s ease, background-color 0.15s ease',
        outline: 'none',
      }}
    >
      {/* Title */}
      <p
        style={{
          fontSize: '11px',
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: theme.textMuted,
          margin: 0,
        }}
      >
        {title}
      </p>

      {/* Value + Trend */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <p
          style={{
            fontSize: '32px',
            fontWeight: 700,
            lineHeight: 1,
            color: accent,
            margin: 0,
          }}
        >
          {value}
        </p>
        {trend && (
          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: TREND_COLORS[trend],
            }}
          >
            {TREND_ARROWS[trend]} {trendLabel}
          </span>
        )}
      </div>

      {/* Breakdown */}
      {breakdown && breakdown.length > 0 && (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {breakdown.map((item) => (
            <span
              key={item.label}
              style={{
                fontSize: '11px',
                color: theme.textDim,
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: item.color ?? theme.textMuted,
                  marginRight: '4px',
                }}
              />
              {item.value} {item.label}
            </span>
          ))}
        </div>
      )}

      {/* Clickable hint */}
      {clickable && (
        <span
          style={{
            fontSize: '10px',
            color: hovered ? accent : theme.textMuted,
            transition: 'color 0.15s ease',
          }}
        >
          Click to view details
        </span>
      )}
    </div>
  );
}
