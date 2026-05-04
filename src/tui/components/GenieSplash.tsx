/** @jsxImportSource @opentui/react */
/**
 * Install/startup splash animation — neon-coloured genie, 6 scenes.
 *
 *   ┌──────────┬──────────┬──────────┬──────────────┬──────────┬──────────┐
 *   │ scene 1  │ scene 2  │ scene 3  │   scene 4    │ scene 5  │ scene 6  │
 *   │ 0..12%   │ 12..22%  │ 22..38%  │  38..70%     │ 70..85%  │ 85..100% │
 *   │ closed   │ eyes     │ smile    │ body +       │ held;    │ fade out │
 *   │ eyes     │ open     │ animates │ earrings     │ wink at  │ (scatter │
 *   │          │ (open    │ in       │ fade in      │ start    │  twinkle)│
 *   │          │ snap)    │ (scatter)│ (scatter)    │          │          │
 *   └──────────┴──────────┴──────────┴──────────────┴──────────┴──────────┘
 *
 * Colour palette mirrors the neon reference art:
 *   - Eyes, smile, earrings (face features): cyan
 *   - Hair, head outline, ears, body: magenta
 *
 * Live mode: `useTimeline` from @opentui/react drives `progress` from 0→1
 * over `duration` ms (default 2000). NOTE: do not pass `autoplay: true`
 * to useTimeline — opentui 0.2.0 has an inverted check and the timeline
 * never advances.
 */

import { useTimeline } from '@opentui/react';
import { useEffect, useMemo, useState } from 'react';
import { type CellCategory, GENIE_ART, bodyCellDelay, categorizeCell, withClosedEyes } from './genie-art.js';

/** Neon palette from the reference art. */
const COLOR_PINK = '#ff3ff5'; // hair, head outline, ears, eyebrows, body
const COLOR_CYAN = '#39ffff'; // eyes, smile, lamp neck
const COLOR_PINK_DIM = '#7a1f80';
const COLOR_CYAN_DIM = '#1f7f7f';

/**
 * Minimal palette inlined here so the splash component has no dependency
 * on the (currently missing) `src/tui/theme.ts` / genie-tokens package.
 * Values match the original Severance Lumon-MDR theme tokens.
 */
const palette = {
  bg: '#0a1d2a',
  bgRaised: '#0f2638',
  text: '#c9cfd4',
  textDim: '#8a9499',
  textMuted: '#5e6e74',
  accent: '#7fc8a9',
  accentBright: '#9eddc1',
  success: '#7fc8a9',
} as const;

export interface GenieSplashProps {
  /**
   * Animation progress in [0, 1]. When provided, internal timer is bypassed
   * and the component renders deterministically at the given progress.
   * Used by tests; production callers should omit this.
   */
  progress?: number;
  /** Total animation duration in ms (ignored when `progress` is set). Default 2000. */
  duration?: number;
  /** Status text shown below the figure. When omitted, a stage-derived default is used. */
  status?: string;
  /** 1-indexed current step (e.g. install pipeline step). Renders "[2/5]" prefix. */
  step?: number;
  /** Total step count for the step prefix. */
  totalSteps?: number;
  /**
   * Force eye-blink state. When omitted, the live component blinks every
   * ~2.5 s for ~160 ms — including during scene 0 (the "eyes-only" intro).
   * Tests use this prop to pin a frame.
   */
  blinking?: boolean;
  /** Fired exactly once when the live animation reaches progress=1. */
  onComplete?: () => void;
}

export function GenieSplash(props: GenieSplashProps) {
  if (props.progress !== undefined) {
    return (
      <SplashFrame
        progress={clamp01(props.progress)}
        blinking={props.blinking ?? false}
        status={props.status}
        step={props.step}
        totalSteps={props.totalSteps}
      />
    );
  }
  return <LiveGenieSplash {...props} />;
}

/**
 * Live (timer-driven) variant. Split out so controlled renders skip
 * `useTimeline` entirely — its frame ticks would otherwise produce
 * out-of-act() state updates inside the testRender harness.
 */
