/** @jsxImportSource @opentui/react */
/**
 * Visual regression harness for the Severance Lumon-MDR TUI palette.
 *
 * Renders each major TUI surface to an opentui char-frame and asserts the
 * frame against a committed snapshot. The snapshot encodes both the layout
 * AND the palette colours (opentui emits ANSI colour escapes into the
 * captured frame string), so flipping any token in
 * `packages/genie-tokens/palette.ts` produces a snapshot diff and fails CI.
 *
 * Update workflow:
 *   1. Modify a component or palette token.
 *   2. Run `bun test test/visual/` — the diff makes the failure obvious.
 *   3. If the new look is intentional, regenerate via
 *      `bun test test/visual/ -u` and commit the snapshot churn.
 *
 * Why these surfaces:
 *   - `Nav` (loading) — the primary left panel; its header + footer prove
 *     the bgRaised + accent tokens are wired everywhere.
 *   - `TreeNode` — every `wsAgentState` (running / stopped / error / spawning)
 *     pulls a different palette token, so a single rotation of any of them
 *     changes the icon + label colour and breaks the snapshot.
 *   - `SystemStatsView` at 10 / 50 / 85 / 95 % — locks the recalibrated
 *     `pickColor` thresholds (>70 warning, >90 error). 24% sits firmly in
 *     mint; 95% must be crimson.
 *   - `AgentPicker`, `QuitDialog`, `TeamCreate`, `ContextMenu` — the modal
 *     family. They share the bgOverlay scrim + borderActive accent and a
 *     palette change anywhere shows up here first.
 *
 * Determinism:
 *   - `VERSION` (read from package.json) is masked to `vX.Y.Z` because the
 *     auto-version commit bumps it every release and would otherwise force
 *     a snapshot churn unrelated to the palette.
 *   - All components are rendered with synthetic, fixture-supplied data.
 *     None of them shell out to tmux, scan the filesystem, or read live
 *     hardware metrics inside this harness.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

// Mock live system probes BEFORE the Nav module graph imports them. SystemStats
// inside Nav would otherwise fetch real CPU/RAM and produce non-deterministic
// frames; the visual harness needs a fixed surface. The mocks pretend the
// probes never resolve, so SystemStatsView renders its `stats === null`
// placeholder (just the genie banner).
mock.module('systeminformation', () => ({
  default: {
    currentLoad: () => new Promise(() => {}),
    mem: () => new Promise(() => {}),
  },
  currentLoad: () => new Promise(() => {}),
  mem: () => new Promise(() => {}),
}));

import { palette } from '../../packages/genie-tokens';
import { AgentPicker, type AgentPickerEntry } from '../../src/tui/components/AgentPicker';
import { ContextMenu } from '../../src/tui/components/ContextMenu';
import { Nav } from '../../src/tui/components/Nav';
import { QuitDialog } from '../../src/tui/components/QuitDialog';
import { type SystemInfo, SystemStatsView } from '../../src/tui/components/SystemStats';
import { TeamCreate } from '../../src/tui/components/TeamCreate';
import { TreeNodeRow } from '../../src/tui/components/TreeNode';
import type { AgentState, MenuItem, TreeNode as TreeNodeType } from '../../src/tui/types';

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

/**
 * Mask the live VERSION string so the snapshot stays stable across release
 * bumps. Replaces ` v4.260426.2 ` (or any equivalent) with ` vX.Y.Z `.
 *
 * The substitution runs on the captured frame, NOT on package.json, so the
 * production code keeps reading the real version at runtime.
 */
function maskVersion(frame: string): string {
  return frame.replace(/ v\d+(?:\.\d+)*(?:[-\w]+)?/g, ' vX.Y.Z');
}

/** Flush microtasks + a frame inside `act()` so React commits before capture. */
async function flushFrame(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await setup.renderOnce();
}

/** Convert a 0..1 float channel into a 2-char hex byte. */
function channelHex(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
}

/** Format an RGBA-like as #RRGGBB (alpha is dropped — opentui ignores it). */
function rgbaHex(rgba: { r: number; g: number; b: number }): string {
  return `#${channelHex(rgba.r)}${channelHex(rgba.g)}${channelHex(rgba.b)}`;
}

/**
 * Build a palette-sensitive serialisation of the rendered frame.
 *
 * The opentui `captureCharFrame` only returns printable characters — colour
 * is invisible. To make the snapshot fail when ANY palette token changes,
 * we walk `captureSpans()` and emit one `fg=#... bg=#... "text"` block per
 * span. The visible char frame is included above for human readability so a
 * snapshot diff is still scannable.
 */
