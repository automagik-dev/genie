/**
 * ClaudeSdkProvider — ExecutorProvider for Claude Agent SDK (in-process).
 *
 * Transport: process (in-process SDK query, no shell/tmux)
 * State detection: tracks query lifecycle via internal flag
 * Session extraction: returns claudeSessionId from executor metadata
 * Resume: not supported (stateless for now)
 * Termination: AbortController signal
 */

import { readFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ensureClaudeSettingsSafe } from '../claude-settings.js';
import type {
  Executor,
  ExecutorProvider,
  ExecutorState,
  LaunchCommand,
  SpawnContext,
  TransportType,
} from '../executor-types.js';
import type { SdkDirectoryConfig } from '../sdk-directory-types.js';
import { findWorkspace, getWorkspaceConfig } from '../workspace.js';
import { routeSdkMessage } from './claude-sdk-events.js';
import type { PermissionConfig } from './claude-sdk-permissions.js';
import { createPermissionGate } from './claude-sdk-permissions.js';
import { createRemoteApprovalGate } from './claude-sdk-remote-approval.js';

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
/** Fields that can be copied directly when truthy (non-null, non-undefined). */
const SDK_TRUTHY_FIELDS = [
  'tools',
  'allowedTools',
  'disallowedTools',
  'plugins',
  'systemPrompt',
  'betas',
  'settingSources',
] as const;

/** Fields that need != null check (booleans and numbers that can be 0/false). */
const SDK_NULLABLE_FIELDS = [
  'maxTurns',
  'maxBudgetUsd',
  'persistSession',
  'enableFileCheckpointing',
  'includePartialMessages',
  'includeHookEvents',
  'promptSuggestions',
  'agentProgressSummaries',
] as const;

/** Fields that require type casting to Options subtypes. */
const SDK_CAST_FIELDS = ['effort', 'thinking', 'agents', 'mcpServers', 'outputFormat', 'sandbox', 'settings'] as const;

export function translateSdkConfig(sdkConfig: SdkDirectoryConfig): Partial<Options> {
  const opts: Record<string, unknown> = {};

  for (const key of SDK_TRUTHY_FIELDS) {
    if (sdkConfig[key]) opts[key] = sdkConfig[key];
  }
  for (const key of SDK_NULLABLE_FIELDS) {
    if (sdkConfig[key] != null) opts[key] = sdkConfig[key];
  }
  for (const key of SDK_CAST_FIELDS) {
    if (sdkConfig[key]) opts[key] = sdkConfig[key];
  }

  return opts as Partial<Options>;
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
    // Defense-in-depth: ensure Claude Code global settings are safe/valid
    ensureClaudeSettingsSafe();

    const abortController = new AbortController();

    // Track this query
    const tracker = { abortController, done: false };
    this.activeQueries.set(ctx.executorId, tracker);

    // Build permission gate hooks
    let permHooks: Partial<Record<string, HookCallbackMatcher[]>> | undefined;

    if (sdkConfig?.permissionMode === 'remoteApproval') {
      // Remote approval: block on every tool use until a human decides
      const ws = findWorkspace(ctx.cwd);
      const permissions = ws ? getWorkspaceConfig(ws.root).permissions : undefined;
      permHooks = {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              createRemoteApprovalGate({
                executorId: ctx.executorId,
                agentName: ctx.agentId ?? ctx.role ?? 'unknown',
                permissions,
              }),
            ],
          },
        ],
      };
    } else if (permissionConfig) {
      permHooks = {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [createPermissionGate(permissionConfig)],
          },
        ],
      };
    }

    // Translate directory-level SDK config
    const translatedSdk = sdkConfig ? translateSdkConfig(sdkConfig) : undefined;

    // Merge hooks: permission gate + translated SDK hooks + extraOptions hooks
    const mergedHooks = mergeHooks(permHooks, translatedSdk?.hooks, extraOptions?.hooks);
    const hasHooks = Object.keys(mergedHooks).length > 0;

    // Resolve system prompt: inline text takes priority, then file (AGENTS.md)
    let resolvedSystemPrompt = ctx.systemPrompt;
    if (!resolvedSystemPrompt && ctx.systemPromptFile) {
      try {
        resolvedSystemPrompt = readFileSync(ctx.systemPromptFile, 'utf-8');
      } catch {
        // File not found or unreadable — proceed without system prompt
      }
    }

    const options: Options = {
      cwd: ctx.cwd,
      abortController,
      ...(ctx.model && { model: ctx.model }),
      ...(resolvedSystemPrompt && { systemPrompt: resolvedSystemPrompt }),
      // Layer 1: directory-level SDK config (lowest priority)
      ...translatedSdk,
      // Layer 2: runtime overrides (highest priority)
      ...extraOptions,
      // Hooks are always merged, never overwritten
      ...(hasHooks && { hooks: mergedHooks }),
      // MUST come last — SDK executor runs under auto permission mode by default.
      // No spread above may override these.
      permissionMode: 'auto',
      allowDangerouslySkipPermissions: true,
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
