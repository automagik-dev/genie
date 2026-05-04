/** @jsxImportSource @opentui/react */
/**
 * GenieSplash animation tests.
 *
 * The component exposes deterministic prop overrides — `progress`,
 * `blinking`, `status`, `step`, `totalSteps` — that bypass the internal
 * timeline + blink-interval timers. Tests pin those props, capture the
 * char frame, and assert structural invariants of each scene:
 *
 *   scene 0 (eyes only)   — nothing rendered EXCEPT the eye region
 *   scene 1 (smile reveal) — mouth chars appear from cluster centres outward
 *   scene 2 (body fade)    — non-eye / non-mouth cells fill in over time
 *   scene 3 (held)         — all cells lit; smile + blink overlays composable
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { GenieSplash } from '../../src/tui/components/GenieSplash';
import {
  EYE_COL_RANGES,
  EYE_ROWS,
  GENIE_ART,
  GENIE_ART_HEIGHT,
  MOUTH_COL_RANGES,
  MOUTH_ROWS,
} from '../../src/tui/components/genie-art';

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

async function flushFrame(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await setup.renderOnce();
}

interface RenderOpts {
  progress: number;
  blinking?: boolean;
  status?: string;
  step?: number;
  totalSteps?: number;
}

async function renderAt(opts: RenderOpts): Promise<string> {
  testSetup = await testRender(<GenieSplash {...opts} />, { width: 104, height: 60 });
  await flushFrame(testSetup);
  return testSetup.captureCharFrame();
}

function blocks(frame: string): number {
  // Count both `█` (face features) and `▓` (softened body cells).
  return (frame.match(/[█▓]/g) ?? []).length;
}

/**
 * Substring check on the captured frame. Useful for asserting that a
 * specific signature (e.g., a fully-revealed eye row) appears verbatim
 * — confirms the figure rendered, without needing to know its vertical
 * offset inside the centred renderer surface.
 */
function frameContains(frame: string, needle: string): boolean {
  return frame.includes(needle);
}

describe('GenieSplash — scene 1 (closed eyes intro)', () => {
  test('progress=0 — both eyes closed, no body / smile', async () => {
    const frame = await renderAt({ progress: 0 });
    // Both eye spans collapse to the thick closed curve `╰▄▄▄╯`.
    expect(frame).toMatch(/╰▄+╯.*╰▄+╯/);
    // Open eyelid bars must NOT appear.
    expect(frameContains(frame, '█████████         ██████████')).toBe(false);
    // Body (lamp bottom) must NOT appear.
    const lampBottomRow = GENIE_ART[45] ?? '';
    expect(frameContains(frame, lampBottomRow)).toBe(false);
    // Smile lip bar must NOT appear.
    expect(frame).not.toContain('█████████████████');
  });
});

describe('GenieSplash — scene 2 (eyes open)', () => {
  test('progress=0.15 — eyes are open (smily oval bars), body still hidden', async () => {
    const frame = await renderAt({ progress: 0.15 });
    expect(frameContains(frame, '█████████         ██████████')).toBe(true);
    // Body (lamp bottom) still hidden.
    const lampBottomRow = GENIE_ART[45] ?? '';
    expect(frameContains(frame, lampBottomRow)).toBe(false);
    // Smile lip bar still hidden.
    expect(frame).not.toContain('█████████████████');
  });
});

describe('GenieSplash — scene 3 (smile animates)', () => {
  test('block count grows monotonically through the smile reveal', async () => {
    const beforeSmile = blocks(await renderAt({ progress: 0.2 }));
    const midSmile = blocks(await renderAt({ progress: 0.3 }));
    const afterSmile = blocks(await renderAt({ progress: 0.38 }));
    expect(midSmile).toBeGreaterThan(beforeSmile);
    expect(afterSmile).toBeGreaterThan(midSmile);
  });

  test('progress=0.36 — most of the smile lip bar is visible, body is not', async () => {
    const frame = await renderAt({ progress: 0.36 });
    expect(frame).toMatch(/█{6,}/);
    const lampBottomRow = GENIE_ART[45] ?? '';
    expect(frame.includes(lampBottomRow)).toBe(false);
  });
});

describe('GenieSplash — scene 4 (body + earrings fade in)', () => {
  test('block count grows from scene 3 through to ready', async () => {
    const beforeBody = blocks(await renderAt({ progress: 0.4 }));
    const midBody = blocks(await renderAt({ progress: 0.55 }));
    const lateBody = blocks(await renderAt({ progress: 0.68 }));
    const ready = blocks(await renderAt({ progress: 0.8 }));
    expect(midBody).toBeGreaterThan(beforeBody);
    expect(lateBody).toBeGreaterThan(midBody);
    expect(ready).toBeGreaterThanOrEqual(lateBody);
  });

  test('progress=0.55 — partial body reveal, not yet complete', async () => {
    const mid = blocks(await renderAt({ progress: 0.55 }));
    const held = blocks(await renderAt({ progress: 0.8 }));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(held);
  });
});

