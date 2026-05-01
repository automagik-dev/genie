/**
 * HeartbeatPublisher unit tests.
 *
 * Strategy: inject a fake `setInterval` so tests can drive ticks
 * deterministically without sleeping. Inject a fake `publish` callback to
 * capture (subject, payload) pairs without touching NATS.
 *
 * Coverage targets (Group 2 acceptance criteria):
 *   - start() registers a session and ticks emit a heartbeat at the configured cadence
 *   - stop() cancels the interval; no further publishes
 *   - busy=false skips a publish (no NATS message that tick)
 *   - multiple concurrent sessions each get independent intervals
 *   - stopAll() drains every active publisher
 *   - intervalMs is clamped to [5000, 60000]
 *   - subject is `omni.agent.heartbeat.{instanceId}.{chatId}`
 *   - payload includes turnId, instanceId, chatId, timestamp
 *   - isBusy that throws is treated as idle (skip), no crash
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type AgentHeartbeatEvent, HeartbeatPublisher, resolveHeartbeatIntervalMs } from '../agent-heartbeat.js';

interface FakeIntervalHandle {
  id: number;
  callback: () => void;
  intervalMs: number;
}

/**
 * In-memory drop-in for `setInterval` / `clearInterval`. Exposes `tick()` so
 * tests can advance one round per session deterministically.
 */
