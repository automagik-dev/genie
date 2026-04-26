/** @jsxImportSource @opentui/react */
/**
 * SpawnTargetPicker — modal that lets the user pick an EXPLICIT tmux target
 * (a session root, or a specific window inside a session) when spawning an
 * agent from the Nav tree.
 *
 * Replaces the old implicit "current session" routing in `spawnAgent()`, which
 * crammed every new agent into the hardcoded `genie` session regardless of
 * intent. The picker builds a `SpawnIntent` (via `buildSpawnInvocation` from
 * Group 3) and renders the exact `genie spawn …` command via `CliPreviewLine`
 * (from Group 7), so the preview and the executed argv cannot drift.
 *
 * Live refresh + stale-guard:
 *   - Sessions come from the parent's existing diagnostics poll — no second
 *     poller. When the parent passes a new `sessions` prop, the tree updates.
 *   - The user's pick is stored as a stable identity ({sessionName, windowIndex})
 *     — NOT an index into the current row list — so it survives topology
 *     shuffles (reorder, name renames elsewhere).
 *   - On Enter, we re-validate the picked identity exists RIGHT NOW in the
 *     `sessions` prop. If it's gone, we surface an inline error row and keep
 *     the modal open so the user can pick another target.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';
import type { SpawnIntent } from '../../lib/spawn-invocation.js';
import type { TmuxSession } from '../diagnostics.js';
import { palette } from '../theme.js';
import { CliPreviewLine } from './CliPreviewLine.js';

/** The TUI's own tmux session — filtered from picker targets to prevent self-attach loops. */
const TUI_SESSION = 'genie-tui';

/**
 * A selectable row in the picker. Either a session root (spawn opens a new
 * window in that session) or a specific window (spawn splits the existing
 * window).
 */
type PickerRow =
  | { kind: 'session'; sessionName: string; label: string }
  | { kind: 'window'; sessionName: string; windowIndex: number; label: string };

/**
 * A stable identity for the user's current pick. Survives session-list
 * reshuffles, rename-elsewhere etc. Compared against the live `sessions` prop
 * on Enter to detect stale targets.
 */
type Pick = { kind: 'session'; sessionName: string } | { kind: 'window'; sessionName: string; windowIndex: number };

/**
 * Props for the picker. Intentionally NOT exported — knip flagged it as
 * unused public surface. Callers infer the shape from the component
 * signature (see `SpawnTargetPicker` below).
 */
interface SpawnTargetPickerProps {
  /** Agent name to spawn (will become `genie spawn <name> …`). */
  agentName: string;
  /** Live tmux topology sourced from the parent's diagnostics poll. */
  sessions: TmuxSession[];
  /** Called with the resolved intent when the user confirms. */
  onConfirm: (intent: SpawnIntent) => void;
  /** Called when the user cancels (Esc). */
  onCancel: () => void;
}

/** Flatten sessions into a list of selectable rows: session > its windows. */
function buildRows(sessions: TmuxSession[]): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const session of sessions) {
    if (session.name === TUI_SESSION) continue;
    rows.push({
      kind: 'session',
      sessionName: session.name,
      label: `${session.name}  (new window)`,
    });
    for (const win of session.windows) {
      const windowLabel = win.name ? ` ${win.name}` : '';
      rows.push({
        kind: 'window',
        sessionName: session.name,
        windowIndex: win.index,
        label: `  ${session.name}:${win.index}${windowLabel}`,
      });
    }
  }
  return rows;
}

function pickFromRow(row: PickerRow): Pick {
  if (row.kind === 'session') {
    return { kind: 'session', sessionName: row.sessionName };
  }
  return { kind: 'window', sessionName: row.sessionName, windowIndex: row.windowIndex };
}

function picksEqual(a: Pick, b: PickerRow): boolean {
  if (a.kind === 'session' && b.kind === 'session') {
    return a.sessionName === b.sessionName;
  }
  if (a.kind === 'window' && b.kind === 'window') {
    return a.sessionName === b.sessionName && a.windowIndex === b.windowIndex;
  }
  return false;
}

/** Does the pick still exist in the live session list? */
function pickExists(pick: Pick, sessions: TmuxSession[]): boolean {
  const session = sessions.find((s) => s.name === pick.sessionName);
  if (!session) return false;
  if (pick.kind === 'session') return true;
  return session.windows.some((w) => w.index === pick.windowIndex);
}

