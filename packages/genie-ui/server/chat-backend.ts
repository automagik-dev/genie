// chat-backend.ts — the ACP CONTROL CHANNEL and the conductor substrate (G3).
//
// A pool of one read-only ACP `ClientSideConnection` per hired agent. A hired agent is a
// roster row until it is first @-mentioned; on that first mention its ACP face is spawned
// lazily (D6), seeded with the wish context + room transcript (so its first reply is not
// amnesiac), and the message is delivered as an ACP `session/prompt`. Replies stream back
// as chat events assembled from `session/update`. Delivery is @-mention-only (D4): an
// unmentioned agent receives nothing; undelivered chat is visible drawer history, never
// implicit agent context.
//
// THE LOAD-BEARING WALL (D7 / AC6). This module imports NOTHING from the PTY/pane layer —
// not `pty-session`, not `TerminalMirror`, not `transport`, not `client`. Its whole surface
// is "deliver message / stream reply". That is exactly the shape the future conductor wish
// routes on (a `ClientSideConnection`-per-child hub with a routing policy on top), so wish
// one is the LITERAL substrate of wish two — proven by the greppable no-PTY-imports test,
// not by aspiration. The only cross-module import here is the `Harness` TYPE (erased at
// runtime) from `genie-lane` and the checked-in `capability-table` data.
//
// NON-MUTATING (D5 / AC4a / R3). The chat face is read-only: it advertises no filesystem
// write capability and CANCELS every permission request. The terminal face (the PTY tab) is
// the sole worktree mutator; git artifacts are the shared truth across an agent's two faces.
// This defines the two-writers-one-worktree race out of existence.
//
// FAIL-LOUD (D9 / AC5). Lazy spawn moves the failure surface to message-send time. A missing
// adapter, an unlaunched worktree, or a mid-turn crash surface as NAMED chat events
// ("@codex could not start: codex exited (code 127); check PATH"), never silence.
//
// RUNTIME. Ships under node (the server host); tests run under bun. The ACP transport
// (`ndJsonStream` over `Writable.toWeb`/`Readable.toWeb` of a spawned child) is verified to
// work identically under both — no runtime-adaptive branching needed here.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { type CapabilityRow, badgesFor, capabilityRow } from '../capability-table';
import { type Client, ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from './acp';
import type { Harness } from './genie-lane';

// ============================================================================
// Public types — the interface IS the contract (deliver message / stream reply)
// ============================================================================

/** A chat event streamed back for an agent. The named fail-loud variants are greppable. */
export type ChatEvent =
  | { type: 'message-chunk'; agentId: string; text: string }
  | { type: 'thought-chunk'; agentId: string; text: string }
  | { type: 'reply-done'; agentId: string; stopReason: string }
  | { type: 'spawn-failed'; agentId: string; harness: Harness; message: string }
  | { type: 'delivery-failed'; agentId: string; message: string };

/** The command that launches a harness's ACP adapter as a subprocess. */
export interface AcpLaunchSpec {
  command: string;
  args: string[];
}

/** Resolve the ACP adapter launch command for a harness. Injectable for tests + remote/ssh. */
export type AcpLauncher = (harness: Harness) => AcpLaunchSpec;

/**
 * Registering a hired agent: enough to lazily spawn its face on first @-mention. This is a
 * roster row's projection into the chat backend — NO process is created here.
 */
export interface AgentRegistration {
  /** Stable id, also the @-mention token and the transport channel key. */
  agentId: string;
  harness: Harness;
  /**
   * The agent's `genie launch` per-group worktree — both faces `cd` here (the coherence
   * contract). `null` when the group is not launched yet (unbound); a deliver against an
   * unbound agent fails loud rather than minting a stray cwd.
   */
  cwd: string | null;
  /** Wish context injected into the FIRST prompt only (D6 seed — no amnesiac first reply). */
  wishContext: string;
}

/** Injectable knobs for the pool; production uses the defaults. */
export interface ChatBackendOptions {
  /** Adapter launch resolver. Defaults to co-located per-harness commands (R1 fallback). */
  launcher?: AcpLauncher;
  /** Client name advertised in ACP `initialize`. */
  clientName?: string;
}

// ============================================================================
// Default launcher — co-located adapter commands (v1: only viewing crosses ssh)
// ============================================================================

/**
 * The default, co-located ACP adapter command per harness (R1's documented fallback: chat
 * faces run beside the server; only remote VIEWING crosses the wire in v1). A command that
 * is not on PATH is not an error here — it surfaces as a named D9 spawn-failed event at
 * @-mention time. Inject a custom launcher to point at an absolute path or an `ssh …` wrap.
 */
export const defaultAcpLauncher: AcpLauncher = (harness) => {
  switch (harness) {
    case 'claude':
      return { command: 'claude-code-acp', args: [] };
    case 'codex':
      return { command: 'codex-acp', args: [] };
    case 'hermes':
      return { command: 'hermes', args: ['acp'] };
    case 'rlmx':
      return { command: 'rlmx', args: ['acp'] };
  }
};

// ============================================================================
// @-mention parsing — the routing primitive (the conductor wish's "who speaks")
// ============================================================================

/** Extract @-mentioned ids from a message (deduped, order-preserving). @-mention-only (D4). */
export function parseMentions(text: string): string[] {
  const seen = new Set<string>();
  const re = /(?:^|[^\w@])@([a-zA-Z0-9][\w.-]*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) seen.add(m[1]);
  return [...seen];
}

// ============================================================================
// Internal face state
// ============================================================================

interface AgentFace {
  reg: AgentRegistration;
  child: ChildProcessWithoutNullStreams | null;
  conn: ClientSideConnection | null;
  sessionId: string | null;
  /** Resolves once spawn + initialize + session/new have settled (success OR named failure). */
  ready: Promise<void>;
  /** True after a spawn/init failure was emitted — queued prompts skip a dead face. */
  failed: boolean;
  /** True once the wish-context seed has been prepended to a prompt. */
  seeded: boolean;
  /** Per-agent prompt serializer — a second @-mention queues behind the first (rlmx -32600). */
  queue: Promise<void>;
}

// ============================================================================
// The pool
// ============================================================================

export class ChatBackend {
  private readonly launcher: AcpLauncher;
  private readonly clientName: string;
  private readonly registrations = new Map<string, AgentRegistration>();
  private readonly faces = new Map<string, AgentFace>();
  private readonly listeners = new Set<(e: ChatEvent) => void>();

  constructor(opts: ChatBackendOptions = {}) {
    this.launcher = opts.launcher ?? defaultAcpLauncher;
    this.clientName = opts.clientName ?? 'genie-ui-chat-backend';
  }

  /** Register a hired agent (roster projection). NO process is spawned — that is lazy (D6). */
  registerAgent(reg: AgentRegistration): void {
    this.registrations.set(reg.agentId, reg);
  }

  /** The checked-in capability row for a harness (badge + doc source of truth, D10). */
  capabilities(harness: Harness): CapabilityRow {
    return capabilityRow(harness);
  }

  /** The minimal hire-time badges for a harness ("shared memory" for Hermes only). */
  badges(harness: Harness): string[] {
    return badgesFor(harness);
  }

  /** True once an agent's ACP face has been (lazily) spawned. False before the first @-mention. */
  hasFace(agentId: string): boolean {
    return this.faces.has(agentId);
  }

  /** Subscribe to every chat event (the drawer bridge). Returns an unsubscribe function. */
  onEvent(listener: (e: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(e: ChatEvent): void {
    for (const l of this.listeners) l(e);
  }

  /**
   * Route a room message: deliver it (plus the room transcript) to every @-mentioned agent
   * that is on the roster, and return the ids actually delivered to. @-mention-only (D4):
   * an agent not named is not delivered to; a name that is not a hired agent is ignored
   * (visible history, not an error).
   */
  routeMessage(text: string, transcript: string): string[] {
    const delivered: string[] = [];
    for (const id of parseMentions(text)) {
      if (this.registrations.has(id)) {
        this.deliverMessage(id, text, transcript);
        delivered.push(id);
      }
    }
    return delivered;
  }

  /**
   * Deliver one message + room transcript to an agent's chat face, spawning the face lazily
   * on the first call (seeded with wish context). Returns void — the reply and every failure
   * arrive asynchronously as {@link ChatEvent}s on {@link streamReply}/{@link onEvent}.
   * Prompts to one agent are serialized (the second queues), which also sidesteps single-
   * session adapters that reject a concurrent prompt with JSON-RPC -32600 (rlmx).
   */
  deliverMessage(agentId: string, text: string, transcript: string): void {
    const reg = this.registrations.get(agentId);
    if (!reg) {
      this.dispatch({ type: 'delivery-failed', agentId, message: `@${agentId} is not on the roster` });
      return;
    }
    const face = this.faces.get(agentId) ?? this.createFace(reg);
    face.queue = face.queue.then(async () => {
      await face.ready;
      if (face.failed || !face.conn || !face.sessionId) return;
      await this.runPrompt(face, text, transcript);
    });
  }

  /**
   * Per-agent reply stream: an async iterable of this agent's chat events (message chunks,
   * reply-done, and the named fail-loud events). Long-lived — the consumer breaks out when
   * it observes a terminal event. Multiple consumers each see every event (fan-out).
   */
  async *streamReply(agentId: string): AsyncGenerator<ChatEvent> {
    const buffer: ChatEvent[] = [];
    let wake: (() => void) | null = null;
    const unsub = this.onEvent((e) => {
      if (e.agentId !== agentId) return;
      buffer.push(e);
      wake?.();
    });
    const nextTick = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      });
    try {
      while (true) {
        if (buffer.length === 0) await nextTick();
        wake = null;
        while (buffer.length) {
          const next = buffer.shift();
          if (next) yield next;
        }
      }
    } finally {
      unsub();
    }
  }

  /** Kill every spawned face. Registrations remain (they can be re-spawned lazily). */
  shutdown(): void {
    for (const face of this.faces.values()) face.child?.kill('SIGTERM');
    this.faces.clear();
  }

  // --------------------------------------------------------------------------
  // Lazy spawn + ACP wiring
  // --------------------------------------------------------------------------

  private createFace(reg: AgentRegistration): AgentFace {
    const face: AgentFace = {
      reg,
      child: null,
      conn: null,
      sessionId: null,
      ready: Promise.resolve(),
      failed: false,
      seeded: false,
      queue: Promise.resolve(),
    };
    this.faces.set(reg.agentId, face);
    face.ready = this.startFace(face);
    return face;
  }

  /**
   * Spawn the adapter subprocess and complete the ACP handshake (initialize → session/new).
   * Always resolves: any failure is converted to a named spawn-failed event and `face.failed`,
   * so queued prompts skip a dead face instead of hanging.
   */
  private async startFace(face: AgentFace): Promise<void> {
    const { reg } = face;
    if (!reg.cwd) {
      this.failFace(face, `@${reg.agentId} could not start: worktree not launched yet; launch the group first`);
      return;
    }
    const spec = this.launcher(reg.harness);
    try {
      const child = this.spawnChild(face, spec, reg.cwd);
      // `Readable/Writable.toWeb` return node `stream/web` types; `ndJsonStream` wants the
      // DOM `ReadableStream`/`WritableStream`. They are the same objects at runtime (proven
      // under both node and bun) — the cast bridges the nominal lib mismatch only.
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(() => this.buildClient(reg.agentId), stream);
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.clientName, version: '0.1.0' },
      });
      const sess = await conn.newSession({ cwd: reg.cwd, mcpServers: [] });
      if (face.failed) return; // the child died during the handshake
      face.conn = conn;
      face.sessionId = sess.sessionId;
    } catch (err) {
      this.failFace(face, `@${reg.agentId} could not start: ${errText(err)}; check PATH`);
    }
  }

  private spawnChild(face: AgentFace, spec: AcpLaunchSpec, cwd: string): ChildProcessWithoutNullStreams {
    const child = spawn(spec.command, spec.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    face.child = child;
    child.on('error', (err: NodeJS.ErrnoException) => {
      const reason = err.code === 'ENOENT' ? `${spec.command} not found (ENOENT)` : errText(err);
      this.onChildDown(face, `@${face.reg.agentId} could not start: ${reason}; check PATH`);
    });
    child.on('exit', (code) => {
      this.onChildDown(
        face,
        `@${face.reg.agentId} could not start: ${spec.command} exited (code ${code ?? 0}); check PATH`,
      );
    });
    return child;
  }

  /** A child that dies before it was ready is a spawn failure; after ready it is a delivery failure. */
  private onChildDown(face: AgentFace, spawnMessage: string): void {
    if (face.failed) return;
    if (face.conn) {
      face.failed = true;
      this.dispatch({
        type: 'delivery-failed',
        agentId: face.reg.agentId,
        message: `@${face.reg.agentId} disconnected`,
      });
    } else {
      this.failFace(face, spawnMessage);
    }
  }

  private failFace(face: AgentFace, message: string): void {
    if (face.failed) return; // idempotency: one child-down + one handshake-catch must emit ONE spawn-failed
    face.failed = true;
    face.child?.kill('SIGKILL');
    this.dispatch({ type: 'spawn-failed', agentId: face.reg.agentId, harness: face.reg.harness, message });
  }

  /**
   * The read-only ACP client half. It routes agent message/thought chunks to the drawer and
   * CANCELS every permission request — the structural enforcement of the non-mutating chat
   * face (D5/AC4a). It advertises no fs write capability, so a compliant agent never even
   * asks to write.
   */
  private buildClient(agentId: string): Client {
    return {
      sessionUpdate: async (params) => {
        const u = params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text')
          this.dispatch({ type: 'message-chunk', agentId, text: u.content.text });
        else if (u.sessionUpdate === 'agent_thought_chunk' && u.content.type === 'text')
          this.dispatch({ type: 'thought-chunk', agentId, text: u.content.text });
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    };
  }

  private async runPrompt(face: AgentFace, text: string, transcript: string): Promise<void> {
    if (!face.conn || !face.sessionId) return;
    const promptText = this.composePrompt(face, text, transcript);
    try {
      const res = await face.conn.prompt({ sessionId: face.sessionId, prompt: [{ type: 'text', text: promptText }] });
      this.dispatch({ type: 'reply-done', agentId: face.reg.agentId, stopReason: res.stopReason });
    } catch (err) {
      this.dispatch({
        type: 'delivery-failed',
        agentId: face.reg.agentId,
        message: deliveryError(face.reg.agentId, err),
      });
    }
  }

  /**
   * Build the prompt text: on the FIRST prompt, prepend the wish-context seed (D6); always
   * include the room transcript (the @-mention carries context — D4). The chat face is a
   * fresh ACP session, so the transcript is how it sees the room.
   */
  private composePrompt(face: AgentFace, text: string, transcript: string): string {
    const parts: string[] = [];
    if (!face.seeded && face.reg.wishContext.trim()) {
      parts.push(`# Wish context\n${face.reg.wishContext.trim()}`);
      face.seeded = true;
    }
    if (transcript.trim()) parts.push(`# Room transcript\n${transcript.trim()}`);
    parts.push(`# Message to you (@${face.reg.agentId})\n${text.trim()}`);
    return parts.join('\n\n');
  }
}

// ============================================================================
// Error formatting
// ============================================================================

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * A delivery failure message. A single-session adapter (rlmx) rejects a concurrent prompt
 * with JSON-RPC -32600; the per-agent queue already serializes our own prompts, but if the
 * adapter is busy from elsewhere we name it honestly rather than going silent.
 */
function deliveryError(agentId: string, err: unknown): string {
  if (err instanceof RequestError && err.code === -32600)
    return `@${agentId} is busy with another prompt (adapter serialized; -32600) — try again`;
  return `@${agentId} delivery failed: ${errText(err)}`;
}
