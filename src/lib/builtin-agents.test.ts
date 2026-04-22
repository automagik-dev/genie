/**
 * Tests for Built-in Agents registry.
 *
 * Agents are discovered from plugins/genie/agents/ folder structure.
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
  resolveBuiltinAgentPath,
} from './builtin-agents.js';

describe('BUILTIN_ROLES', () => {
  test('has 9 built-in roles', () => {
    expect(BUILTIN_ROLES.length).toBe(9);
  });

  test('all roles have required fields', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.name).toBeTruthy();
      expect(role.description).toBeTruthy();
      expect(role.agentPath).toBeTruthy();
      expect(role.category).toBe('role');
    }
  });

  test('role names are unique', () => {
    const names = BUILTIN_ROLES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('contains expected roles', () => {
    const names = listRoleNames();
    expect(names).toContain('engineer');
    expect(names).toContain('reviewer');
    expect(names).toContain('qa');
    expect(names).toContain('fix');
    expect(names).toContain('trace');
    expect(names).toContain('docs');
    expect(names).toContain('refactor');
    expect(names).toContain('team-lead');
    expect(names).toContain('pm');
  });

  test('team-lead role has system promptMode', () => {
    const teamLead = getBuiltin('team-lead');
    expect(teamLead).not.toBeNull();
    expect(teamLead!.category).toBe('role');
    expect(teamLead!.promptMode).toBe('system');
  });
});

describe('BUILTIN_COUNCIL_MEMBERS', () => {
  test('has 11 council members', () => {
    expect(BUILTIN_COUNCIL_MEMBERS.length).toBe(11);
  });

  test('all council members have required fields', () => {
    for (const member of BUILTIN_COUNCIL_MEMBERS) {
      expect(member.name).toBeTruthy();
      expect(member.description).toBeTruthy();
      expect(member.agentPath).toBeTruthy();
      expect(member.category).toBe('council');
    }
  });

  test('all council names start with council', () => {
    for (const member of BUILTIN_COUNCIL_MEMBERS) {
      expect(member.name.startsWith('council')).toBe(true);
    }
  });

  test('council member names are unique', () => {
    const names = BUILTIN_COUNCIL_MEMBERS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('contains expected members', () => {
    const names = listCouncilNames();
    expect(names).toContain('council');
    expect(names).toContain('council--questioner');
    expect(names).toContain('council--benchmarker');
    expect(names).toContain('council--simplifier');
    expect(names).toContain('council--sentinel');
    expect(names).toContain('council--ergonomist');
    expect(names).toContain('council--architect');
    expect(names).toContain('council--operator');
    expect(names).toContain('council--deployer');
    expect(names).toContain('council--measurer');
    expect(names).toContain('council--tracer');
  });

  test('council members have opus model', () => {
    for (const member of BUILTIN_COUNCIL_MEMBERS) {
      expect(member.model).toBe('opus');
    }
  });
});

describe('ALL_BUILTINS', () => {
  test('has 20 total built-in agents', () => {
    expect(ALL_BUILTINS.length).toBe(20);
  });

  test('names are globally unique across roles and council', () => {
    const names = ALL_BUILTINS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('getBuiltin', () => {
  test('finds a role by name', () => {
    const result = getBuiltin('engineer');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('engineer');
    expect(result!.category).toBe('role');
  });

  test('finds a council member by name', () => {
    const result = getBuiltin('council--architect');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('council--architect');
    expect(result!.category).toBe('council');
  });

  test('returns null for unknown name', () => {
    expect(getBuiltin('nonexistent')).toBeNull();
  });
});

describe('resolveBuiltinAgentPath', () => {
  test('returns AGENTS.md path for existing agent', () => {
    const path = resolveBuiltinAgentPath('engineer');
    expect(path).not.toBeNull();
    expect(path).toContain('plugins/genie/agents/engineer/AGENTS.md');
  });

  test('returns null for unknown agent', () => {
    expect(resolveBuiltinAgentPath('nonexistent')).toBeNull();
  });
});