function LiveGenieSplash({
  duration = 2000,
  status,
  step,
  totalSteps,
  blinking: blinkingProp,
  onComplete,
}: GenieSplashProps) {
  const [progress, setProgress] = useState(0);
  const [autoBlink, setAutoBlink] = useState(false);

  // Do NOT pass `autoplay: true`. opentui 0.2.0's `useTimeline` hook has an
  // inverted check — `if (!options.autoplay) timeline.play()` — so passing
  // `autoplay: true` silently skips play() and the timeline never advances.
  const timeline = useTimeline({ duration, loop: false });
  useEffect(() => {
    const target = { p: 0 };
    let fired = false;
    timeline.add(
      target,
      {
        p: 1,
        duration,
        ease: 'linear',
        onUpdate: (animation) => {
          const next = (animation.targets[0] as { p?: number } | undefined)?.p;
          if (typeof next === 'number') setProgress(next);
        },
        onComplete: () => {
          if (fired) return;
          fired = true;
          onComplete?.();
        },
      },
      0,
    );
  }, [duration, timeline, onComplete]);

  // One-eyed wink — fires once at the start of scene 5 (~70% of duration).
  // Scene 1's both-eyes-closed intro is driven by progress directly, not
  // by this auto-blink, so we don't need a wink during the intro.
  useEffect(() => {
    const winkAt = duration * 0.72;
    const start = setTimeout(() => {
      setAutoBlink(true);
      setTimeout(() => setAutoBlink(false), 180);
    }, winkAt);
    return () => clearTimeout(start);
  }, [duration]);

  const blinking = blinkingProp ?? autoBlink;

  return <SplashFrame progress={progress} blinking={blinking} status={status} step={step} totalSteps={totalSteps} />;
}

interface SplashFrameProps {
  progress: number;
  blinking: boolean;
  status?: string;
  step?: number;
  totalSteps?: number;
}

// Scene boundaries. Each scene's progress envelope is open on the right.
const SCENE_2_START = 0.12; // eyes open
const SCENE_3_START = 0.22; // smile animates in (scatter fade)
const SCENE_4_START = 0.38; // body + earrings fade in (scatter)
const SCENE_5_START = 0.7; // held form; wink fires at start
const SCENE_6_START = 0.85; // fade out (per-cell scatter twinkle)

/** Pure presentational layer — fully driven by props. */
function SplashFrame({ progress, blinking, status, step, totalSteps }: SplashFrameProps) {
  // Eye state derives from progress + the explicit wink prop:
  //   - scene 1 (progress < SCENE_2_START)  → both eyes closed (intro)
  //   - blinking=true                       → left-eye wink
  //   - otherwise                           → eyes open
  // The smile is drawn directly into GENIE_ART (rows 37-41), so no
  // smile overlay is needed; visibility is driven by `pickCellColor`.
  const baseFrame = useMemo(() => {
    if (blinking) return withClosedEyes(GENIE_ART, 'left');
    if (progress < SCENE_2_START) return withClosedEyes(GENIE_ART, 'both');
    return [...GENIE_ART];
  }, [blinking, progress]);

  const stage = pickStage(progress);
  const resolvedStatus = status ?? defaultStatus(stage);
  const showStepLine = typeof step === 'number' && typeof totalSteps === 'number' && totalSteps > 0;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      backgroundColor={palette.bg}
    >
      <box flexDirection="column" alignItems="center">
        {baseFrame.map((line, rowIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; indices are stable identity keys.
          <FigureRow key={`row-${rowIdx}`} rowIdx={rowIdx} line={line} progress={progress} />
        ))}
      </box>
      <box flexDirection="column" alignItems="center" marginTop={1} gap={0}>
        <StatusLine
          stage={stage}
          status={resolvedStatus}
          step={showStepLine ? step : undefined}
          totalSteps={showStepLine ? totalSteps : undefined}
        />
        <ProgressBar progress={progress} stage={stage} />
      </box>
    </box>
  );
}

/**
 * Render a single row of the figure as a sequence of fg-coloured spans.
 * For each character we resolve a colour token (or null = invisible /
 * render as space). Adjacent characters with the same colour collapse
 * into one span so we don't emit ~100 spans per row.
 */
