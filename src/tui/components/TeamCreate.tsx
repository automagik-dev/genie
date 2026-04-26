/** @jsxImportSource @opentui/react */
/**
 * TeamCreate — two-step modal for creating a new team from the TUI.
 *
 * Step 1: team name input (validated via `validateBranchName` from
 *         team-manager — the same rule `genie team create` enforces).
 * Step 2: member tick list — space toggles, Enter confirms, Esc goes back.
 *
 * On final Enter the modal calls `onConfirm({ teamName, members })` and
 * the parent (Nav.tsx) is responsible for the detached `genie team create`
 * + follow-up `genie team hire` sequence. Execution is deliberately NOT
 * done here — this component is pure UI state.
 *
 * The preview line at the bottom of each step renders the exact argv that
 * the parent will execute, via `buildSpawnInvocation` (single source of
 * truth from Group 3). That guarantees the preview cannot drift from
 * what runs.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';
import { validateBranchName } from '../../lib/team-manager.js';
import { palette } from '../theme.js';
import { CliPreviewLine } from './CliPreviewLine.js';

/**
 * @internal - consumed only by Nav.tsx in the workspace-root "New team" action.
 *             Not re-exported; we never publish this type outside the package.
 */
interface TeamCreateProps {
  /** Candidate member agent names, rendered as a tick list in step 2. */
  availableAgents: string[];
  /** Default workspace repo — flows into `buildSpawnInvocation` as `--repo`. */
  workspaceRoot?: string;
  /** Called when the user confirms step 2. */
  onConfirm: (result: { teamName: string; members: string[] }) => void;
  /** Called when the user aborts (Esc on step 1). */
  onCancel: () => void;
}

type Step = 'name' | 'members';

/**
 * Return the branch-name error message (human readable) or `null` if valid.
 * `validateBranchName` throws on invalid input — we catch and unwrap the message.
 * An empty name is treated as "incomplete input" (no error yet, but Enter disabled).
 */
