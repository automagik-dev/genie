/**
 * Hook Dispatch — central event bus for genie hooks.
 *
 * Invoked by CC as: genie hook dispatch
 * Reads JSON from stdin, resolves matching handlers, executes the chain,
 * and writes JSON result to stdout.
 *
 * Output format follows CC hook protocol:
 * - PreToolUse: { hookSpecificOutput: { hookEventName, permissionDecision, ... } }
 * - Other blocking: { decision: "block", reason: "..." }
 * - Non-blocking: fire-and-forget, no output
 *
 * Blocking events (PreToolUse, TeammateIdle, TaskCompleted):
 *   Chain of responsibility — handlers run in priority order.
 *   - deny: short-circuits, returns immediately
 *   - hookSpecificOutput: collected, merged at end
 *   - updatedInput: merges into payload for next handler
 *   - allow/void: continues to next handler
 *
 * Non-blocking events (PostToolUse, SessionStart, SessionEnd):
 *   Fire-and-forget — all handlers run, output is ignored.
 */

import { endSpan, startSpan } from '../lib/emit.js';
import { isWideEmitEnabled } from '../lib/observability-flag.js';
import { getAmbient as getTraceContext } from '../lib/trace-context.js';
import { auditContext } from './handlers/audit-context.js';
import { autoSpawn } from './handlers/auto-spawn.js';
import { brainInject } from './handlers/brain-inject.js';
import { branchGuard } from './handlers/branch-guard.js';
import { codexInboxDeliver } from './handlers/codex-inbox-deliver.js';
import { freshness } from './handlers/freshness.js';
import { identityInject } from './handlers/identity-inject.js';
import { orchestrationGuard } from './handlers/orchestration-guard.js';
import {
  emitAssistantResponseEvent,
  emitMessageEvent,
  emitToolCallEvent,
  emitUserPromptEvent,
} from './handlers/runtime-emit.js';
import { sessionSync } from './handlers/session-sync.js';
import type { Handler, HandlerResult, HookPayload } from './types.js';
import { isBlockingEvent } from './types.js';

// ============================================================================
// Handler Registry
// ============================================================================

/**
 * Builtin handlers — registered before any external loader runs.
 *
 * `source: 'builtin'` and `manifest_path` point at this file so `genie hook list`
 * can attribute every dispatched handler back to its source. The boot-scan
 * loader (delivery #2 Group 1) appends external handlers to a fresh array and
 * swaps it into `registryRef` via `setRegistry()` before `server.listen()`.
 */
const BUILTIN_MANIFEST_PATH = 'src/hooks/index.ts';

const builtinHandlers: ReadonlyArray<Handler> = [
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'branch-guard',
    event: 'PreToolUse',
    matcher: /^Bash$/,
    priority: 1,
    fn: branchGuard,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'orchestration-guard',
    event: 'PreToolUse',
    matcher: /^Bash$/,
    priority: 2,
    fn: orchestrationGuard,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'brain-inject',
    event: 'PreToolUse',
    matcher: /.*/,
    priority: 5,
    fn: brainInject,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'freshness',
    event: 'PreToolUse',
    matcher: /^Read$/,
    priority: 8,
    fn: freshness,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'audit-context',
    event: 'PreToolUse',
    matcher: /^(Write|Edit)$/,
    priority: 8,
    fn: auditContext,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'identity-inject',
    event: 'PreToolUse',
    matcher: /^SendMessage$/,
    priority: 10,
    fn: identityInject,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'auto-spawn',
    event: 'PreToolUse',
    matcher: /^SendMessage$/,
    priority: 20,
    fn: autoSpawn,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'runtime-emit-tool',
    event: 'PreToolUse',
    matcher: /.*/,
    priority: 30,
    fn: emitToolCallEvent,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'runtime-emit-msg',
    event: 'PostToolUse',
    matcher: /^SendMessage$/,
    priority: 30,
    fn: emitMessageEvent,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'codex-inbox-deliver',
    event: 'UserPromptSubmit',
    priority: 25,
    fn: codexInboxDeliver,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'runtime-emit-user-prompt',
    event: 'UserPromptSubmit',
    priority: 30,
    fn: emitUserPromptEvent,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'runtime-emit-assistant-response',
    event: 'Stop',
    priority: 30,
    fn: emitAssistantResponseEvent,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'session-sync-tool',
    event: 'PreToolUse',
    matcher: /.*/,
    priority: 35,
    fn: sessionSync,
  },
  {
    version: '1',
    source: 'builtin',
    manifest_path: BUILTIN_MANIFEST_PATH,
    name: 'session-sync-prompt',
    event: 'UserPromptSubmit',
    priority: 35,
    fn: sessionSync,
  },
];

