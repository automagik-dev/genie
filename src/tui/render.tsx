/** @jsxImportSource @opentui/react */
/** OpenTUI React renderer — separated from index.ts to isolate JSX */

import { type CliRendererConfig, createCliRenderer } from '@opentui/core';
import { KeymapProvider } from '@opentui/keymap/react';
import { createRoot } from '@opentui/react';
import { App } from './app.js';
import { createTuiKeymap } from './keymap.js';
import { installOpenTui20Bridge } from './opentui-bridge.js';

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

  return {
    exitOnCtrlC: false, // We handle Ctrl+C ourselves via useKeyboard
    useThread: !isDarwin,
    targetFps,
    maxFps,
    useMouse,
    enableMouseMovement,
    useKittyKeyboard: isDarwin ? null : undefined,
    consoleMode: isDarwin ? 'disabled' : undefined,
    openConsoleOnError: !isDarwin,
  };
}

export async function renderNav(): Promise<void> {
  const rightPane = process.env.GENIE_TUI_RIGHT || undefined;
  const workspaceRoot = process.env.GENIE_TUI_WORKSPACE || undefined;
  const initialAgent = process.env.GENIE_TUI_AGENT || undefined;

  // OpenTUI handles SIGTERM/SIGHUP/SIGINT cleanup automatically.
  // macOS local ptys have repeatedly hit OpenTUI native hot loops. Keep the TUI
  // usable there, but default to a conservative renderer and allow env opt-ins.
  const renderer = await createCliRenderer(resolveTuiRendererConfig());
  const disposeOpenTui20Bridge = installOpenTui20Bridge(renderer);
  const keymap = createTuiKeymap(renderer);

  createRoot(renderer).render(
    <KeymapProvider keymap={keymap}>
      <App rightPane={rightPane} workspaceRoot={workspaceRoot} initialAgent={initialAgent} />
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