function FigureRow({ rowIdx, line, progress }: { rowIdx: number; line: string; progress: number }) {
  const segments = useMemo(() => buildRowSegments(rowIdx, line, progress), [rowIdx, line, progress]);
  return (
    <text>
      {segments.map((seg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments array is rebuilt every render; index is the stable identity within that render.
        <span key={`seg-${i}`} fg={seg.color}>
          {seg.text}
        </span>
      ))}
    </text>
  );
}

interface RowSegment {
  text: string;
  color: string;
}

function buildRowSegments(rowIdx: number, line: string, progress: number): RowSegment[] {
  const segments: RowSegment[] = [];
  let currentColor: string | null = null;
  let buf = '';

  const flush = () => {
    if (buf.length > 0 && currentColor) {
      segments.push({ text: buf, color: currentColor });
    }
    buf = '';
  };

  for (let col = 0; col < line.length; col++) {
    const char = line[col] ?? ' ';
    const category = categorizeCell(rowIdx, col, char);
    const color = pickCellColor(category, char, rowIdx, col, progress);

    // Hidden cells render as a space in the bg colour — keeps row width
    // stable so the figure never jitters horizontally as cells appear.
    const renderedChar = color === null ? ' ' : softenChar(char, category);
    const renderedColor = color ?? palette.bg;

    if (renderedColor !== currentColor) {
      flush();
      currentColor = renderedColor;
    }
    buf += renderedChar;
  }
  flush();
  return segments;
}

/**
 * Resolve a colour for a single cell at the current progress. Returns
 * `null` to mean "this cell is not yet visible" (renders as a bg space).
 *
 * Per-category visibility windows (then `applyFadeOut` handles scene 4):
 *   - 'eye'   visible from frame 0
 *   - 'mouth' visible from SCENE_1_START — appears all at once, no
 *             centre-out reveal (was confusing as a horizontal bar fade)
 *   - 'body'  visible iff progress has crossed this cell's random delay
 *             during scene 2; locked-on by SCENE_3_START
 *
 * Colour by category, mirroring the neon reference art:
 *   - eye / mouth → cyan (face features)
 *   - body / hair / outline → pink (everything else)
 */
function pickCellColor(
  category: CellCategory,
  _char: string,
  rowIdx: number,
  col: number,
  progress: number,
): string | null {
  if (category === 'space') return null;

  const isFaceFeature = category === 'eye' || category === 'mouth' || category === 'earring';
  const fullColor = isFaceFeature ? COLOR_CYAN : COLOR_PINK;
  const dimColor = isFaceFeature ? COLOR_CYAN_DIM : COLOR_PINK_DIM;

  // Eyes — visible from frame 0 (closed shape during scene 1, open after).
  if (category === 'eye') {
    return applyFadeOut(fullColor, dimColor, progress, rowIdx, col);
  }

  // Smile — scatter fade-in across scene 3, then locked.
  if (category === 'mouth') {
    if (progress < SCENE_3_START) return null;
    if (progress >= SCENE_4_START) return applyFadeOut(fullColor, dimColor, progress, rowIdx, col);
    return scatterReveal(progress, SCENE_3_START, SCENE_4_START, rowIdx, col, fullColor, dimColor);
  }

  // Earrings + body — scatter fade-in across scene 4, then locked.
  if (progress < SCENE_4_START) return null;
  if (progress >= SCENE_5_START) return applyFadeOut(fullColor, dimColor, progress, rowIdx, col);
  return scatterReveal(progress, SCENE_4_START, SCENE_5_START, rowIdx, col, fullColor, dimColor);
}

/**
 * Per-cell scatter fade-in across [windowStart, windowEnd]. Each cell
 * gets its own random delay (`bodyCellDelay`); cells with low delays
 * twinkle in first, others drift in later. While in transit the cell
 * steps through bgRaised → dim → full.
 */
function scatterReveal(
  progress: number,
  windowStart: number,
  windowEnd: number,
  rowIdx: number,
  col: number,
  fullColor: string,
  dimColor: string,
): string | null {
  const fadeProgress = (progress - windowStart) / (windowEnd - windowStart);
  const delay = bodyCellDelay(rowIdx, col);
  if (fadeProgress < delay) return null;
  const since = fadeProgress - delay;
  if (since < 0.04) return palette.bgRaised;
  if (since < 0.1) return dimColor;
  return fullColor;
}