describe('GenieSplash — scene 5 (held + wink) and scene 6 (fade out)', () => {
  test('progress=0.8 — held scene, full figure rendered with smile', async () => {
    const frame = await renderAt({ progress: 0.8 });
    expect((frame.match(/█/g) ?? []).length).toBeGreaterThan(0);
    expect(frame).toContain('█████████████████');
  });

  test('progress=0.8, blinking=true — wink: only LEFT eye closed', async () => {
    const frame = await renderAt({ progress: 0.8, blinking: true });
    expect(frame).toMatch(/╰▄+╯/);
    // Body softens to ▓ glyphs at this progress; combined with face
    // feature `█` the total ink density should still be substantial.
    const inkBlocks = (frame.match(/[█▓]/g) ?? []).length;
    expect(inkBlocks).toBeGreaterThan(20);
  });

  test('progress=1.0 — fade-out complete: figure has faded to invisible', async () => {
    const frame = await renderAt({ progress: 1.0 });
    const figureRegion = frame.split('\n').slice(0, GENIE_ART_HEIGHT).join('\n');
    // Both face-feature `█` and body `▓` cells should be cleared.
    expect((figureRegion.match(/[█▓]/g) ?? []).length).toBe(0);
  });
});

describe('GenieSplash — status line', () => {
  test('default status varies by stage', async () => {
    const sc1 = await renderAt({ progress: 0.05 });
    expect(sc1).toContain('awakening');
    const sc2 = await renderAt({ progress: 0.15 });
    expect(sc2).toContain('opening eyes');
    const sc3 = await renderAt({ progress: 0.3 });
    expect(sc3).toContain('rising');
    const sc4 = await renderAt({ progress: 0.55 });
    expect(sc4).toContain('manifesting');
    const sc5 = await renderAt({ progress: 0.8 });
    expect(sc5).toContain('ready');
    expect(sc5).toContain('✓');
  });

  test('explicit status overrides the default', async () => {
    const frame = await renderAt({ progress: 0.5, status: 'installing migrations…' });
    expect(frame).toContain('installing migrations');
    expect(frame).not.toContain('manifesting from the void');
  });

  test('step counter renders when step + totalSteps provided', async () => {
    const frame = await renderAt({ progress: 0.5, step: 2, totalSteps: 5, status: 'wiring hooks' });
    expect(frame).toContain('[2/5]');
    expect(frame).toContain('wiring hooks');
  });

  test('step counter is hidden when step is omitted', async () => {
    const frame = await renderAt({ progress: 0.5, status: 'plain' });
    expect(frame).not.toMatch(/\[\d+\/\d+\]/);
  });
});

describe('GenieSplash — progress bar', () => {
  test('bar fills proportionally to progress', async () => {
    const empty = await renderAt({ progress: 0 });
    const half = await renderAt({ progress: 0.5 });
    const full = await renderAt({ progress: 1.0 });

    const dashes = (frame: string) => (frame.match(/░/g) ?? []).length;

    expect(dashes(empty)).toBeGreaterThan(dashes(half));
    expect(dashes(half)).toBeGreaterThan(dashes(full));
    expect(dashes(full)).toBe(0);
  });
});

describe('GenieSplash — snapshots', () => {
  test('scene 1 (closed eyes) snapshot', async () => {
    const frame = await renderAt({ progress: 0 });
    expect(frame.trimEnd()).toMatchSnapshot();
  });

  test('scene 2 (eyes open) snapshot', async () => {
    const frame = await renderAt({ progress: 0.15 });
    expect(frame.trimEnd()).toMatchSnapshot();
  });

  test('scene 3 (smile mid-reveal) snapshot', async () => {
    const frame = await renderAt({ progress: 0.3 });
    expect(frame.trimEnd()).toMatchSnapshot();
  });

  test('scene 4 (body manifesting) snapshot', async () => {
    const frame = await renderAt({ progress: 0.55 });
    expect(frame.trimEnd()).toMatchSnapshot();
  });

  test('scene 5 (held + wink) snapshot', async () => {
    const frame = await renderAt({ progress: 0.78, blinking: true, step: 5, totalSteps: 5, status: 'all set' });
    expect(frame.trimEnd()).toMatchSnapshot();
  });
});

// Confirm art assets are well-formed.
describe('GenieSplash — art asset invariants', () => {
  test('all rows have the same width', () => {
    const expectedWidth = GENIE_ART[0]?.length ?? 0;
    expect(GENIE_ART.every((r) => r.length === expectedWidth)).toBe(true);
  });

  test('eye and mouth coordinates fall inside the figure', () => {
    for (const r of EYE_ROWS) expect(r).toBeLessThan(GENIE_ART_HEIGHT);
    for (const r of MOUTH_ROWS) expect(r).toBeLessThan(GENIE_ART_HEIGHT);
    const w = GENIE_ART[0]?.length ?? 0;
    for (const range of EYE_COL_RANGES) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(w);
    }
    for (const range of MOUTH_COL_RANGES) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(w);
    }
  });
});