function makeFakeTimer() {
  const handles = new Map<number, FakeIntervalHandle>();
  let nextId = 1;
  const setIntervalFn = ((cb: () => void, intervalMs: number) => {
    const id = nextId++;
    const handle = { id, callback: cb, intervalMs };
    handles.set(id, handle);
    return handle as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as unknown as typeof globalThis.setInterval;
  const clearIntervalFn = ((handle: { id: number } | undefined) => {
    if (!handle) return;
    handles.delete(handle.id);
  }) as unknown as typeof globalThis.clearInterval;
  return {
    setIntervalFn,
    clearIntervalFn,
    handles,
    /** Fire every active interval once (one global tick). */
    fireAll() {
      for (const h of [...handles.values()]) h.callback();
    },
  };
}

interface PublishedEvent {
  subject: string;
  event: AgentHeartbeatEvent;
}

function makePublishSpy() {
  const calls: PublishedEvent[] = [];
  const publish = (subject: string, payload: string) => {
    calls.push({ subject, event: JSON.parse(payload) as AgentHeartbeatEvent });
  };
  return { publish, calls };
}

describe('HeartbeatPublisher — interval lifecycle', () => {
  let origInterval: string | undefined;
  beforeEach(() => {
    origInterval = process.env.OMNI_HEARTBEAT_INTERVAL_MS;
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = undefined;
  });
  afterEach(() => {
    if (origInterval === undefined) {
      process.env.OMNI_HEARTBEAT_INTERVAL_MS = undefined;
    } else {
      process.env.OMNI_HEARTBEAT_INTERVAL_MS = origInterval;
    }
  });

  it('start() schedules a tick at the configured cadence and tick publishes a heartbeat', async () => {
    const { setIntervalFn, clearIntervalFn, handles, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });

    publisher.start('agent:chat-1', {
      instanceId: 'inst-1',
      chatId: 'chat-1',
      turnId: 'turn-abc',
      isBusy: () => true,
    });
    expect(handles.size).toBe(1);
    expect([...handles.values()][0]?.intervalMs).toBe(30_000);

    fireAll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('omni.agent.heartbeat.inst-1.chat-1');
    expect(calls[0]?.event).toEqual({
      turnId: 'turn-abc',
      instanceId: 'inst-1',
      chatId: 'chat-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('stop() cancels the interval; no further publishes after stop', async () => {
    const { setIntervalFn, clearIntervalFn, handles, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('agent:chat-1', {
      instanceId: 'inst-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      isBusy: () => true,
    });
    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);

    publisher.stop('agent:chat-1');
    expect(handles.size).toBe(0);

    fireAll(); // fires zero intervals
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1); // unchanged
  });

  it('busy=false skips the publish for that tick (no NATS message)', async () => {
    const { setIntervalFn, clearIntervalFn, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    let busy = false;
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('agent:chat-1', {
      instanceId: 'inst-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      isBusy: () => busy,
    });

    // First tick: idle → no publish.
    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(0);

    // Flip busy → publish on next tick.
    busy = true;
    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);

    // Flip idle again → no publish.
    busy = false;
    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
  });

  it('multiple concurrent sessions each get independent intervals', async () => {
    const { setIntervalFn, clearIntervalFn, handles, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('agent:chat-A', {
      instanceId: 'inst-1',
      chatId: 'chat-A',
      turnId: 'turn-A',
      isBusy: () => true,
    });
    publisher.start('agent:chat-B', {
      instanceId: 'inst-1',
      chatId: 'chat-B',
      turnId: 'turn-B',
      isBusy: () => true,
    });
    expect(handles.size).toBe(2);
    expect(publisher.size()).toBe(2);

    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(2);

    const subjects = calls.map((c) => c.subject).sort();
    expect(subjects).toEqual(['omni.agent.heartbeat.inst-1.chat-A', 'omni.agent.heartbeat.inst-1.chat-B']);

    // Stopping one leaves the other alone.
    publisher.stop('agent:chat-A');
    expect(handles.size).toBe(1);
    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(3);
    expect(calls[2]?.subject).toBe('omni.agent.heartbeat.inst-1.chat-B');
  });

  it('stopAll() drains every active publisher (used on bridge shutdown)', async () => {
    const { setIntervalFn, clearIntervalFn, handles, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('a:x', { instanceId: 'i', chatId: 'x', turnId: 't1', isBusy: () => true });
    publisher.start('a:y', { instanceId: 'i', chatId: 'y', turnId: 't2', isBusy: () => true });
    publisher.start('a:z', { instanceId: 'i', chatId: 'z', turnId: 't3', isBusy: () => true });
    expect(handles.size).toBe(3);

    publisher.stopAll();
    expect(handles.size).toBe(0);
    expect(publisher.size()).toBe(0);

    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(0);
  });

  it('start() replaces an existing registration without leaking the old interval', () => {
    const { setIntervalFn, clearIntervalFn, handles } = makeFakeTimer();
    const { publish } = makePublishSpy();
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('a:x', { instanceId: 'i', chatId: 'x', turnId: 't1', isBusy: () => true });
    publisher.start('a:x', { instanceId: 'i', chatId: 'x', turnId: 't2', isBusy: () => true });
    expect(handles.size).toBe(1); // old handle was cleared
  });

  it('isBusy() that throws is treated as idle — no publish, no crash', async () => {
    const { setIntervalFn, clearIntervalFn, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('a:x', {
      instanceId: 'i',
      chatId: 'x',
      turnId: 't1',
      isBusy: () => {
        throw new Error('boom');
      },
    });

    fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(0);
    expect(publisher.size()).toBe(1); // session stays registered
  });

  it('async isBusy is awaited; resolved-true publishes, resolved-false skips', async () => {
    const { setIntervalFn, clearIntervalFn, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    let busy = true;
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('a:x', {
      instanceId: 'i',
      chatId: 'x',
      turnId: 't1',
      isBusy: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return busy;
      },
    });

    fireAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);

    busy = false;
    fireAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);
  });

  it('stop() awaited mid-isBusy suppresses the publish for that tick (no late publish)', async () => {
    const { setIntervalFn, clearIntervalFn, fireAll } = makeFakeTimer();
    const { publish, calls } = makePublishSpy();
    let releaseBusy: (value: boolean) => void = () => {};
    const busyPromise = new Promise<boolean>((resolve) => {
      releaseBusy = resolve;
    });
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    publisher.start('a:x', {
      instanceId: 'i',
      chatId: 'x',
      turnId: 't1',
      isBusy: () => busyPromise,
    });

    fireAll(); // tick begins, awaiting busyPromise
    publisher.stop('a:x'); // session removed mid-await
    releaseBusy(true); // resolves "busy", but session is gone
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(0);
  });
});

describe('HeartbeatPublisher — interval resolution', () => {
  let orig: string | undefined;
  beforeEach(() => {
    orig = process.env.OMNI_HEARTBEAT_INTERVAL_MS;
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = undefined;
  });
  afterEach(() => {
    if (orig === undefined) process.env.OMNI_HEARTBEAT_INTERVAL_MS = undefined;
    else process.env.OMNI_HEARTBEAT_INTERVAL_MS = orig;
  });

  it('defaults to 30_000ms when no env or option', () => {
    expect(resolveHeartbeatIntervalMs()).toBe(30_000);
  });

  it('reads OMNI_HEARTBEAT_INTERVAL_MS from env', () => {
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = '15000';
    expect(resolveHeartbeatIntervalMs()).toBe(15_000);
  });

  it('clamps to [5000, 60000]', () => {
    expect(resolveHeartbeatIntervalMs(1000)).toBe(5_000);
    expect(resolveHeartbeatIntervalMs(120_000)).toBe(60_000);
  });

  it('NaN/zero/negative env values fall through to default', () => {
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = 'not-a-number';
    expect(resolveHeartbeatIntervalMs()).toBe(30_000);
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = '0';
    expect(resolveHeartbeatIntervalMs()).toBe(30_000);
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = '-100';
    expect(resolveHeartbeatIntervalMs()).toBe(30_000);
  });

  it('explicit option overrides env', () => {
    process.env.OMNI_HEARTBEAT_INTERVAL_MS = '15000';
    expect(resolveHeartbeatIntervalMs(45_000)).toBe(45_000);
  });
});

describe('HeartbeatPublisher — payload shape', () => {
  it('publishes valid JSON with the agreed schema (turnId, instanceId, chatId, timestamp)', async () => {
    const { setIntervalFn, clearIntervalFn, fireAll } = makeFakeTimer();
    const calls: { subject: string; payload: string }[] = [];
    const publisher = new HeartbeatPublisher({
      intervalMs: 30_000,
      publish: (subject, payload) => calls.push({ subject, payload }),
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
      now: () => Date.parse('2026-04-30T12:00:00.000Z'),
    });

    publisher.start('agent:chat-1', {
      instanceId: 'inst-1',
      chatId: '5511999999999@s.whatsapp.net',
      turnId: 'turn-abc',
      isBusy: () => true,
    });

    fireAll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('omni.agent.heartbeat.inst-1.5511999999999@s.whatsapp.net');
    const parsed = JSON.parse(calls[0]?.payload ?? '{}') as AgentHeartbeatEvent;
    expect(parsed.turnId).toBe('turn-abc');
    expect(parsed.instanceId).toBe('inst-1');
    expect(parsed.chatId).toBe('5511999999999@s.whatsapp.net');
    expect(parsed.timestamp).toBe('2026-04-30T12:00:00.000Z');
  });
});
