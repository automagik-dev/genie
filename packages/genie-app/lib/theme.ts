/**
 * Genie design tokens — re-export from `@automagik/genie-tokens`.
 *
 * Severance Lumon-MDR palette: petrol bg, mint accent, calm amber/crimson alarms.
 * All views import `palette`/`tokens` from here; never hard-code hex.
 */

import { palette } from '../../genie-tokens/index';

export { palette, tokens } from '../../genie-tokens/index';
export type { PaletteKey, TokenKey } from '../../genie-tokens/index';

export const fonts = {
  family: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
} as const;

export const radii = {
  sm: '4px',
  md: '8px',
  lg: '12px',
} as const;

/**
 * Backward-compat shim: legacy `theme.X` consumers get palette-backed values.
 * Prefer `palette` / `tokens` for new code. No hex literals — all values flow
 * from `genie-tokens`.
 */
export const theme = {
  // Accent surface (legacy purple/violet → Severance mint)
  purple: palette.accentBright,
  violet: palette.accent,
  cyan: palette.info,
  emerald: palette.success,
  blue: palette.info,

  // Surfaces
  bg: palette.bg,
  bgCard: palette.bgRaised,
  bgCardHover: palette.bgHover,
  bgOverlay: palette.bgOverlay,

  // Text
  text: palette.text,
  textDim: palette.textDim,
  textMuted: palette.textMuted,

  // Borders
  border: palette.border,
  borderActive: palette.borderActive,

  // Status
  success: palette.success,
  warning: palette.warning,
  error: palette.error,
  info: palette.info,

  // Scrollbar
  scrollTrack: palette.scrollTrack,
  scrollThumb: palette.scrollThumb,

  // Typography / radii (kept for legacy callers)
  fontFamily: fonts.family,
  radiusSm: radii.sm,
  radiusMd: radii.md,
  radiusLg: radii.lg,
} as const;

export type Theme = typeof theme;

/**
 * CSS custom properties injected at the app root via `<div style={cssVars}>`.
 * Keep keys stable — `index.html` <style> consumes them via `var(--genie-*)`.
 */
export const cssVars: Record<string, string> = {
  '--genie-bg': palette.bg,
  '--genie-bg-raised': palette.bgRaised,
  '--genie-bg-hover': palette.bgHover,
  '--genie-text': palette.text,
  '--genie-text-dim': palette.textDim,
  '--genie-text-muted': palette.textMuted,
  '--genie-border': palette.border,
  '--genie-border-active': palette.borderActive,
  '--genie-accent': palette.accent,
  '--genie-accent-bright': palette.accentBright,
  '--genie-accent-dim': palette.accentDim,
  '--genie-success': palette.success,
  '--genie-warning': palette.warning,
  '--genie-error': palette.error,
  '--genie-info': palette.info,
  '--genie-scroll-track': palette.scrollTrack,
  '--genie-scroll-thumb': palette.scrollThumb,
  '--genie-font': fonts.family,
};
