import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  getRegisteredServices,
  killAllServices,
  reapDeadServices,
  registerService,
  unregisterService,
} from './service-registry.js';

describe('service-registry', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('registerService adds entry', () => {
    registerService('pgserve', 12345);
    const services = getRegisteredServices();
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('pgserve');
    expect(services[0].pid).toBe(12345);
    expect(services[0].startedAt).toBeInstanceOf(Date);
  });

  test('registerService replaces existing entry with same name', () => {
    registerService('pgserve', 12345);
    registerService('pgserve', 67890);
    const services = getRegisteredServices();
    expect(services).toHaveLength(1);
    expect(services[0].pid).toBe(67890);
  });

  test('unregisterService removes entry', () => {
    registerService('pgserve', 12345);
    registerService('scheduler', 67890);
    unregisterService('pgserve');
    const services = getRegisteredServices();
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('scheduler');
  });

  test('unregisterService is safe for non-existent name', () => {
    unregisterService('nonexistent');
    expect(getRegisteredServices()).toHaveLength(0);
  });

  test('getRegisteredServices returns all entries', () => {
    registerService('pgserve', 1);
    registerService('scheduler', 2);
    registerService('inbox-watcher', 3);
    expect(getRegisteredServices()).toHaveLength(3);
  });

  test('reapDeadServices removes entries with dead PIDs', () => {
    // Register a PID that definitely does not exist
    registerService('dead-service', 99999999);
    // Register our own PID (alive)
    registerService('alive-service', process.pid);

    const reaped = reapDeadServices();
    expect(reaped).toContain('dead-service');
    expect(reaped).not.toContain('alive-service');

    const remaining = getRegisteredServices();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('alive-service');
  });

  test('clearRegistry removes all entries without killing', () => {
    registerService('a', 1);
    registerService('b', 2);
    clearRegistry();
    expect(getRegisteredServices()).toHaveLength(0);
  });

  test('killAllServices handles empty registry', () => {
    // Should not throw
    killAllServices();
    expect(getRegisteredServices()).toHaveLength(0);
  });

  test('killAllServices cleans up dead PIDs', () => {
    // Register PIDs that don't exist — killAllServices should handle gracefully
    registerService('dead1', 99999998);
    registerService('dead2', 99999997);
    killAllServices();
    expect(getRegisteredServices()).toHaveLength(0);
  });
});
