/**
 * ClaudeCodeOmniExecutor -- tmux-based IExecutor implementation.
 *
 * Spawns Claude Code processes in tmux windows (one per chat) and delivers
 * follow-up messages directly via tmux send-keys — the same injection path
 * that delivers the spawn's initial prompt. Injects env vars so agents can
 * call `omni say/done` directly.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../../lib/agent-directory.js';
import type { DirectoryEntry } from '../../lib/agent-directory.js';
import * as agents from '../../lib/agent-registry.js';
import * as registry from '../../lib/executor-registry.js';
import { signOmniRequest } from '../../lib/omni-signature.js';
import { buildLaunchCommand } from '../../lib/provider-adapters.js';
import type { SpawnParams } from '../../lib/provider-adapters.js';
import { shellQuote } from '../../lib/team-lead-command.js';
import { writeTmuxLaunchScript } from '../../lib/tmux-launch-script.js';
import {
  capturePaneContent,
  ensureTeamWindow,
  executeTmux,
  isPaneAlive,
  isPaneProcessRunning,
  killWindow,
} from '../../lib/tmux.js';
import type { ExecutorSession, IExecutor, OmniMessage, SafePgCallFn } from '../executor.js';
import { buildTurnBasedPrompt } from './turn-based-prompt.js';

interface TmuxSessionState {
  executorId: string | null;
  agentId: string | null;
  repoPath: string | null;
  /**
   * Fingerprint of the most recent capture-pane sample. Used by `isBusy`
   * to decide whether the pane has produced new bytes since the last check.
   * `null` until the first sample lands.
   */
  lastPaneFingerprint: string | null;
}

/**
 * Sanitize a string for use as tmux window name and inbox filename.
 * Strips unsafe characters, truncates to 30 chars.
 */
function safeName(raw: string, maxLen = 30): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, maxLen) || 'unknown';
}

/**
 * Convert a chat JID into a human-readable, path-safe tmux window name.
 *
 * MUST be deterministic from chatId alone — senderName changes per message
 * in groups, so it cannot be part of the key. The optional chatName is
 * resolved once at spawn time from omni's chat database.
 *
 * Uses `-` separator (not `/`) so the name is safe as both a tmux window
 * name AND a filename component in the Claude Code team inbox path.
 *
 * Formats:
 *   5512982298888@s.whatsapp.net  → wa-5512982298888
 *   120363422699972298@g.us       → grp-NMSTXleadership (if chatName) or grp-120363422699972298
 *   54958418317348@lid            → lid-54958418317348
 *   other                         → chat-<sanitized prefix>
 */
export function sanitizeWindowName(chatId: string, chatName?: string): string {
  // WhatsApp DM: number@s.whatsapp.net — always use phone number
  const whatsappDm = chatId.match(/^(\d+)@s\.whatsapp\.net$/);
  if (whatsappDm) return `wa-${whatsappDm[1]}`;

  // WhatsApp group: id@g.us — use chatName if available
  const whatsappGroup = chatId.match(/^(\d+)@g\.us$/);
  if (whatsappGroup) return `grp-${chatName ? safeName(chatName) : whatsappGroup[1]}`;

  // LID format: id@lid — use chatName (contact name) if available
  const lid = chatId.match(/^(\d+)@lid$/);
  if (lid) return chatName ? `wa-${safeName(chatName)}` : `lid-${lid[1]}`;

  // Fallback: sanitize for tmux and file paths (no special chars)
  return `chat-${safeName(chatId)}`;
}

