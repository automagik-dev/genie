/** @jsxImportSource @opentui/react */
/** OpenTUI React renderer — separated from index.ts to isolate JSX */

import { type CliRendererConfig, createCliRenderer } from '@opentui/core';
import { KeymapProvider } from '@opentui/keymap/react';
import { createRoot, extend } from '@opentui/react';
import { App } from './app.js';
import { createTuiKeymap } from './keymap.js';
import { installOpenTui20Bridge } from './opentui-bridge.js';
import { TerminalPane } from './widgets/TerminalPane.js';

/**
 * Read by `renderNav()` to decide whether the right side is an embedded
 * `<TerminalPane>` (Group 4 onward) or the legacy dual-tmux mirror.
 * Group 6 will flip the default + delete the `legacy` branch. See
 * `.genie/runbooks/tui-host/embed-flag.md`.
 */
export function isEmbedHostMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GENIE_TUI_HOST ?? '').trim().toLowerCase() === 'embed';
}

// xterm DECRST sequence that disables BOTH button-event drag tracking (?1002l)
// AND any-event motion tracking (?1003l).
//
// On Linux/non-darwin, OpenTUI's `setMouseMode` emits ?1000h?1002h?1003h because
// `enableMouseMovement` defaults to `!isDarwin = true` (see
// resolveTuiRendererConfig in this file plus
// `anomalyco/opentui@v0.2.6` packages/core/src/zig/terminal.zig:593-596).
// The ?1003 channel reports motion-with-button (= drag) too, so cancelling
// only ?1002 leaves drag events flowing through ?1003 and the override has no
// observable effect — the gap surfaced after merging wish/tui-native-selection.
//
// Cancelling both keeps ?1000 (clicks) intact, which is what Nav clicks rely
// on, while returning all drag/motion to the local terminal so users get
// native drag-select + Cmd+C in Warp / Terminal.app on macOS.
//
// Tracked by .genie/wishes/tui-native-selection-followups/WISH.md.
const ESC_DISABLE_DRAG_TRACKING = '\x1b[?1002l\x1b[?1003l';

export function disableDragTracking(stdout: NodeJS.WritableStream = process.stdout): void {
  stdout.write(ESC_DISABLE_DRAG_TRACKING);
}

interface MouseEnableable {
  enableMouse: () => void;
}

export function installNativeSelectionOverride(
  renderer: MouseEnableable,
  stdout: NodeJS.WritableStream = process.stdout,
): void {
  const originalEnableMouse = renderer.enableMouse.bind(renderer);
  renderer.enableMouse = () => {
    originalEnableMouse();
    disableDragTracking(stdout);
  };
  // The renderer's setupTerminal already called enableMouse() before we wrapped
  // it, so apply the override once for that initial invocation.
  disableDragTracking(stdout);
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

type TuiRendererEnv = Record<string, string | undefined>;

function readBool(env: TuiRendererEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return fallback;
}

function readPositiveInt(env: TuiRendererEnv, name: string): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveTuiRendererConfig(
  env: TuiRendererEnv = process.env,
  platform: NodeJS.Platform | string = process.platform,
): CliRendererConfig {
  const isDarwin = platform === 'darwin';
  const targetFps = readPositiveInt(env, 'GENIE_TUI_TARGET_FPS') ?? (isDarwin ? 8 : 30);
  const configuredMaxFps = readPositiveInt(env, 'GENIE_TUI_MAX_FPS') ?? (isDarwin ? 12 : 60);
  const maxFps = Math.max(configuredMaxFps, targetFps);
  const useMouse = readBool(env, 'GENIE_TUI_MOUSE', true);
  const enableMouseMovement = useMouse && readBool(env, 'GENIE_TUI_MOUSE_MOVEMENT', !isDarwin);
  // consoleMode only controls the OVERLAY surface, not the render thread, so it
  // does not contribute to the darwin CPU-spin we work around with useThread.
  // Default to OpenTUI's `console-overlay` everywhere so backtick/F1 toggles work.
  const consoleEnabled = readBool(env, 'GENIE_TUI_CONSOLE', true);
  // useKittyKeyboard stays opt-in on darwin: it's a native input path that has
  // historically interacted poorly with macOS local ptys. Non-darwin keeps the
  // OpenTUI defaults (disambiguate + alternateKeys).
  const kittyKeyboardOptIn = readBool(env, 'GENIE_TUI_KITTY_KEYBOARD', !isDarwin);

  return {
    exitOnCtrlC: false, // We handle Ctrl+C ourselves via useKeyboard
    useThread: !isDarwin,
    targetFps,
    maxFps,
    useMouse,
    enableMouseMovement,
    useKittyKeyboard: kittyKeyboardOptIn ? undefined : null,
    consoleMode: consoleEnabled ? undefined : 'disabled',
    openConsoleOnError: consoleEnabled && !isDarwin,
  };
}

export async function renderNav(): Promise<void> {
  const rightPane = process.env.GENIE_TUI_RIGHT || undefined;
  const workspaceRoot = process.env.GENIE_TUI_WORKSPACE || undefined;
  const initialAgent = process.env.GENIE_TUI_AGENT || undefined;
  const embedMode = isEmbedHostMode();

  // OpenTUI handles SIGTERM/SIGHUP/SIGINT cleanup automatically.
  // macOS local ptys have repeatedly hit OpenTUI native hot loops. Keep the TUI
  // usable there, but default to a conservative renderer and allow env opt-ins.
  const renderer = await createCliRenderer(resolveTuiRendererConfig());
  if (embedMode) {
    // Embed mode: register the TerminalPane Renderable so React can mount it
    // as <terminal-pane sessionName=… />. The mouse-contract override moves
    // into TerminalPane's mount lifecycle — no renderer-level wrap here.
    extend({ 'terminal-pane': TerminalPane });
  } else {
    // Legacy dual-tmux path: keep the renderer-level wrap so drag-select
    // remains native in the right-pane mirror. Removed entirely in Group 6.
    installNativeSelectionOverride(renderer as unknown as MouseEnableable);
  }
  const disposeOpenTui20Bridge = installOpenTui20Bridge(renderer);
  const keymap = createTuiKeymap(renderer);

  createRoot(renderer).render(
    <KeymapProvider keymap={keymap}>
      <App rightPane={rightPane} workspaceRoot={workspaceRoot} initialAgent={initialAgent} embedMode={embedMode} />
    </KeymapProvider>,
  );

  // Keep process alive until renderer is destroyed (Ctrl+Q, SIGTERM, etc.)
  // Without this, bun exits immediately after render() returns.
  await new Promise<void>((resolve) => {
    (renderer as unknown as { once: (event: string, fn: () => void) => void }).once('destroy', () => {
      disposeOpenTui20Bridge();
      resolve();
    });
  });
}
