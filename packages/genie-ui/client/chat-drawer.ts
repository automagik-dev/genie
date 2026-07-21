// chat-drawer.ts — the wish group chat drawer (G3, the ACP control channel's face).
//
// Rendering only. Data arrives over `transport` (server/chat-room.ts is the source of truth);
// this module never touches the PTY layer, chat-backend, or genie state directly. It is
// wish-scoped: it shows the selected wish's roster + transcript, and a human line is delivered
// @-mention-only (the server routes it). Streamed replies land as live bubbles that commit to
// permanent lines; the NAMED fail-loud events (D9) render as distinct system lines — never
// silence ("@codex could not start: …; check PATH").

import type { ChatAgentRow, ChatEventWire, ChatLine } from './transport';
import type { Transport } from './transport';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** A committed transcript entry (a finished line or a fail-loud system event). */
interface Entry {
  from: string;
  text: string;
  kind: 'human' | 'agent' | 'error';
}

export class ChatDrawer {
  private readonly root: HTMLElement;
  private readonly transport: Transport;
  private readonly log: HTMLElement;
  private readonly rosterEl: HTMLElement;
  private readonly input: HTMLInputElement;
  /** Committed transcript per wish. */
  private readonly entries = new Map<string, Entry[]>();
  /** In-flight streamed reply text per agent (active wish only). */
  private readonly live = new Map<string, string>();
  private roster: ChatAgentRow[] = [];
  private wish: string | null = null;

  constructor(root: HTMLElement, transport: Transport) {
    this.root = root;
    this.transport = transport;
    root.innerHTML = `
      <div class="chat-head"><span class="chat-title">group chat</span><span class="chat-wish"></span></div>
      <div class="chat-roster"></div>
      <div class="chat-log"></div>
      <form class="chat-input"><input type="text" placeholder="@agent message… (@-mention to deliver)" autocomplete="off" /></form>`;
    this.rosterEl = root.querySelector('.chat-roster') as HTMLElement;
    this.log = root.querySelector('.chat-log') as HTMLElement;
    this.input = root.querySelector('input') as HTMLInputElement;
    (root.querySelector('form') as HTMLFormElement).onsubmit = (e) => this.onSubmit(e);
    this.renderWishHead();
  }

  /** The genie lane selected a wish: scope the drawer to it (null ⇒ no wish, chat disabled). */
  setWish(wish: string | null): void {
    this.wish = wish;
    this.live.clear();
    this.renderWishHead();
    this.renderRoster();
    this.render();
  }

  setRoster(agents: ChatAgentRow[]): void {
    this.roster = agents;
    this.renderRoster();
  }

  /** A completed room line (human or agent), also used for history replay on attach. */
  addLine(line: ChatLine): void {
    const kind = line.from === 'human' ? 'human' : 'agent';
    this.commit(line.wish, { from: line.from, text: line.text, kind });
    if (kind === 'agent') this.live.delete(line.from); // committed → drop its live bubble
    if (line.wish === this.wish) this.render();
  }

  /** A streamed chat event: a chunk to a live bubble, or a NAMED fail-loud system line (D9). */
  applyEvent(wish: string, event: ChatEventWire): void {
    if (event.kind === 'message-chunk') this.live.set(event.agentId, (this.live.get(event.agentId) ?? '') + event.text);
    else if (event.kind === 'spawn-failed' || event.kind === 'delivery-failed')
      this.commit(wish, { from: event.agentId, text: event.message, kind: 'error' });
    // reply-done needs no action here — the committed line arrives as a chat-message.
    if (wish === this.wish) this.render();
  }

  // --- internals ---

  private onSubmit(e: Event): void {
    e.preventDefault();
    const text = this.input.value.trim();
    if (!text || !this.wish) return;
    this.transport.chatSend(this.wish, text);
    this.input.value = '';
  }

  private commit(wish: string, entry: Entry): void {
    const list = this.entries.get(wish) ?? [];
    list.push(entry);
    this.entries.set(wish, list);
  }

  private renderWishHead(): void {
    const el = this.root.querySelector('.chat-wish') as HTMLElement;
    el.textContent = this.wish ? this.wish : 'select a wish';
    this.input.disabled = !this.wish;
  }

  private renderRoster(): void {
    const agents = this.roster.filter((a) => this.wish === null || a.wish === this.wish);
    this.rosterEl.innerHTML = agents.map((a) => this.chip(a)).join('');
  }

  private chip(a: ChatAgentRow): string {
    const badges = a.badges.map((b) => `<span class="chat-badge">${esc(b)}</span>`).join('');
    return `<span class="chat-chip" title="${esc(a.harness)}">@${esc(a.id)}${badges}</span>`;
  }

  private render(): void {
    const committed = this.wish ? (this.entries.get(this.wish) ?? []) : [];
    const rows = committed.map((e) => this.lineHtml(e.from, e.text, e.kind));
    for (const [agentId, text] of this.live) rows.push(this.lineHtml(agentId, text, 'agent', true));
    this.log.innerHTML = rows.join('');
    this.log.scrollTop = this.log.scrollHeight;
  }

  private lineHtml(from: string, text: string, kind: Entry['kind'], live = false): string {
    const cls = `chat-line ${kind}${live ? ' live' : ''}`;
    const who = kind === 'human' ? 'you' : from;
    return `<div class="${cls}"><span class="chat-from">${esc(who)}</span><span class="chat-text">${esc(text)}</span></div>`;
  }
}
