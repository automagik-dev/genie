import { describe, expect, test } from 'bun:test';
import { buildLayoutCommand, resolveLayoutMode } from './mosaic-layout.js';

describe('buildLayoutCommand', () => {
  test('builds tiled layout command for mosaic mode', () => {
    const cmd = buildLayoutCommand('session:0', 'mosaic');
    expect(cmd).toBe("select-layout -t 'session:0' tiled");
  });

  test('builds even-horizontal layout command for vertical mode', () => {
    const cmd = buildLayoutCommand('session:0', 'vertical');
    expect(cmd).toBe("select-layout -t 'session:0' even-horizontal");
  });

  test('defaults to mosaic (tiled) layout', () => {
    const cmd = buildLayoutCommand('@4');
    expect(cmd).toBe("select-layout -t '@4' tiled");
  });
});

describe('resolveLayoutMode', () => {
  test('returns vertical when flag is vertical', () => {
    expect(resolveLayoutMode('vertical')).toBe('vertical');
  });

  test('returns mosaic for undefined flag', () => {
    expect(resolveLayoutMode()).toBe('mosaic');
  });

  test('returns mosaic for any other value', () => {
    expect(resolveLayoutMode('horizontal')).toBe('mosaic');
    expect(resolveLayoutMode('mosaic')).toBe('mosaic');
  });
});
