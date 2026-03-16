/**
 * Hook Dispatch — central event bus for genie hooks.
 *
 * Invoked by CC as: genie hook dispatch
 * Reads JSON from stdin, resolves matching handlers, executes the chain,
 * and writes JSON result to stdout.
 *
 * Blocking events (PreToolUse, TeammateIdle, TaskCompleted):
 *   Chain of responsibility — handlers run in priority order.
 *   - deny: short-circuits, returns immediately
 *   - updatedInput: merges into payload for next handler
 *   - allow/void: continues to next handler
 *
 * Non-blocking events (PostToolUse, SessionStart, SessionEnd):
 *   Fire-and-forget — all handlers run, output is ignored.
 */

import { autoSpawn } from './handlers/auto-spawn.js';
import { identityInject } from './handlers/identity-inject.js';
import type { Handler, HandlerResult, HookDecision, HookPayload } from './types.js';
import { isBlockingEvent } from './types.js';

// ============================================================================
// Handler Registry
// ============================================================================

const handlers: Handler[] = [
  {
    name: 'identity-inject',
    event: 'PreToolUse',
    matcher: /^SendMessage$/,
    priority: 10,
    fn: identityInject,
  },
  {
    name: 'auto-spawn',
    event: 'PreToolUse',
    matcher: /^SendMessage$/,
    priority: 20,
    fn: autoSpawn,
  },
];

// ============================================================================
// Dispatch Logic
// ============================================================================

function resolveHandlers(event: string, toolName?: string): Handler[] {
  return handlers
    .filter((h) => {
      if (h.event !== event) return false;
      if (h.matcher && toolName && !h.matcher.test(toolName)) return false;
      if (h.matcher && !toolName) return false;
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}

/** Run a single handler, returning its result or undefined on error. */
async function runHandler(
  handler: Handler,
  payload: HookPayload,
  currentInput: Record<string, unknown> | undefined,
): Promise<HandlerResult> {
  const handlerPayload: HookPayload = { ...payload };
  if (currentInput) handlerPayload.tool_input = currentInput;
  try {
    return await handler.fn(handlerPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[genie-hook] Handler "${handler.name}" threw: ${msg}`);
    return undefined;
  }
}

async function executeBlockingChain(matched: Handler[], payload: HookPayload): Promise<HookDecision> {
  let currentInput = payload.tool_input ? { ...payload.tool_input } : undefined;

  for (const handler of matched) {
    const result = await runHandler(handler, payload, currentInput);
    if (!result) continue;

    if (result.decision === 'deny') {
      return { decision: 'deny', reason: result.reason ?? `Denied by handler: ${handler.name}` };
    }
    if (result.updatedInput) {
      currentInput = { ...currentInput, ...result.updatedInput };
    }
  }

  if (currentInput && payload.tool_input && JSON.stringify(currentInput) !== JSON.stringify(payload.tool_input)) {
    return { updatedInput: currentInput };
  }

  return {};
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
    // No handlers — implicit allow (empty stdout)
    return '';
  }

  if (isBlockingEvent(event)) {
    const result = await executeBlockingChain(matched, payload);
    // Only output JSON if there's an actual decision/update to communicate
    if (result.decision || result.updatedInput) {
      return JSON.stringify(result);
    }
    return '';
  }

  // Non-blocking — fire and forget
  await executeNonBlockingHandlers(matched, payload);
  return '';
}
