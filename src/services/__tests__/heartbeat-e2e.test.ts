/**
 * End-to-end integration test for the omni-activity-heartbeat wire contract.
 *
 * Wires the real `HeartbeatPublisher` (genie side) against a fake in-memory
 * NATS bus and a fake omni-side `TurnMonitor` so we can prove the two
 * acceptance criteria from the wish:
 *
 *   1. Busy session — 200s of simulated work with the publisher running emits
 *      ZERO `omni.turn.nudge.*` events, because each heartbeat resets
 *      `lastActivityAt` well below the 120s nudge threshold.
 *   2. Idle session — 200s with NO publisher emits exactly ONE nudge at
 *      120 ± 5s, proving the existing nudge path still fires when the
 *      heartbeat is absent (regression guard for Decision 6: missing
 *      heartbeats = current behavior).
 *
 * The test uses a virtual clock + injected `setInterval`/`clearInterval`, so
 * 200s of simulated time runs in well under 10s of wall-clock.
 *
 * Wish: omni-activity-heartbeat (group 3).
 */

import { describe, expect, it } from 'bun:test';
import { type AgentHeartbeatEvent, HeartbeatPublisher } from '../agent-heartbeat.js';

// ---------------------------------------------------------------------------
// Virtual clock — drives both setInterval and setTimeout deterministically.
// ---------------------------------------------------------------------------

interface ScheduledTask {
  id: number;
  type: 'interval' | 'timeout';
  fireAt: number;
  intervalMs: number;
  callback: () => void;
}

class VirtualClock {
  private tasks = new Map<number, ScheduledTask>();
  private nextId = 1;
  private nowMs = 0;

  now(): number {
    return this.nowMs;
  }

  setInterval = ((cb: () => void, intervalMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { id, type: 'interval', fireAt: this.nowMs + intervalMs, intervalMs, callback: cb });
    return id as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as unknown as typeof globalThis.setInterval;

  clearInterval = ((handle: number | undefined) => {
    if (handle === undefined) return;
    this.tasks.delete(handle);
  }) as unknown as typeof globalThis.clearInterval;

  /**
   * Advance the clock by `ms`. Fires every scheduled callback whose `fireAt`
   * falls within the new window, in fireAt order (with insertion-order tie
   * break — matches Map iteration). Re-schedules intervals so the next tick
   * is `intervalMs` after the firing time, mirroring the Node.js semantics
   * the publisher relies on. Awaits a microtask after each fire so async
   * callbacks (HeartbeatPublisher.tick) get to settle before we look for
   * the next due task.
   */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      const next = this.findNextTask(target);
      if (!next) break;
      this.nowMs = next.fireAt;
      if (next.type === 'interval') {
        next.fireAt = this.nowMs + next.intervalMs;
      } else {
        this.tasks.delete(next.id);
      }
      next.callback();
      // Drain microtasks so HeartbeatPublisher.tick (an async function
      // dispatched as `void this.tick(...)`) finishes its publish before we
      // look for the next due task.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.nowMs = target;
  }