/**
 * Resolve the tmux session name the Omni bridge will spawn into.
 *
 * Resolution chain (highest priority first):
 *   1. `GENIE_TMUX_SESSION` env var — propagated via NATS by the Omni provider,
 *      sourced from instance-level config (e.g. `instance.bridgeTmuxSession`).
 *      Enables per-instance routing ("one scout agent → ten inbound numbers,
 *      each in its own tmux session").
 *   2. `entry.bridgeTmuxSession` — static per-agent default from agent.yaml.
 *      Enables hierarchical co-location ("felipe/scout lands in felipe session").
 *   3. `agentName` — backward-compatible fallback (legacy behavior).
 *
 * Uses `||` (not `??`) so any falsy value — including the empty string —
 * falls through to the next layer. Empty strings in either source would
 * produce a nameless session, which tmux rejects with a cryptic error.
 *
 * Tmux also reserves `/` (used in some window addressing) and `:` (session
 * vs window separator, e.g. `session:window.pane`), so both are sanitized
 * to `-` regardless of source.
 */
export function resolveBridgeTmuxSession(
  agentName: string,
  entryBridgeTmuxSession: string | undefined,
  envOverride: string | undefined,
): string {
  const raw = envOverride || entryBridgeTmuxSession || agentName;
  return raw.replace(/[\/:]/g, '-');
}

/**
 * Look up the chat/contact name from omni API for human-readable window naming.
 * Queries GET /api/v2/chats?externalId=<jid> — returns the chat name.
 * Returns null if lookup fails (best-effort, never blocks spawn).
 */
async function lookupChatName(chatId: string, _instanceId: string): Promise<string | null> {
  try {
    const configPath = join(homedir(), '.omni', 'config.json');
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const apiUrl = config.apiUrl || 'http://localhost:8882';
    const apiKey = config.apiKey || '';
    if (!apiKey) return null;

    const path = `/api/v2/chats?externalId=${encodeURIComponent(chatId)}`;
    const url = `${apiUrl}${path}`;
    // Sign the lookup when this host has run `genie omni handshake`. Falls
    // back to bearer-only when no key is present, matching pre-fingerprint
    // behavior. Required so the lookup keeps working when the targeted
    // omni instance is locked down with `--require-genie-signature`.
    const sigHeaders = signOmniRequest('GET', path, '');
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (sigHeaders) Object.assign(headers, sigHeaders);
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    // API returns { items: [...] } at root (no data wrapper)
    const body = (await res.json()) as { items?: { name?: string; externalId?: string }[] };
    // Find exact match by externalId since the API may return multiple results
    const match = body.items?.find((c) => c.externalId === chatId) ?? body.items?.[0];
    return match?.name || null;
  } catch {
    return null;
  }
}

/**
 * Build SpawnParams from omni bridge context so we can delegate to buildLaunchCommand().
 *
 * @param resumeClaudeSessionId — when set, emits `--resume <id>` so the omni
 *   bridge reattaches to the same Claude conversation that handled this chat
 *   before a crash/restart. If the JSONL is missing (cleanup, fresh machine),
 *   `--resume` will silently fail; `launchOmniProcessInPane` detects that and
 *   falls back to a fresh `--session-id <new-uuid>` automatically.
 */
export function buildOmniSpawnParams(
  agentName: string,
  chatId: string,
  entry: DirectoryEntry,
  env: Record<string, string>,
  initialMessage?: string,
  resumeClaudeSessionId?: string,
): SpawnParams {
  const instanceId = env.OMNI_INSTANCE ?? '';
  const senderName = env.OMNI_SENDER_NAME ?? 'whatsapp-user';
  const turnContext = buildTurnBasedPrompt(senderName, instanceId, chatId);

  // Turn instructions go in the initial prompt (before the user's message),
  // NOT in the system prompt. System prompt = agent identity (AGENTS.md).
  // Turn context = operational instructions for this specific interaction.
  const fullInitialPrompt = initialMessage ? `${turnContext}\n\n---\n\n${initialMessage}` : turnContext;

  // Pass agent permissions through to Claude Code via --settings so the tmux
  // executor honors AGENTS.md frontmatter permissions. Without this, WhatsApp
  // turn agents run under the default (auto) permission mode with no Bash-level
  // enforcement, defeating the unified per-agent permission system.
  const permissions =
    entry.permissions?.allow?.length || entry.permissions?.deny?.length
      ? { allow: entry.permissions.allow, deny: entry.permissions.deny }
      : undefined;

  return {
    provider: (entry.provider as SpawnParams['provider']) ?? 'claude',
    team: agentName,
    role: agentName,
    sessionId: resumeClaudeSessionId ? undefined : randomUUID(),
    resume: resumeClaudeSessionId,
    model: entry.model,
    promptMode: entry.promptMode,
    systemPromptFile: join(entry.dir, 'AGENTS.md'),
    initialPrompt: fullInitialPrompt,
    skipHooks: true,
    permissions,
    disallowedTools: entry.disallowedTools,
    nativeTeam: {
      enabled: true,
      agentName,
      // Register the agent type so the launch command emits `--agent-type <name>`
      // alongside `--agent <name>`. Claude Code >=2.1.191 rejects `--agent <name>`
      // when the type was never declared ("agent '<name>' not found"), which kills
      // every freshly-spawned omni turn-handler ~15s after launch. The base/dir
      // spawn path already sets this via protocol-router-spawn (template.role);
      // the omni bridge path was missing it.
      agentType: agentName,
      color: (entry.color as 'blue' | undefined) ?? undefined,
    },
  };
}

