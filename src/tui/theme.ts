/**
 * 2050 color palette for Genie TUI.
 * Used by TreeNode, Nav, and tmux status bar styling.
 */

export const theme = {
  accent: '#a855f7', // purple-500
  accentBg: '#7c3aed', // violet-600 — selected row background
  live: '#22d3ee', // cyan-400 — live/active indicators
  dim: '#525270', // muted purple-gray — inactive text
  text: '#c4b5fd', // violet-300 — primary text
  textBright: '#ede9fe', // violet-50 — highlighted text
  success: '#34d399', // emerald-400 — done/idle
  warn: '#fbbf24', // amber-400 — in-progress/permission
  danger: '#f87171', // red-400 — error/blocked
  border: '#1e1a2e', // pane border — almost invisible
  borderActive: '#3b3556', // active pane border
  barBg: '#0f0d17', // status bar background — ultra-dark
} as const;

export type ThemeKey = keyof typeof theme;
