import { omniApproval } from './handlers/omni-approval.js';
import type { HandlerResult, HookPayload } from './types.js';

export function adaptCodexPreToolUseOutput(output: string): string {
  if (!output) return '';
  try {
    const parsed = JSON.parse(output) as {
      hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
    };
    if (
      parsed.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
      parsed.hookSpecificOutput.permissionDecision === 'ask'
    ) {
      return '';
    }
  } catch {
    // Preserve a non-JSON fail-closed response for visibility.
  }
  return output;
}

export function codexPermissionDecision(result: HandlerResult): string {
  const decision = result?.hookSpecificOutput?.permissionDecision ?? result?.decision;
  if (decision !== 'allow' && decision !== 'deny') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: decision },
    },
  });
}

export async function dispatchCodexPermissionRequest(
  payload: HookPayload,
  approval: (payload: HookPayload) => Promise<HandlerResult> = omniApproval,
): Promise<string> {
  const result = await approval({ ...payload, hook_event_name: 'PreToolUse' });
  return codexPermissionDecision(result);
}