/**
 * Resolve the process name expected to be running under the tmux pane.
 * The Omni tmux executor can launch Codex-backed directory entries too, so
 * liveness probes must follow the provider instead of assuming Claude.
 */
export function resolveOmniPaneProcessName(provider: string | undefined): string {
  return provider === 'codex' ? 'codex' : 'claude';
}

export class ClaudeCodeOmniExecutor implements IExecutor {
  private sessions = new Map<string, TmuxSessionState>();
  private safePgCall: SafePgCallFn | null = null;

  setSafePgCall(fn: SafePgCallFn): void {
    this.safePgCall = fn;
  }

  setNatsPublish(_fn: import('../executor.js').NatsPublishFn): void {
    // No-op: tmux executor replies via tmux pane, not NATS
  }

  async injectNudge(session: ExecutorSession, text: string): Promise<void> {
    const paneId = session.tmux?.paneId;
    if (!paneId) return;
    const nudgeText = `[system] ${text}`;
    await executeTmux(`send-keys -t '${paneId}' ${shellQuote(nudgeText)} Enter`);
  }

  private async launchOmniProcessInPane(
    agentName: string,
    chatId: string,
    entry: DirectoryEntry,
    env: Record<string, string>,
    paneId: string,
    initialMessage: string | undefined,
    resumeClaudeSessionId: string | undefined,
  ): Promise<string | undefined> {
    const omniEnv: Record<string, string> = { ...env, GENIE_OMNI_CHAT_ID: chatId, GENIE_OMNI_AGENT: agentName };

    const sendToPane = async (params: SpawnParams): Promise<void> => {
      const launch = buildLaunchCommand(params);
      const allEnv = { ...omniEnv, ...launch.env };
      const envPrefix = Object.entries(allEnv)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ');
      const cmd = envPrefix ? `${envPrefix} ${launch.command}` : launch.command;
      const scriptPath = writeTmuxLaunchScript(`omni-${chatId}`, cmd);
      await executeTmux(`send-keys -t '${paneId}' "source ${scriptPath}" Enter`);
    };

    const params = buildOmniSpawnParams(agentName, chatId, entry, omniEnv, initialMessage, resumeClaudeSessionId);
    await sendToPane(params);

    if (resumeClaudeSessionId) {
      // --resume silently fails when the JSONL is missing (e.g. cleanup, fresh
      // machine): Claude exits immediately and the pane returns to the shell
      // without printing an error. Detect this by polling for the process after
      // a short settle window and, on failure, fall back to a fresh session so
      // the inbound message is not lost.
      await new Promise((r) => setTimeout(r, 3000));
      const processName = resolveOmniPaneProcessName(entry.provider);
      const resumed = await isPaneProcessRunning(paneId, processName);
      if (!resumed) {
        console.warn(
          `[claude-code] --resume ${resumeClaudeSessionId} failed for chat ${chatId} — JSONL likely missing. Falling back to fresh session.`,
        );
        const freshParams = buildOmniSpawnParams(agentName, chatId, entry, omniEnv, initialMessage);
        await sendToPane(freshParams);
        return freshParams.sessionId;
      }
      return resumeClaudeSessionId;
    }

    return params.sessionId;
  }

