/**
 * ClaudeCodeOmniExecutor — First IExecutor implementation.
 *
 * Spawns Claude Code processes in tmux windows (one per chat),
 * delivers messages via Claude Code's native team inbox, and
 * injects env vars for NATS reply routing.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../../lib/agent-directory.js';
import * as agents from '../../lib/agent-registry.js';
import * as registry from '../../lib/executor-registry.js';
import { shellQuote } from '../../lib/team-lead-command.js';
import { ensureTeamWindow, executeTmux, isPaneAlive, isPaneProcessRunning, killWindow } from '../../lib/tmux.js';
import type { IExecutor, OmniMessage, OmniSession, SafePgCallFn } from '../executor.js';

/**
 * Per-session state tracked locally by the tmux executor. Mirrors the SDK
 * executor's `SdkSessionState` for the World A registry integration.
 */
interface TmuxSessionState {
  /**
   * World A executor row ID. Set after successful `createAndLinkExecutor`.
   * Null when PG was unavailable (degraded mode); downstream state updates
   * short-circuit via `bridge.safePgCall`.
   */
  executorId: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Sanitize a string for use as a tmux window name. Hash suffix prevents collisions. */
export function sanitizeWindowName(chatId: string): string {
  const hash = createHash('md5').update(chatId).digest('hex').slice(0, 12);
  const prefix = chatId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `${prefix}-${hash}` || 'chat';
}

/** Path to the omni-reply script installed at spawn time. */
function getReplyScriptPath(): string {
  return join(homedir(), '.genie', 'bin', 'omni-reply');
}

// ============================================================================
// Implementation
// ============================================================================

export class ClaudeCodeOmniExecutor implements IExecutor {
  /** Per-chat local state keyed by `${agentName}:${chatId}` — mirrors SDK executor. */
  private sessions = new Map<string, TmuxSessionState>();
  /**
   * Bridge-provided `safePgCall`. Null until the bridge wires it via
   * `setSafePgCall()`. When null (no bridge attached, e.g. standalone tests),
   * registry calls are skipped entirely — the executor falls through to the
   * pre-World-A behavior.
   */
  private safePgCall: SafePgCallFn | null = null;

  /**
   * Inject the bridge's `safePgCall` helper so World A registry writes are
   * guarded by the same pgAvailable / connection-loss logic as the rest of
   * the bridge. Mirrors the SDK executor's `setSafePgCall`.
   */
  setSafePgCall(fn: SafePgCallFn): void {
    this.safePgCall = fn;
  }

  /**
   * Spawn a Claude Code process in a tmux window for a specific chat.
   *
   * - Resolves agent from genie directory
   * - Creates tmux window in agent's session
   * - Starts Claude Code with env vars for NATS reply routing
   * - Registers the agent + executor in World A via `findOrCreateAgent` +
   *   `createAndLinkExecutor` with `transport='tmux'` and omni metadata.
   *   All PG writes go through `bridge.safePgCall` — degraded mode keeps
   *   `executorId=null` and the session still works without persistence.
   */
  async spawn(agentName: string, chatId: string, env: Record<string, string>): Promise<OmniSession> {
    // Resolve agent from directory
    const resolved = await directory.resolve(agentName);
    if (!resolved) {
      throw new Error(`Agent "${agentName}" not found in genie directory`);
    }

    const entry = resolved.entry;
    const tmuxSession = agentName;
    const windowName = sanitizeWindowName(chatId);

    // Ensure the reply script is available
    ensureReplyScript();

    // Create tmux window
    const { paneId, created } = await ensureTeamWindow(tmuxSession, windowName, entry.dir);

    if (created) {
      // Build env vars string for the tmux command
      const envVars = {
        ...env,
        GENIE_OMNI_CHAT_ID: chatId,
        GENIE_OMNI_AGENT: agentName,
      };

      const envPrefix = Object.entries(envVars)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ');

      // Build Claude Code command
      const systemPromptFile = join(entry.dir, 'AGENTS.md');
      const promptFlag = entry.promptMode === 'system' ? '--system-prompt-file' : '--append-system-prompt-file';
      const modelFlag = entry.model ? `--model ${shellQuote(entry.model)}` : '';
      const sessionId = randomUUID();

      const cmd = [
        envPrefix,
        'claude',
        promptFlag,
        shellQuote(systemPromptFile),
        modelFlag,
        '--session-id',
        shellQuote(sessionId),
        '--dangerously-skip-permissions',
      ]
        .filter(Boolean)
        .join(' ');

      // Send the command to the pane
      await executeTmux(`send-keys -t '${paneId}' ${shellQuote(cmd)} Enter`);
    }

    // World A registration (Group 4 — Decision 1, tmux path).
    // Symmetric with the SDK executor: both transports go through the same
    // findOrCreateAgent + createAndLinkExecutor pipeline, only `transport`
    // and the tmux-specific fields differ.
    const sessionKey = `${agentName}:${chatId}`;
    const executorId = await this.registerInWorldA(
      agentName,
      chatId,
      env.OMNI_INSTANCE_ID ?? '',
      tmuxSession,
      windowName,
      paneId,
    );
    this.sessions.set(sessionKey, { executorId });
    if (executorId) {
      await this.updateState(executorId, 'running', chatId);
    }

    const now = Date.now();
    return {
      id: sessionKey,
      agentName,
      chatId,
      tmuxSession,
      tmuxWindow: windowName,
      paneId,
      createdAt: now,
      lastActivityAt: now,
    };
  }