function validateName(name: string): string | null {
  if (name.length === 0) return null;
  try {
    validateBranchName(name);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function TeamCreate({ availableAgents, workspaceRoot, onConfirm, onCancel }: TeamCreateProps) {
  const [step, setStep] = useState<Step>('name');
  const [teamName, setTeamName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [memberCursor, setMemberCursor] = useState(0);

  const nameError = useMemo(() => validateName(teamName), [teamName]);
  const nameValid = teamName.length > 0 && nameError === null;

  const intent = useMemo(
    () =>
      ({
        kind: 'create-team' as const,
        name: teamName.length > 0 ? teamName : 'TEAM_NAME',
        repo: workspaceRoot,
      }) as const,
    [teamName, workspaceRoot],
  );

  const handleNameChange = useCallback((value: string) => {
    setTeamName(value);
  }, []);

  const advanceFromName = useCallback(() => {
    if (!nameValid) return;
    setStep('members');
  }, [nameValid]);

  const toggleMember = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const confirmMembers = useCallback(() => {
    onConfirm({ teamName, members: Array.from(selected) });
  }, [onConfirm, teamName, selected]);

  // Keyboard handling — scoped per step. Esc on step 1 cancels, on step 2
  // goes back to step 1 (so the user can edit the name after browsing members).
  useKeyboard((key) => {
    if (step === 'name') {
      handleNameStepKey(key, { onCancel, nameValid, advanceFromName });
      return;
    }
    handleMembersStepKey(key, {
      availableAgents,
      memberCursor,
      setStep,
      setMemberCursor,
      toggleMember,
      confirmMembers,
    });
  });

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
        borderColor={palette.borderActive}
        backgroundColor={palette.bgRaised}
        paddingX={3}
        paddingY={1}
        flexDirection="column"
        width={64}
        gap={1}
      >
        <text>
          <span fg={palette.accent}>New team</span>
          <span fg={palette.textMuted}>{step === 'name' ? ' \u2014 step 1 of 2' : ' \u2014 step 2 of 2'}</span>
        </text>

        {step === 'name' ? (
          <NameStep value={teamName} onChange={handleNameChange} onSubmit={advanceFromName} errorMessage={nameError} />
        ) : (
          <MembersStep agents={availableAgents} selected={selected} cursor={memberCursor} />
        )}

        <CliPreviewLine
          intent={intent}
          hint={
            step === 'name' ? 'Enter: next \u00b7 Esc: cancel' : 'Space: toggle \u00b7 Enter: create \u00b7 Esc: back'
          }
        />
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — name input
// ---------------------------------------------------------------------------

interface NameStepProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  errorMessage: string | null;
}

function NameStep({ value, onChange, onSubmit, errorMessage }: NameStepProps) {
  return (
    <box flexDirection="column" gap={1}>
      <text>
        <span fg={palette.textDim}>Team name (git-branch-safe):</span>
      </text>
      <input
        value={value}
        onInput={onChange}
        onChange={onChange}
        onSubmit={onSubmit as () => void}
        focused
        placeholder="feat/auth-bug"
        backgroundColor={palette.bg}
        textColor={palette.text}
        placeholderColor={palette.textMuted}
      />
      {errorMessage !== null ? (
        <text>
          <span fg={palette.error}>{`\u26a0 ${errorMessage}`}</span>
        </text>
      ) : null}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — members tick list
// ---------------------------------------------------------------------------

interface MembersStepProps {
  agents: string[];
  selected: Set<string>;
  cursor: number;
}

function MembersStep({ agents, selected, cursor }: MembersStepProps) {
  if (agents.length === 0) {
    return (
      <box flexDirection="column">
        <text>
          <span fg={palette.textDim}>No agents registered</span>
        </text>
        <text>
          <span fg={palette.textMuted}>Members can be hired later via `genie team hire`.</span>
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      <text>
        <span fg={palette.textDim}>Select members (space to toggle):</span>
      </text>
      <box flexDirection="column">
        {agents.map((name, idx) => {
          const isSelected = selected.has(name);
          const isCursor = idx === cursor;
          const tick = isSelected ? '[x]' : '[ ]';
          const prefix = isCursor ? '\u25b6 ' : '  ';
          return (
            <text key={name}>
              <span fg={isCursor ? palette.accent : palette.textMuted}>{prefix}</span>
              <span fg={isSelected ? palette.success : palette.textDim}>{tick}</span>
              <span fg={palette.text}>{` ${name}`}</span>
            </text>
          );
        })}
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Keyboard dispatch helpers (hoisted to keep the useKeyboard body flat).
// ---------------------------------------------------------------------------

type Key = { name?: string };

function isEnter(key: Key): boolean {
  return key.name === 'enter' || key.name === 'return';
}

function handleNameStepKey(
  key: Key,
  opts: { onCancel: () => void; nameValid: boolean; advanceFromName: () => void },
): void {
  if (key.name === 'escape') {
    opts.onCancel();
    return;
  }
  if (isEnter(key) && opts.nameValid) {
    opts.advanceFromName();
  }
}

function handleMembersStepKey(
  key: Key,
  opts: {
    availableAgents: string[];
    memberCursor: number;
    setStep: (s: Step) => void;
    setMemberCursor: (fn: (prev: number) => number) => void;
    toggleMember: (name: string) => void;
    confirmMembers: () => void;
  },
): void {
  if (key.name === 'escape') {
    opts.setStep('name');
    return;
  }
  if (opts.availableAgents.length === 0) {
    if (isEnter(key)) opts.confirmMembers();
    return;
  }
  if (key.name === 'up' || key.name === 'k') {
    opts.setMemberCursor((prev) => (prev <= 0 ? opts.availableAgents.length - 1 : prev - 1));
    return;
  }
  if (key.name === 'down' || key.name === 'j') {
    opts.setMemberCursor((prev) => (prev >= opts.availableAgents.length - 1 ? 0 : prev + 1));
    return;
  }
  if (key.name === 'space') {
    const name = opts.availableAgents[opts.memberCursor];
    if (name) opts.toggleMember(name);
    return;
  }
  if (isEnter(key)) opts.confirmMembers();
}