/**
 * Live handler registry — read at dispatch time so `setRegistry()` swaps
 * are picked up by in-flight invocations on their next call. Single-writer
 * by convention: the loader / `genie hook reload` are the only legal
 * mutators (Group 1 of the absorption wish locks this down).
 *
 * Frozen-by-construction: `ReadonlyArray<Handler>` plus deep-frozen elements
 * via `Object.freeze` on the array. Mutating an element in place is a runtime
 * error; producers MUST build a fresh array and call `setRegistry`.
 */
let registryRef: ReadonlyArray<Handler> = Object.freeze([...builtinHandlers]);

/**
 * Replace the live handler registry. Called by:
 *   - the boot-scan loader after dynamic-importing trusted external hooks
 *   - `genie hook reload` after a re-scan
 *   - tests that need to install fixtures
 *
 * Single-writer guarantee is enforced at the CLI layer (a `genie hook reload`
 * can't run concurrently with another reload). In-flight dispatches that
 * already captured the previous reference finish on it; the next call to
 * `dispatch()` / `resolveHandlers()` sees the new array.
 */
export function setRegistry(next: ReadonlyArray<Handler>): void {
  registryRef = Object.freeze([...next]);
}

/**
 * Read-only accessor for tests + `genie hook list`. Returns the current
 * snapshot — the array reference is stable until the next `setRegistry` call.
 */
export function getRegistry(): ReadonlyArray<Handler> {
  return registryRef;
}

// ============================================================================
// Dispatch Logic
// ============================================================================