  async spawn(
    agentName: string,
    chatId: string,
    env: Record<string, string>,
    initialMessage?: string,
  ): Promise<ExecutorSession> {
    const resolved = await directory.resolve(agentName);
    if (!resolved) throw new Error(`Agent "${agentName}" not found in genie directory`);

    const entry = resolved.entry;
    const tmuxSession = resolveBridgeTmuxSession(agentName, entry.bridgeTmuxSession, env.GENIE_TMUX_SESSION);
    const chatName = await lookupChatName(chatId, env.OMNI_INSTANCE ?? '');
    const windowName = sanitizeWindowName(chatId, chatName ?? undefined);
    const { paneId, created } = await ensureTeamWindow(tmuxSession, windowName, entry.dir);

    // Find-or-create the per-chat agent record up front so we can look up any
    // prior executor for this (agent, chat) pair BEFORE building the launch
    // command. If a prior executor exists with a recorded Claude session id,
    // we pass it as `--resume` so the freshly-spawned tmux pane attaches to
    // the same conversation history. This is the key invariant requested by
    // operators: "omni-bridged sessions are permanent until explicitly closed".
    const instanceId = env.OMNI_INSTANCE ?? '';
    const agent = this.safePgCall
      ? await this.safePgCall(
          'tmux-find-or-create-agent',
          () => agents.findOrCreateAgent(`${agentName}:${chatId}`, 'omni', 'omni'),
          null,
          { chatId },
        )
      : null;
    const existingExecutor = agent
      ? ((await this.safePgCall?.(
          'tmux-find-existing-executor',
          () => registry.findLatestByMetadata({ agentId: agent.id, source: 'omni', chatId }),
          null,
          { chatId },
        )) ?? null)
      : null;
    const resumeClaudeSessionId = existingExecutor?.claudeSessionId ?? undefined;

    const processName = resolveOmniPaneProcessName(entry.provider);
    const processRunning = !created && (await isPaneProcessRunning(paneId, processName));
    const needsLaunch = created || !processRunning;

    const claudeSessionId: string | undefined = needsLaunch
      ? await this.launchOmniProcessInPane(agentName, chatId, entry, env, paneId, initialMessage, resumeClaudeSessionId)
      : resumeClaudeSessionId;

    const sessionKey = `${agentName}:${chatId}`;
    const registration = await this.registerOrRelinkExecutor(
      agent,
      existingExecutor,
      chatId,
      instanceId,
      tmuxSession,
      windowName,
      paneId,
      entry.dir,
      claudeSessionId,
    );
    this.sessions.set(sessionKey, {
      executorId: registration?.executorId ?? null,
      agentId: registration?.agentId ?? null,
      repoPath: entry.dir,
      lastPaneFingerprint: null,
    });
    if (registration?.executorId) await this.updateState(registration.executorId, 'running', chatId);

    const now = Date.now();
    return {
      id: sessionKey,
      agentName,
      chatId,
      executorType: 'tmux' as const,
      createdAt: now,
      lastActivityAt: now,
      tmux: { session: tmuxSession, window: windowName, paneId, claudeSessionId, processName },
    };
  }

