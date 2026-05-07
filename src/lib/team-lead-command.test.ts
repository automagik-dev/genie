/**
 * Tests for team-lead-command: buildTeamLeadCommand, sessionExists, ccProjectDirName
 *
 * Run with: bun test src/lib/team-lead-command.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTeamLeadCommand, ccProjectDirName, sessionExists } from './team-lead-command.js';

const TEST_DIR = `${realpathSync('/tmp')}/genie-team-lead-cmd-test`;

// ============================================================================
// ccProjectDirName
// ============================================================================

describe('ccProjectDirName', () => {
  test('converts absolute path to CC project dir name', () => {
    expect(ccProjectDirName('/home/user/projects/myapp')).toBe('-home-user-projects-myapp');
  });

  test('handles root path', () => {
    expect(ccProjectDirName('/')).toBe('-');
  });

  test('handles nested paths', () => {
    expect(ccProjectDirName('/a/b/c/d')).toBe('-a-b-c-d');
  });
});

// ============================================================================
// sessionExists
// ============================================================================

describe('sessionExists', () => {
  const projectCwd = '/tmp/fake-project';
  const projectDirName = ccProjectDirName(projectCwd);
  let ccProjectPath: string;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });

    // Create a fake CC projects directory
    ccProjectPath = join(TEST_DIR, '.claude', 'projects', projectDirName);
    mkdirSync(ccProjectPath, { recursive: true });

    // Override HOME so sessionExists looks in our test dir
    process.env.HOME = TEST_DIR;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.env.HOME = '/home/genie';
  });

  test('returns false when no project directory exists', () => {
    expect(sessionExists('nonexistent', '/no/such/project')).toBe(false);
  });

  test('returns false when project dir has no JSONL files', () => {
    expect(sessionExists('my-session', projectCwd)).toBe(false);
  });

  test('returns true when a session with matching name exists', () => {
    const sessionFile = join(ccProjectPath, 'abc-123.jsonl');
    writeFileSync(
      sessionFile,
      '{"type":"custom-title","customTitle":"my-team","sessionId":"abc-123"}\n{"type":"user","message":"hello"}\n',
    );

    expect(sessionExists('my-team', projectCwd)).toBe(true);
  });

  test('match is case-insensitive', () => {
    const sessionFile = join(ccProjectPath, 'abc-123.jsonl');
    writeFileSync(sessionFile, '{"type":"custom-title","customTitle":"My-Team","sessionId":"abc-123"}\n');

    expect(sessionExists('my-team', projectCwd)).toBe(true);
    expect(sessionExists('MY-TEAM', projectCwd)).toBe(true);
  });

  test('returns false when name does not match any session', () => {
    const sessionFile = join(ccProjectPath, 'abc-123.jsonl');
    writeFileSync(sessionFile, '{"type":"custom-title","customTitle":"other-team","sessionId":"abc-123"}\n');

    expect(sessionExists('my-team', projectCwd)).toBe(false);
  });

  test('returns false for non-JSONL files', () => {
    writeFileSync(
      join(ccProjectPath, 'abc-123'),
      '{"type":"custom-title","customTitle":"my-team","sessionId":"abc-123"}\n',
    );

    expect(sessionExists('my-team', projectCwd)).toBe(false);
  });

  test('handles malformed JSONL gracefully', () => {
    writeFileSync(join(ccProjectPath, 'bad.jsonl'), 'not valid json\n');

    expect(sessionExists('anything', projectCwd)).toBe(false);
  });

  test('scans multiple session files', () => {
    writeFileSync(
      join(ccProjectPath, 'first.jsonl'),
      '{"type":"custom-title","customTitle":"alpha","sessionId":"first"}\n',
    );
    writeFileSync(
      join(ccProjectPath, 'second.jsonl'),
      '{"type":"custom-title","customTitle":"beta","sessionId":"second"}\n',
    );

    expect(sessionExists('alpha', projectCwd)).toBe(true);
    expect(sessionExists('beta', projectCwd)).toBe(true);
    expect(sessionExists('gamma', projectCwd)).toBe(false);
  });

  test('uses cwd when no explicit dir is provided', () => {
    // Create a project dir matching the actual cwd
    const actualCwd = process.cwd();
    const actualProjectDir = ccProjectDirName(actualCwd);
    const actualProjectPath = join(TEST_DIR, '.claude', 'projects', actualProjectDir);
    mkdirSync(actualProjectPath, { recursive: true });
    writeFileSync(
      join(actualProjectPath, 'test.jsonl'),
      '{"type":"custom-title","customTitle":"cwd-session","sessionId":"test"}\n',
    );

    expect(sessionExists('cwd-session')).toBe(true);
  });
});

// ============================================================================
// buildTeamLeadCommand — resume behavior
// ============================================================================

describe('buildTeamLeadCommand resume behavior', () => {
  test('omits --resume and --session-id when neither is set', () => {
    const cmd = buildTeamLeadCommand('test-team', { promptMode: 'append' });
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--session-id');
    // --name retired (Felipe directive 2026-05-07): CC's customTitle
    // clobbered the UUID resume hint. Always use --session-id / --resume.
    expect(cmd).not.toContain('--name ');
  });

  test('sessionId without resume emits --session-id <uuid>', () => {
    const cmd = buildTeamLeadCommand('team', { sessionId: 'uuid-123', promptMode: 'append' });
    expect(cmd).toContain("--session-id 'uuid-123'");
    expect(cmd).not.toContain('--resume');
  });

  test('sessionId + resume:true emits --resume <uuid> (Gap B)', () => {
    // Gap B from trace-stale-resume (task #6): resuming must pass the UUID,
    // not a name, so CC cannot fuzzy-match to a different JSONL.
    const cmd = buildTeamLeadCommand('team', {
      sessionId: 'uuid-123',
      resume: true,
      promptMode: 'append',
    });
    expect(cmd).toContain("--resume 'uuid-123'");
    expect(cmd).not.toContain('--session-id');
  });

  test('sessionId + resume:false emits --session-id <uuid>', () => {
    const cmd = buildTeamLeadCommand('team', {
      sessionId: 'uuid-123',
      resume: false,
      promptMode: 'append',
    });
    expect(cmd).toContain("--session-id 'uuid-123'");
    expect(cmd).not.toContain('--resume');
  });
});

// ============================================================================
// buildTeamLeadCommand — GENIE_AGENT_NAME / --agent-name parity
// ============================================================================

describe('buildTeamLeadCommand identity parity', () => {
  // Regression: when GENIE_AGENT_NAME (env-side identity used by `genie send`
  // to label the sender) diverged from --agent-name (flag-side identity that
  // CC binds to the inbox poller), `genie send 'msg' --to <self>` fell
  // through the existing `from === to` self-loop guards (msg.ts:555,
  // protocol-router.ts:500) because `from` was the cwd basename while
  // `to` was the resolved leader. The message landed in inboxes/<leader>.json
  // and the operator's own CC instance polled it — echoing every send back
  // as a teammate-message. Repro: parent claude pid had
  // `GENIE_AGENT_NAME=workspace` while `--agent-name felipe` from the same
  // launch.

  test('GENIE_AGENT_NAME equals --agent-name (default leader = team)', () => {
    const cmd = buildTeamLeadCommand('felipe', { promptMode: 'append' });
    expect(cmd).toContain("GENIE_AGENT_NAME='felipe'");
    expect(cmd).toContain("--agent-name 'felipe'");
  });

  test('GENIE_AGENT_NAME equals --agent-name when leaderName overrides team', () => {
    const cmd = buildTeamLeadCommand('felipe', {
      leaderName: 'felipe',
      promptMode: 'append',
    });
    expect(cmd).toContain("GENIE_AGENT_NAME='felipe'");
    expect(cmd).toContain("--agent-name 'felipe'");
  });

  test('GENIE_AGENT_NAME ignores cwd basename', () => {
    // Even if the launching cwd's basename ("workspace", "src",
    // "node_modules", anything) would have been the previous source of
    // truth, the env var must still match the leader name.
    const cmd = buildTeamLeadCommand('alpha-team', {
      leaderName: 'alpha-leader',
      promptMode: 'append',
    });
    // sanitizeTeamName strips/normalizes — both sides should use the
    // sanitized form consistently.
    expect(cmd).toContain("GENIE_AGENT_NAME='alpha-leader'");
    expect(cmd).toContain("--agent-name 'alpha-leader'");
    expect(cmd).not.toMatch(/GENIE_AGENT_NAME='[^']*workspace[^']*'/);
  });
});

// ============================================================================
// buildTeamLeadCommand — AskUserQuestion baseline (#1688)
// ============================================================================

describe('buildTeamLeadCommand AskUserQuestion baseline', () => {
  // Regression: without --settings carrying AskUserQuestion in permissions.allow,
  // the team-lead's own user-prompt UI routed through Claude Code's approval
  // queue, causing the operator to see "Waiting for team lead approval" for a
  // tool whose entire purpose is to ask the operator a question.
  test('emits --settings with AskUserQuestion in permissions.allow', () => {
    const cmd = buildTeamLeadCommand('genie', { promptMode: 'append' });
    const match = cmd.match(/--settings '((?:[^'\\]|\\.)*)'/);
    expect(match).toBeTruthy();
    const settings = JSON.parse(match![1]) as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow).toEqual(['AskUserQuestion']);
  });

  test('--settings is emitted even when no system prompt file is provided', () => {
    const cmd = buildTeamLeadCommand('alpha-team', { promptMode: 'append' });
    expect(cmd).toContain('--settings');
    expect(cmd).toContain('AskUserQuestion');
  });
});
