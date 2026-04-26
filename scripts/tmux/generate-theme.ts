#!/usr/bin/env bun
/**
 * Generate the tmux theme file from genie-tokens.
 *
 * Reads the Severance Lumon-MDR palette from `packages/genie-tokens` and emits
 * `scripts/tmux/.generated.theme.conf` with every color-bearing tmux directive:
 * styles (status, pane border, message, mode, clock) and format strings
 * (pane-border-format, status-format[0], status-format[1]).
 *
 * Why a generator: hand-maintaining hex in tmux configs caused off-by-one hue
 * drift between the TUI and tmux (`#7c3aed` vs `#7b2ff7`). Single source of
 * truth — the palette — eliminates that class of bug.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { palette } from '../../packages/genie-tokens';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.generated.theme.conf');

const { bg, bgRaised, text, textDim, textMuted, border, borderActive, accent, accentDim, accentBright, warning, info } =
  palette;

// Pane-border-format embeds tmux-style `#[bg=...,fg=...]` directives.
// Inside #{} conditionals the `,` is reserved, so we splice with explicit
// alignment markers and align tags. Keep this string single-line — tmux does
// not allow newlines inside set -g values without `\n` escaping in 3.x.
const paneBorderFormat = [
  `#[align=left,bg=${bgRaised},fg=${text}]`,
  ` #[fg=${accent},bold]Genie#[fg=${textMuted},nobold] `,
  `#[fg=${border}]│ `,
  `#[fg=${textDim}]#{pane_current_path}`,
  `#[align=right,bg=${bgRaised}]`,
  `#[fg=${text}]#{session_name}:#{window_name} `,
  `#[fg=${border}]│ `,
  `#[fg=${text}]%H:%M `,
].join('');

// Status line 0 (very bottom): window tabs for current session.
// Active window gets accent bg + bold text; inactive window keeps petrol bg.
const statusFormat0 = [
  `#[align=left,bg=${bg},fg=${text}] `,
  '#{W:',
  '#[range=window|#{window_index}]',
  '#{?#{window_active},',
  `#[bg=${accent}#,fg=${bg}#,bold] #{window_index}:#{window_name} #[bg=${bg}#,fg=${accent}#,nobold]`,
  ',',
  `#[bg=${bg}#,fg=${textDim}] #{window_index}:#{window_name} `,
  '}',
  '#[norange default]',
  '}',
  `#[align=right,bg=${bg},fg=${textMuted}]#{session_name} `,
].join('');

// Status line 1 (just above): agent sessions = tmux sessions.
const statusFormat1 = [
  `#[align=left,bg=${bgRaised},fg=${textDim}] `,
  `#[fg=${textMuted}]Agents: `,
  '#{S:',
  '#[range=session|#{session_name}]',
  '#{?#{==:#{session_name},#{client_session}},',
  `#[bg=${accent}#,fg=${bg}#,bold] #{session_name} #[bg=${bgRaised}#,nobold]`,
  ',',
  `#[bg=${bgRaised}#,fg=${textDim}] #{session_name} `,
  '}',
  '#[norange default]',
  '}',
].join('');

const lines = [
  '# ============================================================================',
  '# Generated tmux theme — DO NOT EDIT BY HAND',
  '# Source of truth: packages/genie-tokens/palette.ts',
  '# Regenerate: bash scripts/tmux/generate-theme.sh',
  '# ============================================================================',
  '',
  '# --- Pane borders ---',
  `set -g pane-border-style "fg=${border}"`,
  `set -g pane-active-border-style "fg=${accent}"`,
  '',
  '# --- Message styling ---',
  `set -g message-style "bg=${bgRaised},fg=${info}"`,
  `set -g message-command-style "bg=${bgRaised},fg=${warning}"`,
  '',
  '# --- Copy/mode styling ---',
  `setw -g mode-style "bg=${accent},fg=${bg}"`,
  '',
  '# --- Clock ---',
  `setw -g clock-mode-colour "${accent}"`,
  '',
  '# --- Status line ---',
  `set -g status-style "bg=${bg},fg=${text}"`,
  '',
  '# --- Pane-border-format (top bar) ---',
  `set -g pane-border-format "${paneBorderFormat}"`,
  '',
  '# --- Status line 0 (very bottom): window tabs ---',
  `set -g status-format[0] "${statusFormat0}"`,
  '',
  '# --- Status line 1 (above): agent sessions ---',
  `set -g status-format[1] "${statusFormat1}"`,
  '',
  '# Token export for shell consumers (genie-projects.sh, genie-sessions.sh).',
  '# tmux ignores #{?...} expansion of plain `setenv` lines, so these are read',
  '# by `tmux show-environment -g GENIE_TMUX_*` from helper scripts.',
  `set-environment -g GENIE_TMUX_BG "${bg}"`,
  `set-environment -g GENIE_TMUX_BG_RAISED "${bgRaised}"`,
  `set-environment -g GENIE_TMUX_TEXT "${text}"`,
  `set-environment -g GENIE_TMUX_TEXT_DIM "${textDim}"`,
  `set-environment -g GENIE_TMUX_TEXT_MUTED "${textMuted}"`,
  `set-environment -g GENIE_TMUX_BORDER "${border}"`,
  `set-environment -g GENIE_TMUX_BORDER_ACTIVE "${borderActive}"`,
  `set-environment -g GENIE_TMUX_ACCENT "${accent}"`,
  `set-environment -g GENIE_TMUX_ACCENT_DIM "${accentDim}"`,
  `set-environment -g GENIE_TMUX_ACCENT_BRIGHT "${accentBright}"`,
  '',
];

writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`Wrote ${out}`);
