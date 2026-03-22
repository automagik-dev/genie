import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { _resetForTesting, close, isAvailable, publish, subscribe } from './nats-client.js';

// Force tests to use a dead NATS server to test graceful degradation
const DEAD_NATS = 'nats://127.0.0.1:19999';

beforeEach(() => {
  _resetForTesting();
  process.env.GENIE_NATS_URL = DEAD_NATS;
});

afterEach(async () => {
  await close();
  _resetForTesting();
  process.env.GENIE_NATS_URL = undefined;
});

describe('nats-client', () => {
  describe('graceful degradation', () => {
    test('publish no-ops when nats is unreachable', async () => {
      await publish('test.subject', { hello: 'world' });
    });

    test('subscribe returns noop handle when nats is unreachable', async () => {
      const cb = mock(() => {});
      const sub = await subscribe('test.subject', cb);
      expect(sub).toBeDefined();
      expect(sub.unsubscribe).toBeFunction();
      sub.unsubscribe();
      expect(cb).not.toHaveBeenCalled();
    });

    test('isAvailable returns false when nats is unreachable', async () => {
      const available = await isAvailable();
      expect(available).toBe(false);
    });

    test('close is safe to call without connection', async () => {
      await close();
    });

    test('close is safe to call multiple times', async () => {
      await close();
      _resetForTesting();
      process.env.GENIE_NATS_URL = DEAD_NATS;
      await close();
      await close();
    });
  });

  describe('GENIE_NATS_URL', () => {
    test('uses env var when set', async () => {
      process.env.GENIE_NATS_URL = 'nats://custom:9999';
      const available = await isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('_resetForTesting', () => {
    test('resets state so new connections can be attempted', async () => {
      const first = await isAvailable();
      expect(first).toBe(false);

      _resetForTesting();
      process.env.GENIE_NATS_URL = DEAD_NATS;

      const second = await isAvailable();
      expect(second).toBe(false);
    });
  });
});
