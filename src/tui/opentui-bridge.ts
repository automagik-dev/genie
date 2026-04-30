import type { CliRenderer, GetPaletteOptions, TerminalColors, ThemeMode } from '@opentui/core';
import { type TuiTmuxThemeSnapshot, syncTuiTmuxTheme } from './tmux-theme-sync.js';

type TuiRendererEnv = Record<string, string | undefined>;
type ThemeSyncFn = (snapshot: TuiTmuxThemeSnapshot, options: { timeoutMs: number }) => boolean;

export interface OpenTuiBridgeOptions {
  env?: TuiRendererEnv;
  syncTheme?: ThemeSyncFn;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_THEME_QUERY_TIMEOUT_MS = 700;
const DEFAULT_TMUX_APPLY_TIMEOUT_MS = 300;
const OPEN_TUI_02_PALETTE_SIZE = 16;

function readBool(env: TuiRendererEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return fallback;
}

function readPositiveInt(env: TuiRendererEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inferThemeMode(background: string | null | undefined): ThemeMode | null {
  if (!background || !/^#[0-9a-f]{6}$/i.test(background)) return null;
  const r = Number.parseInt(background.slice(1, 3), 16);
  const g = Number.parseInt(background.slice(3, 5), 16);
  const b = Number.parseInt(background.slice(5, 7), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance >= 0.5 ? 'light' : 'dark';
}

function snapshotKey(snapshot: TuiTmuxThemeSnapshot): string {
  return [snapshot.mode, snapshot.terminalForeground ?? '', snapshot.terminalBackground ?? ''].join('|');
}

function buildSnapshot(mode: ThemeMode | null, colors?: TerminalColors | null): TuiTmuxThemeSnapshot | null {
  const resolvedMode = mode ?? inferThemeMode(colors?.defaultBackground);
  if (!resolvedMode) return null;
  return {
    mode: resolvedMode,
    terminalForeground: colors?.defaultForeground,
    terminalBackground: colors?.defaultBackground,
  };
}

export function installOpenTui20Bridge(renderer: CliRenderer, options: OpenTuiBridgeOptions = {}): () => void {
  const env = options.env ?? process.env;
  if (!readBool(env, 'GENIE_TUI_TMUX_THEME_SYNC', true)) {
    return () => {};
  }

  const syncTheme = options.syncTheme ?? syncTuiTmuxTheme;
  const themeQueryTimeoutMs = readPositiveInt(env, 'GENIE_TUI_THEME_QUERY_TIMEOUT_MS', DEFAULT_THEME_QUERY_TIMEOUT_MS);
  const tmuxApplyTimeoutMs = readPositiveInt(
    env,
    'GENIE_TUI_TMUX_THEME_SYNC_TIMEOUT_MS',
    DEFAULT_TMUX_APPLY_TIMEOUT_MS,
  );
  let disposed = false;
  let lastSnapshot = '';

  const syncSnapshot = (snapshot: TuiTmuxThemeSnapshot | null) => {
    if (disposed || !snapshot) return;
    const key = snapshotKey(snapshot);
    if (key === lastSnapshot) return;
    lastSnapshot = key;
    try {
      syncTheme(snapshot, { timeoutMs: tmuxApplyTimeoutMs });
    } catch {
      // Theme sync is best-effort; never let tmux state break the TUI.
    }
  };

  const syncFromMode = (mode: ThemeMode | null, colors?: TerminalColors | null) => {
    syncSnapshot(buildSnapshot(mode, colors));
  };

  const onThemeMode = (mode: ThemeMode) => syncFromMode(mode);
  renderer.on('theme_mode', onThemeMode);

  syncFromMode(renderer.themeMode);

  void renderer
    .waitForThemeMode(themeQueryTimeoutMs)
    .then((mode) => syncFromMode(mode))
    .catch(() => {});

  const paletteOptions: GetPaletteOptions = {
    size: OPEN_TUI_02_PALETTE_SIZE,
    timeout: themeQueryTimeoutMs,
  };
  void renderer
    .getPalette(paletteOptions)
    .then((colors) => syncFromMode(renderer.themeMode, colors))
    .catch(() => {});

  return () => {
    disposed = true;
    renderer.off('theme_mode', onThemeMode);
  };
}
