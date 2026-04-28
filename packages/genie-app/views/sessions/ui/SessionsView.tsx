import { useNats, useNatsSubscription } from '@khal-os/sdk/app';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';
import { ChatBubble } from '../../shared/ChatBubble';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { LoadingState } from '../../shared/LoadingState';
import { SearchBar } from '../../shared/SearchBar';
import { TimelineDensity } from '../../shared/TimelineDensity';
import type { TimelineSegment } from '../../shared/TimelineDensity';
import { ToolCallCard } from '../../shared/ToolCallCard';

// ============================================================================
// Types
// ============================================================================

interface SessionRow {
  id: string;
  agentName: string;
  agentRole: string | null;
  agentState: string;
  lastMessage: string;
  turnCount: number;
  costUsd: number;
  startedAt: string;
  updatedAt: string;
  isActive: boolean;
}

interface TurnRow {
  turnIndex: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  toolStatus: 'success' | 'error' | null;
  timestamp: string;
}

/** Grouped assistant message with nested tool calls. */
interface MessageGroup {
  /** The primary assistant or user or system message. */
  turn: TurnRow;
  /** Tool calls that belong under this assistant message. */
  toolCalls: TurnRow[];
}

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';
const PAGE_SIZE = 50;

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\u2026`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Group turns into message groups.
 * Consecutive tool calls (role=assistant + toolName) are nested under the
 * preceding assistant message.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: turn grouping state machine
function groupTurns(turns: TurnRow[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const turn of turns) {
    const isToolCall = turn.role === 'assistant' && turn.toolName != null;

    if (isToolCall) {
      // Attach to current assistant group, or create a synthetic one
      if (currentGroup && currentGroup.turn.role === 'assistant') {
        currentGroup.toolCalls.push(turn);
      } else {
        // No preceding assistant message — create inline group
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { turn, toolCalls: [] };
      }
    } else {
      // New message group
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { turn, toolCalls: [] };
    }
  }
  if (currentGroup) groups.push(currentGroup);

  return groups;
}

/**
 * Build timeline density segments from turns.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: timeline segmentation state machine
function buildTimelineSegments(turns: TurnRow[]): TimelineSegment[] {
  if (turns.length === 0) return [];
  const segments: TimelineSegment[] = [];
  let currentType: TimelineSegment['type'] | null = null;
  let startTurn = 0;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const type: TimelineSegment['type'] =
      t.toolName != null ? 'tool' : t.role === 'user' ? 'user' : t.role === 'system' ? 'system' : 'assistant';

    if (type !== currentType) {
      if (currentType != null) {
        segments.push({ startTurn, endTurn: i - 1, type: currentType });
      }
      currentType = type;
      startTurn = i;
    }
  }
  if (currentType != null) {
    segments.push({ startTurn, endTurn: turns.length - 1, type: currentType });
  }

  return segments;
}

// ============================================================================
// Role Icon (agent avatar placeholder)
// ============================================================================

const ROLE_ICONS: Record<string, string> = {
  engineer: '\u2699', // gear
  reviewer: '\u2713', // check
  qa: '\u2714', // checkmark
  'team-lead': '\u2691', // flag
  fix: '\u2692', // wrench
  default: '\u2605', // star
};

function roleIcon(role: string | null): string {
  if (!role) return ROLE_ICONS.default;
  return ROLE_ICONS[role.toLowerCase()] ?? ROLE_ICONS.default;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    height: '100%',
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: theme.fontFamily,
  },

  // Left panel — session list
  listPanel: {
    width: '380px',
    minWidth: '320px',
    borderRight: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  listHeader: {
    padding: '16px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    color: theme.text,
    margin: 0,
  },
  subtitle: {
    fontSize: '11px',
    color: theme.textMuted,
    margin: 0,
  },
  filterBar: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  filterSelect: {
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: theme.fontFamily,
    backgroundColor: theme.bgCard,
    color: theme.textDim,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    outline: 'none',
    appearance: 'auto' as const,
  },
  sessionList: {
    flex: 1,
    overflow: 'auto',
  },

  // Session row
  sessionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 16px',
    cursor: 'pointer',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: theme.fontFamily,
    color: theme.text,
    background: 'none',
    fontSize: '13px',
    transition: 'background-color 0.1s ease',
  },
  avatar: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    backgroundColor: theme.bgCard,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '16px',
    flexShrink: 0,
    position: 'relative' as const,
  },
  statusDot: {
    position: 'absolute' as const,
    bottom: '0px',
    right: '0px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: `2px solid ${theme.bg}`,
  },
  sessionInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  sessionNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  sessionName: {
    fontWeight: 500,
    fontSize: '13px',
    color: theme.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  sessionPreview: {
    fontSize: '11px',
    color: theme.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  sessionMeta: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-end',
    gap: '4px',
    flexShrink: 0,
  },
  timeLabel: {
    fontSize: '10px',
    color: theme.textMuted,
  },
  badge: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '8px',
    backgroundColor: theme.bgCard,
    color: theme.textDim,
  },
  costBadge: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '8px',
    backgroundColor: 'rgba(168, 85, 247, 0.15)',
    color: theme.purple,
  },

  // Right panel — conversation thread
  threadPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  threadHeader: {
    padding: '12px 16px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  threadHeaderTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  threadTitle: {
    fontSize: '15px',
    fontWeight: 600,
    color: theme.text,
    margin: 0,
  },
  threadMessages: {
    flex: 1,
    overflow: 'auto',
    padding: '12px 0',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  typingIndicator: {
    display: 'flex',
    justifyContent: 'flex-start',
    padding: '4px 16px',
  },
  typingDots: {
    backgroundColor: theme.bgCard,
    color: theme.emerald,
    padding: '8px 14px',
    borderRadius: '12px',
    borderBottomLeftRadius: '4px',
    fontSize: '18px',
    letterSpacing: '3px',
    lineHeight: 1,
  },
  loadMoreButton: {
    display: 'flex',
    justifyContent: 'center',
    padding: '8px',
  },
  turnGutter: {
    position: 'absolute' as const,
    left: '2px',
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: '9px',
    color: theme.textMuted,
    opacity: 0,
    transition: 'opacity 0.15s ease',
  },

  // Time block separator
  timeBlock: {
    display: 'flex',
    justifyContent: 'center',
    padding: '12px 0 4px',
  },
  timeBlockLabel: {
    fontSize: '10px',
    color: theme.textMuted,
    backgroundColor: theme.bgCard,
    padding: '2px 10px',
    borderRadius: '8px',
  },
} as const;

// ============================================================================
// Pulsing Green Dot (CSS-in-JS animation via keyframes)
// ============================================================================

function PulsingDot() {
  return (
    <span
      style={{
        ...styles.statusDot,
        backgroundColor: theme.emerald,
        animation: 'pulse-glow 2s ease-in-out infinite',
      }}
    />
  );
}

// Global style for pulsing animation (injected once)
let pulseInjected = false;
function injectPulseAnimation() {
  if (pulseInjected) return;
  pulseInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 0 0 rgba(127, 200, 169, 0.5); }
      50% { box-shadow: 0 0 0 4px rgba(127, 200, 169, 0); }
    }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// Session Row Component
// ============================================================================

interface SessionRowItemProps {
  session: SessionRow;
  selected: boolean;
  onSelect: (id: string) => void;
}

function SessionRowItem({ session, selected, onSelect }: SessionRowItemProps) {
  return (
    <button
      type="button"
      style={{
        ...styles.sessionRow,
        backgroundColor: selected ? theme.bgCardHover : 'transparent',
        borderLeft: selected ? `3px solid ${theme.violet}` : '3px solid transparent',
      }}
      onClick={() => onSelect(session.id)}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = theme.bgCard;
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      {/* Avatar */}
      <div style={styles.avatar}>
        <span>{roleIcon(session.agentRole)}</span>
        {session.isActive ? (
          <PulsingDot />
        ) : (
          <span
            style={{
              ...styles.statusDot,
              backgroundColor: theme.textMuted,
            }}
          />
        )}
      </div>

      {/* Info */}
      <div style={styles.sessionInfo}>
        <div style={styles.sessionNameRow}>
          <span style={styles.sessionName}>{session.agentName}</span>
          {session.agentRole && (
            <span
              style={{
                fontSize: '10px',
                color: theme.textMuted,
                backgroundColor: theme.bgCard,
                padding: '0 4px',
                borderRadius: '3px',
              }}
            >
              {session.agentRole}
            </span>
          )}
        </div>
        <span style={styles.sessionPreview}>{truncate(session.lastMessage, 60)}</span>
      </div>

      {/* Meta (right side) */}
      <div style={styles.sessionMeta}>
        <span style={styles.timeLabel}>{formatRelativeTime(session.updatedAt)}</span>
        <span style={styles.badge}>{session.turnCount}t</span>
        {session.costUsd > 0 && <span style={styles.costBadge}>{formatCost(session.costUsd)}</span>}
      </div>
    </button>
  );
}

// ============================================================================
// Time Block Separator
// ============================================================================

function TimeBlockSeparator({ timestamp }: { timestamp: string }) {
  const label = formatTimestamp(timestamp);
  if (!label) return null;
  return (
    <div style={styles.timeBlock}>
      <span style={styles.timeBlockLabel}>{label}</span>
    </div>
  );
}

// ============================================================================
// Typing Indicator
// ============================================================================

function TypingIndicator() {
  return (
    <div style={styles.typingIndicator}>
      <div style={styles.typingDots}>{'\u2022\u2022\u2022'}</div>
    </div>
  );
}

// ============================================================================
// Message Group Component
// ============================================================================

interface MessageGroupItemProps {
  group: MessageGroup;
  showTimeBlock: boolean;
}

function MessageGroupItem({ group, showTimeBlock }: MessageGroupItemProps) {
  const { turn, toolCalls } = group;
  const isToolOnly = turn.toolName != null;

  return (
    <>
      {showTimeBlock && <TimeBlockSeparator timestamp={turn.timestamp} />}

      {isToolOnly ? (
        // Standalone tool call (no preceding assistant text)
        <div style={{ padding: '2px 16px', display: 'flex', justifyContent: 'flex-start' }}>
          <div style={{ maxWidth: '75%' }}>
            <ToolCallCard
              toolName={turn.toolName ?? 'Tool'}
              input={turn.toolInput ?? turn.content}
              output={turn.toolOutput ?? undefined}
              status={turn.toolStatus ?? 'success'}
              timestamp={turn.timestamp}
            />
          </div>
        </div>
      ) : (
        <ChatBubble role={turn.role} content={turn.content} timestamp={turn.timestamp}>
          {toolCalls.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px' }}>
              {toolCalls.map((tc, idx) => (
                <ToolCallCard
                  key={`${tc.turnIndex}-${idx}`}
                  toolName={tc.toolName ?? 'Tool'}
                  input={tc.toolInput ?? tc.content}
                  output={tc.toolOutput ?? undefined}
                  status={tc.toolStatus ?? 'success'}
                  timestamp={tc.timestamp}
                />
              ))}
            </div>
          )}
        </ChatBubble>
      )}
    </>
  );
}

// ============================================================================
// Conversation Thread Panel
// ============================================================================

interface ThreadPanelProps {
  session: SessionRow | null;
  turns: TurnRow[];
  loadState: LoadState;
  error: string | null;
  hasMore: boolean;
  isStreaming: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onJumpToTurn: (turnIndex: number) => void;
}

function ThreadPanel({
  session,
  turns,
  loadState,
  error,
  hasMore,
  isStreaming,
  onLoadMore,
  onRetry,
  onJumpToTurn,
}: ThreadPanelProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const prevTurnCountRef = useRef(0);

  // Auto-scroll to bottom when new turns arrive
  useEffect(() => {
    if (turns.length > prevTurnCountRef.current && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
    prevTurnCountRef.current = turns.length;
  }, [turns.length]);

  if (!session) {
    return (
      <div style={styles.threadPanel}>
        <EmptyState
          icon={'\u2709'}
          title="Select a session"
          description="Choose a session from the list to view the conversation."
        />
      </div>
    );
  }

  if (loadState === 'loading' && turns.length === 0) {
    return (
      <div style={styles.threadPanel}>
        <LoadingState message="Loading conversation..." />
      </div>
    );
  }

  if (loadState === 'error' && turns.length === 0) {
    return (
      <div style={styles.threadPanel}>
        <ErrorState message={error ?? 'Failed to load session'} service="sessions.content" onRetry={onRetry} />
      </div>
    );
  }

  const messageGroups = groupTurns(turns);
  const timelineSegments = buildTimelineSegments(turns);

  // Determine time block separators: insert when gap > 5 minutes
  const timeGaps = new Set<number>();
  for (let i = 1; i < messageGroups.length; i++) {
    const prev = new Date(messageGroups[i - 1].turn.timestamp).getTime();
    const curr = new Date(messageGroups[i].turn.timestamp).getTime();
    if (curr - prev > 5 * 60 * 1000) {
      timeGaps.add(i);
    }
  }

  return (
    <div style={styles.threadPanel}>
      {/* Thread header */}
      <div style={styles.threadHeader}>
        <div style={styles.threadHeaderTop}>
          <div>
            <h2 style={styles.threadTitle}>{session.agentName}</h2>
            <p style={{ fontSize: '11px', color: theme.textMuted, margin: '2px 0 0' }}>
              {session.turnCount} turns {'\u00b7'} {formatCost(session.costUsd)}
              {session.isActive && <span style={{ color: theme.emerald, marginLeft: '8px' }}>{'\u25cf'} Live</span>}
            </p>
          </div>
        </div>

        {/* Timeline density bar */}
        <TimelineDensity segments={timelineSegments} totalTurns={turns.length} onJump={onJumpToTurn} />
      </div>

      {/* Messages */}
      <div ref={messagesRef} style={styles.threadMessages}>
        {/* Load more button at top */}
        {hasMore && (
          <div style={styles.loadMoreButton}>
            <button
              type="button"
              onClick={onLoadMore}
              style={{
                padding: '4px 16px',
                fontSize: '11px',
                fontFamily: theme.fontFamily,
                backgroundColor: theme.bgCard,
                color: theme.textDim,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                cursor: 'pointer',
              }}
            >
              Load older messages
            </button>
          </div>
        )}

        {messageGroups.map((group, idx) => (
          <div
            key={group.turn.turnIndex}
            style={{ position: 'relative' }}
            onMouseEnter={(e) => {
              const gutter = e.currentTarget.querySelector('[data-gutter]') as HTMLElement;
              if (gutter) gutter.style.opacity = '1';
            }}
            onMouseLeave={(e) => {
              const gutter = e.currentTarget.querySelector('[data-gutter]') as HTMLElement;
              if (gutter) gutter.style.opacity = '0';
            }}
          >
            {/* Turn index gutter (visible on hover) */}
            <span data-gutter="" style={styles.turnGutter}>
              #{group.turn.turnIndex}
            </span>
            <MessageGroupItem group={group} showTimeBlock={idx === 0 || timeGaps.has(idx)} />
          </div>
        ))}

        {/* Typing indicator for active sessions */}
        {isStreaming && <TypingIndicator />}
      </div>
    </div>
  );
}

// ============================================================================
// SessionsView (Main Export)
// ============================================================================

export function SessionsView({ windowId, meta: _meta }: AppComponentProps) {
  // ---- State ----
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [listState, setListState] = useState<LoadState>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'recent' | 'turns' | 'cost'>('recent');
  const [filterActive, setFilterActive] = useState<'' | 'active' | 'ended'>('');

  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [threadState, setThreadState] = useState<LoadState>('loading');
  const [threadError, setThreadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const turnsOffsetRef = useRef(0);
  const nats = useNats();

  // ---- Inject animation CSS ----
  useEffect(() => {
    injectPulseAnimation();
  }, []);

  // ---- Fetch session list ----
  const fetchSessions = useCallback(async () => {
    try {
      const data = await nats.request<SessionRow[]>(GENIE_SUBJECTS.sessions.list(ORG_ID));
      setSessions(Array.isArray(data) ? data : []);
      setListState('ready');
      setListError(null);
    } catch (err) {
      if (sessions.length === 0) setListState('error');
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [nats, sessions.length]);

  useEffect(() => {
    fetchSessions();
    const timer = setInterval(fetchSessions, 10_000);
    return () => clearInterval(timer);
  }, [fetchSessions]);

  // ---- Fetch session content (turns) ----
  const fetchTurns = useCallback(
    async (sessionId: string, offset: number, append: boolean) => {
      if (!append) setThreadState('loading');
      try {
        const data = await nats.request<{ turns: TurnRow[]; hasMore: boolean }>(
          GENIE_SUBJECTS.sessions.content(ORG_ID),
          { sessionId, offset, limit: PAGE_SIZE },
        );
        const newTurns = Array.isArray(data?.turns) ? data.turns : [];
        setTurns((prev) => (append ? [...newTurns, ...prev] : newTurns));
        setHasMore(data?.hasMore ?? false);
        turnsOffsetRef.current = offset + newTurns.length;
        setThreadState('ready');
        setThreadError(null);
      } catch (err) {
        if (!append) setThreadState('error');
        setThreadError(err instanceof Error ? err.message : String(err));
      }
    },
    [nats],
  );

  // When selected session changes, load its content
  useEffect(() => {
    if (!selectedId) {
      setTurns([]);
      setThreadState('loading');
      return;
    }
    turnsOffsetRef.current = 0;
    setTurns([]);
    setIsStreaming(false);
    fetchTurns(selectedId, 0, false);
  }, [selectedId, fetchTurns]);

  // ---- Live streaming subscription ----
  // Subscribe to runtime events and append new turns for active session
  useNatsSubscription<{
    sessionId: string;
    turn: TurnRow;
    type: 'turn' | 'typing_start' | 'typing_end';
  }>(
    GENIE_SUBJECTS.events.runtime(ORG_ID),
    useCallback(
      (event) => {
        if (!event || !selectedId) return;

        // Match events for the selected session
        if (event.sessionId === selectedId) {
          if (event.type === 'turn' && event.turn) {
            setTurns((prev) => [...prev, event.turn]);
            setIsStreaming(false);
          } else if (event.type === 'typing_start') {
            setIsStreaming(true);
          } else if (event.type === 'typing_end') {
            setIsStreaming(false);
          }
        }

        // Refresh session list on any runtime event (lightweight)
        fetchSessions();
      },
      [selectedId, fetchSessions],
    ),
  );

  // ---- Load more (older messages) ----
  const handleLoadMore = useCallback(() => {
    if (!selectedId || !hasMore) return;
    fetchTurns(selectedId, turnsOffsetRef.current, true);
  }, [selectedId, hasMore, fetchTurns]);

  // ---- Search navigation ----
  const handleSearchNavigate = useCallback(
    (sessionId: string, turnIndex: number) => {
      setSelectedId(sessionId);
      // After loading, scroll to turn — we set a brief timeout to let content render
      setTimeout(() => {
        const el = document.querySelector('[data-gutter]')?.closest(`[style*="position: relative"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 500);
      // If not the same session, the useEffect for selectedId will reload turns
      if (sessionId === selectedId) {
        // Already loaded — just need to scroll to turn
        const gutterEls = document.querySelectorAll('[data-gutter]');
        for (const el of gutterEls) {
          if (el.textContent === `#${turnIndex}`) {
            el.closest('[style*="position: relative"]')?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
            break;
          }
        }
      }
    },
    [selectedId],
  );

  // ---- Timeline jump ----
  const handleJumpToTurn = useCallback((turnIndex: number) => {
    const gutterEls = document.querySelectorAll('[data-gutter]');
    for (const el of gutterEls) {
      if (el.textContent === `#${turnIndex}`) {
        el.closest('[style*="position: relative"]')?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
        break;
      }
    }
  }, []);

  // ---- Sorted & filtered sessions ----
  const sortedSessions = useMemo(() => {
    let result = [...sessions];

    // Filter
    if (filterActive === 'active') {
      result = result.filter((s) => s.isActive);
    } else if (filterActive === 'ended') {
      result = result.filter((s) => !s.isActive);
    }

    // Sort
    if (sortBy === 'recent') {
      result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } else if (sortBy === 'turns') {
      result.sort((a, b) => b.turnCount - a.turnCount);
    } else if (sortBy === 'cost') {
      result.sort((a, b) => b.costUsd - a.costUsd);
    }

    return result;
  }, [sessions, sortBy, filterActive]);

  const selectedSession = sessions.find((s) => s.id === selectedId) ?? null;

  // Check if selected session is active (for streaming indicator)
  const selectedIsActive = selectedSession?.isActive ?? false;

  // ---- Keyboard navigation ----
  useEffect(() => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-key keyboard handler dispatch
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = sortedSessions.findIndex((s) => s.id === selectedId);
        const next = idx < sortedSessions.length - 1 ? idx + 1 : 0;
        setSelectedId(sortedSessions[next]?.id ?? null);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = sortedSessions.findIndex((s) => s.id === selectedId);
        const next = idx > 0 ? idx - 1 : sortedSessions.length - 1;
        setSelectedId(sortedSessions[next]?.id ?? null);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sortedSessions, selectedId]);

  // ---- Render ----

  if (listState === 'loading' && sessions.length === 0) {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading sessions..." />
      </div>
    );
  }

  if (listState === 'error' && sessions.length === 0) {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={listError ?? 'Failed to load sessions'} service="sessions.list" onRetry={fetchSessions} />
      </div>
    );
  }

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* ──── Left Panel: Session List ──── */}
      <div style={styles.listPanel}>
        <div style={styles.listHeader}>
          <div>
            <h1 style={styles.title}>Sessions</h1>
            <p style={styles.subtitle}>
              {sessions.filter((s) => s.isActive).length} active {'\u00b7'} {sessions.length} total
              {listError && <span style={{ color: theme.warning }}> (stale)</span>}
            </p>
          </div>

          {/* Search + filters */}
          <div style={styles.filterBar}>
            <SearchBar orgId={ORG_ID} onNavigate={handleSearchNavigate} />
          </div>
          <div style={styles.filterBar}>
            <select
              style={styles.filterSelect}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              aria-label="Sort sessions"
            >
              <option value="recent">Recent</option>
              <option value="turns">Most Turns</option>
              <option value="cost">Highest Cost</option>
            </select>
            <select
              style={styles.filterSelect}
              value={filterActive}
              onChange={(e) => setFilterActive(e.target.value as typeof filterActive)}
              aria-label="Filter sessions"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="ended">Ended</option>
            </select>
          </div>
        </div>

        {/* Session list */}
        <div style={styles.sessionList}>
          {sortedSessions.length === 0 ? (
            <EmptyState
              icon={'\u2709'}
              title="No sessions"
              description={
                sessions.length === 0
                  ? 'Sessions will appear here once agents start working.'
                  : 'No sessions match the current filters.'
              }
            />
          ) : (
            sortedSessions.map((session) => (
              <SessionRowItem
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                onSelect={setSelectedId}
              />
            ))
          )}
        </div>
      </div>

      {/* ──── Right Panel: Conversation Thread ──── */}
      <ThreadPanel
        session={selectedSession}
        turns={turns}
        loadState={threadState}
        error={threadError}
        hasMore={hasMore}
        isStreaming={selectedIsActive && isStreaming}
        onLoadMore={handleLoadMore}
        onRetry={() => {
          if (selectedId) fetchTurns(selectedId, 0, false);
        }}
        onJumpToTurn={handleJumpToTurn}
      />
    </div>
  );
}
