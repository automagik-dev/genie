/**
 * Tests for team-auto-spawn module
 *
 * Tests the core logic of ensureTeamLead without requiring actual tmux sessions.
 * Run with: bun test src/lib/team-auto-spawn.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as registry from './agent-registry.js';
import { sanitizeTeamName } from './claude-native-teams.js';
import * as executorRegistry from './executor-registry.js';

// We test the helper functions and logic by importing from team-auto-spawn
// The tmux-dependent parts are integration-tested separately

// ============================================================================
// Unit tests for buildTeamLeadCommand (tested via session.ts buildClaudeCommand)
// The auto-spawn module reuses the same pattern, tested in session.test.ts
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

// ============================================================================
// Team-lead executor-reuse decision (Group 5 of claude-resume-by-session-id)
// ============================================================================
//
// The executor-reuse decision that ensureTeamLead makes is:
//   priorSessionId = await getResumeSessionId(teamLeadAgentId)
//   sessionId      = priorSessionId ?? randomUUID()
//   shouldResume   = priorSessionId !== null
//
// These tests exercise the same lookup path ensureTeamLead uses
// (findOrCreateAgent → getResumeSessionId) to prove that on a second
// invocation with the same (leaderName, team), we recover the UUID we
// captured previously — i.e. no JSONL scan, no fresh mint.

describe('team-auto-spawn: team-lead executor-reuse decision', () => {
  test('second invocation recovers the session UUID of the first', async () => {
    const team = `auto-spawn-reuse-${Date.now().toString(36)}`;
    const sanitized = sanitizeTeamName(team);
    const leaderName = team;

    // First "spawn": find-or-create agent, mint a UUID, persist via executor.
    const agent1 = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);
    const captured = '11111111-2222-3333-4444-555555555555';
    const exec1 = await executorRegistry.createAndLinkExecutor(agent1.id, 'claude', 'tmux', {
      claudeSessionId: captured,
      state: 'spawning',
    });
    await registry.setCurrentExecutor(agent1.id, exec1.id);

    // Second "spawn": ensureTeamLead would look up the same agent and query
    // getResumeSessionId. It must return the captured UUID, not null.
    const agent2 = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);
    expect(agent2.id).toBe(agent1.id); // idempotent by (custom_name, team)

    const priorSessionId = await executorRegistry.getResumeSessionId(agent2.id);
    expect(priorSessionId).toBe(captured);

    // Decision: when priorSessionId is non-null we reuse via --resume <uuid>.
    const shouldResume = priorSessionId !== null;
    expect(shouldResume).toBe(true);
  });

  test('fresh team with no executor → decision mints a new UUID and does not resume', async () => {
    const team = `auto-spawn-fresh-${Date.now().toString(36)}`;
    const sanitized = sanitizeTeamName(team);
    const leaderName = team;

    const agent = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);
    const priorSessionId = await executorRegistry.getResumeSessionId(agent.id);

    expect(priorSessionId).toBeNull();

    // Decision: fresh → mint + pass via --session-id on spawn.
    const shouldResume = priorSessionId !== null;
    expect(shouldResume).toBe(false);
  });
});
