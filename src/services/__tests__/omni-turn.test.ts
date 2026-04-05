/**
 * TurnTracker unit tests — Group 1.
 *
 * Covers the in-memory turn state machine:
 *   - open -> isOpen returns true
 *   - close -> isOpen returns false
 *   - close is idempotent (double-close does not throw or corrupt state)
 *   - getByTurnId reverse lookup works
 *   - open overwrites stale turn on same sessionKey
 *   - delete removes turn
 */

import { describe, expect, it } from 'bun:test';
import { TurnTracker } from '../omni-turn.js';

describe('TurnTracker', () => {
  it('open -> isOpen returns true', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-1', 'msg-1');
    expect(tracker.isOpen('agent:chat1')).toBe(true);
  });

  it('close -> isOpen returns false', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-1', 'msg-1');
    tracker.close('agent:chat1', 'message');
    expect(tracker.isOpen('agent:chat1')).toBe(false);
  });

  it('close is idempotent', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-1', 'msg-1');
    tracker.close('agent:chat1', 'message');
    tracker.close('agent:chat1', 'react');
    // closedAction stays as the first close's value
    const turn = tracker.getByTurnId('turn-1');
    expect(turn?.closed).toBe(true);
    expect(turn?.closedAction).toBe('message');
  });

  it('getByTurnId reverse lookup works', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-1', 'msg-1');
    tracker.open('agent:chat2', 'turn-2', 'msg-2');

    const turn1 = tracker.getByTurnId('turn-1');
    expect(turn1).toBeDefined();
    expect(turn1?.sessionKey).toBe('agent:chat1');
    expect(turn1?.messageId).toBe('msg-1');

    const turn2 = tracker.getByTurnId('turn-2');
    expect(turn2).toBeDefined();
    expect(turn2?.sessionKey).toBe('agent:chat2');

    // Non-existent turn
    expect(tracker.getByTurnId('turn-999')).toBeUndefined();
  });

  it('open overwrites stale turn on same sessionKey', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-old', 'msg-old');
    tracker.close('agent:chat1', 'skip');

    // Open a new turn on the same session
    tracker.open('agent:chat1', 'turn-new', 'msg-new');
    expect(tracker.isOpen('agent:chat1')).toBe(true);
    expect(tracker.getTurnId('agent:chat1')).toBe('turn-new');

    // Old turn is gone (overwritten in the Map)
    expect(tracker.getByTurnId('turn-old')).toBeUndefined();
  });

  it('delete removes turn', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-1', 'msg-1');
    expect(tracker.isOpen('agent:chat1')).toBe(true);

    tracker.delete('agent:chat1');
    expect(tracker.isOpen('agent:chat1')).toBe(false);
    expect(tracker.getTurnId('agent:chat1')).toBeUndefined();
    expect(tracker.getByTurnId('turn-1')).toBeUndefined();
  });

  it('getTurnId returns the turnId for an open session', () => {
    const tracker = new TurnTracker();
    tracker.open('agent:chat1', 'turn-abc', 'msg-1');
    expect(tracker.getTurnId('agent:chat1')).toBe('turn-abc');
  });

  it('getTurnId returns undefined for unknown sessionKey', () => {
    const tracker = new TurnTracker();
    expect(tracker.getTurnId('nonexistent')).toBeUndefined();
  });

  it('isOpen returns false for unknown sessionKey', () => {
    const tracker = new TurnTracker();
    expect(tracker.isOpen('nonexistent')).toBe(false);
  });

  it('close on unknown sessionKey is a no-op', () => {
    const tracker = new TurnTracker();
    // Should not throw
    tracker.close('nonexistent', 'timeout');
  });
});
