/**
 * Tests for team shortcut routing: genie [team] -> genie _open [team]
 *
 * Run with: bun test src/lib/team-shortcut.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { resolveTeamShortcut } from './team-shortcut.js';

const KNOWN_COMMANDS = new Set([
  'install',
  'setup',
  'doctor',
  'update',
  'uninstall',
  '_open',
  'shortcuts',
  'profiles',
  'brainstorm',
  'ledger',
  'team',
  'agent',
  'send',
  'inbox',
  'task',
  'hook',
  'work',
  'daemon',
  'council',
  'help',
]);

describe('resolveTeamShortcut', () => {
  // =========================================================================
  // Catch-all: unknown arg -> _open <team>
  // =========================================================================

  test('unknown first arg routes to _open', () => {
    const result = resolveTeamShortcut(['myteam'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'myteam']);
    expect(result.isShortcut).toBe(true);
    expect(result.collisionWarning).toBeNull();
  });

  test('"main" is treated as team name, not command', () => {
    const result = resolveTeamShortcut(['main'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'main']);
    expect(result.isShortcut).toBe(true);
  });

  test('unknown first arg with extra flags', () => {
    const result = resolveTeamShortcut(['myteam', '--reset'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'myteam', '--reset']);
    expect(result.isShortcut).toBe(true);
  });

  test('unknown first arg with dir option', () => {
    const result = resolveTeamShortcut(['myteam', '-d', '/tmp/workspace'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'myteam', '-d', '/tmp/workspace']);
    expect(result.isShortcut).toBe(true);
  });

  // =========================================================================
  // No args -> open session (window name derived from cwd at runtime)
  // =========================================================================

  test('no args opens session without team arg', () => {
    const result = resolveTeamShortcut([], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open']);
    expect(result.isShortcut).toBe(true);
  });

  // =========================================================================
  // Known subcommands have priority
  // =========================================================================

  test('known subcommand "agent" is not rewritten', () => {
    const result = resolveTeamShortcut(['agent', 'spawn'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['agent', 'spawn']);
    expect(result.isShortcut).toBe(false);
  });

  test('known subcommand "work" is not rewritten', () => {
    const result = resolveTeamShortcut(['work', 'next'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['work', 'next']);
    expect(result.isShortcut).toBe(false);
  });

  test('known subcommand "team" is not rewritten', () => {
    const result = resolveTeamShortcut(['team', 'list'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['team', 'list']);
    expect(result.isShortcut).toBe(false);
  });

  // =========================================================================
  // --team flag (disambiguation)
  // =========================================================================

  test('--team flag routes to _open', () => {
    const result = resolveTeamShortcut(['--team', 'myteam'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'myteam']);
    expect(result.isShortcut).toBe(true);
  });

  test('--team flag overrides subcommand collision', () => {
    const result = resolveTeamShortcut(['--team', 'agent'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'agent']);
    expect(result.isShortcut).toBe(true);
    expect(result.collisionWarning).toBeNull();
  });

  test('--team=name syntax routes to _open', () => {
    const result = resolveTeamShortcut(['--team=agent'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'agent']);
    expect(result.isShortcut).toBe(true);
  });

  test('--team flag preserves remaining args', () => {
    const result = resolveTeamShortcut(['--team', 'myteam', '--reset', '-d', '/tmp'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['_open', 'myteam', '--reset', '-d', '/tmp']);
    expect(result.isShortcut).toBe(true);
  });

  // =========================================================================
  // Collision warnings
  // =========================================================================

  test('warns when known command collides with existing team', () => {
    const teamExists = (name: string) => name === 'agent';
    const result = resolveTeamShortcut(['agent', 'spawn'], KNOWN_COMMANDS, teamExists);
    expect(result.args).toEqual(['agent', 'spawn']);
    expect(result.isShortcut).toBe(false);
    expect(result.collisionWarning).toContain('is a subcommand');
    expect(result.collisionWarning).toContain('genie --team agent');
  });

  test('no warning when known command has no team collision', () => {
    const teamExists = () => false;
    const result = resolveTeamShortcut(['agent', 'spawn'], KNOWN_COMMANDS, teamExists);
    expect(result.collisionWarning).toBeNull();
  });

  test('no collision check for unknown commands (they route to _open)', () => {
    const teamExists = () => true;
    const result = resolveTeamShortcut(['myteam'], KNOWN_COMMANDS, teamExists);
    expect(result.isShortcut).toBe(true);
    expect(result.collisionWarning).toBeNull();
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  test('--help flag is not treated as team name', () => {
    const result = resolveTeamShortcut(['--help'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['--help']);
    expect(result.isShortcut).toBe(false);
  });

  test('-h flag is not treated as team name', () => {
    const result = resolveTeamShortcut(['-h'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['-h']);
    expect(result.isShortcut).toBe(false);
  });

  test('-V flag is not treated as team name', () => {
    const result = resolveTeamShortcut(['-V'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['-V']);
    expect(result.isShortcut).toBe(false);
  });

  test('--team with no value -> no rewrite', () => {
    const result = resolveTeamShortcut(['--team'], KNOWN_COMMANDS);
    expect(result.args).toEqual(['--team']);
    expect(result.isShortcut).toBe(false);
  });

  test('--team= with empty value -> no rewrite', () => {
    const result = resolveTeamShortcut(['--team='], KNOWN_COMMANDS);
    expect(result.args).toEqual(['--team=']);
    expect(result.isShortcut).toBe(false);
  });
});
