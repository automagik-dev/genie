import { describe, expect, test } from 'bun:test';
import { isWideEmitEnabled, readWideEmitFlag } from './observability-flag.js';

describe('readWideEmitFlag', () => {
  test('returns off when unset', () => {
    expect(readWideEmitFlag({})).toBe('off');
  });

  test('returns off for empty string', () => {
    expect(readWideEmitFlag({ GENIE_WIDE_EMIT: '' })).toBe('off');
  });

  test.each(['1', 'true', 'on', 'yes', 'TRUE', 'On', 'Yes'])('returns on for %s', (value) => {
    expect(readWideEmitFlag({ GENIE_WIDE_EMIT: value })).toBe('on');
  });

  test.each(['0', 'false', 'off', 'no', 'maybe'])('returns off for %s', (value) => {
    expect(readWideEmitFlag({ GENIE_WIDE_EMIT: value })).toBe('off');
  });

  test('trims whitespace', () => {
    expect(readWideEmitFlag({ GENIE_WIDE_EMIT: '  true  ' })).toBe('on');
  });

  test('isWideEmitEnabled mirrors readWideEmitFlag', () => {
    expect(isWideEmitEnabled({ GENIE_WIDE_EMIT: '1' })).toBe(true);
    expect(isWideEmitEnabled({ GENIE_WIDE_EMIT: '0' })).toBe(false);
    expect(isWideEmitEnabled({})).toBe(false);
  });
});
