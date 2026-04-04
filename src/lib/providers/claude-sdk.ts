/**
 * ClaudeSdkProvider — ExecutorProvider for Claude Agent SDK (in-process).
 *
 * Transport: process (in-process SDK query, no shell/tmux)
 * State detection: tracks query lifecycle via internal flag
 * Session extraction: returns claudeSessionId from executor metadata
 * Resume: not supported (stateless for now)
 * Termination: AbortController signal
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Executor,
  ExecutorProvider,
  ExecutorState,
  LaunchCommand,
  SpawnContext,
  TransportType,
} from '../executor-types.js';
import { routeSdkMessage } from './claude-sdk-events.js';
import type { PermissionConfig } from './claude-sdk-permissions.js';
import { createPermissionGate } from './claude-sdk-permissions.js';

// ============================================================================
// Provider Implementation
// ============================================================================

export class ClaudeSdkProvider implements ExecutorProvider {
  readonly name = 'claude-sdk';
  readonly transport: TransportType = 'process';

  /** Active queries keyed by executor ID, for state detection and termination. */
  private activeQueries = new Map<string, { abortController: AbortController; done: boolean }>();

  /**
   * Build a metadata-only LaunchCommand.
   *
   * The SDK provider runs in-process — there is no shell command to execute.
   * The command field is a sentinel value indicating in-process execution.
   */
  buildSpawnCommand(ctx: SpawnContext): LaunchCommand {
    return {
      command: 'claude-sdk-in-process',
      provider: 'claude-sdk',
      meta: {
        role: ctx.role,
        skill: ctx.skill,
      },
    };
  }

  /**
   * Run an SDK query for a given spawn context.
   *
   * Returns an async iterable of SDK messages. The caller is responsible
   * for iterating the result to drive execution.
   */
  runQuery(
    ctx: SpawnContext,
    prompt: string,
    permissionConfig?: PermissionConfig,
    extraOptions?: Partial<Options>,
  ): { messages: Query; abortController: AbortController } {
    const abortController = new AbortController();

    // Track this query
    const tracker = { abortController, done: false };
    this.activeQueries.set(ctx.executorId, tracker);

    const options: Options = {
      cwd: ctx.cwd,
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(ctx.model && { model: ctx.model }),
      ...(ctx.systemPrompt && { systemPrompt: ctx.systemPrompt }),
      ...(permissionConfig && {
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [createPermissionGate(permissionConfig)],
            },
          ],
        },
      }),
      ...extraOptions,
    };

    const messages = query({ prompt, options });

    // Wrap to track completion
    const originalReturn = messages.return.bind(messages);
    messages.return = async (value?: undefined) => {
      tracker.done = true;
      this.activeQueries.delete(ctx.executorId);
      return originalReturn(value);
    };

    // Track natural completion via a side-effect listener
    const self = this;
    const wrappedMessages = (async function* (): AsyncGenerator<SDKMessage, void> {
      try {
        for await (const msg of messages) {
          yield msg;
          // Fire-and-forget event routing — never blocks stream
          routeSdkMessage(msg, ctx.executorId, ctx.agentId).catch(() => {});
        }
      } finally {
        tracker.done = true;
        self.activeQueries.delete(ctx.executorId);
      }
    })() as Query;

    // Preserve control methods from the original Query
    wrappedMessages.interrupt = messages.interrupt.bind(messages);
    wrappedMessages.setPermissionMode = messages.setPermissionMode.bind(messages);
    wrappedMessages.setModel = messages.setModel.bind(messages);
    wrappedMessages.return = messages.return.bind(messages);
    wrappedMessages.throw = messages.throw.bind(messages);

    return { messages: wrappedMessages, abortController };
  }

  /**
   * Extract session metadata from an executor.
   *
   * Returns the claudeSessionId if available. No JSONL discovery needed
   * since the SDK runs in-process.
   */
  async extractSession(executor: Executor): Promise<{ sessionId: string; logPath?: string } | null> {
    const sessionId = executor.claudeSessionId;
    if (!sessionId) return null;
    return { sessionId };
  }

  /**
   * Detect the current state of an executor.
   *
   * Checks the internal query tracker. If the executor has an active query,
   * it's running. If the query completed, it's done. Otherwise terminated.
   */
  async detectState(executor: Executor): Promise<ExecutorState> {
    const tracker = this.activeQueries.get(executor.id);
    if (!tracker) return 'done';
    return tracker.done ? 'done' : 'running';
  }

  /**
   * Terminate the executor by aborting its query.
   */
  async terminate(executor: Executor): Promise<void> {
    const tracker = this.activeQueries.get(executor.id);
    if (tracker) {
      tracker.abortController.abort();
      tracker.done = true;
      this.activeQueries.delete(executor.id);
    }
  }

  /** SDK provider does not support resume (stateless for now). */
  canResume(): boolean {
    return false;
  }
}
