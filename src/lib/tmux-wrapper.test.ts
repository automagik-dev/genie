/**
 * tmux-wrapper unit tests.
 *
 * Focuses on the env-propagation contract used by the tmux spawn path:
 * `prependEnvVars` is how GENIE_EXECUTOR_ID / GENIE_AGENT_ID / GENIE_AGENT_NAME
 * reach the agent child when it's launched under `tmux split-window` or
 * `tmux new-window`. See turn-session-contract wish, Group 3.
 */

import { describe, expect, test } from 'bun:test';
import { genieTmuxCmd, genieTmuxPrefix, prependEnvVars } from './tmux-wrapper.js';

describe('genieTmuxPrefix', () => {
  test('includes -L <socket> and -f <config>', () => {
    const parts = genieTmuxPrefix();
    expect(parts[0]).toBe('-L');
    expect(parts[1]).toMatch(/.+/); // socket name, default 'genie'
    expect(parts[2]).toBe('-f');
    expect(parts[3]).toMatch(/.+/); // config path or /dev/null
  });
});

describe('genieTmuxCmd', () => {
  test('prefixes the subcommand with the genie tmux flags', () => {
    const cmd = genieTmuxCmd('list-sessions');
    expect(cmd).toContain('-L');
    expect(cmd).toContain('list-sessions');
  });
});

describe('prependEnvVars', () => {
  test('returns command unchanged when env is undefined', () => {
    expect(prependEnvVars('bun run start')).toBe('bun run start');
  });

  test('returns command unchanged when env is empty object', () => {
    expect(prependEnvVars('bun run start', {})).toBe('bun run start');
  });

  test('prefixes env assignments with `env` keyword', () => {
    const out = prependEnvVars('claude --dangerously-skip-permissions', {
      GENIE_EXECUTOR_ID: '11111111-2222-3333-4444-555555555555',
    });
    expect(out).toBe(
      'env GENIE_EXECUTOR_ID=11111111-2222-3333-4444-555555555555 claude --dangerously-skip-permissions',
    );
  });

  test('joins multiple env vars with spaces, preserving order', () => {
    const out = prependEnvVars('cmd', {
      GENIE_EXECUTOR_ID: 'exec-id',
      GENIE_AGENT_ID: 'agent-id',
      GENIE_AGENT_NAME: 'engineer',
    });
    expect(out).toBe('env GENIE_EXECUTOR_ID=exec-id GENIE_AGENT_ID=agent-id GENIE_AGENT_NAME=engineer cmd');
  });

  test('propagates GENIE_EXECUTOR_ID when present — turn-close contract', () => {
    const execId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const out = prependEnvVars('claude', { GENIE_EXECUTOR_ID: execId });
    expect(out).toContain(`GENIE_EXECUTOR_ID=${execId}`);
    // The child shell will see this in its environment after `env` evaluates.
    expect(out.startsWith('env ')).toBe(true);
  });
});
