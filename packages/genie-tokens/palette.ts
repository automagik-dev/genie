/**
 * Genie palette — primitive hex values.
 *
 * A dark, calm scheme:
 * - Terminal surface: black-petrol bg, mint-green monospace text, desaturated red alarms.
 * - Muted base palette; warm beige/amber reserved for rare highlights.
 * - Red is rare and means alarm — never decorative.
 */
export const palette = {
  // Surfaces
  bg: '#0a1d2a',
  bgRaised: '#0f2638',
  bgHover: '#143049',
  bgOverlay: 'rgba(10, 29, 42, 0.92)',

  // Text (overhead fluorescent)
  text: '#c9cfd4',
  textDim: '#8a9499',
  textMuted: '#5e6e74',

  // Borders
  border: '#2a3f4f',
  borderActive: '#7fc8a9',

  // Accent (mint terminal text — replaces brand purple)
  accent: '#7fc8a9',
  accentDim: '#5a9d82',
  accentBright: '#9eddc1',

  // Status (calmer, fewer alarms)
  success: '#7fc8a9',
  warning: '#d4a574',
  error: '#a83838',
  errorBright: '#c44a4a',
  info: '#5a8ca8',

  // Warm accents (rare)
  beige: '#d4c5a9',
  mutedGrey: '#5e6e74',
  warmAmber: '#d4a574',

  // Scrollbar
  scrollTrack: '#2a3f4f',
  scrollThumb: '#5e6e74',
} as const;

export type PaletteKey = keyof typeof palette;
