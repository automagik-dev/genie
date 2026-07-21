// chat-room.ts — the COMPOSITION-ROOT glue that binds the wish group chat to the wire.
//
// This is NOT the chat backend and it is NOT the transport: it is the seam index.ts uses to
// join them, so neither has to import the other (the load-bearing chat wall stays intact —
// chat-backend never imports transport, transport never imports chat-backend). It owns the
// wish-scoped room state the backend is deliberately free of: the per-wish transcript, the
// human/agent line history, and the mapping from a hired pane to a registered chat agent.
//
// Flow:
//   send(wish, text)  → append the human line, deliver the message + prior transcript to each
//                       @-mentioned agent IN THIS WISH (wish-scoped @-mention-only routing),
//                       and emit the human line for broadcast.
//   backend events    → forwarded to the drawer as CHAT_EVENT (chunks + named fail-loud
//                       events), and on reply-done the assembled agent line is appended to the
//                       transcript and emitted as a CHAT_MESSAGE.

import { badgesFor } from '../capability-table';
import { ChatBackend, type ChatBackendOptions, type ChatEvent, parseMentions } from './chat-backend';
import type { PaneSpec } from './fleet-config';
import { type WishContext, wishContext } from './genie-lane';
import type { ChatAgentRow, ChatEventWire, ChatLine, ServerMsg } from './transport';

/** A hired agent's chat registration derived from its pane. */
interface RoomAgent {
  id: string;
  name: string;
  wish: string;
}

export interface ChatRoomOptions extends ChatBackendOptions {
  /** Resolve a wish's seed context; injectable for tests. Defaults to genie-lane. */
  seedContext?: (wish: string) => string;
}

/** Build the D6 seed string for a wish from its genie-lane context (best-effort). */
function defaultSeed(wish: string): string {
  try {
    const ctx: WishContext = wishContext(wish);
    const title = ctx.wish?.title ?? wish;
    const status = ctx.wish?.status ? ` [${ctx.wish.status}]` : '';
    const groups = ctx.groups.map((g) => `- ${g.name}: ${g.status}`).join('\n');
    return `Wish: ${title}${status}\n${groups}`.trim();
  } catch {
    return `Wish: ${wish}`;
  }
}

export class ChatRoom {
  private readonly backend: ChatBackend;
  private readonly agents = new Map<string, RoomAgent>();
  private readonly transcripts = new Map<string, ChatLine[]>();
  private readonly replyBuffers = new Map<string, string>();
  private readonly roster: ChatAgentRow[] = [];
  private sink: (msg: ServerMsg) => void = () => {};

  constructor(fleet: PaneSpec[], opts: ChatRoomOptions = {}) {
    this.backend = new ChatBackend(opts);
    const seed = opts.seedContext ?? defaultSeed;
    for (const pane of fleet) {
      if (!pane.harness) continue; // terminal-only pane → no chat face
      this.agents.set(pane.id, { id: pane.id, name: pane.name, wish: pane.wishId ?? '' });
      this.roster.push({
        id: pane.id,
        name: pane.name,
        harness: pane.harness,
        badges: badgesFor(pane.harness),
        wish: pane.wishId,
      });
      this.backend.registerAgent({
        agentId: pane.id,
        harness: pane.harness,
        cwd: pane.cwd, // both faces share the pane's worktree (the coherence contract)
        wishContext: pane.wishId ? seed(pane.wishId) : '',
      });
    }
    this.backend.onEvent((e) => this.onBackendEvent(e));
  }

  /** The drawer roster: every hired agent with a chat face + its minimal badges. */
  agentRoster(): ChatAgentRow[] {
    return this.roster;
  }

  /** The full room history (all wishes) for replay on a fresh client attach. */
  history(): ChatLine[] {
    const all: ChatLine[] = [];
    for (const lines of this.transcripts.values()) all.push(...lines);
    return all;
  }

  /** Register the outbound sink (index.ts broadcasts whatever the room emits). */
  onOutbound(sink: (msg: ServerMsg) => void): void {
    this.sink = sink;
  }

  /**
   * A human line typed into wish `wish`'s drawer. Appends it to the transcript, emits it for
   * broadcast, and delivers it (with the PRIOR transcript) to every @-mentioned agent scoped
   * to this wish. @-mention-only (D4): unmentioned agents get nothing; a mention that is not
   * a hired agent of this wish is ignored (visible history, not an error).
   */
  send(wish: string, text: string): void {
    const priorTranscript = this.renderTranscript(wish);
    const line: ChatLine = { wish, from: 'human', text };
    this.appendLine(line);
    this.sink({ t: 'chat-message', line });
    for (const id of parseMentions(text)) {
      const agent = this.agents.get(id);
      if (agent && agent.wish === wish) this.backend.deliverMessage(id, text, priorTranscript);
    }
  }

  shutdown(): void {
    this.backend.shutdown();
  }

  // --- internals ---

  private appendLine(line: ChatLine): void {
    const lines = this.transcripts.get(line.wish) ?? [];
    lines.push(line);
    this.transcripts.set(line.wish, lines);
  }

  private renderTranscript(wish: string): string {
    return (this.transcripts.get(wish) ?? []).map((l) => `${l.from}: ${l.text}`).join('\n');
  }

  private onBackendEvent(e: ChatEvent): void {
    const wish = this.agents.get(e.agentId)?.wish ?? '';
    if (e.type === 'message-chunk') this.replyBuffers.set(e.agentId, (this.replyBuffers.get(e.agentId) ?? '') + e.text);
    if (e.type === 'reply-done') this.finalizeReply(e.agentId, wish);
    this.sink({ t: 'chat-event', wish, event: toWire(e) });
  }

  private finalizeReply(agentId: string, wish: string): void {
    const text = this.replyBuffers.get(agentId) ?? '';
    this.replyBuffers.delete(agentId);
    if (!text) return;
    const line: ChatLine = { wish, from: agentId, text };
    this.appendLine(line);
    this.sink({ t: 'chat-message', line });
  }
}

/** Map a backend ChatEvent onto its wire form (the drawer's CHAT_EVENT payload). */
function toWire(e: ChatEvent): ChatEventWire {
  switch (e.type) {
    case 'message-chunk':
      return { kind: 'message-chunk', agentId: e.agentId, text: e.text };
    case 'thought-chunk':
      return { kind: 'thought-chunk', agentId: e.agentId, text: e.text };
    case 'reply-done':
      return { kind: 'reply-done', agentId: e.agentId, stopReason: e.stopReason };
    case 'spawn-failed':
      return { kind: 'spawn-failed', agentId: e.agentId, message: e.message };
    case 'delivery-failed':
      return { kind: 'delivery-failed', agentId: e.agentId, message: e.message };
  }
}
