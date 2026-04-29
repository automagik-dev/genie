import { describe, expect, test } from 'bun:test';
import { resolveTuiRendererConfig } from './render.js';

describe('resolveTuiRendererConfig', () => {
  test('uses conservative renderer defaults on macOS', () => {
    const config = resolveTuiRendererConfig({}, 'darwin');

    expect(config.exitOnCtrlC).toBe(false);
    expect(config.useThread).toBe(false);
    expect(config.targetFps).toBe(8);
    expect(config.maxFps).toBe(12);
    expect(config.useMouse).toBe(false);
    expect(config.enableMouseMovement).toBe(false);
    expect(config.useKittyKeyboard).toBe(null);
    expect(config.consoleMode).toBe('disabled');
    expect(config.openConsoleOnError).toBe(false);
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
