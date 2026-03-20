import { afterEach, describe, expect, mock, test } from 'bun:test';
import { _resetForTesting, close, isAvailable, publish, subscribe } from './nats-client.js';

// ============================================================================
// Tests
// ============================================================================

afterEach(async () => {
  _resetForTesting();
});

describe('nats-client', () => {
  describe('graceful degradation', () => {
    test('publish no-ops when nats package is missing', async () => {
      // Default behavior — dynamic import will fail since nats isn't installed
      // This should not throw
      await publish('test.subject', { hello: 'world' });
    });

    test('subscribe returns noop handle when nats is missing', async () => {
      const cb = mock(() => {});
      const sub = await subscribe('test.subject', cb);
      expect(sub).toBeDefined();
      expect(sub.unsubscribe).toBeFunction();
      // Should not throw
      sub.unsubscribe();
      expect(cb).not.toHaveBeenCalled();
    });

    test('isAvailable returns false when nats is missing', async () => {
      const available = await isAvailable();
      expect(available).toBe(false);
    });

    test('close is safe to call without connection', async () => {
      await close();
      // Should not throw
    });

    test('close is safe to call multiple times', async () => {
      await close();
      _resetForTesting();
      await close();
      await close();
    });
  });

  describe('GENIE_NATS_URL', () => {
    test('uses env var when set', async () => {
      const original = process.env.GENIE_NATS_URL;
      try {
        process.env.GENIE_NATS_URL = 'nats://custom:9999';
        // Trigger connection attempt — will fail since no server, but exercises the code path
        await isAvailable();
      } finally {
        if (original !== undefined) {
          process.env.GENIE_NATS_URL = original;
        } else {
          process.env.GENIE_NATS_URL = undefined;
        }
      }
    });
  });

  describe('_resetForTesting', () => {
    test('resets state so new connections can be attempted', async () => {
      // First attempt — will fail (no nats package)
      const first = await isAvailable();
      expect(first).toBe(false);

      // Reset
      _resetForTesting();

      // Second attempt — can try again
      const second = await isAvailable();
      expect(second).toBe(false);
    });
  });
});
