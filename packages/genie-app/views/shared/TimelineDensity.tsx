import { useMemo, useState } from 'react';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface TimelineSegment {
  /** Starting turn index for this segment. */
  startTurn: number;
  /** Ending turn index (inclusive). */
  endTurn: number;
  /** Dominant role/type for color coding: 'user' | 'assistant' | 'tool' | 'system'. */
  type: 'user' | 'assistant' | 'tool' | 'system';
}

export interface TimelineDensityProps {
  /** Segments representing turn ranges with their types. */
  segments: TimelineSegment[];
  /** Total number of turns. */
  totalTurns: number;
  /** Called when user clicks a segment to jump to that turn. */
  onJump: (turnIndex: number) => void;
  /** Currently visible turn index (for highlight). */
  currentTurn?: number;
}

// ============================================================================
// Color map
// ============================================================================

const TYPE_COLORS: Record<string, string> = {
  user: theme.info,
  assistant: theme.emerald,
  tool: theme.warning,
  system: theme.textMuted,
};

// ============================================================================
// TimelineDensity Component
// ============================================================================

export function TimelineDensity({ segments, totalTurns, onJump, currentTurn }: TimelineDensityProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Compute segment widths as percentages of total turns
  const segmentWidths = useMemo(() => {
    if (totalTurns === 0) return [];
    return segments.map((seg) => ({
      ...seg,
      widthPct: Math.max(((seg.endTurn - seg.startTurn + 1) / totalTurns) * 100, 1),
    }));
  }, [segments, totalTurns]);

  if (totalTurns === 0 || segments.length === 0) return null;

  // Current turn indicator position
  const currentPct = currentTurn != null && totalTurns > 0 ? (currentTurn / totalTurns) * 100 : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {/* Bar container */}
      <div
        style={{
          display: 'flex',
          height: '8px',
          borderRadius: '4px',
          overflow: 'hidden',
          backgroundColor: theme.border,
          position: 'relative',
          cursor: 'pointer',
        }}
      >
        {segmentWidths.map((seg, idx) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: visual density bar — keyboard nav via parent turn list
          <div
            key={`${seg.startTurn}-${seg.endTurn}`}
            style={{
              width: `${seg.widthPct}%`,
              height: '100%',
              backgroundColor: TYPE_COLORS[seg.type] ?? theme.textMuted,
              opacity: hoveredIdx === idx ? 1 : 0.75,
              transition: 'opacity 0.1s ease',
            }}
            title={`Turns ${seg.startTurn}-${seg.endTurn} (${seg.type})`}
            onClick={() => onJump(seg.startTurn)}
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
          />
        ))}

        {/* Current turn indicator */}
        {currentPct != null && (
          <div
            style={{
              position: 'absolute',
              left: `${currentPct}%`,
              top: '-2px',
              width: '2px',
              height: '12px',
              backgroundColor: theme.text,
              borderRadius: '1px',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '10px', fontSize: '10px', color: theme.textMuted }}>
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: color,
              }}
            />
            {type}
          </span>
        ))}
      </div>
    </div>
  );
}
