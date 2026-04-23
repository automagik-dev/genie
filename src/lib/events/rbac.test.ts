/**
 * Unit tests for the RBAC matrix. No PG connection required.
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { describe, expect, test } from 'bun:test';
import {
  ALL_ROLES,
  RBACError,
  allowedChannels,
  assertChannelAllowed,
  canAccessTable,
  describeMatrix,
  resolveChannels,
  tablePrivileges,
  typeReachable,
  typesForChannel,
} from './rbac.js';

describe('canAccessTable', () => {
  test('admin has full privileges on runtime + debug, SELECT-only on audit', () => {
    expect(canAccessTable('events:admin', 'genie_runtime_events', 'DELETE')).toBe(true);
    expect(canAccessTable('events:admin', 'genie_runtime_events_debug', 'UPDATE')).toBe(true);
    expect(canAccessTable('events:admin', 'genie_runtime_events_audit', 'SELECT')).toBe(true);
    expect(canAccessTable('events:admin', 'genie_runtime_events_audit', 'INSERT')).toBe(false);
    expect(canAccessTable('events:admin', 'genie_runtime_events_audit', 'UPDATE')).toBe(false);
  });

  test('operator can SELECT+INSERT on runtime/debug, nothing on audit', () => {
    expect(canAccessTable('events:operator', 'genie_runtime_events', 'SELECT')).toBe(true);
    expect(canAccessTable('events:operator', 'genie_runtime_events', 'INSERT')).toBe(true);
    expect(canAccessTable('events:operator', 'genie_runtime_events', 'DELETE')).toBe(false);
    expect(canAccessTable('events:operator', 'genie_runtime_events_audit', 'SELECT')).toBe(false);
  });

  test('subscriber only SELECTs runtime main table', () => {
    expect(canAccessTable('events:subscriber', 'genie_runtime_events', 'SELECT')).toBe(true);
    expect(canAccessTable('events:subscriber', 'genie_runtime_events', 'INSERT')).toBe(false);
    expect(canAccessTable('events:subscriber', 'genie_runtime_events_debug', 'SELECT')).toBe(false);
    expect(canAccessTable('events:subscriber', 'genie_runtime_events_audit', 'SELECT')).toBe(false);
  });

  test('audit role only touches WORM table', () => {
    expect(canAccessTable('events:audit', 'genie_runtime_events_audit', 'SELECT')).toBe(true);
    expect(canAccessTable('events:audit', 'genie_runtime_events_audit', 'INSERT')).toBe(true);
    expect(canAccessTable('events:audit', 'genie_runtime_events_audit', 'UPDATE')).toBe(false);
    expect(canAccessTable('events:audit', 'genie_runtime_events', 'SELECT')).toBe(false);
    expect(canAccessTable('events:audit', 'genie_runtime_events_debug', 'SELECT')).toBe(false);
  });
});

describe('allowedChannels', () => {
  test('every role has at least one channel', () => {
    for (const r of ALL_ROLES) {
      expect(allowedChannels(r).length).toBeGreaterThan(0);
    }
  });

  test('subscriber channel set is disjoint from audit-specific channels', () => {
    const subs = allowedChannels('events:subscriber');
    expect(subs).not.toContain('genie_events.audit');
    expect(subs).not.toContain('genie_events.emitter');
    expect(subs).not.toContain('genie_events.notify');
  });

  test('audit role has the audit channel', () => {
    expect(allowedChannels('events:audit')).toContain('genie_events.audit');
  });
});

describe('resolveChannels', () => {
  test('empty request returns role defaults', () => {
    const defaults = allowedChannels('events:operator');
    expect([...resolveChannels('events:operator', [])]).toEqual([...defaults]);
  });

  test('subset request returns the subset', () => {
    const subset = ['genie_events.cli', 'genie_events.agent'];
    expect([...resolveChannels('events:operator', subset)]).toEqual(subset);
  });

  test('request for out-of-role channel throws RBACError', () => {
    expect(() => resolveChannels('events:subscriber', ['genie_events.audit'])).toThrow(RBACError);
  });
});

describe('assertChannelAllowed', () => {
  test('passes for allowed channel', () => {
    expect(() => assertChannelAllowed('events:admin', 'genie_events.audit')).not.toThrow();
  });

  test('throws RBACError for disallowed channel', () => {
    expect(() => assertChannelAllowed('events:subscriber', 'genie_events.audit')).toThrow(RBACError);
  });
});

describe('typesForChannel', () => {
  test('maps genie_events.audit to audit.* registered types', () => {
    const types = typesForChannel('genie_events.audit');
    expect(types).toContain('audit.un_hash');
    expect(types).toContain('audit.export');
  });

  test('unknown prefix returns empty array', () => {
    const types = typesForChannel('genie_events.bogus');
    expect(types.length).toBe(0);
  });
});

describe('typeReachable', () => {
  test('subscriber cannot reach audit.un_hash', () => {
    expect(typeReachable('events:subscriber', 'audit.un_hash', ['genie_events.mailbox'])).toBe(false);
  });

  test('audit role can reach audit.un_hash via audit channel', () => {
    expect(typeReachable('events:audit', 'audit.un_hash', ['genie_events.audit'])).toBe(true);
  });
});

describe('describeMatrix', () => {
  test('enumerates every role + tables + channels', () => {
    const snapshot = describeMatrix();
    expect(snapshot.roles).toEqual(ALL_ROLES);
    for (const r of ALL_ROLES) {
      expect(snapshot.tables[r]).toBeDefined();
      expect(snapshot.channels[r]).toBeDefined();
    }
  });
});

describe('tablePrivileges', () => {
  test('exposes full per-table privilege map', () => {
    const priv = tablePrivileges('events:admin');
    expect(priv.genie_runtime_events).toContain('DELETE');
    expect(priv.genie_runtime_events_audit).not.toContain('INSERT');
  });
});
