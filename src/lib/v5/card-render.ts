/**
 * Genie v5 card badges — the small, PURE presentation layer shared by the human
 * board render and `task status`. Every badge is a deterministic function of the
 * card's runtime projection ({@link TaskCardRow}) plus an injected `now`, so each
 * visual state (▶/⏸/☠, ⛔ + provenance, 💬 n) is substring-testable against a
 * seeded fixture — no visual criterion is eyeball-accepted (WISH Decision 8).
 *
 * These glyphs are intentionally NOT colored: the board colors its own column
 * headers, but the badges stay plain so `NO_COLOR` tests assert exact substrings.
 */

import { type Liveness, type TaskCardRow, livenessFromHeartbeat } from './task-state.js';

/** Liveness glyphs, keyed by the pure {@link livenessFromHeartbeat} verdict. */
export const LIVENESS_GLYPH: Record<Liveness, string> = { running: '▶', idle: '⏸', stale: '☠' };

/**
 * Liveness glyph for a CLAIMED card, or null when the card is unclaimed (no
 * runtime owns it, so there is nothing to be alive). Pure over `now`.
 */
export function livenessBadge(card: TaskCardRow, now: number): string | null {
  if (!card.claimedBy) return null;
  return LIVENESS_GLYPH[livenessFromHeartbeat(card.heartbeatAt, now)];
}

/**
 * The ⛔ block badge with provenance + reason, or null when the card is not
 * blocked. A stored `blocked_by` (agent/human) renders the blocker and reason; a
 * `blocked`-status card with no stored blocker is deps-blocked — that provenance
 * is RENDER-DERIVED here (never stored) so `recomputeReady` stays untouched and
 * the block auto-clears the moment dependencies complete (WISH Decision 6).
 */
export function blockBadge(card: TaskCardRow): string | null {
  if (card.blockedBy != null) {
    return card.blockedReason ? `⛔ ${card.blockedBy}: ${card.blockedReason}` : `⛔ ${card.blockedBy}`;
  }
  if (card.status === 'blocked') return '⛔ deps';
  return null;
}

/** The 💬 comment-count badge, or null when the card carries no comments. */
export function commentBadge(count: number): string | null {
  return count > 0 ? `💬 ${count}` : null;
}

/**
 * Assemble the space-prefixed badge suffix appended to a card's render line:
 * liveness, then block, then comment count — each omitted when absent. Returns
 * '' when the card has no badges so the caller can concatenate unconditionally.
 */
export function cardBadges(card: TaskCardRow, now: number, commentCount: number): string {
  const parts = [livenessBadge(card, now), blockBadge(card), commentBadge(commentCount)].filter(
    (p): p is string => p != null,
  );
  return parts.length > 0 ? `  ${parts.join('  ')}` : '';
}
