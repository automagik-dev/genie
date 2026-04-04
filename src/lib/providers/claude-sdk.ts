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
import type { HookCallbackMatcher, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Executor,
  ExecutorProvider,
  ExecutorState,
  LaunchCommand,
  SpawnContext,
  TransportType,
} from '../executor-types.js';
import type { SdkDirectoryConfig } from '../sdk-directory-types.js';
import { routeSdkMessage } from './claude-sdk-events.js';
import type { PermissionConfig } from './claude-sdk-permissions.js';
import { createPermissionGate } from './claude-sdk-permissions.js';

// ============================================================================
// SdkDirectoryConfig -> SDK Options translation
// ============================================================================

/**
 * Translate a persisted SdkDirectoryConfig into SDK Options.
 *
 * Only copies fields that are actually set (not undefined) so the result
 * can be safely spread into the final Options without overwriting defaults
 * with undefined.
 */
export function translateSdkConfig(sdkConfig: SdkDirectoryConfig): Partial<Options> {
  const opts: Partial<Options> = {};

  // Permission & effort
  if (sdkConfig.permissionMode) opts.permissionMode = sdkConfig.permissionMode;
  if (sdkConfig.effort) opts.effort = sdkConfig.effort as Options['effort'];

  // Tool configuration
  if (sdkConfig.tools) opts.tools = sdkConfig.tools;
  if (sdkConfig.allowedTools) opts.allowedTools = sdkConfig.allowedTools;
  if (sdkConfig.disallowedTools) opts.disallowedTools = sdkConfig.disallowedTools;

  // Limits
  if (sdkConfig.maxTurns != null) opts.maxTurns = sdkConfig.maxTurns;
  if (sdkConfig.maxBudgetUsd != null) opts.maxBudgetUsd = sdkConfig.maxBudgetUsd;

  // Thinking & reasoning
  if (sdkConfig.thinking) opts.thinking = sdkConfig.thinking as Options['thinking'];

  // Agents & MCP
  if (sdkConfig.agents) opts.agents = sdkConfig.agents as Options['agents'];
  if (sdkConfig.mcpServers) opts.mcpServers = sdkConfig.mcpServers as Options['mcpServers'];

  // Plugins
  if (sdkConfig.plugins) opts.plugins = sdkConfig.plugins;

  // Session & checkpointing
  if (sdkConfig.persistSession != null) opts.persistSession = sdkConfig.persistSession;
  if (sdkConfig.enableFileCheckpointing) opts.enableFileCheckpointing = sdkConfig.enableFileCheckpointing;

  // Output & streaming
  if (sdkConfig.outputFormat) opts.outputFormat = sdkConfig.outputFormat as Options['outputFormat'];
  if (sdkConfig.includePartialMessages) opts.includePartialMessages = sdkConfig.includePartialMessages;
  if (sdkConfig.includeHookEvents != null) opts.includeHookEvents = sdkConfig.includeHookEvents;
  if (sdkConfig.promptSuggestions) opts.promptSuggestions = sdkConfig.promptSuggestions;
  if (sdkConfig.agentProgressSummaries) opts.agentProgressSummaries = sdkConfig.agentProgressSummaries;

  // System prompt
  if (sdkConfig.systemPrompt) opts.systemPrompt = sdkConfig.systemPrompt;

  // Sandbox
  if (sdkConfig.sandbox) opts.sandbox = sdkConfig.sandbox as Options['sandbox'];

  // Betas & settings
  if (sdkConfig.betas) opts.betas = sdkConfig.betas;
  if (sdkConfig.settingSources) opts.settingSources = sdkConfig.settingSources;
  if (sdkConfig.settings) opts.settings = sdkConfig.settings as Options['settings'];

  return opts;
}

/**
 * Deep-merge hooks objects. Concatenates matcher arrays per event rather than
 * replacing. This ensures permission gate hooks survive when user-defined hooks
 * are added from SdkDirectoryConfig or extraOptions.
 */
function mergeHooks(
  ...sources: (Partial<Record<string, HookCallbackMatcher[]>> | undefined)[]
): Partial<Record<string, HookCallbackMatcher[]>> {
  const merged: Record<string, HookCallbackMatcher[]> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [event, matchers] of Object.entries(src)) {
      if (!matchers) continue;
      if (!merged[event]) {
        merged[event] = [...matchers];
      } else {
        merged[event].push(...matchers);
      }
    }
  }
  return merged;
}

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
   * The SDK provider runs in-process. There is no shell command to execute.
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
   *
   * @param ctx           Spawn context (cwd, model, systemPrompt, etc.)
   * @param prompt        Initial user message
   * @param permissionConfig  Permission gate config (PreToolUse hook)
   * @param extraOptions  Runtime overrides. Highest priority, wins over sdkConfig
   * @param sdkConfig     Directory-level SDK config. Lower priority than extraOptions
   */
  runQuery(
    ctx: SpawnContext,
    prompt: string,
    permissionConfig?: PermissionConfig,
    extraOptions?: Partial<Options>,
    sdkConfig?: SdkDirectoryConfig,
  ): { messages: Query; abortController: AbortController } {
    const abortController = new AbortController();

    // Track this query
    const tracker = { abortController, done: false };
    this.activeQueries.set(ctx.executorId, tracker);

    // Build permission gate hooks
    const permHooks: Partial<Record<string, HookCallbackMatcher[]>> | undefined = permissionConfig
      ? {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [createPermissionGate(permissionConfig)],
            },
          ],
        }
      : undefined;

    // Translate directory-level SDK config
    const translatedSdk = sdkConfig ? translateSdkConfig(sdkConfig) : undefined;

    // Merge hooks: permission gate + translated SDK hooks + extraOptions hooks
    const mergedHooks = mergeHooks(permHooks, translatedSdk?.hooks, extraOptions?.hooks);
    const hasHooks = Object.keys(mergedHooks).length > 0;

    const options: Options = {
      cwd: ctx.cwd,
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(ctx.model && { model: ctx.model }),
      ...(ctx.systemPrompt && { systemPrompt: ctx.systemPrompt }),
      // Layer 1: directory-level SDK config (lowest priority)
      ...translatedSdk,
      // Layer 2: runtime overrides (highest priority)
      ...extraOptions,
      // Hooks are always merged, never overwritten
      ...(hasHooks && { hooks: mergedHooks }),
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
          // Fire-and-forget event routing. Never blocks stream
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
