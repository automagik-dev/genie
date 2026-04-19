/** @jsxImportSource @opentui/react */
/**
 * Tests for CliPreviewLine — asserts that the rendered preview contains the
 * exact `cli` string returned by buildSpawnInvocation, that invalid intents
 * render an inline error (without crashing), and that the hint is overridable.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { type SpawnIntent, buildSpawnInvocation } from '../../lib/spawn-invocation.js';
import { CliPreviewLine } from './CliPreviewLine.js';

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

describe('CliPreviewLine', () => {
  test('spawn-agent intent: rendered output contains the exact cli string', async () => {
    const intent: SpawnIntent = {
      kind: 'spawn-agent',
      name: 'simone',
      team: 'simone',
      session: 'simone',
      newWindow: true,
    };
    const expectedCli = buildSpawnInvocation(intent).cli;

    testSetup = await testRender(<CliPreviewLine intent={intent} />, { width: 120, height: 6 });
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();

    expect(frame).toContain(expectedCli);
  });

  test('create-team intent: rendered output contains the exact cli string', async () => {
    const intent: SpawnIntent = {
      kind: 'create-team',
      name: 'proj-x',
      repo: '/path/to/repo',
    };
    const expectedCli = buildSpawnInvocation(intent).cli;

    testSetup = await testRender(<CliPreviewLine intent={intent} />, { width: 120, height: 6 });
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();

    expect(frame).toContain(expectedCli);
  });

  test('invalid intent: rendered output shows the error message and does NOT throw', async () => {
    // Empty name — buildSpawnInvocation throws with a message that names the field.
    const badIntent: SpawnIntent = { kind: 'spawn-agent', name: '' };

    // Capture the expected error message from the helper itself — that way
    // this test stays in lockstep with whatever wording the helper uses.
    let expectedMessage = '';
    try {
      buildSpawnInvocation(badIntent);
    } catch (err) {
      expectedMessage = err instanceof Error ? err.message : String(err);
    }
    expect(expectedMessage.length).toBeGreaterThan(0);

    // The render itself must not throw.
    testSetup = await testRender(<CliPreviewLine intent={badIntent} />, { width: 120, height: 6 });
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();

    expect(frame).toContain(expectedMessage);
  });

  test('hint override: custom hint prop replaces the default hint', async () => {
    const intent: SpawnIntent = { kind: 'spawn-agent', name: 'reviewer' };
    const customHint = 'Press Y to confirm';
    const defaultHint = 'Enter to run';

    testSetup = await testRender(<CliPreviewLine intent={intent} hint={customHint} />, { width: 120, height: 6 });
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();

    expect(frame).toContain(customHint);
    expect(frame).not.toContain(defaultHint);
  });
});
