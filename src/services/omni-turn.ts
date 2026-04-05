/**
 * Local turn tracker — lightweight in-memory state machine.
 *
 * Omni PG is the source of truth for turn lifecycle; this tracker exists for
 * fast local lookups by the bridge (e.g., "is there an open turn for this
 * session?") without hitting the database on every NATS event.
 */

interface Turn {
  turnId: string;
  sessionKey: string;
  messageId: string;
  startedAt: number;
  closed: boolean;
  closedAction?: 'message' | 'react' | 'skip' | 'timeout';
}

export class TurnTracker {
  private turns = new Map<string, Turn>();

  open(sessionKey: string, turnId: string, messageId: string): void {
    this.turns.set(sessionKey, { turnId, sessionKey, messageId, startedAt: Date.now(), closed: false });
  }

  close(sessionKey: string, action: string): void {
    const turn = this.turns.get(sessionKey);
    if (turn && !turn.closed) {
      turn.closed = true;
      turn.closedAction = action as Turn['closedAction'];
    }
  }

  isOpen(sessionKey: string): boolean {
    const turn = this.turns.get(sessionKey);
    return turn !== undefined && !turn.closed;
  }

  getTurnId(sessionKey: string): string | undefined {
    return this.turns.get(sessionKey)?.turnId;
  }

  getByTurnId(turnId: string): Turn | undefined {
    for (const turn of this.turns.values()) {
      if (turn.turnId === turnId) return turn;
    }
    return undefined;
  }

  delete(sessionKey: string): void {
    this.turns.delete(sessionKey);
  }
}