  private findNextTask(maxFireAt: number): ScheduledTask | undefined {
    let best: ScheduledTask | undefined;
    for (const task of this.tasks.values()) {
      if (task.fireAt > maxFireAt) continue;
      if (!best || task.fireAt < best.fireAt) best = task;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// In-memory NATS bus — matches `*` (single segment) and `>` (trailing) like NATS.
// ---------------------------------------------------------------------------

type SubscriberFn = (subject: string, payload: string) => void;

class FakeBus {
  private subs: Array<{ pattern: string; fn: SubscriberFn }> = [];

  publish(subject: string, payload: string): void {
    for (const { pattern, fn } of this.subs) {
      if (matchSubject(pattern, subject)) fn(subject, payload);
    }
  }

  subscribe(pattern: string, fn: SubscriberFn): void {
    this.subs.push({ pattern, fn });
  }
}

function matchSubject(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return true;
    if (p[i] === '*') {
      if (s[i] === undefined) return false;
      continue;
    }
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

// ---------------------------------------------------------------------------
// Fake TurnService + TurnMonitor (omni side).
//
// Mirrors the omni invariant: `lastActivityAt` is the only field that gates
// the 120s nudge. Heartbeats reset it via `recordActivity(turnId)`. The
// monitor polls open turns and publishes `omni.turn.nudge.{instanceId}.{chatId}`
// once per turn when `now - lastActivityAt >= NUDGE_THRESHOLD_MS`.
// ---------------------------------------------------------------------------

const NUDGE_THRESHOLD_MS = 120_000;
const MONITOR_CHECK_INTERVAL_MS = 5_000;

interface OpenTurn {
  turnId: string;
  instanceId: string;
  chatId: string;
  lastActivityAt: number;
  nudged: boolean;
}

class FakeTurnService {
  private turns = new Map<string, OpenTurn>();
  constructor(private readonly nowFn: () => number) {}

  open(turnId: string, instanceId: string, chatId: string): void {
    this.turns.set(turnId, {
      turnId,
      instanceId,
      chatId,
      lastActivityAt: this.nowFn(),
      nudged: false,
    });
  }

  recordActivity(turnId: string): void {
    const t = this.turns.get(turnId);
    if (!t) return;
    t.lastActivityAt = this.nowFn();
  }

  list(): OpenTurn[] {
    return [...this.turns.values()];
  }
}

class FakeTurnMonitor {
  private handle: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(
    private readonly bus: FakeBus,
    private readonly turns: FakeTurnService,
    private readonly nowFn: () => number,
    private readonly setIntervalFn: typeof globalThis.setInterval,
    private readonly clearIntervalFn: typeof globalThis.clearInterval,
  ) {}

  start(): void {
    this.handle = this.setIntervalFn(() => this.tick(), MONITOR_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.handle) this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  private tick(): void {
    const now = this.nowFn();
    for (const t of this.turns.list()) {
      if (t.nudged) continue;
      if (now - t.lastActivityAt >= NUDGE_THRESHOLD_MS) {
        t.nudged = true;
        this.bus.publish(
          `omni.turn.nudge.${t.instanceId}.${t.chatId}`,
          JSON.stringify({ turnId: t.turnId, message: 'Turn idle for 120s. Are you still working?' }),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Wire-up — composes the real publisher and the fake omni consumer over the bus.
// ---------------------------------------------------------------------------

interface E2ESystem {
  bus: FakeBus;
  clock: VirtualClock;
  publisher: HeartbeatPublisher;
  turns: FakeTurnService;
  monitor: FakeTurnMonitor;
  nudges: Array<{ subject: string; t: number; turnId: string }>;
  heartbeats: Array<{ subject: string; t: number; turnId: string }>;
}

function buildSystem(): E2ESystem {
  const clock = new VirtualClock();
  const bus = new FakeBus();
  const turns = new FakeTurnService(() => clock.now());

  const heartbeats: E2ESystem['heartbeats'] = [];
  const nudges: E2ESystem['nudges'] = [];

  // Omni-side heartbeat consumer: reset lastActivityAt for the carried turnId.
  bus.subscribe('omni.agent.heartbeat.>', (subject, payload) => {
    const event = JSON.parse(payload) as AgentHeartbeatEvent;
    heartbeats.push({ subject, t: clock.now(), turnId: event.turnId });
    turns.recordActivity(event.turnId);
  });

  // Test-side capture for the assertion target.
  bus.subscribe('omni.turn.nudge.>', (subject, payload) => {
    const event = JSON.parse(payload) as { turnId: string };
    nudges.push({ subject, t: clock.now(), turnId: event.turnId });
  });

  const publisher = new HeartbeatPublisher({
    intervalMs: 30_000,
    publish: (subject, payload) => bus.publish(subject, payload),
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    now: () => clock.now(),
  });

  const monitor = new FakeTurnMonitor(bus, turns, () => clock.now(), clock.setInterval, clock.clearInterval);
  monitor.start();

  return { bus, clock, publisher, turns, monitor, nudges, heartbeats };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('heartbeat e2e — wire contract (omni-activity-heartbeat)', () => {
  it('busy session: 200s with heartbeats → ZERO turn.nudge events', async () => {
    const sys = buildSystem();
    sys.turns.open('turn-busy', 'inst-1', 'chat-1');

    sys.publisher.start('agent:chat-1', {
      instanceId: 'inst-1',
      chatId: 'chat-1',
      turnId: 'turn-busy',
      isBusy: () => true,
    });

    await sys.clock.advance(200_000);

    // Primary assertion: zero nudges over the 200s window.
    expect(sys.nudges).toHaveLength(0);

    // Sanity: at 30s cadence over 200s the publisher fires at
    // t=30, 60, 90, 120, 150, 180 — six heartbeats. The t=210 tick is
    // outside the window and must not appear.
    expect(sys.heartbeats).toHaveLength(6);
    const fireTimes = sys.heartbeats.map((h) => h.t);
    expect(fireTimes).toEqual([30_000, 60_000, 90_000, 120_000, 150_000, 180_000]);
    for (const h of sys.heartbeats) {
      expect(h.subject).toBe('omni.agent.heartbeat.inst-1.chat-1');
      expect(h.turnId).toBe('turn-busy');
    }

    sys.publisher.stopAll();
    sys.monitor.stop();
  });

  it('idle session: 200s without heartbeats → exactly ONE nudge at 120 ± 5s', async () => {
    const sys = buildSystem();
    sys.turns.open('turn-idle', 'inst-1', 'chat-2');
    // Note: publisher.start is intentionally NOT called. Simulates a
    // pre-heartbeat-aware client (Decision 6) or an executor that crashed
    // mid-turn. The omni nudge path must still fire.

    await sys.clock.advance(200_000);

    expect(sys.heartbeats).toHaveLength(0);
    expect(sys.nudges).toHaveLength(1);
    const [only] = sys.nudges;
    expect(only?.subject).toBe('omni.turn.nudge.inst-1.chat-2');
    expect(only?.turnId).toBe('turn-idle');
    expect(only?.t).toBeGreaterThanOrEqual(115_000);
    expect(only?.t).toBeLessThanOrEqual(125_000);

    sys.monitor.stop();
  });

  it('busy then settled: heartbeats stop on publisher.stop(), nudge fires ~120s after the last heartbeat', async () => {
    // This is not in the wish acceptance criteria but proves the bridge's
    // start/stop wiring keeps the regression path alive: once the publisher
    // is stopped (turn.done / turn.timeout / session.reset), the existing
    // omni nudge timer takes over from the time of the final heartbeat.
    const sys = buildSystem();
    sys.turns.open('turn-mixed', 'inst-1', 'chat-3');

    sys.publisher.start('agent:chat-3', {
      instanceId: 'inst-1',
      chatId: 'chat-3',
      turnId: 'turn-mixed',
      isBusy: () => true,
    });

    // 60s of busy work — the publisher fires at t=30 and t=60.
    await sys.clock.advance(60_000);
    expect(sys.nudges).toHaveLength(0);
    const heartbeatsBefore = sys.heartbeats.length;
    expect(heartbeatsBefore).toBeGreaterThanOrEqual(1);
    const lastHeartbeatT = sys.heartbeats[heartbeatsBefore - 1]?.t ?? 0;

    // Executor settles — exactly the call the bridge makes on `turn.done`.
    sys.publisher.stop('agent:chat-3');

    await sys.clock.advance(150_000);

    // No new heartbeats after stop().
    expect(sys.heartbeats).toHaveLength(heartbeatsBefore);
    // Exactly one nudge ~120s after the last heartbeat.
    expect(sys.nudges).toHaveLength(1);
    expect(sys.nudges[0]?.t).toBeGreaterThanOrEqual(lastHeartbeatT + 115_000);
    expect(sys.nudges[0]?.t).toBeLessThanOrEqual(lastHeartbeatT + 125_000);

    sys.monitor.stop();
  });
});
