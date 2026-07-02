/**
 * Approve/deny matching — turn an inbound WhatsApp text reply or emoji reaction
 * into an {@link ApprovalDecision}, or `null` when it matches neither vocabulary.
 *
 * Ported from origin/v4:src/lib/omni-approval-handler.ts. v4 spoke in the SDK's
 * `allow`/`deny`; the v5 queue speaks `approved`/`denied`, so the boundary is
 * mapped here once and the rest of the runner stays in queue vocabulary.
 */

import type { ApprovalDecision } from './v5/omni-queue.js';

export interface MatchVocabulary {
  approveTokens: string[];
  denyTokens: string[];
  approveReactions: string[];
  denyReactions: string[];
}

/**
 * Match a free-text reply against the approve/deny token lists. The whole
 * trimmed, lower-cased message must equal a token — a substring match would let
 * "no problem, go ahead" resolve as a denial. Returns null on no match so the
 * caller can ignore chatter that isn't a decision.
 */
export function matchTextToken(content: string, vocab: MatchVocabulary): ApprovalDecision | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;
  if (vocab.approveTokens.some((t) => t.toLowerCase() === normalized)) return 'approved';
  if (vocab.denyTokens.some((t) => t.toLowerCase() === normalized)) return 'denied';
  return null;
}

/** Match a reaction emoji against the approve/deny reaction lists. */
export function matchReaction(emoji: string, vocab: MatchVocabulary): ApprovalDecision | null {
  if (vocab.approveReactions.includes(emoji)) return 'approved';
  if (vocab.denyReactions.includes(emoji)) return 'denied';
  return null;
}
