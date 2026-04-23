/** @jsxImportSource @opentui/react */
/**
 * AgentPicker — "Spawn here…" modal.
 *
 * Opened from a session-node or window-node in the Nav tree. The caller
 * supplies the target (session + optional window); the user picks an agent
 * from the directory, sees a live `CliPreviewLine` of the resolved `genie
 * spawn …` command, and Enter confirms.
 *
 * This is the reverse direction of Group 4 (SpawnTargetPicker): instead of
 * picking a target from a known agent, the target is fixed and we pick an
 * agent from the directory.
 *
 * Intent composition is delegated to `buildSpawnInvocation` (Group 3) via
 * the CliPreviewLine component; the intent we pass to `onConfirm` on Enter
 * is the exact same object rendered in the preview — the preview and the
 * executed argv cannot drift.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SpawnIntent } from '../../lib/spawn-invocation.js';
import { palette } from '../theme.js';
import { CliPreviewLine } from './CliPreviewLine.js';

/** Node in the Nav tree that the picker was opened on. */
export interface AgentPickerTarget {
  /** tmux session name — always required. */
  session: string;
  /** tmux window target (e.g., "simone:1"). Omitted for session-root targets. */
  window?: string;
}

/** Minimal shape needed from the directory listing. */
export interface AgentPickerEntry {
  name: string;
}

interface AgentPickerProps {
  target: AgentPickerTarget;
  onConfirm: (intent: SpawnIntent) => void;
  onCancel: () => void;
  /**
   * Injectable agent loader — defaults to shelling out to
   * `genie dir ls --json`. Tests supply a static list.
   */
  loadAgents?: () => Promise<AgentPickerEntry[]>;
}

/** Default loader — shells out to `genie dir ls --json` and parses stdout. */
async function defaultLoadAgents(): Promise<AgentPickerEntry[]> {
  const { spawn } = await import('node:child_process');
  const bunPath = process.execPath || 'bun';
  const genieBin = process.argv[1];
  const [command, args] =
    genieBin && genieBin !== 'genie'
      ? [bunPath, [genieBin, 'dir', 'ls', '--json']]
      : ['genie', ['dir', 'ls', '--json']];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });

  const parsed = JSON.parse(stdout) as Array<{ name?: unknown }>;
  return parsed
    .map((e) => (typeof e?.name === 'string' ? { name: e.name } : null))
    .filter((e): e is AgentPickerEntry => e !== null);
}

/** Build the SpawnIntent for the currently-selected agent + target. */
function buildIntent(agentName: string, target: AgentPickerTarget): SpawnIntent {
  const intent: SpawnIntent = {
    kind: 'spawn-agent',
    name: agentName,
    session: target.session,
  };
  if (target.window !== undefined && target.window.length > 0) {
    intent.window = target.window;
  } else {
    intent.newWindow = true;
  }
  return intent;
}

/** Narrow the agent list to entries whose name contains `filter` (case-insensitive). */
function applyFilter(agents: AgentPickerEntry[], filter: string): AgentPickerEntry[] {
  if (filter.length === 0) return agents;
  const needle = filter.toLowerCase();
  return agents.filter((a) => a.name.toLowerCase().includes(needle));
}

interface ControlKeyDeps {
  onCancel: () => void;
  onConfirm: (intent: SpawnIntent) => void;
  target: AgentPickerTarget;
  highlighted: AgentPickerEntry | undefined;
  filteredLength: number;
  setSelectedIndex: (fn: (prev: number) => number) => void;
  setFilter: (fn: (prev: string) => string) => void;
}

