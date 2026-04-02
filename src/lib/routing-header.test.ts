/**
 * Routing Header Parser + Session Key Resolver — Tests
 *
 * Run with: bun test src/lib/routing-header.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { parseRoutingHeader, resolveSessionKey, stripRoutingHeader } from './routing-header.js';

// ============================================================================
// parseRoutingHeader
// ============================================================================

describe('parseRoutingHeader', () => {
  test('parses Telegram DM header', () => {
    const text = '[channel:telegram instance:telegram-01 chat:123456 msg:msg-001 from:Alice type:dm]\nHello world';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.channel).toBe('telegram');
    expect(header!.instance).toBe('telegram-01');
    expect(header!.chat).toBe('123456');
    expect(header!.msg).toBe('msg-001');
    expect(header!.from).toBe('Alice');
    expect(header!.type).toBe('dm');
    expect(header!.thread).toBeUndefined();
    expect(header!.replyTo).toBeUndefined();
  });

  test('parses WhatsApp DM header', () => {
    const text =
      '[channel:whatsapp-baileys instance:wa-prod chat:5511999999999@s.whatsapp.net msg:3EB0A1B2C3 from:Bob type:dm]\nHey there';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.channel).toBe('whatsapp-baileys');
    expect(header!.instance).toBe('wa-prod');
    expect(header!.chat).toBe('5511999999999@s.whatsapp.net');
    expect(header!.msg).toBe('3EB0A1B2C3');
    expect(header!.from).toBe('Bob');
    expect(header!.type).toBe('dm');
  });

  test('parses threaded message header', () => {
    const text =
      '[channel:slack instance:slack-01 chat:C0123ABCDEF msg:1234567890.123456 from:Carol type:group thread:1234567890.000001]\nThread reply';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.channel).toBe('slack');
    expect(header!.chat).toBe('C0123ABCDEF');
    expect(header!.type).toBe('group');
    expect(header!.thread).toBe('1234567890.000001');
  });

  test('parses group message header', () => {
    const text =
      '[channel:discord instance:discord-01 chat:9876543210 msg:msg-100 from:Dave type:group]\nGroup message';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.type).toBe('group');
    expect(header!.channel).toBe('discord');
    expect(header!.chat).toBe('9876543210');
    expect(header!.from).toBe('Dave');
  });

  test('parses header with replyTo field', () => {
    const text = '[channel:telegram instance:tg-01 chat:555 msg:msg-200 from:Eve type:dm replyTo:msg-199]\nReply text';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.replyTo).toBe('msg-199');
  });

  test('returns null for non-header text', () => {
    expect(parseRoutingHeader('Hello world')).toBeNull();
    expect(parseRoutingHeader('Not a [header] here')).toBeNull();
    expect(parseRoutingHeader('')).toBeNull();
  });

  test('returns null for incomplete header (missing required fields)', () => {
    // Missing 'from' and 'type'
    expect(parseRoutingHeader('[channel:telegram instance:tg-01 chat:123 msg:m1]')).toBeNull();
  });

  test('returns null for invalid type value', () => {
    expect(parseRoutingHeader('[channel:telegram instance:tg-01 chat:123 msg:m1 from:X type:channel]')).toBeNull();
  });

  test('parses header-only message (no body)', () => {
    const text = '[channel:telegram instance:tg-01 chat:123 msg:m1 from:X type:dm]';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.channel).toBe('telegram');
  });

  test('handles extra whitespace in header', () => {
    const text = '[channel:telegram  instance:tg-01  chat:123  msg:m1  from:X  type:dm]\nBody';
    const header = parseRoutingHeader(text);
    expect(header).not.toBeNull();
    expect(header!.channel).toBe('telegram');
  });
});

// ============================================================================
// resolveSessionKey
// ============================================================================

describe('resolveSessionKey', () => {
  test('DM produces {agent}-{hash} key', () => {
    const header = parseRoutingHeader(
      '[channel:whatsapp-baileys instance:wa-prod chat:5511999@s.whatsapp.net msg:m1 from:Alice type:dm]',
    )!;
    const key = resolveSessionKey('sofia', header);
    expect(key).toMatch(/^sofia-[a-f0-9]{8}$/);
  });

  test('group produces {agent}-{hash} key', () => {
    const header = parseRoutingHeader('[channel:discord instance:dc-01 chat:general-123 msg:m1 from:Bob type:group]')!;
    const key = resolveSessionKey('sofia', header);
    expect(key).toMatch(/^sofia-[a-f0-9]{8}$/);
  });

  test('threaded DM produces {agent}-{hash}-{thread} key', () => {
    const header = parseRoutingHeader(
      '[channel:slack instance:sl-01 chat:D0123 msg:m1 from:Carol type:dm thread:t-001]',
    )!;
    const key = resolveSessionKey('sofia', header);
    expect(key).toMatch(/^sofia-[a-f0-9]{8}-t-001$/);
  });

  test('threaded group produces {agent}-{hash}-{thread} key', () => {
    const header = parseRoutingHeader(
      '[channel:slack instance:sl-01 chat:C0123 msg:m1 from:Dave type:group thread:t-002]',
    )!;
    const key = resolveSessionKey('genie', header);
    expect(key).toMatch(/^genie-[a-f0-9]{8}-t-002$/);
  });

  test('determinism: same input → same key', () => {
    const text = '[channel:whatsapp-baileys instance:wa-prod chat:5511999@s.whatsapp.net msg:m1 from:Alice type:dm]';
    const header = parseRoutingHeader(text)!;
    const key1 = resolveSessionKey('sofia', header);
    const key2 = resolveSessionKey('sofia', header);
    const key3 = resolveSessionKey('sofia', header);
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });

  test('isolation: different chats → different keys', () => {
    const h1 = parseRoutingHeader(
      '[channel:whatsapp-baileys instance:wa-prod chat:5511111@s.whatsapp.net msg:m1 from:Alice type:dm]',
    )!;
    const h2 = parseRoutingHeader(
      '[channel:whatsapp-baileys instance:wa-prod chat:5522222@s.whatsapp.net msg:m1 from:Bob type:dm]',
    )!;
    expect(resolveSessionKey('sofia', h1)).not.toBe(resolveSessionKey('sofia', h2));
  });

  test('isolation: different instances → different keys', () => {
    const h1 = parseRoutingHeader(
      '[channel:whatsapp-baileys instance:wa-prod chat:5511111@s.whatsapp.net msg:m1 from:Alice type:dm]',
    )!;
    const h2 = parseRoutingHeader(
      '[channel:whatsapp-baileys instance:wa-staging chat:5511111@s.whatsapp.net msg:m1 from:Alice type:dm]',
    )!;
    expect(resolveSessionKey('sofia', h1)).not.toBe(resolveSessionKey('sofia', h2));
  });

  test('isolation: different agents → different keys', () => {
    const header = parseRoutingHeader('[channel:telegram instance:tg-01 chat:123 msg:m1 from:Alice type:dm]')!;
    expect(resolveSessionKey('sofia', header)).not.toBe(resolveSessionKey('genie', header));
  });

  test('msg field does not affect session key', () => {
    const h1 = parseRoutingHeader('[channel:telegram instance:tg-01 chat:123 msg:m1 from:Alice type:dm]')!;
    const h2 = parseRoutingHeader('[channel:telegram instance:tg-01 chat:123 msg:m999 from:Alice type:dm]')!;
    expect(resolveSessionKey('sofia', h1)).toBe(resolveSessionKey('sofia', h2));
  });
});

// ============================================================================
// stripRoutingHeader
// ============================================================================

describe('stripRoutingHeader', () => {
  test('strips header and returns body', () => {
    const text = '[channel:telegram instance:tg-01 chat:123 msg:m1 from:X type:dm]\nHello world';
    expect(stripRoutingHeader(text)).toBe('Hello world');
  });

  test('returns full text when no header', () => {
    expect(stripRoutingHeader('Just a normal message')).toBe('Just a normal message');
  });

  test('returns empty string for header-only message', () => {
    expect(stripRoutingHeader('[channel:telegram instance:tg-01 chat:123 msg:m1 from:X type:dm]')).toBe('');
  });

  test('preserves multiline body after header', () => {
    const text = '[channel:telegram instance:tg-01 chat:123 msg:m1 from:X type:dm]\nLine 1\nLine 2\nLine 3';
    expect(stripRoutingHeader(text)).toBe('Line 1\nLine 2\nLine 3');
  });

  test('returns empty/null inputs as-is', () => {
    expect(stripRoutingHeader('')).toBe('');
  });
});
