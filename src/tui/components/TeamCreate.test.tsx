/** @jsxImportSource @opentui/react */
/**
 * Tests for TeamCreate — covers the two-step modal flow, name validation,
 * preview-string parity with buildSpawnInvocation, Esc semantics per step,
 * and the empty-agents fallback.
 *
 * Interaction is driven via the `mockInput` returned by `testRender`
 * (@opentui/react/test-utils). We prefer `typeText` / `pressKey` over
 * direct state pokes because this is the same surface a real user hits.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { buildSpawnInvocation } from '../../lib/spawn-invocation.js';
import { TeamCreate } from './TeamCreate.js';

type Setup = Awaited<ReturnType<typeof testRender>>;

/**
 * Send a key and let React flush any resulting state updates.
 *
 * We wrap in `act(...)` because the @opentui/react test harness already sets
 * `IS_REACT_ACT_ENVIRONMENT = true` — so updates that fire from event
 * listeners (onInput, onSubmit) must be committed via `act` or the next
 * `captureCharFrame()` will observe pre-update state.
 */
async function sendKeys(setup: Setup, action: (setup: Setup) => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action(setup);
    // Give the stdin-to-parser pipeline a chance to flush before we continue;
    // certain key sequences (plain Escape) are buffered until a short timeout
    // elapses to disambiguate them from CSI prefixes.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  });
  await act(async () => {
    await setup.renderOnce();
  });
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

const AGENTS = ['simone', 'reviewer', 'qa'];

describe('TeamCreate', () => {
  test('happy path: types name, ticks two members, confirms', async () => {
    let received: { teamName: string; members: string[] } | undefined;
    let cancelled = false;

    testSetup = await testRender(
      <TeamCreate
        availableAgents={AGENTS}
        workspaceRoot="/tmp/repo"
        onConfirm={(r) => {
          received = r;
        }}
        onCancel={() => {
          cancelled = true;
        }}
      />,
      { width: 120, height: 30 },
    );
    await testSetup.renderOnce();

    // Step 1 — type name + Enter
    await sendKeys(testSetup, async (s) => {
      await s.mockInput.typeText('proj-x');
    });
    await sendKeys(testSetup, (s) => s.mockInput.pressEnter());

    // Step 2 — cursor starts at 0 (simone). Toggle first, arrow down, toggle second.
    await sendKeys(testSetup, (s) => s.mockInput.pressKey(' '));
    await sendKeys(testSetup, (s) => s.mockInput.pressArrow('down'));
    await sendKeys(testSetup, (s) => s.mockInput.pressKey(' '));
    await sendKeys(testSetup, (s) => s.mockInput.pressEnter());

    expect(cancelled).toBe(false);
    expect(received).toBeDefined();
    expect(received?.teamName).toBe('proj-x');
    expect(received?.members.sort()).toEqual(['reviewer', 'simone']);
  });

  test('cli preview: matches buildSpawnInvocation({kind:create-team, name, repo}).cli exactly', async () => {
    testSetup = await testRender(
      <TeamCreate availableAgents={AGENTS} workspaceRoot="/tmp/workspace" onConfirm={() => {}} onCancel={() => {}} />,
      { width: 120, height: 30 },
    );
    await testSetup.renderOnce();

    // Type the full name so the preview line reflects the real intent
    // (before any characters are typed the component renders a placeholder
    // name of `TEAM_NAME` so the preview stays non-error; assert against
    // the full intent after typing).
    await sendKeys(testSetup, async (s) => {
      await s.mockInput.typeText('proj-x');
    });

    const expectedCli = buildSpawnInvocation({
      kind: 'create-team',
      name: 'proj-x',
      repo: '/tmp/workspace',
    }).cli;
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain(expectedCli);
  });

  test('invalid names keep the user on step 1 and surface inline errors', async () => {
    const invalids: string[] = ['spaces here', '-bad', 'feat/test.lock'];

    for (const bad of invalids) {
      let received: { teamName: string; members: string[] } | undefined;
      testSetup = await testRender(
        <TeamCreate
          availableAgents={AGENTS}
          workspaceRoot="/tmp/repo"
          onConfirm={(r) => {
            received = r;
          }}
          onCancel={() => {}}
        />,
        { width: 140, height: 30 },
      );
      await testSetup.renderOnce();

      await sendKeys(testSetup, async (s) => {
        await s.mockInput.typeText(bad);
      });

      // Enter on step 1 should be a no-op when the name is invalid.
      await sendKeys(testSetup, (s) => s.mockInput.pressEnter());

      const frame = testSetup.captureCharFrame();
      // The inline error string always starts with "Invalid team name"
      // per validateBranchName's message format.
      expect(frame).toContain('Invalid team name');
      expect(received).toBeUndefined();

      testSetup.renderer.destroy();
      testSetup = undefined;
    }
  });

  test('Esc on step 1 calls onCancel', async () => {
    let cancelled = false;
    testSetup = await testRender(
      <TeamCreate
        availableAgents={AGENTS}
        onConfirm={() => {}}
        onCancel={() => {
          cancelled = true;
        }}
      />,
      { width: 120, height: 30 },
    );
    await testSetup.renderOnce();

    await sendKeys(testSetup, (s) => s.mockInput.pressEscape());

    expect(cancelled).toBe(true);
  });

  test('Esc on step 2 returns to step 1 (not onCancel)', async () => {
    let cancelled = false;
    let received: { teamName: string; members: string[] } | undefined;
    testSetup = await testRender(
      <TeamCreate
        availableAgents={AGENTS}
        onConfirm={(r) => {
          received = r;
        }}
        onCancel={() => {
          cancelled = true;
        }}
      />,
      { width: 120, height: 30 },
    );
    await testSetup.renderOnce();

    // Advance to step 2
    await sendKeys(testSetup, async (s) => {
      await s.mockInput.typeText('ok-name');
    });
    await sendKeys(testSetup, (s) => s.mockInput.pressEnter());

    // Esc — should land back on step 1, NOT call onCancel
    await sendKeys(testSetup, (s) => s.mockInput.pressEscape());

    expect(cancelled).toBe(false);
    expect(received).toBeUndefined();

    // Frame should now show step 1 indicator again
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain('step 1 of 2');
  });

  test('empty agent list: renders fallback, Enter still confirms with zero members', async () => {
    let received: { teamName: string; members: string[] } | undefined;
    testSetup = await testRender(
      <TeamCreate
        availableAgents={[]}
        workspaceRoot="/tmp/repo"
        onConfirm={(r) => {
          received = r;
        }}
        onCancel={() => {}}
      />,
      { width: 120, height: 30 },
    );
    await testSetup.renderOnce();

    await sendKeys(testSetup, async (s) => {
      await s.mockInput.typeText('solo');
    });
    await sendKeys(testSetup, (s) => s.mockInput.pressEnter());

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain('No agents registered');

    await sendKeys(testSetup, (s) => s.mockInput.pressEnter());

    expect(received).toEqual({ teamName: 'solo', members: [] });
  });
});
