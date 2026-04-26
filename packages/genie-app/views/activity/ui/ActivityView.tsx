import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../../lib/ipc';
import { palette } from '../../../lib/theme';
import type { ActivityViewProps, RuntimeEventKind } from '../../../lib/types';

// ============================================================================
// Types
// ============================================================================

interface EventRow {
  id: number;
  repo_path: string;
  kind: string;
  source: string;
  agent: string;
  team: string | null;
  direction: string | null;
  peer: string | null;
  text: string;
  data: Record<string, unknown> | null;
  thread_id: string | null;
  created_at: string;
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Theme tokens — sourced from genie-tokens via lib/theme
// ============================================================================

const t = {
  bg: palette.bg,
  bgCard: palette.bgRaised,
  bgCardHover: palette.bgHover,
  border: palette.border,
  borderAccent: palette.borderActive,
  text: palette.text,
  textDim: palette.textDim,
  textMuted: palette.textMuted,
  purple: palette.accentBright,
  violet: palette.accent,
  cyan: palette.info,
  emerald: palette.success,
  warning: palette.warning,
  error: palette.error,
  blue: palette.info,
} as const;

const KIND_COLORS: Record<string, string> = {
  user: t.cyan,
  assistant: t.emerald,
  message: t.purple,
  state: t.warning,
  tool_call: t.blue,
  tool_result: t.textDim,
  system: t.textMuted,
  qa: t.violet,
};

const KIND_ICONS: Record<string, string> = {
  user: '\u25b6', // ▶
  assistant: '\u25c0', // ◀
  message: '\u2709', // ✉
  state: '\u26a1', // ⚡
  tool_call: '\u2699', // ⚙
  tool_result: '\u2713', // ✓
  system: '\u25cf', // ●
  qa: '\u2714', // ✔
};

const SOURCE_LABELS: Record<string, string> = {
  provider: 'ai',
  mailbox: 'mail',
  chat: 'chat',
  registry: 'reg',
  hook: 'hook',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '??:??:??';
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    backgroundColor: t.bg,
    color: t.text,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    borderBottom: `1px solid ${t.border}`,
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    color: t.text,
    margin: 0,
  },
  subtitle: {
    fontSize: '11px',
    color: t.textMuted,
    margin: '4px 0 0 0',
  },
  filters: {
    display: 'flex',
    gap: '8px',
    padding: '8px 24px',
    borderBottom: `1px solid ${t.border}`,
    alignItems: 'center',
  },
  filterButton: {
    padding: '4px 10px',
    fontSize: '11px',
    fontFamily: 'inherit',
    border: `1px solid ${t.border}`,
    borderRadius: '4px',
    backgroundColor: 'transparent',
    color: t.textDim,
    cursor: 'pointer',
    transition: 'all 0.1s',
  },
  filterActive: {
    backgroundColor: `${t.violet}22`,
    borderColor: t.violet,
    color: t.violet,
  },
  feed: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 0',
  },
  eventRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '6px 24px',
    fontSize: '12px',
    lineHeight: 1.5,
    transition: 'background-color 0.1s',
  },
  eventTime: {
    color: t.textMuted,
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    minWidth: '70px',
    flexShrink: 0,
  },
  eventIcon: {
    fontSize: '12px',
    minWidth: '16px',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  eventAgent: {
    color: t.purple,
    fontWeight: 500,
    minWidth: '100px',
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  eventSource: {
    fontSize: '10px',
    padding: '1px 4px',
    borderRadius: '3px',
    backgroundColor: t.bgCard,
    color: t.textMuted,
    minWidth: '32px',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  eventText: {
    flex: 1,
    color: t.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  errorBox: {
    backgroundColor: 'rgba(168, 56, 56, 0.12)',
    border: `1px solid ${t.error}`,
    borderRadius: '8px',
    padding: '16px',
    color: t.error,
    fontSize: '13px',
    margin: '24px',
  },
  loadingBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: t.textMuted,
    fontSize: '14px',
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: t.textMuted,
    fontSize: '14px',
  },
} as const;

// ============================================================================
// Event Row
// ============================================================================

function EventRowItem({ event, highlight }: { event: EventRow; highlight: boolean }) {
  const kindColor = KIND_COLORS[event.kind] ?? t.textMuted;
  const icon = KIND_ICONS[event.kind] ?? '\u25cf';
  const sourceLabel = SOURCE_LABELS[event.source] ?? event.source;

  return (
    <div
      style={{
        ...styles.eventRow,
        backgroundColor: highlight ? t.bgCardHover : 'transparent',
      }}
    >
      <span style={styles.eventTime}>{formatTime(event.created_at)}</span>
      <span style={{ ...styles.eventIcon, color: kindColor }}>{icon}</span>
      <span style={styles.eventAgent}>{event.agent}</span>
      <span style={styles.eventSource}>{sourceLabel}</span>
      <span style={styles.eventText}>{truncate(event.text, 120)}</span>
    </div>
  );
}

// ============================================================================
// Activity View
// ============================================================================

const POLL_INTERVAL_MS = 2_000;
const INITIAL_LIMIT = 200;

type KindFilter = RuntimeEventKind | 'all';

export function ActivityView({ windowId }: ActivityViewProps) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastIdRef = useRef<number>(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      const params: { afterId?: number; team?: string; limit?: number } = {};
      if (lastIdRef.current > 0) {
        params.afterId = lastIdRef.current;
      } else {
        params.limit = INITIAL_LIMIT;
      }
      if (teamFilter) params.team = teamFilter;

      const data = await invoke<EventRow[]>('stream_events', params);

      if (data.length > 0) {
        // Initial load returns DESC order, incremental returns ASC
        if (lastIdRef.current === 0) {
          data.reverse(); // Flip to chronological for initial load
        }
        const maxId = Math.max(...data.map((e) => e.id));
        lastIdRef.current = maxId;
        setEvents((prev) => {
          const next = lastIdRef.current === maxId && prev.length === 0 ? data : [...prev, ...data];
          // Cap at 2000 events
          return next.length > 2000 ? next.slice(-1500) : next;
        });
      }

      setState('ready');
      setError(null);
    } catch (err) {
      if (events.length === 0) setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [teamFilter, events.length]);

  useEffect(() => {
    // Reset on filter change
    lastIdRef.current = 0;
    setEvents([]);
    setState('loading');

    fetchEvents();
    timerRef.current = setInterval(fetchEvents, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchEvents]);

  // Auto-scroll to bottom when new events arrive
  const prevCountRef = useRef(0);
  if (autoScroll && feedRef.current && events.length !== prevCountRef.current) {
    prevCountRef.current = events.length;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }

  // Detect manual scroll (disable auto-scroll)
  const handleScroll = useCallback(() => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  // Filter events by kind
  const filtered = kindFilter === 'all' ? events : events.filter((e) => e.kind === kindFilter);

  // Extract unique teams for filter
  const teamSet = new Set(events.map((e) => e.team).filter(Boolean) as string[]);
  const teams = [...teamSet].sort();

  if (state === 'loading') {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={styles.loadingBox}>Loading events...</div>
      </div>
    );
  }

  if (state === 'error' && events.length === 0) {
    return (
      <div data-window-id={windowId} style={styles.root}>
        <div style={styles.errorBox}>Failed to load events: {error}</div>
      </div>
    );
  }

  const kindFilters: KindFilter[] = ['all', 'user', 'assistant', 'state', 'tool_call', 'message', 'system'];

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Activity</h1>
          <p style={styles.subtitle}>
            {filtered.length} events{teamFilter ? ` \u00b7 team: ${teamFilter}` : ''}
            {error && <span style={{ color: t.warning, marginLeft: '8px' }}>(poll failed)</span>}
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div style={styles.filters}>
        {kindFilters.map((k) => (
          <button
            key={k}
            type="button"
            style={{
              ...styles.filterButton,
              ...(kindFilter === k ? styles.filterActive : {}),
            }}
            onClick={() => setKindFilter(k)}
          >
            {k}
          </button>
        ))}
        {teams.length > 0 && (
          <>
            <span style={{ color: t.border }}>|</span>
            <button
              type="button"
              style={{
                ...styles.filterButton,
                ...(teamFilter === null ? styles.filterActive : {}),
              }}
              onClick={() => setTeamFilter(null)}
            >
              all teams
            </button>
            {teams.map((team) => (
              <button
                key={team}
                type="button"
                style={{
                  ...styles.filterButton,
                  ...(teamFilter === team ? styles.filterActive : {}),
                }}
                onClick={() => setTeamFilter(team)}
              >
                {team}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Event feed */}
      <div ref={feedRef} style={styles.feed} onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <div style={styles.emptyState}>No events yet</div>
        ) : (
          filtered.map((event, i) => (
            <EventRowItem key={event.id} event={event} highlight={i === filtered.length - 1 && autoScroll} />
          ))
        )}
      </div>
    </div>
  );
}
