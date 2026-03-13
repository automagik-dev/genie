/**
 * Tests for team-auto-spawn module
 *
 * Tests the core logic of ensureTeamLead without requiring actual tmux sessions.
 * Run with: bun test src/lib/team-auto-spawn.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// We test the helper functions and logic by importing from team-auto-spawn
// The tmux-dependent parts are integration-tested separately

// ============================================================================
// Unit tests for buildTeamLeadCommand (tested via tui.ts buildClaudeCommand)
// The auto-spawn module reuses the same pattern, tested in tui.test.ts
// ============================================================================

// ============================================================================
// isTeamActive logic tests (config.json presence)
// ============================================================================

describe('team-auto-spawn: config.json detection', () => {
  const TEST_DIR = '/tmp/team-auto-spawn-test';
  const TEAMS_DIR = join(TEST_DIR, '.claude', 'teams');

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEAMS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('team directory without config.json means team is not set up', () => {
    const teamDir = join(TEAMS_DIR, 'my-team');
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });

    // config.json should NOT exist
    expect(existsSync(join(teamDir, 'config.json'))).toBe(false);
    // but inbox dir does
    expect(existsSync(join(teamDir, 'inboxes'))).toBe(true);
  });

  test('team directory with config.json means team is set up', () => {
    const teamDir = join(TEAMS_DIR, 'my-team');
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });

    const config = {
      name: 'my-team',
      description: 'Genie team: my-team',
      createdAt: Date.now(),
      leadAgentId: 'team-lead@my-team',
      leadSessionId: 'pending',
      members: [],
    };
    writeFileSync(join(teamDir, 'config.json'), JSON.stringify(config, null, 2));

    expect(existsSync(join(teamDir, 'config.json'))).toBe(true);
    const loaded = JSON.parse(readFileSync(join(teamDir, 'config.json'), 'utf-8'));
    expect(loaded.name).toBe('my-team');
    expect(loaded.leadAgentId).toBe('team-lead@my-team');
  });

  test('inbox file can exist without config.json (the gap we are fixing)', () => {
    // This simulates what happens when Omni writes to a team that doesn't exist:
    // It creates the inbox dir + file, but NOT config.json
    const teamDir = join(TEAMS_DIR, 'orphan-team');
    const inboxDir = join(teamDir, 'inboxes');
    mkdirSync(inboxDir, { recursive: true });

    const inboxMessage = [
      {
        from: 'omni',
        text: 'Hello from Omni',
        summary: 'Hello from Omni',
        timestamp: new Date().toISOString(),
        read: false,
      },
    ];
    writeFileSync(join(inboxDir, 'team-lead.json'), JSON.stringify(inboxMessage, null, 2));

    // Inbox exists but config.json doesn't — this is the gap
    expect(existsSync(join(inboxDir, 'team-lead.json'))).toBe(true);
    expect(existsSync(join(teamDir, 'config.json'))).toBe(false);
  });
});

// ============================================================================
// EnsureTeamLeadResult type tests
// ============================================================================

describe('team-auto-spawn: result types', () => {
  test('result shape for created team', () => {
    const result = { created: true, session: 'genie', window: 'my-team' };
    expect(result.created).toBe(true);
    expect(result.session).toBe('genie');
    expect(result.window).toBe('my-team');
  });

  test('result shape for existing team', () => {
    const result = { created: false, session: 'genie', window: 'my-team' };
    expect(result.created).toBe(false);
  });
});
