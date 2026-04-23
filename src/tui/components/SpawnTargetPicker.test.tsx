/** @jsxImportSource @opentui/react */
/**
 * Tests for SpawnTargetPicker — asserts Enter on a session root yields an
 * intent whose preview matches `buildSpawnInvocation(...).cli`, Enter on a
 * specific window yields the window-scoped intent, Esc cancels, and a
 * stale-target case surfaces an inline error without calling onConfirm.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { useState } from 'react';
import { type SpawnIntent, buildSpawnInvocation } from '../../lib/spawn-invocation.js';
import type { TmuxSession } from '../diagnostics.js';
import { SpawnTargetPicker } from './SpawnTargetPicker.js';

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

/**
 * Mock keypresses go via stdin → parser → keyHandler emit, which is not
 * synchronous. Give the parser a tick, then force a re-render so state
 * updates land before we assert.
 */
async function flush(setup: NonNullable<typeof testSetup>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await setup.renderOnce();
}

/**
 * React state updates from test-code (not from events) don't synchronously
 * flush in React 19's concurrent mode. Call this twice after a prop-swap to
 * let the commit propagate before firing the next keystroke.
 */
async function flushReactCommit(setup: NonNullable<typeof testSetup>): Promise<void> {
  await flush(setup);
  await flush(setup);
}

/** Minimal tmux session factory — fills only fields the picker actually reads. */
function makeSession(name: string, windows: Array<{ index: number; name: string }>): TmuxSession {
  return {
    name,
    attached: false,
    windowCount: windows.length,
    created: 0,
    windows: windows.map((w) => ({
      sessionName: name,
      index: w.index,
      name: w.name,
      active: false,
      paneCount: 1,
      panes: [],
    })),
  };
}

