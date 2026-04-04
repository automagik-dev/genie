import { describe, expect, test } from 'bun:test';
import { sanitizeWindowName } from './claude-code.js';

describe('sanitizeWindowName', () => {
  test('different JIDs produce different window names', () => {
    const a = sanitizeWindowName('5511999999999@s.whatsapp.net');
    const b = sanitizeWindowName('5511888888888@s.whatsapp.net');
    expect(a).not.toBe(b);
  });

  test('identical inputs produce identical output', () => {
    const id = '5511999999999@s.whatsapp.net';
    expect(sanitizeWindowName(id)).toBe(sanitizeWindowName(id));
  });

  test('output contains alphanumeric prefix and hash suffix', () => {
    const result = sanitizeWindowName('5511999999999@s.whatsapp.net');
    expect(result).toMatch(/^[a-zA-Z0-9]+-[a-f0-9]{12}$/);
  });

  test('prefix is truncated to 24 chars', () => {
    const longId = 'a'.repeat(100);
    const result = sanitizeWindowName(longId);
    const [prefix] = result.split('-');
    expect(prefix.length).toBeLessThanOrEqual(24);
  });

  test('empty string returns hash-only name (not "chat")', () => {
    const result = sanitizeWindowName('');
    // Empty prefix but hash is always non-empty, so fallback to 'chat' never triggers
    expect(result).toMatch(/^-[a-f0-9]{12}$/);
  });

  test('special characters are stripped from prefix', () => {
    const result = sanitizeWindowName('user@domain.com/resource');
    const [prefix] = result.split('-');
    expect(prefix).toMatch(/^[a-zA-Z0-9]+$/);
  });

  test('similar JIDs with different numbers do not collide', () => {
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const jid = `55119${String(i).padStart(8, '0')}@s.whatsapp.net`;
      names.add(sanitizeWindowName(jid));
    }
    expect(names.size).toBe(100);
  });
});
