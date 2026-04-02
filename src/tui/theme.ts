/** 2050 color palette for the Genie TUI */

export const palette = {
  // Accent colors
  purple: '#a855f7',
  violet: '#7c3aed',
  cyan: '#22d3ee',
  emerald: '#34d399',

  // Backgrounds
  bg: '#1a1028',
  bgLight: '#241838',
  bgLighter: '#2e2048',

  // Text
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textMuted: '#64748b',

  // Borders
  border: '#414868',
  borderActive: '#7c3aed',

  // Scrollbar
  scrollTrack: '#414868',
  scrollThumb: '#7aa2f7',

  // Status
  active: '#22d3ee',
  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
  idle: '#94a3b8',
} as const;

/** Icons for tree node types */
export const icons = {
  org: '\u25c6', // ◆
  project: '\u25b8', // ▸
  projectOpen: '\u25be', // ▾
  board: '\u2261', // ≡
  boardOpen: '\u2261',
  column: '\u2502', // │
  task: '\u25cb', // ○
  taskActive: '\u25cf', // ●
  taskDone: '\u2713', // ✓
  agent: '\u25b6', // ▶
  collapsed: '\u25b8', // ▸
  expanded: '\u25be', // ▾
} as const;