/** Handle reserved control keys (escape, enter, arrows, backspace). Returns true if handled. */
function handleControlKey(key: { name?: string }, deps: ControlKeyDeps): boolean {
  if (key.name === 'escape') {
    deps.onCancel();
    return true;
  }
  if (key.name === 'up' && deps.filteredLength > 0) {
    deps.setSelectedIndex((prev) => (prev <= 0 ? deps.filteredLength - 1 : prev - 1));
    return true;
  }
  if (key.name === 'down' && deps.filteredLength > 0) {
    deps.setSelectedIndex((prev) => (prev >= deps.filteredLength - 1 ? 0 : prev + 1));
    return true;
  }
  if ((key.name === 'return' || key.name === 'enter') && deps.highlighted) {
    deps.onConfirm(buildIntent(deps.highlighted.name, deps.target));
    return true;
  }
  if (key.name === 'backspace') {
    deps.setFilter((prev) => prev.slice(0, -1));
    return true;
  }
  // Arrow keys on empty list still count as "handled" — swallow so they don't
  // get appended to the filter buffer.
  if (key.name === 'up' || key.name === 'down' || key.name === 'return' || key.name === 'enter') {
    return true;
  }
  return false;
}

/** Append a single printable character from the key event to the filter buffer. */
function appendCharIfPrintable(
  key: { name?: string; sequence?: string },
  setFilter: (fn: (prev: string) => string) => void,
): void {
  const ch = key.sequence ?? key.name;
  if (typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch !== '\x7f') {
    setFilter((prev) => prev + ch);
  }
}

export function AgentPicker({ target, onConfirm, onCancel, loadAgents = defaultLoadAgents }: AgentPickerProps) {
  const [agents, setAgents] = useState<AgentPickerEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let active = true;
    loadAgents()
      .then((list) => {
        if (!active) return;
        setAgents(list);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setAgents([]);
      });
    return () => {
      active = false;
    };
  }, [loadAgents]);

  const filtered = useMemo(() => (agents ? applyFilter(agents, filter) : []), [agents, filter]);

  // Keep selection in bounds when filter narrows the list.
  useEffect(() => {
    if (filtered.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(filtered.length - 1);
    }
  }, [filtered.length, selectedIndex]);

  const highlighted = filtered[selectedIndex];
  const previewIntent: SpawnIntent | null = highlighted ? buildIntent(highlighted.name, target) : null;

  const handleKey = useCallback(
    (key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }) => {
      if (
        handleControlKey(key, {
          onCancel,
          onConfirm,
          target,
          highlighted,
          filteredLength: filtered.length,
          setSelectedIndex,
          setFilter,
        })
      )
        return;
      if (key.ctrl || key.meta) return;
      appendCharIfPrintable(key, setFilter);
    },
    [filtered.length, highlighted, onCancel, onConfirm, target],
  );

  useKeyboard(handleKey);

  const targetLabel = target.window ? target.window : target.session;
  const modeHint = target.window ? 'in window' : 'new window in session';
  const statusText = agents === null ? 'Loading agents…' : loadError !== null ? `Load failed: ${loadError}` : null;

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor="#0a0a0a"
    >
      <box
        border
        borderStyle="rounded"
        borderColor={palette.violet}
        backgroundColor={palette.bgLight}
        width={80}
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        gap={1}
      >
        <text>
          <span fg={palette.purple}>Spawn here</span>
          <span fg={palette.textDim}>{` — ${modeHint} `}</span>
          <span fg={palette.text}>{targetLabel}</span>
        </text>

        <text>
          <span fg={palette.textDim}>{'Filter: '}</span>
          <span fg={palette.text}>{filter.length > 0 ? filter : ' '}</span>
          <span fg={palette.textMuted}>{filter.length > 0 ? '' : '(type to narrow)'}</span>
        </text>

        {statusText !== null ? (
          <text>
            <span fg={loadError !== null ? palette.error : palette.textDim}>{statusText}</span>
          </text>
        ) : filtered.length === 0 ? (
          <text>
            <span fg={palette.textMuted}>No agents registered</span>
          </text>
        ) : (
          <box flexDirection="column">
            {filtered.map((agent, i) => (
              <text key={agent.name}>
                <span fg={i === selectedIndex ? palette.violet : palette.textDim}>
                  {i === selectedIndex ? '▸ ' : '  '}
                </span>
                <span fg={i === selectedIndex ? palette.text : palette.textDim}>{agent.name}</span>
              </text>
            ))}
          </box>
        )}

        {previewIntent !== null ? <CliPreviewLine intent={previewIntent} /> : null}
      </box>
    </box>
  );
}