function serialiseFrame(setup: Awaited<ReturnType<typeof testRender>>): string {
  const charFrame = maskVersion(setup.captureCharFrame());
  const spans = setup.captureSpans();
  const lines: string[] = ['── visible chars ──', charFrame.trimEnd(), '── colour spans ──'];
  spans.lines.forEach((line, rowIdx) => {
    const nonEmpty = line.spans.filter((s) => s.text.trim().length > 0);
    if (nonEmpty.length === 0) return;
    const formatted = nonEmpty
      .map((s) => `[fg=${rgbaHex(s.fg)} bg=${rgbaHex(s.bg)}]${JSON.stringify(maskVersion(s.text))}`)
      .join(' ');
    lines.push(`row ${String(rowIdx).padStart(2, '0')}: ${formatted}`);
  });
  return lines.join('\n');
}

/** Capture + serialise + commit snapshot. */
async function captureFrame(): Promise<string> {
  if (!testSetup) throw new Error('testSetup not initialised');
  await flushFrame(testSetup);
  return serialiseFrame(testSetup);
}

// ---------------------------------------------------------------------------
// SystemStatsView — load-band fixtures (10 / 50 / 85 / 95 %)
// ---------------------------------------------------------------------------

/** Build a deterministic SystemInfo for a given CPU/RAM/load percent. */
function makeStats(percent: number): SystemInfo {
  return {
    cpu: {
      combined: percent,
      hotCores: [
        { id: 0, load: percent },
        { id: 1, load: Math.max(0, percent - 5) },
        { id: 2, load: Math.max(0, percent - 10) },
      ],
      coreCount: 8,
    },
    ram: {
      usedGB: Math.round((percent / 100) * 16 * 10) / 10,
      totalGB: 16,
      percent,
    },
    swap: {
      usedGB: 0,
      totalGB: 0,
      percent: 0,
    },
    load: {
      percent,
      busy: Math.round((percent / 100) * 8 * 10) / 10,
      total: 8,
    },
  };
}