/**
 * Scene 4 fade-out — mirror of the body fade-in. Every cell gets its own
 * per-cell delay (same `bodyCellDelay` hash used for fade-in) so the
 * figure dissolves with a scattered, twinkling-out-into-the-void effect
 * rather than all cells dimming together. Cells with low delay fade out
 * first; cells with high delay linger longest. By `progress >= 0.99` the
 * entire figure is forced to null so the renderer commits a clean exit
 * before destroying.
 */
function applyFadeOut(
  fullColor: string,
  dimColor: string,
  progress: number,
  rowIdx: number,
  col: number,
): string | null {
  if (progress < SCENE_6_START) return fullColor;
  if (progress >= 0.99) return null; // hard cut at the very end

  const fadeProgress = clamp01((progress - SCENE_6_START) / (1 - SCENE_6_START));
  // Compress delays into [0, 0.7] so every cell has at least 0.3 of the
  // fade window left to step through dim → bgRaised → null.
  const delay = bodyCellDelay(rowIdx, col) * 0.7;
  if (fadeProgress < delay) return fullColor;

  const since = fadeProgress - delay;
  if (since < 0.05) return dimColor; // first hint of dimming
  if (since < 0.12) return palette.bgRaised; // almost gone
  return null; // faded into the void
}

interface StatusLineProps {
  stage: Stage;
  status: string;
  step?: number;
  totalSteps?: number;
}

function StatusLine({ stage, status, step, totalSteps }: StatusLineProps) {
  const prefix = step && totalSteps ? `[${step}/${totalSteps}] ` : '';
  const indicator = stage === 'ready' ? '✓ ' : `${pickSpinnerGlyph(stage)} `;
  const indicatorFg = stage === 'ready' ? palette.success : palette.accent;
  return (
    <text>
      <span fg={indicatorFg}>{indicator}</span>
      <span fg={palette.textDim}>{prefix}</span>
      <span fg={palette.text}>{status}</span>
    </text>
  );
}

const PROGRESS_BAR_WIDTH = 36;

function ProgressBar({ progress, stage }: { progress: number; stage: Stage }) {
  const filled = Math.round(clamp01(progress) * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;
  const fg = stage === 'ready' ? palette.success : palette.accentBright;
  return (
    <text>
      <span fg={fg}>{'█'.repeat(filled)}</span>
      <span fg={palette.textMuted}>{'░'.repeat(empty)}</span>
    </text>
  );
}

type Stage = 'awakening' | 'opening' | 'smiling' | 'manifesting' | 'ready';

function pickStage(progress: number): Stage {
  if (progress < SCENE_2_START) return 'awakening';
  if (progress < SCENE_3_START) return 'opening';
  if (progress < SCENE_4_START) return 'smiling';
  if (progress < SCENE_5_START) return 'manifesting';
  return 'ready';
}

function defaultStatus(stage: Stage): string {
  switch (stage) {
    case 'awakening':
      return 'awakening...';
    case 'opening':
      return 'opening eyes...';
    case 'smiling':
      return 'rising...';
    case 'manifesting':
      return 'manifesting from the void...';
    case 'ready':
      return 'ready';
  }
}

function pickSpinnerGlyph(stage: Stage): string {
  switch (stage) {
    case 'awakening':
      return '◐';
    case 'opening':
      return '◓';
    case 'smiling':
      return '◑';
    case 'manifesting':
      return '◒';
    case 'ready':
      return '◯';
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Soften the rendered character for non-face cells. The reference neon
 * art has thin lines for the head outline, ears, and lamp wisp — a full
 * `█` block reads as too heavy. `▓` (dark shade, ~75% fill) keeps the
 * silhouette but visually slims the line, giving the body a softer
 * neon-outline feel while face features stay at sharp `█` for contrast.
 */
function softenChar(char: string, category: CellCategory): string {
  if (char !== '█') return char;
  return category === 'body' ? '▓' : char;
}
