import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmuxBin } from '../lib/ensure-tmux.js';
import { palette } from './theme.js';

export type OpenTuiThemeMode = 'dark' | 'light';

export interface TuiTmuxThemeSnapshot {
  mode: OpenTuiThemeMode;
  terminalForeground?: string | null;
  terminalBackground?: string | null;
}

interface TmuxThemePalette {
  bg: string;
  bgRaised: string;
  text: string;
  textDim: string;
  textMuted: string;
  border: string;
  accent: string;
  accentDim: string;
  accentBright: string;
  warning: string;
  info: string;
}

interface SyncTuiTmuxThemeDeps {
  spawnSync?: typeof spawnSync;
  tmuxBin?: string;
  socketName?: string;
  configPath?: string;
  timeoutMs?: number;
}

const TUI_TMUX_SOCKET = 'genie-tui';
const DEFAULT_TMUX_SYNC_TIMEOUT_MS = 300;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const lightPalette: TmuxThemePalette = {
  bg: '#f5efe4',
  bgRaised: '#ebe3d7',
  text: '#24323a',
  textDim: '#56656d',
  textMuted: '#718087',
  border: '#c8bdae',
  accent: '#2f7a62',
  accentDim: '#3e9277',
  accentBright: '#17694f',
  warning: '#9a651e',
  info: '#406f8b',
};

function resolveTuiTmuxConf(): string {
  const home = process.env.GENIE_HOME ?? `${process.env.HOME}/.genie`;
  const tuiConf = `${home}/tui-tmux.conf`;
  return existsSync(tuiConf) ? tuiConf : '/dev/null';
}

function safeHex(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed : fallback;
}

function resolveThemePalette(snapshot: TuiTmuxThemeSnapshot): TmuxThemePalette {
  if (snapshot.mode === 'dark') {
    return {
      bg: palette.bg,
      bgRaised: palette.bgRaised,
      text: palette.text,
      textDim: palette.textDim,
      textMuted: palette.textMuted,
      border: palette.border,
      accent: palette.accent,
      accentDim: palette.accentDim,
      accentBright: palette.accentBright,
      warning: palette.warning,
      info: palette.info,
    };
  }

  return {
    ...lightPalette,
    bg: safeHex(snapshot.terminalBackground, lightPalette.bg),
    text: safeHex(snapshot.terminalForeground, lightPalette.text),
  };
}

function flattenTmuxCommands(commands: string[][]): string[] {
  const args: string[] = [];
  commands.forEach((command, index) => {
    if (index > 0) args.push(';');
    args.push(...command);
  });
  return args;
}

export function buildTuiTmuxThemeCommands(snapshot: TuiTmuxThemeSnapshot): string[] {
  const theme = resolveThemePalette(snapshot);
  const terminalForeground = safeHex(snapshot.terminalForeground, theme.text);
  const terminalBackground = safeHex(snapshot.terminalBackground, theme.bg);
  return flattenTmuxCommands([
    ['set-environment', '-g', 'GENIE_TUI_THEME_MODE', snapshot.mode],
    ['set-environment', '-g', 'GENIE_TUI_TERMINAL_FG', terminalForeground],
    ['set-environment', '-g', 'GENIE_TUI_TERMINAL_BG', terminalBackground],
    ['set-environment', '-g', 'GENIE_TUI_TMUX_BG', theme.bg],
    ['set-environment', '-g', 'GENIE_TUI_TMUX_TEXT', theme.text],
    ['set-environment', '-g', 'GENIE_TUI_TMUX_ACCENT', theme.accent],
    ['set-option', '-g', 'pane-border-style', `fg=${theme.border}`],
    ['set-option', '-g', 'pane-active-border-style', `fg=${theme.accent}`],
    ['set-option', '-g', 'message-style', `bg=${theme.bgRaised},fg=${theme.info}`],
    ['set-option', '-g', 'message-command-style', `bg=${theme.bgRaised},fg=${theme.warning}`],
    ['set-option', '-g', 'status-style', `bg=${theme.bg},fg=${theme.text}`],
    ['set-window-option', '-g', 'mode-style', `bg=${theme.accent},fg=${theme.bg}`],
    ['set-window-option', '-g', 'clock-mode-colour', theme.accent],
  ]);
}

export function syncTuiTmuxTheme(snapshot: TuiTmuxThemeSnapshot, deps: SyncTuiTmuxThemeDeps = {}): boolean {
  const run = deps.spawnSync ?? spawnSync;
  const tmux = deps.tmuxBin ?? tmuxBin();
  const socketName = deps.socketName ?? TUI_TMUX_SOCKET;
  const configPath = deps.configPath ?? resolveTuiTmuxConf();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TMUX_SYNC_TIMEOUT_MS;
  const result = run(tmux, ['-L', socketName, '-f', configPath, ...buildTuiTmuxThemeCommands(snapshot)], {
    stdio: 'ignore',
    timeout: timeoutMs,
  });
  return result.status === 0;
}
