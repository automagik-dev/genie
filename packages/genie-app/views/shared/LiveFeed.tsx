import { useEffect, useRef } from 'react';
import { theme } from '../../lib/theme';
import type { RuntimeEvent, RuntimeEventKind } from '../../lib/types';

// ============================================================================
// Constants
// ============================================================================

/** Color coding by event kind. */
const KIND_COLORS: Record<RuntimeEventKind, string> = {
  tool_call: theme.warning, // amber
  tool_result: theme.warning, // amber
  state: theme.info, // blue/info
  message: theme.emerald, // mint
  system: theme.textDim, // dim
  user: theme.purple, // accent-bright
  assistant: theme.purple, // accent-bright
  qa: theme.info, // info
};

/** Icon per event kind. */
const KIND_ICONS: Record<RuntimeEventKind, string> = {
  tool_call: '\u2699', // gear
  tool_result: '\u2713', // check
  state: '\u25cf', // circle
  message: '\u2709', // envelope
  system: '\u2630', // bars
  user: '\u2192', // arrow
  assistant: '\u2190', // arrow
  qa: '\u2714', // checkmark
};

// ============================================================================
// LiveFeedEvent
// ============================================================================

interface LiveFeedEventProps {
  event: RuntimeEvent;
}

function LiveFeedEvent({ event }: LiveFeedEventProps) {
  const color = KIND_COLORS[event.kind] ?? theme.textMuted;
  const icon = KIND_ICONS[event.kind] ?? '\u2022';
  const time = new Date(event.timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.border}`,
        fontSize: '12px',
        fontFamily: theme.fontFamily,
      }}
    >
      {/* Timestamp */}
      <span
        style={{
          color: theme.textMuted,
          minWidth: '70px',
          flexShrink: 0,
          fontSize: '11px',
        }}
      >
        {time}
      </span>

      {/* Kind icon */}
      <span
        style={{
          color,
          fontSize: '13px',
          minWidth: '18px',
          textAlign: 'center',
          flexShrink: 0,
        }}
        title={event.kind}
      >
        {icon}
      </span>

      {/* Agent name */}
      <span
        style={{
          color: theme.purple,
          fontWeight: 500,
          minWidth: '90px',
          maxWidth: '120px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
        title={event.agent}
      >
        {event.agent}
      </span>

      {/* Description */}
      <span
        style={{
          color: theme.text,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={event.text}
      >
        {event.text}
      </span>
    </div>
  );
}

// ============================================================================
// LiveFeed
// ============================================================================

interface LiveFeedProps {
  events: RuntimeEvent[];
  maxItems?: number;
  /** If true, auto-scrolls to newest (top). */
  autoScroll?: boolean;
}

export function LiveFeed({ events, maxItems = 20, autoScroll = true }: LiveFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayEvents = events.slice(0, maxItems);

  // Scroll to top when a new event arrives
  const prevCountRef = useRef(events.length);
  useEffect(() => {
    if (events.length !== prevCountRef.current && autoScroll && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    prevCountRef.current = events.length;
  }, [events, autoScroll]);

  if (displayEvents.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
          color: theme.textMuted,
          fontSize: '13px',
        }}
      >
        No activity yet. Events will appear here in real time.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        maxHeight: '400px',
        backgroundColor: theme.bgCard,
        borderRadius: theme.radiusMd,
        border: `1px solid ${theme.border}`,
      }}
    >
      {displayEvents.map((event) => (
        <LiveFeedEvent key={event.id} event={event} />
      ))}
    </div>
  );
}
