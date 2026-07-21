/**
 * Pure badge-render unit tests. Every glyph is a deterministic function of the
 * card projection + injected `now`, so each visual state is asserted directly
 * (no board subprocess, no sleep). The board/status CLI tests then confirm the
 * same glyphs reach real stdout.
 */

import { describe, expect, test } from 'bun:test';
import { LIVENESS_GLYPH, blockBadge, cardBadges, commentBadge, livenessBadge } from './card-render.js';
import { LIVENESS_RUNNING_MS, LIVENESS_STALE_MS, type TaskCardRow } from './task-state.js';

const NOW = 10_000_000;

/** Minimal card fixture; override only the fields a case exercises. */
function card(over: Partial<TaskCardRow> = {}): TaskCardRow {
  return {
    id: 't_1',
    boardId: null,
    title: 'x',
    status: 'ready',
    claimedBy: null,
    claimedAt: null,
    wish: null,
    group: null,
    createdAt: 0,
    updatedAt: 0,
    lane: null,
    agentKind: null,
    heartbeatAt: null,
    blockedBy: null,
    blockedReason: null,
    ...over,
  };
}

describe('livenessBadge', () => {
  test('unclaimed cards carry no liveness glyph', () => {
    expect(livenessBadge(card({ claimedBy: null, heartbeatAt: NOW }), NOW)).toBeNull();
  });

  test('claimed cards map heartbeat age to ▶ / ⏸ / ☠', () => {
    expect(livenessBadge(card({ claimedBy: 'w', heartbeatAt: NOW }), NOW)).toBe('▶');
    expect(livenessBadge(card({ claimedBy: 'w', heartbeatAt: NOW - (LIVENESS_RUNNING_MS + 1) }), NOW)).toBe('⏸');
    expect(livenessBadge(card({ claimedBy: 'w', heartbeatAt: NOW - (LIVENESS_STALE_MS + 1) }), NOW)).toBe('☠');
    // Claimed but never pulsed → stale (the zombie).
    expect(livenessBadge(card({ claimedBy: 'w', heartbeatAt: null }), NOW)).toBe('☠');
  });

  test('the glyph table covers every liveness state', () => {
    expect(LIVENESS_GLYPH).toEqual({ running: '▶', idle: '⏸', stale: '☠' });
  });
});

describe('blockBadge', () => {
  test('a deps-blocked card (no stored blocker) renders ⛔ deps (render-derived)', () => {
    expect(blockBadge(card({ status: 'blocked', blockedBy: null }))).toBe('⛔ deps');
  });

  test('a stored block renders provenance + reason', () => {
    expect(blockBadge(card({ blockedBy: 'eng-B', blockedReason: 'awaiting design' }))).toBe(
      '⛔ eng-B: awaiting design',
    );
    expect(blockBadge(card({ blockedBy: 'felipe', blockedReason: null }))).toBe('⛔ felipe');
  });

  test('an unblocked, non-blocked card renders no ⛔', () => {
    expect(blockBadge(card({ status: 'ready', blockedBy: null }))).toBeNull();
  });
});

describe('commentBadge + cardBadges assembly', () => {
  test('commentBadge appears only for a positive count', () => {
    expect(commentBadge(0)).toBeNull();
    expect(commentBadge(3)).toBe('💬 3');
  });

  test('cardBadges concatenates liveness, block, then comments; empty when none', () => {
    expect(cardBadges(card(), NOW, 0)).toBe('');
    const full = cardBadges(
      card({ claimedBy: 'w', heartbeatAt: NOW, blockedBy: 'felipe', blockedReason: 'hold' }),
      NOW,
      2,
    );
    expect(full).toContain('▶');
    expect(full).toContain('⛔ felipe: hold');
    expect(full).toContain('💬 2');
    // Liveness precedes the block, which precedes the comment count.
    expect(full.indexOf('▶')).toBeLessThan(full.indexOf('⛔'));
    expect(full.indexOf('⛔')).toBeLessThan(full.indexOf('💬'));
  });
});
