/**
 * Severance Lumon-MDR palette — primitive hex values.
 *
 * Reference: TV show "Severance" (Apple TV+).
 * - MDR terminal: black-petrol bg, mint-green monospace text, desaturated red alarms.
 * - Lumon offices: pale beige walls, deep navy carpet, fluorescent overhead light.
 * - Severed/Innie palette is muted; warmth (amber) reserved for the Outie world.
 * - Red is rare and means alarm — never decorative.
 */
export const palette = {
  // Surfaces (Lumon institutional)
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

  // Accent (MDR terminal text — replaces brand purple)
  accent: '#7fc8a9',
  accentDim: '#5a9d82',
  accentBright: '#9eddc1',

  // Status (calmer, fewer alarms)
  success: '#7fc8a9',
  warning: '#d4a574',
  error: '#a83838',
  errorBright: '#c44a4a',
  info: '#5a8ca8',

  // Severance accents (rare)
  beige: '#d4c5a9',
  innieGrey: '#5e6e74',
  outieAmber: '#d4a574',

  // Scrollbar
  scrollTrack: '#2a3f4f',
  scrollThumb: '#5e6e74',
} as const;

export type PaletteKey = keyof typeof palette;