  /**
   * Register agent + tmux executor in World A (Decision 1 from WISH Post-Audit).
   * Returns the created executor ID on success, or null when PG is unavailable.
   * All writes are wrapped in `bridge.safePgCall` so degraded mode is silent.
   */
  private async registerInWorldA(
    agentName: string,
    chatId: string,
    instanceId: string,
    tmuxSession: string,
    tmuxWindow: string,
    tmuxPaneId: string,
  ): Promise<string | null> {
    if (!this.safePgCall) return null;

    const agent = await this.safePgCall(
      'tmux-find-or-create-agent',
      () => agents.findOrCreateAgent(agentName, 'omni', 'omni'),
      null,
      { chatId },
    );
    if (!agent) return null;

    const executor = await this.safePgCall(
      'tmux-create-executor',
      () =>
        registry.createAndLinkExecutor(agent.id, 'claude', 'tmux', {
          tmuxSession,
          tmuxWindow,
          tmuxPaneId,
          tmuxWindowId: null, // tmux window IDs aren't surfaced by `ensureTeamWindow` — fill in a follow-up.
          metadata: { source: 'omni', chat_id: chatId, instance_id: instanceId },
        }),
      null,
      { chatId },
    );
    return executor?.id ?? null;
  }

  /** Update executor state through safePgCall. No-op when PG is degraded. */
  private async updateState(executorId: string, state: 'running' | 'working' | 'idle', chatId: string): Promise<void> {
    if (!this.safePgCall) return;
    await this.safePgCall(
      'tmux-update-executor-state',
      () => registry.updateExecutorState(executorId, state),
      undefined,
      { executorId, chatId },
    );
  }

  /**
   * Deliver a message to a running Claude Code session via native team inbox.
   *
   * Writes to ~/.claude/teams/<team>/inboxes/<agent>.json so Claude Code
   * picks it up natively. Also records a `working → idle` transition in the
   * World A registry (wrapped in `safePgCall`, no-op in degraded mode).
   */
  async deliver(session: OmniSession, message: OmniMessage): Promise<void> {
    const state = this.sessions.get(session.id);

    // World A state transition: the inbox write itself is effectively instantaneous,
    // but the transitions exist so observability consumers can tell whether a given
    // tmux executor is currently processing a delivery or waiting.
    if (state?.executorId) await this.updateState(state.executorId, 'working', session.chatId);

    const inboxDir = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      'teams',
      session.tmuxSession,
      'inboxes',
    );
    mkdirSync(inboxDir, { recursive: true });

    const inboxFile = join(inboxDir, `${sanitizeWindowName(session.chatId)}.json`);

    // Read existing messages
    let messages: { from: string; text: string; summary: string; timestamp: string; read: boolean }[] = [];
    try {
      const { readFileSync } = await import('node:fs');
      messages = JSON.parse(readFileSync(inboxFile, 'utf-8'));
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Append new message
    messages.push({
      from: message.sender || 'whatsapp-user',
      text: message.content,
      summary: message.content.slice(0, 120),
      timestamp: message.timestamp || new Date().toISOString(),
      read: false,
    });

    writeFileSync(inboxFile, JSON.stringify(messages, null, 2));
    session.lastActivityAt = Date.now();

    if (state?.executorId) await this.updateState(state.executorId, 'idle', session.chatId);
  }

