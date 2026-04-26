import { describe, expect, test } from 'bun:test';
import { rotateHue } from '../hsl';
import { palette } from '../palette';
import { tokens } from '../tokens';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const RGBA_RE = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[0-9.]+\s*\)$/;

function hexToLinearChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) throw new Error(`Not a 6-digit hex: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((p) => Number.parseInt(p, 16));
  return 0.2126 * hexToLinearChannel(r) + 0.7152 * hexToLinearChannel(g) + 0.0722 * hexToLinearChannel(b);
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('palette shape', () => {
  test('every value is defined and non-empty', () => {
    for (const [key, value] of Object.entries(palette)) {
      expect(value, `palette.${key} must be defined`).toBeDefined();
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test('every value is a 6-digit hex or rgba()', () => {
    for (const [key, value] of Object.entries(palette)) {
      const ok = HEX_RE.test(value) || RGBA_RE.test(value);
      expect(ok, `palette.${key} = "${value}" must be 6-digit hex or rgba()`).toBe(true);
    }
  });

  test('Severance signature values are exact', () => {
    expect(palette.bg).toBe('#0a1d2a');
    expect(palette.accent).toBe('#7fc8a9');
    expect(palette.error).toBe('#a83838');
    expect(palette.beige).toBe('#d4c5a9');
  });
});

describe('semantic tokens', () => {
  const requiredAliases = [
    'accent',
    'surface',
    'surfaceRaised',
    'surfaceHover',
    'danger',
    'dangerStrong',
    'attention',
    'info',
    'severed',
    'outieWarm',
    'lumonBeige',
  ] as const;

  test.each(requiredAliases)('%s is exposed and resolves to a palette value', (alias) => {
    const value = (tokens as Record<string, string>)[alias];
    expect(value, `tokens.${alias} must be defined`).toBeDefined();
    const ok = HEX_RE.test(value) || RGBA_RE.test(value);
    expect(ok, `tokens.${alias} = "${value}" must be hex or rgba`).toBe(true);
  });

  test('surface/danger/attention map to the expected palette primitives', () => {
    expect(tokens.surface).toBe(palette.bg);
    expect(tokens.surfaceRaised).toBe(palette.bgRaised);
    expect(tokens.surfaceHover).toBe(palette.bgHover);
    expect(tokens.danger).toBe(palette.error);
    expect(tokens.dangerStrong).toBe(palette.errorBright);
    expect(tokens.attention).toBe(palette.warning);
    expect(tokens.info).toBe(palette.info);
    expect(tokens.severed).toBe(palette.innieGrey);
    expect(tokens.outieWarm).toBe(palette.outieAmber);
    expect(tokens.lumonBeige).toBe(palette.beige);
  });
});

describe('WCAG AA contrast', () => {
  test('text on bg meets 4.5:1', () => {
    expect(contrast(palette.text, palette.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test('text on bgRaised meets 4.5:1', () => {
    expect(contrast(palette.text, palette.bgRaised)).toBeGreaterThanOrEqual(4.5);
  });

  test('accent on bg meets 3:1 (large/UI element threshold)', () => {
    expect(contrast(palette.accent, palette.bg)).toBeGreaterThanOrEqual(3);
  });

  test('accentBright on bg meets 3:1', () => {
    expect(contrast(palette.accentBright, palette.bg)).toBeGreaterThanOrEqual(3);
  });

  test('errorBright on bg meets 3:1 — escalated alarm state must be readable', () => {
    // Note: `palette.error` (#a83838) is intentionally desaturated per the Severance
    // design ("Red is rare and means alarm — never decorative"). When higher contrast
    // is required, surfaces use `errorBright` (the hover/escalation state).
    expect(contrast(palette.errorBright, palette.bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('rotateHue', () => {
  test('zero rotation returns the same color (after roundtrip)', () => {
    expect(rotateHue('#7fc8a9', 0).toLowerCase()).toBe('#7fc8a9');
  });

  test('360 rotation is a no-op', () => {
    expect(rotateHue('#7fc8a9', 360).toLowerCase()).toBe('#7fc8a9');
  });

  test('produces 6-digit hex regardless of rotation', () => {
    for (let deg = 0; deg < 360; deg += 45) {
      const out = rotateHue(palette.accent, deg);
      expect(out).toMatch(HEX_RE);
    }
  });

  test('rotation preserves saturation/lightness (different hue)', () => {
    const rotated = rotateHue('#7fc8a9', 180);
    expect(rotated).not.toBe('#7fc8a9');
    expect(rotated).toMatch(HEX_RE);
  });
});