function resolveHandlers(event: string, toolName?: string): Handler[] {
  // Read registryRef at call time so setRegistry() swaps land on the next
  // dispatch — in-flight calls finish on the previously captured snapshot.
  return registryRef
    .filter((h) => {
      if (h.event !== event) return false;
      if (h.matcher && toolName && !h.matcher.test(toolName)) return false;
      if (h.matcher && !toolName) return false;
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}

/** Log handler decision when GENIE_HOOK_DEBUG is enabled. */
function hookDebug(handlerName: string, decision: string, elapsedMs: number): void {
  if (process.env.GENIE_HOOK_DEBUG === '1') {
    console.error(`[hook-debug] ${handlerName} → ${decision} (${elapsedMs}ms)`);
  }
}

/** Run a single handler, returning its result or undefined on error. */
export async function runHandler(
  handler: Handler,
  payload: HookPayload,
  currentInput: Record<string, unknown> | undefined,
  isBlocking: boolean,
): Promise<HandlerResult> {
  const handlerPayload: HookPayload = { ...payload };
  if (currentInput) handlerPayload.tool_input = currentInput;
  const start = Date.now();
  const agentId = process.env.GENIE_AGENT_NAME ?? 'unknown';
  const span = isWideEmitEnabled()
    ? startSpan(
        'hook.delivery',
        // event included so hook_perf_baseline view can group by it (Group 4 of
        // hookify-perf-foundation). tool may be undefined for UserPromptSubmit / Stop.
        { hook_name: handler.name, agent_id: agentId, tool: payload.tool_name, event: payload.hook_event_name },
        { source_subsystem: 'hooks', ctx: getTraceContext() ?? undefined, agent: agentId },
      )
    : null;
  try {
    const result = await handler.fn(handlerPayload);
    hookDebug(
      handler.name,
      result?.decision ?? result?.hookSpecificOutput?.permissionDecision ?? 'allow',
      Date.now() - start,
    );
    if (span) {
      endSpan(
        span,
        { hook_name: handler.name, agent_id: agentId, status: result?.decision === 'deny' ? 'rejected' : 'ok' },
        { source_subsystem: 'hooks', agent: agentId },
      );
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[genie-hook] Handler "${handler.name}" threw: ${msg}`);
    if (span) {
      endSpan(
        span,
        { hook_name: handler.name, agent_id: agentId, status: 'error', stderr_excerpt: msg.slice(0, 1024) },
        { source_subsystem: 'hooks', agent: agentId },
      );
    }
    if (isBlocking) {
      hookDebug(handler.name, 'deny (crash)', Date.now() - start);
      return { decision: 'deny', reason: `handler crashed: ${msg}` };
    }
    hookDebug(handler.name, 'allow (crash, non-blocking)', Date.now() - start);
    return undefined;
  }
}

function buildDenyResponse(
  handler: Handler,
  reason: string | undefined,
  hookEventName: string,
): Record<string, unknown> {
  if (hookEventName === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason ?? `Denied by handler: ${handler.name}`,
      },
    };
  }
  return { decision: 'block', reason: reason ?? `Denied by handler: ${handler.name}` };
}

function buildBlockingResponse(
  hookEventName: string,
  contextMessages: string[],
  currentInput: Record<string, unknown> | undefined,
  originalInput: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  const hasContext = contextMessages.length > 0;
  const hasInputChange =
    currentInput && originalInput && JSON.stringify(currentInput) !== JSON.stringify(originalInput);

  if (hasInputChange) {
    response.updatedInput = currentInput;
  }

  if (hookEventName === 'PreToolUse' && (hasContext || hasInputChange)) {
    const output: Record<string, unknown> = { hookEventName: 'PreToolUse' };
    if (hasContext) output.additionalContext = contextMessages.join('\n');
    if (hasInputChange) {
      output.permissionDecision = 'allow';
      output.updatedInput = currentInput;
    }
    response.hookSpecificOutput = output;
  }

  // UserPromptSubmit (claude + codex) accepts hookSpecificOutput.additionalContext
  // to inject context into the model input for the upcoming turn. Pre-PR-B the
  // dispatcher dropped this for non-PreToolUse blocking events; the codex
  // inbox-deliver handler depends on it (see src/hooks/handlers/codex-inbox-deliver.ts).
  if (hookEventName === 'UserPromptSubmit' && hasContext) {
    response.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextMessages.join('\n'),
    };
  }

  return response;
}

async function executeBlockingChain(matched: Handler[], payload: HookPayload): Promise<Record<string, unknown>> {
  let currentInput = payload.tool_input ? { ...payload.tool_input } : undefined;
  const contextMessages: string[] = [];
  const hookEventName = payload.hook_event_name;

  for (const handler of matched) {
    const result = await runHandler(handler, payload, currentInput, true);
    if (!result) continue;

    if (result.decision === 'deny') {
      return buildDenyResponse(handler, result.reason, hookEventName);
    }

    if (result.hookSpecificOutput?.additionalContext) {
      contextMessages.push(result.hookSpecificOutput.additionalContext);
    }

    const inputUpdate = result.hookSpecificOutput?.updatedInput ?? result.updatedInput;
    if (inputUpdate) {
      currentInput = { ...currentInput, ...inputUpdate };
    }
  }

  return buildBlockingResponse(hookEventName, contextMessages, currentInput, payload.tool_input);
}

async function executeNonBlockingHandlers(matched: Handler[], payload: HookPayload): Promise<void> {
  // Run all in parallel, don't wait for results
  await Promise.allSettled(
    matched.map((h) =>
      h.fn(payload).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[genie-hook] Handler "${h.name}" threw: ${msg}`);
      }),
    ),
  );
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function dispatch(stdin: string): Promise<string> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    console.error('[genie-hook] Invalid JSON on stdin');
    return '';
  }

  const event = payload.hook_event_name;
  if (!event) {
    console.error('[genie-hook] Missing hook_event_name in payload');
    return '';
  }

  const toolName = payload.tool_name;
  const matched = resolveHandlers(event, toolName);

  if (matched.length === 0) {
    return '';
  }

  if (isBlockingEvent(event)) {
    const result = await executeBlockingChain(matched, payload);
    if (Object.keys(result).length > 0) {
      return JSON.stringify(result);
    }
    return '';
  }

  // Non-blocking — fire and forget
  await executeNonBlockingHandlers(matched, payload);
  return '';
}