  /**
   * Shut down a session by killing its tmux window and terminating the
   * World A executor row (if one was created).
   */
  async shutdown(session: OmniSession): Promise<void> {
    const state = this.sessions.get(session.id);
    try {
      await killWindow(session.tmuxSession, session.tmuxWindow);
    } finally {
      if (state?.executorId && this.safePgCall) {
        await this.safePgCall(
          'tmux-terminate-executor',
          () => registry.terminateExecutor(state.executorId as string),
          undefined,
          { executorId: state.executorId, chatId: session.chatId },
        );
      }
      this.sessions.delete(session.id);
    }
  }

  /**
   * Check if a session's tmux pane is alive AND the Claude process is running inside it.
   * A pane can be alive (not dead) but the Claude process may have exited/crashed.
   */
  async isAlive(session: OmniSession): Promise<boolean> {
    try {
      const paneAlive = await isPaneAlive(session.paneId);
      if (!paneAlive) return false;
      // Verify the Claude process is actually running inside the pane
      return await isPaneProcessRunning(session.paneId, 'claude');
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Reply Script Management
// ============================================================================

/**
 * Ensure the omni-reply bash script exists in ~/.genie/bin/.
 *
 * This script is injected into agent's PATH at spawn time. Agents call
 * `echo 'message' | omni-reply` to publish replies to NATS.
 */
function ensureReplyScript(): void {
  const scriptPath = getReplyScriptPath();
  const binDir = join(homedir(), '.genie', 'bin');

  if (existsSync(scriptPath)) return;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    scriptPath,
    `#!/bin/bash
# omni-reply — Publish agent reply to NATS for Omni delivery.
# Usage: echo 'message' | omni-reply
#   or:  omni-reply 'message'
#
# Required env vars (injected by genie omni bridge at spawn):
#   OMNI_REPLY_TOPIC  — e.g., omni.reply.60a466a7.chat123
#   OMNI_NATS_URL     — e.g., localhost:4222

set -euo pipefail

TOPIC="\${OMNI_REPLY_TOPIC:?OMNI_REPLY_TOPIC not set — are you running inside an omni-bridged agent?}"
NATS_URL="\${OMNI_NATS_URL:-localhost:4222}"

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG=$(cat)
fi

[ -z "$MSG" ] && exit 0

# Build JSON payload — use jq for correct escaping, bash fallback for all JSON-special chars
if command -v jq &>/dev/null; then
  PAYLOAD=$(jq -nc \\
    --arg content "$MSG" \\
    --arg agent "\${GENIE_OMNI_AGENT:-unknown}" \\
    --arg chat_id "\${GENIE_OMNI_CHAT_ID:-unknown}" \\
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \\
    '{content:\$content,agent:\$agent,chat_id:\$chat_id,timestamp:\$ts}')
else
  json_escape() {
    local s="\$1"
    s="\${s//\\\\/\\\\\\\\}"
    s="\${s//\\"/\\\\\\"}"
    s="\${s//\$'\\n'/\\\\n}"
    s="\${s//\$'\\r'/\\\\r}"
    s="\${s//\$'\\t'/\\\\t}"
    printf '%s' "\$s"
  }
  PAYLOAD=$(printf '{"content":"%s","agent":"%s","chat_id":"%s","timestamp":"%s"}' \\
    "$(json_escape "$MSG")" \\
    "$(json_escape "\${GENIE_OMNI_AGENT:-unknown}")" \\
    "$(json_escape "\${GENIE_OMNI_CHAT_ID:-unknown}")" \\
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)")
fi

# Publish to NATS (try nats CLI first, fall back to nc)
if command -v nats &>/dev/null; then
  echo "$PAYLOAD" | nats pub "$TOPIC" --server "$NATS_URL"
elif command -v natscli &>/dev/null; then
  echo "$PAYLOAD" | natscli pub "$TOPIC" --server "$NATS_URL"
else
  # Fallback: use the genie omni-reply TypeScript publisher
  SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
  if [ -f "$SCRIPT_DIR/../src/services/omni-reply.ts" ]; then
    echo "$PAYLOAD" | bun run "$SCRIPT_DIR/../src/services/omni-reply.ts"
  else
    echo "[omni-reply] ERROR: nats CLI not found and no fallback available" >&2
    exit 1
  fi
fi
`,
  );
  chmodSync(scriptPath, 0o755);
}
