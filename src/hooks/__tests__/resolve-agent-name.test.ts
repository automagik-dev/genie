/**
 * Regression tests for the hook span agent-context resolver — Group 3 of
 * wish observability-signal-normalization.
 *
 * Cascade order under test (first non-empty wins):
 *   payload.teammate_name → GENIE_AGENT_NAME → settings.local.json →
 *   cwd basename → session_id prefix → 'harness' (NEVER 'unknown').
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_AGENT, isHarnessAgent, resolveAgentName, resolveTeamName } from '../resolve-agent-name.js';
import type { HookPayload } from '../types.js';

function basePayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: 'PreToolUse',
    ...overrides,
  };
}

describe('resolveAgentName cascade', () => {
  const originalAgent = process.env.GENIE_AGENT_NAME;
  const originalAgentId = process.env.GENIE_AGENT_ID;
  const originalTeam = process.env.GENIE_TEAM;
  let scratchDir: string;

  beforeEach(() => {
    // G7 — clear both id and name; the cascade tests exercise tiers that
    // come AFTER the env reads, so leaving an inherited GENIE_AGENT_ID in
    // place would short-circuit every "env unset" test.
    process.env.GENIE_AGENT_ID = undefined;
    process.env.GENIE_AGENT_NAME = undefined;
    process.env.GENIE_TEAM = undefined;
    scratchDir = mkdtempSync(join(tmpdir(), 'resolve-agent-'));
  });

  afterEach(() => {
    process.env.GENIE_AGENT_ID = originalAgentId;
    process.env.GENIE_AGENT_NAME = originalAgent;
    process.env.GENIE_TEAM = originalTeam;
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test('payload.teammate_name beats every other source (highest priority)', () => {
    process.env.GENIE_AGENT_NAME = 'env-agent';
    const payload = basePayload({ teammate_name: 'payload-agent', cwd: scratchDir, session_id: 'abcd1234efgh' });
    expect(resolveAgentName(payload)).toBe('payload-agent');
  });

  test('GENIE_AGENT_NAME wins when teammate_name absent', () => {
    process.env.GENIE_AGENT_NAME = 'env-agent';
    expect(resolveAgentName(basePayload({ cwd: scratchDir }))).toBe('env-agent');
  });

  test('GENIE_AGENT_ID (UUID) wins over GENIE_AGENT_NAME when both env vars set', () => {
    // G7 — post-061 the canonical agent identity is a UUID. The cascade
    // returns the id so downstream PG calls FK-satisfy mailbox.from_worker.
    process.env.GENIE_AGENT_ID = '11111111-2222-3333-4444-555555555555';
    process.env.GENIE_AGENT_NAME = 'env-agent';
    expect(resolveAgentName(basePayload({ cwd: scratchDir }))).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('GENIE_AGENT_ID is ignored when not a UUID (falls through to NAME)', () => {
    // G7 — readEnvAgentId guards the regex so non-UUID env values don't poison
    // downstream FK writes. Non-UUID id → fall through to name.
    process.env.GENIE_AGENT_ID = 'cli:something';
    process.env.GENIE_AGENT_NAME = 'env-agent';
    expect(resolveAgentName(basePayload({ cwd: scratchDir }))).toBe('env-agent');
  });

  test('settings.local.json agentName wins over cwd basename when env unset', () => {
    const cwd = join(scratchDir, 'projectdir');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ agentName: 'settings-agent' }));
    expect(resolveAgentName(basePayload({ cwd }))).toBe('settings-agent');
  });

  test('cwd basename used when env + settings absent', () => {
    const cwd = join(scratchDir, 'my-project');
    mkdirSync(cwd, { recursive: true });
    expect(resolveAgentName(basePayload({ cwd }))).toBe('my-project');
  });

  test('session_id prefix is the last-resort identity before harness fallback', () => {
    expect(resolveAgentName(basePayload({ session_id: 'deadbeef-cafe-1234-5678' }))).toBe('session-deadbeef');
  });

  test("returns 'harness' (NOT 'unknown') when no context is available", () => {
    const result = resolveAgentName(basePayload({}));
    expect(result).toBe(HARNESS_AGENT);
    expect(result).toBe('harness');
    expect(result).not.toBe('unknown');
    expect(isHarnessAgent(result)).toBe(true);
  });

  test('isHarnessAgent distinguishes harness rows from real agent rows', () => {
    expect(isHarnessAgent('harness')).toBe(true);
    expect(isHarnessAgent('engineer-3')).toBe(false);
    expect(isHarnessAgent('unknown')).toBe(false);
  });

  test('malformed settings.local.json falls through gracefully to next tier', () => {
    const cwd = join(scratchDir, 'bad-settings');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{not valid json');
    expect(resolveAgentName(basePayload({ cwd }))).toBe('bad-settings');
  });
});

describe('resolveTeamName', () => {
  const originalTeam = process.env.GENIE_TEAM;

  beforeEach(() => {
    process.env.GENIE_TEAM = undefined;
  });

  afterEach(() => {
    process.env.GENIE_TEAM = originalTeam;
  });

  test('payload.team_name takes precedence over GENIE_TEAM', () => {
    process.env.GENIE_TEAM = 'env-team';
    expect(resolveTeamName(basePayload({ team_name: 'payload-team' }))).toBe('payload-team');
  });

  test('GENIE_TEAM env when payload omits team_name', () => {
    process.env.GENIE_TEAM = 'env-team';
    expect(resolveTeamName(basePayload({}))).toBe('env-team');
  });

  test('returns undefined when neither source is set', () => {
    expect(resolveTeamName(basePayload({}))).toBeUndefined();
  });
});
