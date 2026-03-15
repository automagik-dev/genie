/**
 * Tests for Built-in Agents registry.
 *
 * Run with: bun test src/lib/builtin-agents.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  ALL_BUILTINS,
  BUILTIN_COUNCIL_MEMBERS,
  BUILTIN_ROLES,
  getBuiltin,
  listCouncilNames,
  listRoleNames,
} from './builtin-agents.js';

describe('BUILTIN_ROLES', () => {
  test('has 11 built-in roles', () => {
    expect(BUILTIN_ROLES.length).toBe(11);
  });

  test('all roles have required fields', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.name).toBeTruthy();
      expect(role.description).toBeTruthy();
      expect(role.systemPrompt).toBeTruthy();
      expect(role.category).toBe('role');
    }
  });

  test('role names are unique', () => {
    const names = BUILTIN_ROLES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('contains expected roles', () => {
    const names = listRoleNames();
    expect(names).toContain('implementor');
    expect(names).toContain('tester');
    expect(names).toContain('reviewer');
    expect(names).toContain('debugger');
    expect(names).toContain('verifier');
    expect(names).toContain('investigator');
    expect(names).toContain('reproducer');
    expect(names).toContain('dreamer');
    expect(names).toContain('critic');
    expect(names).toContain('security');
    expect(names).toContain('leader');
  });

  test('leader role has append promptMode', () => {
    const leader = getBuiltin('leader');
    expect(leader).not.toBeNull();
    expect(leader!.category).toBe('role');
    expect(leader!.promptMode).toBe('append');
  });
});

describe('BUILTIN_COUNCIL_MEMBERS', () => {
  test('has 10 council members', () => {
    expect(BUILTIN_COUNCIL_MEMBERS.length).toBe(10);
  });

  test('all council members have required fields', () => {
    for (const member of BUILTIN_COUNCIL_MEMBERS) {
      expect(member.name).toBeTruthy();
      expect(member.description).toBeTruthy();
      expect(member.systemPrompt).toBeTruthy();
      expect(member.model).toBeTruthy();
      expect(member.category).toBe('council');
    }
  });

  test('all council names start with council-', () => {
    for (const member of BUILTIN_COUNCIL_MEMBERS) {
      expect(member.name.startsWith('council-')).toBe(true);
    }
  });

  test('council member names are unique', () => {
    const names = BUILTIN_COUNCIL_MEMBERS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('contains expected members', () => {
    const names = listCouncilNames();
    expect(names).toContain('council-questioner');
    expect(names).toContain('council-benchmarker');
    expect(names).toContain('council-simplifier');
    expect(names).toContain('council-sentinel');
    expect(names).toContain('council-ergonomist');
    expect(names).toContain('council-architect');
    expect(names).toContain('council-operator');
    expect(names).toContain('council-deployer');
    expect(names).toContain('council-measurer');
    expect(names).toContain('council-tracer');
  });

  test('sentinel and architect use opus model', () => {
    const sentinel = getBuiltin('council-sentinel');
    const architect = getBuiltin('council-architect');
    expect(sentinel?.model).toBe('opus');
    expect(architect?.model).toBe('opus');
  });

  test('other council members use sonnet model', () => {
    const sonnetMembers = BUILTIN_COUNCIL_MEMBERS.filter(
      (m) => m.name !== 'council-sentinel' && m.name !== 'council-architect',
    );
    for (const member of sonnetMembers) {
      expect(member.model).toBe('sonnet');
    }
  });
});

describe('ALL_BUILTINS', () => {
  test('has 21 total built-in agents', () => {
    expect(ALL_BUILTINS.length).toBe(21);
  });

  test('names are globally unique across roles and council', () => {
    const names = ALL_BUILTINS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('getBuiltin', () => {
  test('finds a role by name', () => {
    const result = getBuiltin('implementor');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('implementor');
    expect(result!.category).toBe('role');
  });

  test('finds a council member by name', () => {
    const result = getBuiltin('council-architect');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('council-architect');
    expect(result!.category).toBe('council');
  });

  test('returns null for unknown name', () => {
    expect(getBuiltin('nonexistent')).toBeNull();
  });
});
