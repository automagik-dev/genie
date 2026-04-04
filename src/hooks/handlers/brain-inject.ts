/**
 * Brain Inject Handler — PreToolUse (first tool call)
 *
 * Since SessionStart is non-blocking and cannot inject context,
 * this handler fires on the first PreToolUse event per session.
 * It queries genie-brain (if installed) for relevant context based
 * on the current working directory and injects it via additionalContext.
 *
 * Brain is an optional enterprise dependency — this handler is
 * completely no-op when brain is not installed.
 *
 * Priority: 5 (runs early, before identity-inject)
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HandlerResult, HookPayload } from '../types.js';

const BRAIN_PKG = '@automagik/genie-brain';
const BRAIN_DIR = 'node_modules/@automagik/genie-brain';

/** Track which sessions have already been enriched. */
const enrichedSessions = new Set<string>();

/** Build a session key from payload context. */
function sessionKey(payload: HookPayload): string {
  return payload.session_id ?? `${process.pid}`;
}

/** Check if genie-brain is installed locally. */
function isBrainAvailable(): boolean {
  return existsSync(join(BRAIN_DIR, 'package.json'));
}

/** Query brain for context relevant to the current project. */
async function queryBrain(cwd: string): Promise<string | null> {
  try {
    const brain = await import(BRAIN_PKG);
    if (!brain.search) return null;

    const projectName = basename(cwd);
    const results = await brain.search({
      query: `context for ${projectName}`,
      limit: 5,
      minScore: 0.5,
    });

    if (!results || results.length === 0) return null;

    const lines = results.map((r: { content?: string; text?: string; score?: number }) => {
      const text = r.content ?? r.text ?? '';
      return `- ${text.slice(0, 200)}`;
    });

    return lines.join('\n');
  } catch {
    // Brain query failed — best effort, never block
    return null;
  }
}

export async function brainInject(payload: HookPayload): Promise<HandlerResult> {
  // Only fire once per session
  const key = sessionKey(payload);
  if (enrichedSessions.has(key)) return;
  enrichedSessions.add(key);

  // Skip if brain is not installed
  if (!isBrainAvailable()) return;

  const cwd = payload.cwd ?? process.cwd();

  try {
    const context = await queryBrain(cwd);
    if (!context) return;

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: `[brain-inject] Prior context from knowledge base:\n${context}`,
      },
    };
  } catch {
    // Never block on brain failure
    return;
  }
}

/** Reset enriched sessions tracking (for testing). */
export function _resetEnrichedSessions(): void {
  enrichedSessions.clear();
}
