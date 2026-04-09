/**
 * Shared mock for `@anthropic-ai/claude-agent-sdk`.
 *
 * Bun's `mock.module()` is process-global and first-registration-wins. When
 * multiple test files register competing mocks for the same module, whichever
 * loads first locks the global cache, and other files' mocks become dead weight.
 *
 * This file provides a SINGLE `queryMock` instance used by both:
 *   - `src/__tests__/sdk-integration.test.ts`
 *   - `src/services/executors/__tests__/_sdk-mocks.ts`
 *
 * It ONLY mocks `@anthropic-ai/claude-agent-sdk` — no directory, registry, or
 * other module mocks — so it's safe to import from any test file without
 * polluting unrelated modules.
 */

import { mock } from 'bun:test';

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

export function resetQueryMock(): void {
  queryMock.mockReset();
  queryMock.mockImplementation(defaultQueryImpl);
}

// ============================================================================
// Register the SDK mock — this is the single source of truth for the process.
// ============================================================================

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
