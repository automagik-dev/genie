import type { HandlerResult, HookPayload } from './types.js';

const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/gm;
/** Audit keeps five paths and approval previews keep ten. Retaining more at the
 * provider boundary only amplifies an attacker-controlled patch for no consumer. */
const MAX_PATCH_PATHS = 10;

/**
 * Codex reports file edits as `tool_name: "apply_patch"` with the patch in
 * `tool_input.command`. Provider-neutral handlers historically consumed
 * Claude's `file_path`, so normalize the canonical Codex shape at the adapter
 * boundary instead of teaching every policy about every provider wire format.
 */
export function normalizeCodexHookPayload(payload: HookPayload): HookPayload {
  // Runtime provenance is attached inside the provider adapter so policy
  // handlers can select a strictly local Codex path without consulting global
  // process state. This field only narrows behavior (for example, Codex denies
  // remote PR merges locally); it never grants a permission.
  const normalized: HookPayload = { ...payload, genie_hook_runtime: 'codex' };
  if (payload.tool_name !== 'apply_patch') return normalized;
  const input = payload.tool_input;
  const command = input?.command;
  if (typeof command !== 'string') return normalized;

  const paths: string[] = [];
  const seen = new Set<string>();
  let pathsTruncated = false;
  extraction: for (const pattern of [PATCH_FILE_HEADER, PATCH_MOVE_HEADER]) {
    pattern.lastIndex = 0;
    for (const match of command.matchAll(pattern)) {
      const path = match[1]?.trim();
      if (!path || path.includes('\0') || seen.has(path)) continue;
      seen.add(path);
      if (paths.length === MAX_PATCH_PATHS) {
        pathsTruncated = true;
        break extraction;
      }
      paths.push(path);
    }
  }
  if (paths.length === 0) return normalized;

  return {
    ...normalized,
    tool_input: {
      ...input,
      file_path: paths[0],
      file_paths: paths,
      ...(pathsTruncated ? { file_paths_truncated: true } : {}),
    },
  };
}

/**
 * `permissionDecision: "ask"` is not a supported Codex PreToolUse output.
 * Treat it as a deny rather than dropping it: an empty successful response can
 * let an otherwise runnable tool continue without either approval path.
 */
export function adaptCodexPreToolUseOutput(output: string): string {
  if (!output) return '';
  try {
    const parsed = JSON.parse(output) as {
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    const hookOutput = parsed.hookSpecificOutput;
    if (hookOutput?.hookEventName === 'PreToolUse' && hookOutput.permissionDecision === 'ask') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            hookOutput.permissionDecisionReason ?? 'Genie could not complete the requested approval safely.',
        },
      });
    }
  } catch {
    // The entrypoint/launcher validates malformed output and fails closed. Keep
    // this adapter lossless so callers can attribute the invalid response.
  }
  return output;
}

/** Encode the documented Codex PermissionRequest allow/deny envelope. */
export function codexPermissionDecision(result: HandlerResult): string {
  const decision = result?.hookSpecificOutput?.permissionDecision ?? result?.decision;
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') return '';
  const reason = result?.hookSpecificOutput?.permissionDecisionReason ?? result?.reason;
  const behavior =
    decision === 'allow' ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: reason };
  if (behavior.behavior === 'deny' && !behavior.message) {
    behavior.message = 'Genie could not complete the requested approval safely.';
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior,
    },
  });
}
