import { describe, expect, mock, test } from 'bun:test';
import { Writable } from 'node:stream';
import { disableDragTracking, installNativeSelectionOverride, resolveTuiRendererConfig } from './render.js';

const ESC_DISABLE_DRAG_TRACKING = '\x1b[?1002l';

function makeStdoutSpy(): { stdout: NodeJS.WritableStream; writes: string[] } {
  const writes: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      callback();
    },
  });
  return { stdout, writes };
}

describe('resolveTuiRendererConfig', () => {
  test('uses click-only renderer defaults on macOS', () => {
    const config = resolveTuiRendererConfig({}, 'darwin');

    expect(config.exitOnCtrlC).toBe(false);
    expect(config.useThread).toBe(false);
    expect(config.targetFps).toBe(8);
    expect(config.maxFps).toBe(12);
    expect(config.useMouse).toBe(true);
    expect(config.enableMouseMovement).toBe(false);
    // Kitty keyboard stays opt-in on darwin (native input regressions); the
    // console overlay surface is enabled (cheap when hidden) so the keymap
    // backtick toggle is not a no-op. openConsoleOnError stays off on darwin
    // to avoid surprise overlays at reduced FPS.
    expect(config.useKittyKeyboard).toBe(null);
    expect(config.consoleMode).toBeUndefined();
    expect(config.openConsoleOnError).toBe(false);
  });

  test('allows explicit macOS console + kitty opt-in', () => {
    const config = resolveTuiRendererConfig({ GENIE_TUI_CONSOLE: '0', GENIE_TUI_KITTY_KEYBOARD: '1' }, 'darwin');

    expect(config.consoleMode).toBe('disabled');
    expect(config.openConsoleOnError).toBe(false);
    expect(config.useKittyKeyboard).toBeUndefined();
  });

  test('allows explicit macOS mouse opt-out', () => {
    const config = resolveTuiRendererConfig({ GENIE_TUI_MOUSE: '0' }, 'darwin');

    expect(config.useMouse).toBe(false);
    expect(config.enableMouseMovement).toBe(false);
  });

  test('allows explicit macOS mouse and FPS overrides', () => {
    const config = resolveTuiRendererConfig(
      {
        GENIE_TUI_MOUSE: '1',
        GENIE_TUI_MOUSE_MOVEMENT: '1',
        GENIE_TUI_TARGET_FPS: '20',
        GENIE_TUI_MAX_FPS: '30',
      },
      'darwin',
    );

    expect(config.useMouse).toBe(true);
    expect(config.enableMouseMovement).toBe(true);
    expect(config.targetFps).toBe(20);
    expect(config.maxFps).toBe(30);
  });

  test('keeps the old renderer defaults outside macOS', () => {
    const config = resolveTuiRendererConfig({}, 'linux');

    expect(config.useThread).toBe(true);
    expect(config.targetFps).toBe(30);
    expect(config.maxFps).toBe(60);
    expect(config.useMouse).toBe(true);
    expect(config.enableMouseMovement).toBe(true);
    expect(config.useKittyKeyboard).toBeUndefined();
    expect(config.consoleMode).toBeUndefined();
    expect(config.openConsoleOnError).toBe(true);
  });

  test('keeps max FPS at least as high as target FPS', () => {
    const config = resolveTuiRendererConfig(
      {
        GENIE_TUI_TARGET_FPS: '15',
        GENIE_TUI_MAX_FPS: '4',
      },
      'darwin',
    );

    expect(config.targetFps).toBe(15);
    expect(config.maxFps).toBe(15);
  });
});

describe('disableDragTracking', () => {
  test('writes the DECRST sequence that turns off button-event drag tracking', () => {
    const { stdout, writes } = makeStdoutSpy();
    disableDragTracking(stdout);
    expect(writes).toEqual([ESC_DISABLE_DRAG_TRACKING]);
  });
});

describe('installNativeSelectionOverride', () => {
  test('emits ?1002l once on install (covers the implicit setupTerminal enableMouse call)', () => {
    const { stdout, writes } = makeStdoutSpy();
    const originalEnableMouse = mock(() => {});
    const renderer = { enableMouse: originalEnableMouse };

    installNativeSelectionOverride(renderer, stdout);

    expect(writes).toEqual([ESC_DISABLE_DRAG_TRACKING]);
    expect(originalEnableMouse).not.toHaveBeenCalled();
  });

  test('re-applies ?1002l after every enableMouse() invocation (suspend/resume + useMouse setter paths)', () => {
    const { stdout, writes } = makeStdoutSpy();
    const originalEnableMouse = mock(() => {});
    const renderer = { enableMouse: originalEnableMouse };

    installNativeSelectionOverride(renderer, stdout);
    // initial install fired one override
    expect(writes.length).toBe(1);

    // Simulate suspend → resume cycle: resume() calls enableMouse() internally.
    renderer.enableMouse();
    // Simulate runtime `useMouse = true` setter, which also calls enableMouse().
    renderer.enableMouse();

    expect(originalEnableMouse).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([ESC_DISABLE_DRAG_TRACKING, ESC_DISABLE_DRAG_TRACKING, ESC_DISABLE_DRAG_TRACKING]);
  });

  test('preserves the original enableMouse behavior (does not swallow side effects)', () => {
    const { stdout } = makeStdoutSpy();
    let nativeEnabled = 0;
    const renderer = {
      enableMouse: () => {
        nativeEnabled += 1;
      },
    };

    installNativeSelectionOverride(renderer, stdout);
    renderer.enableMouse();
    renderer.enableMouse();

    expect(nativeEnabled).toBe(2);
  });
});
