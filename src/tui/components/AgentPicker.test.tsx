/** @jsxImportSource @opentui/react */
/**
 * Tests for AgentPicker — asserts filter/select/confirm behavior, the
 * target→intent mapping, and parity between the rendered preview and
 * `buildSpawnInvocation(intent).cli`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { type SpawnIntent, buildSpawnInvocation } from '../../lib/spawn-invocation.js';
import { AgentPicker, type AgentPickerEntry } from './AgentPicker.js';

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

function staticLoader(entries: AgentPickerEntry[]): () => Promise<AgentPickerEntry[]> {
  return () => Promise.resolve(entries);
}

/**
 * Flush microtasks + a frame inside `act()` so React commits the loadAgents
 * promise resolution before we inspect the rendered frame. Without act,
 * React 19 defers state updates and our assertions fire against the initial
 * "Loading agents…" frame.
 */
async function flushLoader(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await setup.renderOnce();
}

/** Send a key and flush state updates so the next captureCharFrame reflects them. */
async function press(setup: Awaited<ReturnType<typeof testRender>>, fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await setup.renderOnce();
}

/**
 * Flatten a captured frame into a single line of content, stripping box-drawing
 * characters, wrap-induced newlines, and leading/trailing padding. Used to
 * assert the preview CLI is present even when the modal wrapped it across
 * multiple terminal rows.
 */
function flattenFrame(frame: string): string {
  return frame
    .replace(/[│╭╮╯╰─┌┐└┘]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('AgentPicker', () => {
  test('filter narrows the list and Enter confirms with a cli matching buildSpawnInvocation', async () => {
    const confirmed: SpawnIntent[] = [];
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'martins', window: 'martins:1' }}
        onConfirm={(intent) => confirmed.push(intent)}
        onCancel={() => {}}
        loadAgents={staticLoader([{ name: 'simone' }, { name: 'engineer' }])}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    await flushLoader(testSetup);

    // Type "si" to narrow to simone.
    await press(testSetup, () => {
      testSetup?.mockInput.pressKey('s');
    });
    await press(testSetup, () => {
      testSetup?.mockInput.pressKey('i');
    });

    const frame = testSetup.captureCharFrame();
    // "simone" visible; "engineer" filtered out.
    expect(frame).toContain('simone');
    expect(frame).not.toContain('engineer');

    // Confirm with Enter.
    await press(testSetup, () => {
      testSetup?.mockInput.pressEnter();
    });

    expect(confirmed).toHaveLength(1);
    const intent = confirmed[0];
    expect(intent.kind).toBe('spawn-agent');
    if (intent.kind !== 'spawn-agent') throw new Error('unreachable');
    expect(intent.name).toBe('simone');
    expect(intent.session).toBe('martins');
    expect(intent.window).toBe('martins:1');
    expect(intent.newWindow).toBeUndefined();

    // Round-trip parity: the rendered preview must contain exactly the cli
    // that buildSpawnInvocation would produce for this intent (ignoring any
    // line wrapping introduced by the modal's column width).
    const expectedCli = buildSpawnInvocation(intent).cli;
    expect(flattenFrame(frame)).toContain(expectedCli);
  });

  test('window-scoped target: intent includes window and omits newWindow', async () => {
    const confirmed: SpawnIntent[] = [];
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone', window: 'simone:1' }}
        onConfirm={(intent) => confirmed.push(intent)}
        onCancel={() => {}}
        loadAgents={staticLoader([{ name: 'reviewer' }])}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    await flushLoader(testSetup);

    // Preview must be visible before Enter — capture it first so we can
    // assert parity against the intent that Enter emits.
    const framePre = testSetup.captureCharFrame();

    await press(testSetup, () => {
      testSetup?.mockInput.pressEnter();
    });

    expect(confirmed).toHaveLength(1);
    const intent = confirmed[0];
    if (intent.kind !== 'spawn-agent') throw new Error('unreachable');
    expect(intent.window).toBe('simone:1');
    expect(intent.newWindow).toBeUndefined();

    // Live preview parity: the pre-Enter frame contains the exact cli.
    expect(flattenFrame(framePre)).toContain(buildSpawnInvocation(intent).cli);
  });

  test('session-only target: intent sets newWindow=true and omits window', async () => {
    const confirmed: SpawnIntent[] = [];
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone' }}
        onConfirm={(intent) => confirmed.push(intent)}
        onCancel={() => {}}
        loadAgents={staticLoader([{ name: 'reviewer' }])}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    await flushLoader(testSetup);

    const framePre = testSetup.captureCharFrame();

    await press(testSetup, () => {
      testSetup?.mockInput.pressEnter();
    });

    expect(confirmed).toHaveLength(1);
    const intent = confirmed[0];
    if (intent.kind !== 'spawn-agent') throw new Error('unreachable');
    expect(intent.session).toBe('simone');
    expect(intent.window).toBeUndefined();
    expect(intent.newWindow).toBe(true);

    expect(flattenFrame(framePre)).toContain(buildSpawnInvocation(intent).cli);
  });

  test('Esc triggers onCancel and does NOT call onConfirm', async () => {
    let cancelCount = 0;
    let confirmCount = 0;
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone' }}
        onConfirm={() => {
          confirmCount += 1;
        }}
        onCancel={() => {
          cancelCount += 1;
        }}
        loadAgents={staticLoader([{ name: 'simone' }])}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    await flushLoader(testSetup);

    await press(testSetup, () => {
      testSetup?.mockInput.pressEscape();
    });

    expect(cancelCount).toBe(1);
    expect(confirmCount).toBe(0);
  });

  test('empty directory: renders "No agents registered" and Enter is disabled', async () => {
    let confirmCount = 0;
    testSetup = await testRender(
      <AgentPicker
        target={{ session: 'simone' }}
        onConfirm={() => {
          confirmCount += 1;
        }}
        onCancel={() => {}}
        loadAgents={staticLoader([])}
      />,
      { width: 100, height: 20, kittyKeyboard: true },
    );
    await flushLoader(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain('No agents registered');

    // Enter must be a no-op when the list is empty.
    await press(testSetup, () => {
      testSetup?.mockInput.pressEnter();
    });

    expect(confirmCount).toBe(0);
  });
});
