/**
 * Shared mock.module registrations for SDK executor tests.
 *
 * Why this file exists:
 * Both `claude-sdk.test.ts` and `claude-sdk-resume.test.ts` mocked the same
 * production modules (agent-directory, agent-registry, executor-registry,
 * claude-agent-sdk) using `mock.module(...)`. Bun's mock.module is
 * process-global, and the FIRST test file that imports claude-sdk.js locks
 * its internal imports to whichever mock was active at first-import time.
 * Subsequent mock.module registrations in later files become dead weight —
 * the cached claude-sdk.js keeps pointing at the first file's mocks.
 *
 * Locally this didn't matter (module-loading order + bun dev behavior made
 * it work), but CI consistently exposed 7 failures because the file running
 * second registered mocks that were never observed by the production code.
 *
 * Fix: both test files import THIS file first. It registers each mock.module
 * exactly once and exports the mock functions. Both tests share the same
 * mock instances, so whichever gets cached by claude-sdk.js is the one both
 * test files can spy on and reset between tests.
 */

import { mock } from 'bun:test';

// ============================================================================
// Shared mock functions — single instances referenced by all SDK test files
// ============================================================================

export const findOrCreateAgentMock = mock(async (_name: string, _team: string, _role?: string) => ({
  id: 'agent-id-fixture',
  startedAt: new Date().toISOString(),
  currentExecutorId: null,
}));

export const findLatestByMetadataMock = mock((_filter: any): Promise<any> => Promise.resolve(null));
export const relinkExecutorToAgentMock = mock((..._args: any[]): Promise<void> => Promise.resolve());
export const updateClaudeSessionIdMock = mock((..._args: any[]): Promise<void> => Promise.resolve());
export const createAndLinkExecutorMock = mock(
  async (_agentId: string, _provider: string, _transport: string, _opts?: any) => ({
    id: 'executor-id-fixture',
    agentId: 'agent-id-fixture',
    provider: 'claude',
    transport: 'api',
    state: 'spawning',
    metadata: {},
    claudeSessionId: null,
  }),
);
export const updateExecutorStateMock = mock(async (_id: string, _state: string) => undefined);
export const terminateExecutorMock = mock(async (_id: string) => undefined);

const directoryResolveMock = mock(async (name: string) => ({
  entry: {
    name,
    dir: '/tmp/test',
    promptMode: 'system' as const,
    model: 'sonnet',
    registeredAt: new Date().toISOString(),
    permissions: { preset: 'full' },
  },
  builtin: false,
}));

/** Default SDK query implementation — yields one assistant reply + success result with session_id. */
const defaultQueryImpl = () => {
  const gen = (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } };
    yield { type: 'result', subtype: 'success', session_id: 'sdk-session-aaa' };
  })();
  return Object.assign(gen, {
    interrupt: mock(),
    setPermissionMode: mock(),
    setModel: mock(),
    return: mock(async () => ({ value: undefined, done: true })),
    throw: mock(async () => ({ value: undefined, done: true })),
  });
};

export const queryMock = mock(defaultQueryImpl);

/**
 * Reset queryMock to its default implementation. Use in beforeEach for tests
 * that care about the default behavior — some tests override via
 * mockImplementation() and that override persists across files because
 * queryMock is shared.
 */
export function resetQueryMock(): void {
  queryMock.mockReset();
  queryMock.mockImplementation(defaultQueryImpl);
}

// ============================================================================
// mock.module registrations — run once at module load
// ============================================================================

mock.module('../../../lib/agent-directory.js', () => ({
  resolve: directoryResolveMock,
  loadIdentity: mock(() => null),
}));

mock.module('../../../lib/agent-registry.js', () => ({
  findOrCreateAgent: findOrCreateAgentMock,
}));

mock.module('../../../lib/executor-registry.js', () => ({
  findLatestByMetadata: findLatestByMetadataMock,
  relinkExecutorToAgent: relinkExecutorToAgentMock,
  updateClaudeSessionId: updateClaudeSessionIdMock,
  createAndLinkExecutor: createAndLinkExecutorMock,
  updateExecutorState: updateExecutorStateMock,
  terminateExecutor: terminateExecutorMock,
}));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: mock((opts: any) => ({
    type: 'sdk' as const,
    name: opts.name,
    instance: {},
  })),
  tool: mock((_name: string, _desc: string, _schema: any, handler: any) => ({
    name: _name,
    description: _desc,
    inputSchema: _schema,
    handler,
  })),
}));
