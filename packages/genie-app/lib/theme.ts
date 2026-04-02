/**
 * Automagik Genie Theme — CSS variable definitions for the desktop app.
 *
 * Dark theme with purple accent (#7C3AED = Automagik brand).
 * Views import this theme object for consistent styling.
 */

export const theme = {
  // Accent colors
  purple: '#a855f7',
  violet: '#7c3aed',
  cyan: '#22d3ee',
  emerald: '#34d399',
  blue: '#60a5fa',

  // Backgrounds
  bg: '#1a1028',
  bgCard: '#241838',
  bgCardHover: '#2e2048',
  bgOverlay: 'rgba(26, 16, 40, 0.85)',

  // Text
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textMuted: '#64748b',

  // Borders
  border: '#414868',
  borderActive: '#7c3aed',

  // Status
  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
  info: '#22d3ee',

  // Scrollbar
  scrollTrack: '#414868',
  scrollThumb: '#7aa2f7',

  // Spacing
  fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
  radiusSm: '4px',
  radiusMd: '8px',
  radiusLg: '12px',
} as const;

export type Theme = typeof theme;

/**
 * CSS custom properties for injecting into a root element style attribute.
 * Usage: `<div style={cssVars}>` at the app root.
 */
export const cssVars: Record<string, string> = {
  '--genie-bg': theme.bg,
  '--genie-bg-card': theme.bgCard,
  '--genie-bg-card-hover': theme.bgCardHover,
  '--genie-text': theme.text,
  '--genie-text-dim': theme.textDim,
  '--genie-text-muted': theme.textMuted,
  '--genie-border': theme.border,
  '--genie-border-active': theme.borderActive,
  '--genie-accent': theme.violet,
  '--genie-accent-light': theme.purple,
  '--genie-success': theme.success,
  '--genie-warning': theme.warning,
  '--genie-error': theme.error,
  '--genie-info': theme.info,
  '--genie-font': theme.fontFamily,
};
