/**
 * inbox renderers — unit tests
 *
 * Pure helpers exposed by `genie agent inbox list`. Verifies:
 *   - `[<source>]` tag prepended in the human render when source !== 'agent'
 *   - default-source previews skip the tag (back-compat)
 *   - JSON enrichment surfaces source + meta verbatim
 *
 * Run with: bun test src/term-commands/agent/inbox.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { buildInboxEntry, extractSource, renderConversation } from './inbox.js';

const baseConv = {
  id: 'conv-1',
  name: 'whatsapp:+5511999',
  type: 'dm',
  linkedEntity: null,
  linkedEntityId: null,
};

describe('extractSource', () => {
  test('returns agent for null/undefined message', () => {
    expect(extractSource(null)).toBe('agent');
    expect(extractSource(undefined)).toBe('agent');
  });

  test('returns agent when metadata.source missing', () => {
    expect(extractSource({ metadata: {} })).toBe('agent');
    expect(extractSource({})).toBe('agent');
  });

  test('returns the explicit source value', () => {
    expect(extractSource({ metadata: { source: 'whatsapp' } })).toBe('whatsapp');
    expect(extractSource({ metadata: { source: 'system' } })).toBe('system');
  });

  test('treats non-string source as agent', () => {
    expect(extractSource({ metadata: { source: 42 } })).toBe('agent');
  });
});

describe('renderConversation', () => {
  test('omits source tag for default agent source', () => {
    const lastMsg = {
      body: 'hello peer',
      senderId: 'engineer',
      createdAt: '2026-04-27T13:42:00.000Z',
      metadata: {},
    };
    const lines = renderConversation(baseConv, lastMsg);
    const previewLine = lines[1];
    expect(previewLine.includes('engineer:')).toBe(true);
    expect(previewLine.includes('[agent]')).toBe(false);
    expect(previewLine.startsWith('    ')).toBe(true);
  });

  test('prepends [<source>] tag when source is non-default', () => {
    const lastMsg = {
      body: 'whats up genie',
      senderId: 'felipe',
      createdAt: '2026-04-27T13:42:00.000Z',
      metadata: { source: 'whatsapp', phone: '+5511999' },
    };
    const lines = renderConversation(baseConv, lastMsg);
    const previewLine = lines[1];
    expect(previewLine.includes('[whatsapp] ')).toBe(true);
    expect(previewLine.includes('felipe:')).toBe(true);
  });

  test('handles missing last message without crashing', () => {
    const lines = renderConversation(baseConv, null);
    expect(lines.length).toBe(2); // header + trailing blank
  });
});

describe('buildInboxEntry', () => {
  test('JSON entry surfaces source and meta verbatim', () => {
    const conv = { id: 'c1', name: 'wa', type: 'dm' };
    const lastMessage = {
      id: 1,
      body: 'hi',
      senderId: 'felipe',
      createdAt: '2026-04-27T13:42:00.000Z',
      metadata: { source: 'whatsapp', phone: '+5511999', conversationId: 'wa-abc' },
    };
    const entry = buildInboxEntry(conv, lastMessage);
    expect(entry.conversation).toBe(conv);
    expect(entry.lastMessage).toBe(lastMessage);
    expect(entry.source).toBe('whatsapp');
    expect(entry.meta).toEqual({
      source: 'whatsapp',
      phone: '+5511999',
      conversationId: 'wa-abc',
    });
  });

  test('JSON entry defaults source to agent when missing', () => {
    const entry = buildInboxEntry({ id: 'c2' }, { metadata: {} });
    expect(entry.source).toBe('agent');
    expect(entry.meta).toEqual({});
  });

  test('handles null last message', () => {
    const entry = buildInboxEntry({ id: 'c3' }, null);
    expect(entry.lastMessage).toBeNull();
    expect(entry.source).toBe('agent');
    expect(entry.meta).toEqual({});
  });
});
