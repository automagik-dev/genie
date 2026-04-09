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

// SDK query mock is defined in a shared file so that sdk-integration.test.ts
// (which only needs the SDK mock, not directory/registry mocks) can import the
// same instance without triggering the registry mocks below.
import {
  queryMock as _queryMock,
  resetQueryMock as _resetQueryMock,
} from '../../../__tests__/_shared-sdk-query-mock.js';

export const queryMock = _queryMock;
export const resetQueryMock = _resetQueryMock;

/**
 * Reset ALL shared mocks to their default implementations and clear call
 * counts. Call this in beforeEach to guarantee a clean slate regardless of
 * which file or describe block ran previously. This is stronger than
 * mockClear (which only clears call counts but leaves overridden
 * implementations in place).
 */
export function resetAllMocks(): void {
  findOrCreateAgentMock.mockReset();
  findOrCreateAgentMock.mockImplementation(async () => ({
    id: 'agent-id-fixture',
    startedAt: new Date().toISOString(),
    currentExecutorId: null,
  }));

  findLatestByMetadataMock.mockReset();
  findLatestByMetadataMock.mockImplementation(async () => null);

  relinkExecutorToAgentMock.mockReset();
  relinkExecutorToAgentMock.mockImplementation(async () => undefined as any);

  updateClaudeSessionIdMock.mockReset();
  updateClaudeSessionIdMock.mockImplementation(async () => undefined as any);

  createAndLinkExecutorMock.mockReset();
  createAndLinkExecutorMock.mockImplementation(async () => ({
    id: 'executor-id-fixture',
    agentId: 'agent-id-fixture',
    provider: 'claude',
    transport: 'api',
    state: 'spawning',
    metadata: {},
    claudeSessionId: null,
  }));

  updateExecutorStateMock.mockReset();
  updateExecutorStateMock.mockImplementation(async () => undefined);

  terminateExecutorMock.mockReset();
  terminateExecutorMock.mockImplementation(async () => undefined);

  resetQueryMock();
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

// SDK mock.module registration is handled by _shared-sdk-query-mock.ts
// (imported above via re-export). No need to register again here.