/** Strip whitespace-only newlines from a char-frame so wrapped lines join up. */
function unwrap(frame: string): string {
  // The CliPreviewLine can wrap across box borders (the preview is quoted
  // shell, which runs wider than the 60-column modal). For substring-asserts
  // against the rendered CLI we need to collapse wrap markers. Replace each
  // `│\s*│` gap and `─` borders with nothing, then collapse whitespace.
  return frame
    .replace(/[│╭╮╰╯─\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('SpawnTargetPicker', () => {
  test('selecting a session root + Enter: onConfirm receives a session intent whose cli matches buildSpawnInvocation', async () => {
    const sessions: TmuxSession[] = [makeSession('simone', [{ index: 1, name: 'genie' }])];
    const onConfirm = mock((_intent: SpawnIntent) => {});
    const onCancel = mock(() => {});

    testSetup = await testRender(
      <SpawnTargetPicker agentName="reviewer" sessions={sessions} onConfirm={onConfirm} onCancel={onCancel} />,
      { width: 100, height: 20 },
    );
    await testSetup.renderOnce();

    // First row is the session root ("simone  (new window)"), which is the
    // default selection.
    testSetup.mockInput.pressEnter();
    await flush(testSetup);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(0);

    const intent = onConfirm.mock.calls[0]?.[0] as SpawnIntent;
    expect(intent).toEqual({
      kind: 'spawn-agent',
      name: 'reviewer',
      session: 'simone',
      newWindow: true,
    });

    // cli is the shell-quoted round-trip of argv — assert the exact form via
    // buildSpawnInvocation so the test stays in lockstep with the helper's
    // quoting rules (all args single-quoted).
    const { cli } = buildSpawnInvocation(intent);
    expect(cli).toBe("'spawn' 'reviewer' '--session' 'simone' '--new-window'");
  });

  test('selecting a specific window + Enter: onConfirm intent has window="simone:1" and omits newWindow', async () => {
    const sessions: TmuxSession[] = [makeSession('simone', [{ index: 1, name: 'genie' }])];
    const onConfirm = mock((_intent: SpawnIntent) => {});
    const onCancel = mock(() => {});

    testSetup = await testRender(
      <SpawnTargetPicker agentName="reviewer" sessions={sessions} onConfirm={onConfirm} onCancel={onCancel} />,
      { width: 100, height: 20 },
    );
    await testSetup.renderOnce();

    // Move cursor down one row from the session root to the window row.
    testSetup.mockInput.pressArrow('down');
    await flush(testSetup);
    testSetup.mockInput.pressEnter();
    await flush(testSetup);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const intent = onConfirm.mock.calls[0]?.[0] as SpawnIntent;
    expect(intent.kind).toBe('spawn-agent');
    if (intent.kind !== 'spawn-agent') throw new Error('expected spawn-agent');
    expect(intent.window).toBe('simone:1');
    expect(intent.newWindow).toBeUndefined();

    const { cli } = buildSpawnInvocation(intent);
    expect(cli).toBe("'spawn' 'reviewer' '--window' 'simone:1'");
  });

  test('Esc: onCancel fires, onConfirm does NOT fire', async () => {
    const sessions: TmuxSession[] = [makeSession('simone', [{ index: 1, name: 'genie' }])];
    const onConfirm = mock((_intent: SpawnIntent) => {});
    const onCancel = mock(() => {});

    testSetup = await testRender(
      <SpawnTargetPicker agentName="reviewer" sessions={sessions} onConfirm={onConfirm} onCancel={onCancel} />,
      { width: 100, height: 20 },
    );
    await testSetup.renderOnce();

    testSetup.mockInput.pressEscape();
    await flush(testSetup);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(0);
  });

  test('stale target: picked row disappears between open and Enter → Enter surfaces inline error, does NOT confirm', async () => {
    // Harness holds the sessions state. The picker's pick identity is latched
    // on the first render; swapping sessions to an empty list simulates the
    // picked target disappearing (e.g. another pane killed it mid-modal).
    const onConfirm = mock((_intent: SpawnIntent) => {});
    const onCancel = mock(() => {});
    const initialSessions: TmuxSession[] = [makeSession('simone', [{ index: 1, name: 'genie' }])];

    let swap: ((next: TmuxSession[]) => void) | undefined;
    function Harness() {
      const [live, setLive] = useState<TmuxSession[]>(initialSessions);
      swap = setLive;
      return <SpawnTargetPicker agentName="reviewer" sessions={live} onConfirm={onConfirm} onCancel={onCancel} />;
    }

    testSetup = await testRender(<Harness />, { width: 160, height: 20 });
    await testSetup.renderOnce();

    // Simulate topology mutation: the picked simone session vanishes.
    swap?.([]);
    await flushReactCommit(testSetup);

    // Enter now: the pick identity still points at 'simone', which no longer
    // exists. The guard must fire — no onConfirm, inline error rendered.
    testSetup.mockInput.pressEnter();
    await flush(testSetup);

    expect(onConfirm).toHaveBeenCalledTimes(0);
    expect(onCancel).toHaveBeenCalledTimes(0);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain('no longer exists');
  });

  test('stale target with a specific session vanishing while others remain: Enter surfaces inline error, preview still reflects user intent', async () => {
    const onConfirm = mock((_intent: SpawnIntent) => {});
    const onCancel = mock(() => {});
    const initialSessions: TmuxSession[] = [
      makeSession('prod', [{ index: 1, name: 'main' }]),
      makeSession('staging', [{ index: 1, name: 'main' }]),
    ];
    const mutatedSessions: TmuxSession[] = [makeSession('prod', [{ index: 1, name: 'main' }])];

    let swap: ((next: TmuxSession[]) => void) | undefined;
    function Harness() {
      const [live, setLive] = useState<TmuxSession[]>(initialSessions);
      swap = setLive;
      return <SpawnTargetPicker agentName="reviewer" sessions={live} onConfirm={onConfirm} onCancel={onCancel} />;
    }

    testSetup = await testRender(<Harness />, { width: 160, height: 20 });
    await testSetup.renderOnce();

    // Navigate to the 'staging' session row (index 2: prod-session, prod:1,
    // staging-session, staging:1).
    testSetup.mockInput.pressArrow('down');
    await flush(testSetup);
    testSetup.mockInput.pressArrow('down');
    await flush(testSetup);

    // Mutate topology: staging disappears. The pick identity still points at
    // 'staging' because we store by identity, not index.
    swap?.(mutatedSessions);
    await flushReactCommit(testSetup);

    testSetup.mockInput.pressEnter();
    await flush(testSetup);

    // Stale-guard must prevent the confirm — we can't spawn into a ghost.
    expect(onConfirm).toHaveBeenCalledTimes(0);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain('no longer exists');
    // The surviving 'prod' row is still listed.
    expect(frame).toContain('prod');
  });

  test('CliPreviewLine renders the current intent cli below the list, updating as selection changes', async () => {
    const sessions: TmuxSession[] = [makeSession('simone', [{ index: 1, name: 'genie' }])];
    const onConfirm = mock((_intent: SpawnIntent) => {});
    const onCancel = mock(() => {});

    testSetup = await testRender(
      <SpawnTargetPicker agentName="reviewer" sessions={sessions} onConfirm={onConfirm} onCancel={onCancel} />,
      { width: 200, height: 20 },
    );
    await testSetup.renderOnce();

    // The CLI preview can wrap inside the fixed-width modal — assert on the
    // distinctive argv tokens rather than the full concatenated string, so
    // the test is robust against soft-wrap artifacts.
    let frame = unwrap(testSetup.captureCharFrame());
    // Default pick = first row (session root) → preview shows session target.
    expect(frame).toContain("'spawn'");
    expect(frame).toContain("'reviewer'");
    expect(frame).toContain("'--session'");
    expect(frame).toContain("'simone'");
    // Confirm the "new-window" flag is present (wrapped or not).
    expect(frame).toMatch(/new-\s*window/);

    // Move down to the window row → preview updates to window form.
    testSetup.mockInput.pressArrow('down');
    await flush(testSetup);

    frame = unwrap(testSetup.captureCharFrame());
    expect(frame).toContain("'--window'");
    expect(frame).toContain("'simone:1'");
    // And the preview MUST no longer claim the session+new-window form —
    // those tokens should be absent once we're on the window row.
    expect(frame).not.toContain("'--session'");
    expect(frame).not.toContain("'--new-window'");
  });
});