/** Build a SpawnIntent for a given pick. */
function pickToIntent(agentName: string, pick: Pick | null): SpawnIntent {
  if (!pick) {
    // No selection yet — return a minimal intent so CliPreviewLine renders
    // the partial command without throwing.
    return { kind: 'spawn-agent', name: agentName };
  }
  if (pick.kind === 'session') {
    return {
      kind: 'spawn-agent',
      name: agentName,
      session: pick.sessionName,
      newWindow: true,
    };
  }
  return {
    kind: 'spawn-agent',
    name: agentName,
    window: `${pick.sessionName}:${pick.windowIndex}`,
  };
}

/** Pick label for error-row display. */
function pickLabel(pick: Pick): string {
  if (pick.kind === 'session') return pick.sessionName;
  return `${pick.sessionName}:${pick.windowIndex}`;
}

export function SpawnTargetPicker({ agentName, sessions, onConfirm, onCancel }: SpawnTargetPickerProps) {
  const rows = useMemo(() => buildRows(sessions), [sessions]);

  // Default pick = first row (if any). We store a stable identity, not an
  // index, so topology reshuffles don't silently change what the user picked.
  const [pick, setPick] = useState<Pick | null>(() => (rows[0] ? pickFromRow(rows[0]) : null));
  const [staleError, setStaleError] = useState<string | null>(null);

  // If the picker opened with no rows, rehydrate the pick once rows arrive.
  if (pick === null && rows[0]) {
    setPick(pickFromRow(rows[0]));
  }

  const selectedIndex = useMemo(() => {
    if (!pick) return -1;
    return rows.findIndex((r) => picksEqual(pick, r));
  }, [pick, rows]);

  const movePick = useCallback(
    (delta: 1 | -1) => {
      if (rows.length === 0) return;
      // If the pick doesn't map to a visible row any more (topology changed),
      // snap to the first row instead of trying to move relative to nothing.
      const base = selectedIndex < 0 ? 0 : selectedIndex;
      const next = (base + delta + rows.length) % rows.length;
      setPick(pickFromRow(rows[next]));
      setStaleError(null);
    },
    [rows, selectedIndex],
  );

  const handleEnter = useCallback(() => {
    if (!pick) return;
    if (!pickExists(pick, sessions)) {
      setStaleError(`Target "${pickLabel(pick)}" no longer exists — pick another.`);
      return;
    }
    onConfirm(pickToIntent(agentName, pick));
  }, [pick, sessions, agentName, onConfirm]);

  useKeyboard(
    useCallback(
      (key: { name?: string }) => {
        const n = key.name;
        if (n === 'escape') {
          onCancel();
          return;
        }
        if (n === 'enter' || n === 'return') {
          handleEnter();
          return;
        }
        if (n === 'up' || n === 'k') {
          movePick(-1);
        } else if (n === 'down' || n === 'j') {
          movePick(1);
        }
      },
      [onCancel, handleEnter, movePick],
    ),
  );

  const intent = useMemo(() => pickToIntent(agentName, pick), [agentName, pick]);

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor={palette.bgOverlay}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={palette.borderActive}
        backgroundColor={palette.bgRaised}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        width={60}
        gap={1}
      >
        <text>
          <span fg={palette.accent}>{`Spawn "${agentName}" into…`}</span>
        </text>

        {rows.length === 0 ? (
          <text>
            <span fg={palette.textDim}>No tmux sessions available. Press Esc to cancel.</span>
          </text>
        ) : (
          <box flexDirection="column">
            {rows.map((row, i) => (
              <text key={`${row.kind}:${row.sessionName}:${row.kind === 'window' ? row.windowIndex : ''}`}>
                <span fg={i === selectedIndex ? palette.accent : palette.text}>
                  {i === selectedIndex ? '> ' : '  '}
                  {row.label}
                </span>
              </text>
            ))}
          </box>
        )}

        {staleError ? (
          <text>
            <span fg={palette.error}>{`\u26a0 ${staleError}`}</span>
          </text>
        ) : null}

        <CliPreviewLine intent={intent} />
      </box>
    </box>
  );
}
