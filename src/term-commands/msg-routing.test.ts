/**
 * Messaging Commands — Session propagation regression
 *
 * Verifies that `genie send` forwards the sender session into the router.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { __resetMsgCommandTestDeps, __setMsgCommandTestDeps, registerSendInboxCommands } from './msg.js';

const ENV_KEYS = ['GENIE_SESSION', 'GENIE_AGENT_NAME', 'TMUX_PANE', 'GENIE_HOME'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.GENIE_SESSION = 'project-a';
  process.env.GENIE_AGENT_NAME = undefined as unknown as string;
  process.env.TMUX_PANE = undefined as unknown as string;
  process.env.GENIE_HOME = `/tmp/msg-routing-test-${Date.now()}`;
  __resetMsgCommandTestDeps();
});

afterEach(() => {
  __resetMsgCommandTestDeps();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('registerSendInboxCommands', () => {
  test('passes sender session to protocol router', async () => {
    const sendCalls: Array<{
      repoPath: string;
      from: string;
      to: string;
      body: string;
      teamName?: string;
      senderSession?: string;
    }> = [];

    __setMsgCommandTestDeps({
      protocolRouter: {
        sendMessage: async (
          repoPath: string,
          from: string,
          to: string,
          body: string,
          teamName?: string,
          senderSession?: string,
        ) => {
          sendCalls.push({ repoPath, from, to, body, teamName, senderSession });
          return { messageId: 'msg-1', workerId: to, delivered: true };
        },
        getInbox: async () => [],
      },
      teamManager: {
        listTeams: async () => [],
      },
      registry: {
        findByPane: async () => null,
      },
    });

    const program = new Command();
    registerSendInboxCommands(program);

    await program.parseAsync(['send', 'hello there', '--to', 'implementor', '--from', 'alice'], {
      from: 'user',
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toBe('implementor');
    expect(sendCalls[0]?.senderSession).toBe('project-a');
  });
});