describe('visual: SystemStatsView', () => {
  test('placeholder (no stats yet) — only the genie banner is shown', async () => {
    testSetup = await testRender(<SystemStatsView stats={null} />, { width: 40, height: 6 });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });

  test('10% load — mint accent across CPU/RAM/Load (no warning, no alarm)', async () => {
    testSetup = await testRender(<SystemStatsView stats={makeStats(10)} />, { width: 40, height: 8 });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
    // Sanity: at 10% the petrol-mint band must dominate. Crimson must NOT
    // appear anywhere — that token is reserved for true alarms (>90). The
    // serialised frame embeds `fg=#RRGGBB` per span, so a string match on
    // the error hex (lowercased) catches an accidental swap into the alarm
    // band even before the snapshot diff.
    expect(frame.toLowerCase()).not.toContain(palette.error.toLowerCase());
  });

  test('50% load — still mint (recalibrated threshold is >70, not >50)', async () => {
    testSetup = await testRender(<SystemStatsView stats={makeStats(50)} />, { width: 40, height: 8 });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });

  test('85% load — warning band (amber for the >70 threshold)', async () => {
    testSetup = await testRender(<SystemStatsView stats={makeStats(85)} />, { width: 40, height: 8 });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });

  test('95% load — alarm band (crimson for the >90 threshold)', async () => {
    testSetup = await testRender(<SystemStatsView stats={makeStats(95)} />, { width: 40, height: 8 });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// TreeNode — each wsAgentState
// ---------------------------------------------------------------------------

function makeAgentNode(name: string, state: AgentState): TreeNodeType {
  return {
    id: `agent:${name}`,
    type: 'agent',
    label: name,
    depth: 0,
    expanded: false,
    children: [],
    data: { windowCount: state === 'running' ? 1 : 0 },
    activePanes: state === 'running' ? 1 : 0,
    wsAgentState: state,
  };
}

describe('visual: TreeNode (workspace agent states)', () => {
  const states: AgentState[] = ['running', 'stopped', 'error', 'spawning'];

  for (const state of states) {
    test(`agent state = ${state} — palette + icon match the design`, async () => {
      const node = makeAgentNode('engineer', state);
      testSetup = await testRender(
        <box width={40} height={1}>
          <TreeNodeRow node={node} selected={false} onSelect={() => {}} onToggle={() => {}} onContextMenu={() => {}} />
        </box>,
        { width: 40, height: 1 },
      );
      const frame = await captureFrame();
      expect(frame).toMatchSnapshot();
    });
  }

  test('selected agent — accentDim row background + accentBright label', async () => {
    const node = makeAgentNode('engineer', 'running');
    testSetup = await testRender(
      <box width={40} height={1}>
        <TreeNodeRow node={node} selected={true} onSelect={() => {}} onToggle={() => {}} onContextMenu={() => {}} />
      </box>,
      { width: 40, height: 1 },
    );
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// AgentPicker — empty + filtered
// ---------------------------------------------------------------------------

const AGENT_PICKER_AGENTS: AgentPickerEntry[] = [{ name: 'engineer' }, { name: 'reviewer' }, { name: 'qa' }];

const staticAgents = (entries: AgentPickerEntry[]) => () => Promise.resolve(entries);

describe('visual: AgentPicker', () => {
  test('empty directory — "No agents registered" message is rendered', async () => {
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone' }}
        onConfirm={() => {}}
        onCancel={() => {}}
        loadAgents={staticAgents([])}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });

  test('populated — three agents listed with first row selected', async () => {
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone', window: 'simone:1' }}
        onConfirm={() => {}}
        onCancel={() => {}}
        loadAgents={staticAgents(AGENT_PICKER_AGENTS)}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });

  test('filtered — typing "rev" narrows the list to "reviewer"', async () => {
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone', window: 'simone:1' }}
        onConfirm={() => {}}
        onCancel={() => {}}
        loadAgents={staticAgents(AGENT_PICKER_AGENTS)}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    await flushFrame(testSetup);
    await act(async () => {
      testSetup?.mockInput.pressKey('r');
      testSetup?.mockInput.pressKey('e');
      testSetup?.mockInput.pressKey('v');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// QuitDialog
// ---------------------------------------------------------------------------

describe('visual: QuitDialog', () => {
  test('default — overlay + bordered panel + "Quit genie?" prompt', async () => {
    testSetup = await testRender(<QuitDialog onConfirm={() => {}} onCancel={() => {}} />, {
      width: 80,
      height: 20,
      kittyKeyboard: true,
    });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// TeamCreate — name step (members step requires keystroke navigation)
// ---------------------------------------------------------------------------

describe('visual: TeamCreate', () => {
  test('step 1 (name) — input field + cli preview line', async () => {
    testSetup = await testRender(
      <TeamCreate
        availableAgents={['engineer', 'reviewer']}
        workspaceRoot="/repo"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { width: 100, height: 24, kittyKeyboard: true },
    );
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// ContextMenu — running-agent menu
// ---------------------------------------------------------------------------

const RUNNING_AGENT_MENU: MenuItem[] = [
  { label: 'Clone', shortcut: 'N', action: 'agent-new-window' },
  { label: 'New window', shortcut: 'W', action: 'new-empty-window' },
  { label: 'Spawn into…', shortcut: 'I', action: 'spawn-into' },
  { label: 'Rename...', shortcut: 'R', action: 'rename-session', needsInput: true, separator: true },
  { label: 'Remove', shortcut: 'K', action: 'kill' },
];

describe('visual: ContextMenu', () => {
  test('running agent menu — five items with bordered overlay', async () => {
    testSetup = await testRender(
      <ContextMenu items={RUNNING_AGENT_MENU} onAction={() => {}} onClose={() => {}} positionY={0} />,
      { width: 80, height: 16, kittyKeyboard: true },
    );
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Nav — loading state (no diagnostics yet)
// ---------------------------------------------------------------------------
//
// Nav fetches tmux topology + filesystem agents on mount. In the test
// harness those calls happen asynchronously and won't have resolved by the
// time we capture the first frame, so the rendered surface is the loading
// skeleton: header ("Sessions"), "Collecting..." placeholder, the
// SystemStats banner, and the keybinding footer. That's exactly the
// per-token surface we want to lock in — every chrome edge of the left
// panel.

describe('visual: Nav (loading skeleton)', () => {
  test('cold start — header + collecting placeholder + footer', async () => {
    testSetup = await testRender(<Nav onTmuxSessionSelect={() => {}} keyboardDisabled />, {
      width: 50,
      height: 20,
      kittyKeyboard: true,
    });
    const frame = await captureFrame();
    expect(frame).toMatchSnapshot();
  });
});
