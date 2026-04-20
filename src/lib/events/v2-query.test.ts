/**
 * Pure unit tests for v2-query helpers.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 4 / CLI filter
 * extension). These cover the `kindFilterToLike` translator that backs
 * `genie events stream-follow --kind '<glob>'` so the operator-facing UX
 * documented in the runbook (`detector.*`) actually filters the right rows.
 */

import { describe, expect, test } from 'bun:test';
import { kindFilterToLike } from './v2-query.js';

describe('kindFilterToLike — predicate translator', () => {
  test('bare prefix preserves historic LIKE-prefix contract', () => {
    expect(kindFilterToLike('mailbox')).toBe('mailbox%');
    expect(kindFilterToLike('agent.lifecycle')).toBe('agent.lifecycle%');
  });

  test('glob `detector.*` matches `detector.fired` and `detector.disabled` semantics', () => {
    const pattern = kindFilterToLike('detector.*');
    expect(pattern).toBe('detector.%');
    // Spot-check that the SQL LIKE pattern matches what the runbook contract
    // promises and rejects unrelated event families.
    expect(matchesLike('detector.fired', pattern)).toBe(true);
    expect(matchesLike('detector.disabled', pattern)).toBe(true);
    expect(matchesLike('command.success', pattern)).toBe(false);
    expect(matchesLike('detection.rate', pattern)).toBe(false);
  });

  test('embedded glob expands at the right offset', () => {
    expect(kindFilterToLike('rot.*.detected')).toBe('rot.%.detected');
  });

  test('SQL wildcards in the input are escaped, not propagated', () => {
    // `%` and `_` must be escaped so that an operator cannot inadvertently
    // (or maliciously) widen the predicate by typing them in --kind.
    expect(kindFilterToLike('mail%box')).toBe('mail\\%box%');
    expect(kindFilterToLike('agent_lifecycle')).toBe('agent\\_lifecycle%');
  });
});

/**
 * Tiny SQL LIKE evaluator used by the spot-check assertions above. Mirrors the
 * subset of LIKE semantics the predicate uses — `%` matches any sequence,
 * `_` matches any single char. Escaped via `\` per the production query.
 */
function matchesLike(input: string, pattern: string): boolean {
  let regex = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      regex += escapeRegex(pattern[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '%') {
      regex += '.*';
    } else if (ch === '_') {
      regex += '.';
    } else {
      regex += escapeRegex(ch);
    }
    i++;
  }
  regex += '$';
  return new RegExp(regex).test(input);
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
