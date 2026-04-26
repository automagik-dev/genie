import { palette } from './palette';

/**
 * Semantic aliases on top of the primitive palette. Consumers should prefer
 * these names — they survive palette rebalancing without churning import sites.
 */
export const tokens = {
  accent: palette.accent,
  accentDim: palette.accentDim,
  accentBright: palette.accentBright,

  surface: palette.bg,
  surfaceRaised: palette.bgRaised,
  surfaceHover: palette.bgHover,
  surfaceOverlay: palette.bgOverlay,

  text: palette.text,
  textDim: palette.textDim,
  textMuted: palette.textMuted,

  border: palette.border,
  borderActive: palette.borderActive,

  danger: palette.error,
  dangerStrong: palette.errorBright,
  attention: palette.warning,
  info: palette.info,
  success: palette.success,

  severed: palette.innieGrey,
  outieWarm: palette.outieAmber,
  lumonBeige: palette.beige,
} as const;

export type TokenKey = keyof typeof tokens;