  /**
   * Persist (or relink) the executor row for this per-chat omni session.
   *
   * - If an existing executor row was found by `findLatestByMetadata`, we
   *   relink it to the same agent (in case current_executor_id drifted),
   *   refresh its tmux pane/window pointers (a respawn lands in a new pane),
   *   and persist the resolved Claude session id when the row was missing
   *   one (e.g., legacy rows from before this fix). The row's identity
   *   (executor.id) and history are preserved.
   * - Otherwise, create a fresh executor row carrying the freshly-generated
   *   Claude session id, so the *next* respawn finds it via
   *   `findLatestByMetadata` and re-attaches via `--resume`.
   *
   * Either path makes per-chat sessions permanent across executor death:
   * the bridge always finds the same `claude_session_id` for a given
   * `(agent_id, chat_id)`, and Claude's `--resume` reloads the JSONL
   * transcript transparently.
   */
  private async registerOrRelinkExecutor(
    agent: { id: string } | null,
    existingExecutor: { id: string; claudeSessionId?: string | null } | null,
    chatId: string,
    instanceId: string,
    tmuxSession: string,
    tmuxWindow: string,
    tmuxPaneId: string,
    repoPath: string,
    claudeSessionId: string | undefined,
  ): Promise<{ executorId: string; agentId: string } | null> {
    if (!this.safePgCall || !agent) return null;

    // Update agent record with pane_id and repo_path. Used by inter-agent
    // SendMessage (protocol-router) and observability — not by omni-turn
    // delivery, which now injects directly via tmux send-keys.
    await this.safePgCall(
      'tmux-update-agent-pane',
      async () => {
        const sql = await import('../../lib/db.js').then((m) => m.getConnection());
        await sql`
          UPDATE agents
          SET pane_id = ${tmuxPaneId},
              session = ${tmuxSession},
              repo_path = ${repoPath},
              window_name = ${tmuxWindow},
              state = 'idle',
              last_state_change = now()
          WHERE id = ${agent.id}
        `;
      },
      undefined,
      { chatId },
    );

    // RELINK PATH — reuse the prior executor row so the per-chat session id
    // (claude_session_id) and audit history are preserved across crashes.
    if (existingExecutor) {
      await this.safePgCall(
        'tmux-relink-executor',
        () => registry.relinkExecutorToAgent(existingExecutor.id, agent.id),
        undefined,
        { executorId: existingExecutor.id, chatId },
      );
      // Refresh tmux pane pointers — a respawn lands in a new pane.
      await this.safePgCall(
        'tmux-refresh-executor-pane',
        async () => {
          const sql = await import('../../lib/db.js').then((m) => m.getConnection());
          await sql`
            UPDATE executors
            SET tmux_session = ${tmuxSession},
                tmux_window = ${tmuxWindow},
                tmux_pane_id = ${tmuxPaneId},
                ended_at = NULL,
                state = 'running',
                updated_at = now()
            WHERE id = ${existingExecutor.id}
          `;
        },
        undefined,
        { executorId: existingExecutor.id, chatId },
      );
      // Backfill claude_session_id on legacy rows (pre-fix executors created
      // without one). Idempotent — `updateClaudeSessionId` is a single UPDATE.
      if (claudeSessionId && !existingExecutor.claudeSessionId) {
        await this.safePgCall(
          'tmux-backfill-claude-session-id',
          () => registry.updateClaudeSessionId(existingExecutor.id, claudeSessionId),
          undefined,
          { executorId: existingExecutor.id, chatId },
        );
      }
      return { executorId: existingExecutor.id, agentId: agent.id };
    }

    // CREATE PATH — fresh chat (no prior executor). Persist the
    // claude_session_id so the next respawn finds it.
    const executor = await this.safePgCall(
      'tmux-create-executor',
      () =>
        registry.createAndLinkExecutor(agent.id, 'claude', 'tmux', {
          tmuxSession,
          tmuxWindow,
          tmuxPaneId,
          tmuxWindowId: null,
          claudeSessionId,
          metadata: { source: 'omni', chat_id: chatId, instance_id: instanceId },
        }),
      null,
      { chatId },
    );
    return executor ? { executorId: executor.id, agentId: agent.id } : null;
  }

  private async updateState(executorId: string, state: 'running' | 'working' | 'idle', chatId: string): Promise<void> {
    if (!this.safePgCall) return;
    await this.safePgCall(
      'tmux-update-executor-state',
      () => registry.updateExecutorState(executorId, state),
      undefined,
      { executorId, chatId },
    );
  }

