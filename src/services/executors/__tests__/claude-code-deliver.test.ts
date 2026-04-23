/**
 * Regression tests for ClaudeCodeOmniExecutor.deliver().
 *
 * Bug: subsequent messages on an active tmux session were routed through
 * mailbox.send() and never reached the running Claude pane. Fix: deliver()
 * injects directly via tmux send-keys, same path as injectNudge()/spawn().
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockExecuteTmux = mock(async (_cmd: string) => '');

mock.module('../../../lib/tmux-wrapper.js', () => ({
  executeTmux: mockExecuteTmux,
  genieTmuxPrefix: () => ['-L', 'genie'],
  genieTmuxCmd: (sub: string) => `tmux -L genie ${sub}`,
  // Must mirror real export surface — omitting any export poisons Bun's
  // module cache globally and breaks concurrent tests that import it
  // (issue #1223). Passthrough matches the real implementation so the
  // tmux-wrapper.test.ts suite still sees correct behavior when its
  // import happens to win the mock-cache race.
  prependEnvVars: (command: string, env?: Record<string, string>) => {
    if (!env || Object.keys(env).length === 0) return command;
    const envArgs = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `env ${envArgs} ${command}`;
  },
}));

// isPaneAlive lives in tmux.ts and calls executeTmux internally; by stubbing
// executeTmux above we control what isPaneAlive observes (`'0'` → alive).
const { ClaudeCodeOmniExecutor } = await import('../claude-code.js');
import type { ExecutorSession, OmniMessage } from '../../executor.js';

function makeSession(overrides: Partial<ExecutorSession> = {}): ExecutorSession {
  return {
    id: 'simone:156354157260957@lid',
    agentName: 'simone',
    chatId: '156354157260957@lid',
    executorType: 'tmux',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    tmux: { session: 'simone', window: 'wa-156354157260957lid', paneId: '%83' },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<OmniMessage> = {}): OmniMessage {
  return {
    chatId: '156354157260957@lid',
    instanceId: '5adc1ffe-9089-480a-9df0-2d3a79d5df69',
    sender: 'Stéfani',
    agent: 'simone',
    content: 'Bem, descansando.',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('ClaudeCodeOmniExecutor.deliver', () => {
  let executor: InstanceType<typeof ClaudeCodeOmniExecutor>;

  beforeEach(() => {
    mockExecuteTmux.mockReset();
    // Default: isPaneAlive check (display-message -p pane_dead) returns '0' (alive)
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('display-message')) return '0';
      return '';
    });
    executor = new ClaudeCodeOmniExecutor();
  });

  test('injects framed body into pane via two-phase send-keys with 200ms settle', async () => {
    const session = makeSession();
    const message = makeMessage();

    const start = Date.now();
    await executor.deliver(session, message);
    const elapsed = Date.now() - start;

    // Two-phase pattern: body send-keys, settle, Enter send-keys.
    const sendKeysCalls = mockExecuteTmux.mock.calls
      .map((c) => c[0] as string)
      .filter((cmd) => cmd.startsWith("send-keys -t '%83'"));
    expect(sendKeysCalls).toHaveLength(2);

    // First call sends the framed body (no Enter).
    expect(sendKeysCalls[0]).toContain('[Stéfani]: Bem, descansando.');
    expect(sendKeysCalls[0]).toContain('WhatsApp Turn');
    expect(sendKeysCalls[0].endsWith(' Enter')).toBe(false);

    // Second call is the Enter key alone.
    expect(sendKeysCalls[1]).toBe("send-keys -t '%83' Enter");

    // 200ms settle is load-bearing: Claude's TUI may drop a newline that
    // arrives in the same tmux batch as the text body.
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  test('body contains turn context (senderName, instanceId, chatId)', async () => {
    const session = makeSession();
    const message = makeMessage({ sender: 'TestUser', content: 'hello world' });

    await executor.deliver(session, message);

    const body = (mockExecuteTmux.mock.calls[1]?.[0] as string) ?? '';
    expect(body).toContain('TestUser');
    expect(body).toContain('5adc1ffe-9089-480a-9df0-2d3a79d5df69');
    expect(body).toContain('156354157260957@lid');
    expect(body).toContain('[TestUser]: hello world');
  });

  test('falls back to "whatsapp-user" when sender is empty string', async () => {
    const session = makeSession();
    const message = makeMessage({ sender: '' });

    await executor.deliver(session, message);

    const body = (mockExecuteTmux.mock.calls[1]?.[0] as string) ?? '';
    expect(body).toContain('[whatsapp-user]:');
  });

  test('no send-keys when paneId missing', async () => {
    const session = makeSession({ tmux: undefined });
    await executor.deliver(session, makeMessage());

    const sendKeysCalls = mockExecuteTmux.mock.calls
      .map((c) => c[0] as string)
      .filter((cmd) => cmd.startsWith('send-keys'));
    expect(sendKeysCalls).toHaveLength(0);
  });

  test('no send-keys when paneId malformed (shell-injection guard)', async () => {
    const session = makeSession({
      tmux: { session: 'simone', window: 'w', paneId: "%83'; rm -rf /" },
    });
    await executor.deliver(session, makeMessage());

    const sendKeysCalls = mockExecuteTmux.mock.calls
      .map((c) => c[0] as string)
      .filter((cmd) => cmd.startsWith('send-keys'));
    expect(sendKeysCalls).toHaveLength(0);
  });

  test('no send-keys when pane reported dead', async () => {
    // isPaneAlive returns false when display-message outputs '1'
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('display-message')) return '1';
      return '';
    });

    const session = makeSession();
    await executor.deliver(session, makeMessage());

    const sendKeysCalls = mockExecuteTmux.mock.calls
      .map((c) => c[0] as string)
      .filter((cmd) => cmd.startsWith('send-keys'));
    expect(sendKeysCalls).toHaveLength(0);
  });

  test('updates lastActivityAt on success', async () => {
    const session = makeSession({ lastActivityAt: 0 });
    await executor.deliver(session, makeMessage());
    expect(session.lastActivityAt).toBeGreaterThan(0);
  });

  test('does not throw when tmux send-keys fails', async () => {
    mockExecuteTmux.mockImplementation(async (cmd: string) => {
      if (cmd.includes('display-message')) return '0';
      if (cmd.startsWith('send-keys')) throw new Error('tmux boom');
      return '';
    });

    const session = makeSession();
    // Must not throw — failure is logged and swallowed.
    await executor.deliver(session, makeMessage());
  });
});
