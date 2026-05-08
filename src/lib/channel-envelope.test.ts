/**
 * channel-envelope — Unit tests
 *
 * Pure module — no PG, no fs. Covers:
 *   - format/parse round-trip across multiple sources
 *   - plain-body passthrough when source defaults to 'agent'
 *   - meta keys with characters that need attribute escaping
 *   - parseEnvelope returns null for malformed input
 *
 * Run with: bun test src/lib/channel-envelope.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { formatEnvelope, parseEnvelope } from './channel-envelope.js';

describe('formatEnvelope', () => {
  test('passes plain body through when source defaults to agent', () => {
    const out = formatEnvelope({ body: 'hello peer' });
    expect(out).toBe('hello peer');
  });

  test('passes plain body through when source is explicitly agent', () => {
    const out = formatEnvelope({ source: 'agent', body: 'hi' });
    expect(out).toBe('hi');
  });

  test('wraps body with channel tag for whatsapp source', () => {
    const out = formatEnvelope({
      source: 'whatsapp',
      from: '+5511999999999',
      meta: { phone: '+5511999999999', conversationId: 'wa-123' },
      body: 'whats up genie',
    });
    expect(out).toMatch(/^<channel /);
    expect(out).toMatch(/source="whatsapp"/);
    expect(out).toMatch(/from="\+5511999999999"/);
    expect(out).toMatch(/phone="\+5511999999999"/);
    expect(out).toMatch(/conversationId="wa-123"/);
    expect(out.endsWith('whats up genie</channel>')).toBe(true);
  });

  test('serialises numeric and boolean meta values as strings', () => {
    const out = formatEnvelope({
      source: 'system',
      meta: { priority: 3, urgent: true },
      body: 'nudge',
    });
    expect(out).toContain('priority="3"');
    expect(out).toContain('urgent="true"');
  });

  test('escapes embedded quotes inside attribute values', () => {
    const out = formatEnvelope({
      source: 'webhook',
      meta: { reason: 'said "hi"' },
      body: 'b',
    });
    expect(out).toContain('reason="said \\"hi\\""');
  });

  test('skips invalid meta keys silently', () => {
    const out = formatEnvelope({
      source: 'system',
      meta: { 'bad key': 'x', good_key: 'y' },
      body: 'b',
    });
    expect(out).not.toContain('bad key');
    expect(out).toContain('good_key="y"');
  });
});

describe('parseEnvelope', () => {
  test('parses an envelope with source/from/meta and body', () => {
    const text = '<channel source="whatsapp" from="+55" phone="+55">hello</channel>';
    const parsed = parseEnvelope(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.source).toBe('whatsapp');
    expect(parsed?.from).toBe('+55');
    expect(parsed?.meta).toEqual({ phone: '+55' });
    expect(parsed?.body).toBe('hello');
  });

  test('round-trips arbitrary source values via format → parse', () => {
    for (const source of ['whatsapp', 'system', 'telegram', 'webhook']) {
      const formatted = formatEnvelope({
        source,
        from: 'sender',
        meta: { k: 'v' },
        body: `body for ${source}`,
      });
      const parsed = parseEnvelope(formatted);
      expect(parsed).not.toBeNull();
      expect(parsed?.source).toBe(source);
      expect(parsed?.from).toBe('sender');
      expect(parsed?.meta).toEqual({ k: 'v' });
      expect(parsed?.body).toBe(`body for ${source}`);
    }
  });

  test('returns null for plain body (no envelope)', () => {
    expect(parseEnvelope('hello peer')).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseEnvelope('<channel source="x">no close')).toBeNull();
    expect(parseEnvelope('<channel >missing attrs</channel>')).not.toBeNull();
    expect(parseEnvelope('')).toBeNull();
  });

  test('round-trips meta values containing escaped quotes', () => {
    const formatted = formatEnvelope({
      source: 'webhook',
      meta: { reason: 'said "hi"' },
      body: 'b',
    });
    const parsed = parseEnvelope(formatted);
    expect(parsed?.meta.reason).toBe('said "hi"');
  });

  test('tolerates leading whitespace before the tag', () => {
    const text = '   \n<channel source="system">x</channel>';
    expect(parseEnvelope(text)?.body).toBe('x');
  });
});