  async deliver(session: ExecutorSession, message: OmniMessage): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state?.executorId) await this.updateState(state.executorId, 'working', session.chatId);

    const senderName = message.sender || 'whatsapp-user';
    const turnContext = buildTurnBasedPrompt(senderName, message.instanceId, session.chatId);
    const body = `${turnContext}\n\n---\n\n[${senderName}]: ${message.content}`;

    // Inject directly into the tmux pane — same path spawn() uses for the
    // initial prompt (see line 197) and injectNudge() uses for system nudges.
    // Two-phase send-keys with a 200ms settle between body and Enter: Claude's
    // TUI input buffer can drop the newline if it arrives in the same tmux
    // batch as the text. Matches injectToTmuxPane in protocol-router.ts.
    const paneId = session.tmux?.paneId;
    if (paneId && /^%\d+$/.test(paneId) && (await isPaneAlive(paneId))) {
      try {
        await executeTmux(`send-keys -t '${paneId}' ${shellQuote(body)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await executeTmux(`send-keys -t '${paneId}' Enter`);
      } catch (err) {
        console.error(
          `[claude-code] deliver: send-keys failed for ${session.id} (pane ${paneId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      console.error(
        `[claude-code] deliver: pane unavailable for ${session.id} (paneId=${paneId ?? 'null'}), message lost`,
      );
    }

    session.lastActivityAt = Date.now();
    if (state?.executorId) await this.updateState(state.executorId, 'idle', session.chatId);
  }

  async shutdown(session: ExecutorSession): Promise<void> {
    const state = this.sessions.get(session.id);
    try {
      if (session.tmux) await killWindow(session.tmux.session, session.tmux.window);
    } finally {
      if (state?.executorId && this.safePgCall) {
        await this.safePgCall(
          'tmux-terminate-executor',
          () => registry.terminateExecutor(state.executorId as string),
          undefined,
          { executorId: state.executorId, chatId: session.chatId },
        );
      }
      // Clean up agent registry so deliverToPane() won't try to deliver to a dead pane
      if (state?.agentId && this.safePgCall) {
        await this.safePgCall('tmux-unregister-agent', () => agents.unregister(state.agentId as string), undefined, {
          chatId: session.chatId,
        });
      }
      this.sessions.delete(session.id);
    }
  }

  async isAlive(session: ExecutorSession): Promise<boolean> {
    const paneId = session.tmux?.paneId;
    if (!paneId) return false;
    try {
      const paneAlive = await isPaneAlive(paneId);
      if (!paneAlive) return false;
      return await isPaneProcessRunning(paneId, session.tmux?.processName ?? 'claude');
    } catch {
      return false;
    }
  }

  /**
   * "Busy" = the pane has emitted new bytes since the last sample. We capture
   * the latest 200 lines and fingerprint by `length:tail-128`, which is cheap
   * and avoids hashing whole pane buffers. The first call always returns
   * `true` (no prior fingerprint to compare against) — that matches the
   * intent: the publisher just registered, and the agent is presumed busy
   * until proven otherwise. Subsequent calls compare against the stored
   * fingerprint and update it.
   *
   * Permission-prompt state IS effectively idle (the pane stops producing
   * bytes), so this correctly emits no heartbeat in that case — the user
   * gets nudged, which is the desired behavior per the wish risk table.
   */
  async isBusy(session: ExecutorSession): Promise<boolean> {
    const state = this.sessions.get(session.id);
    const paneId = session.tmux?.paneId;
    if (!state || !paneId) return false;
    let content: string;
    try {
      content = await capturePaneContent(paneId, 200, false);
    } catch {
      return false;
    }
    const fingerprint = `${content.length}:${content.slice(-128)}`;
    const previous = state.lastPaneFingerprint;
    state.lastPaneFingerprint = fingerprint;
    if (previous === null) return true;
    return previous !== fingerprint;
  }
}
