// transport.ts — browser mirror of server/transport.ts. One WebSocket, typed events.
// Reconnects on drop so the dev loop (and a phone that slept) survives a server
// restart. The client talks to the server EXCLUSIVELY over this protocol.

export type SessionStatus = 'idle' | 'running' | 'exited';

export interface PaneInfo {
  id: string;
  name: string;
  role: string | null;
  wishId: string | null;
  command: string;
  args: string[];
  cwd: string;
  status: SessionStatus;
  exitCode: number | null;
}

/** One row of the genie-lane left menu (G2). Mirrors server/transport.ts `WishRow`. */
export interface WishRow {
  slug: string;
  title: string;
  status: string;
}

/** A wish-group's state row in a wish's opened context (G2). */
export interface WishGroupRow {
  name: string;
  status: string;
  assignee: string | null;
}

/** The worktree-bound context selecting a wish opens (G2). Mirrors server `WishContextMsg`. */
export interface WishContextMsg {
  slug: string;
  groups: WishGroupRow[];
  taskCount: number;
}

/** A hired agent's chat face + minimal badges (G3). Mirrors server `ChatAgentRow`. */
export interface ChatAgentRow {
  id: string;
  name: string;
  harness: 'claude' | 'codex' | 'hermes' | 'rlmx';
  badges: string[];
  wish: string | null;
}

/** A completed room line (G3). Mirrors server `ChatLine`. */
export interface ChatLine {
  wish: string;
  from: string;
  text: string;
}

/** A streamed chat event (G3). Mirrors server `ChatEventWire` — includes the named fail-loud ones. */
export type ChatEventWire =
  | { kind: 'message-chunk'; agentId: string; text: string }
  | { kind: 'thought-chunk'; agentId: string; text: string }
  | { kind: 'reply-done'; agentId: string; stopReason: string }
  | { kind: 'spawn-failed'; agentId: string; message: string }
  | { kind: 'delivery-failed'; agentId: string; message: string };

type ServerMsg =
  | { t: 'fleet'; panes: PaneInfo[] }
  | { t: 'replay'; id: string; data: string }
  | { t: 'data'; id: string; data: string }
  | { t: 'status'; id: string; status: SessionStatus }
  | { t: 'exit'; id: string; code: number }
  | { t: 'wishes'; wishes: WishRow[] }
  | { t: 'wish-context'; context: WishContextMsg }
  | { t: 'chat-roster'; agents: ChatAgentRow[] }
  | { t: 'chat-message'; line: ChatLine }
  | { t: 'chat-event'; wish: string; event: ChatEventWire };

interface Handlers {
  onFleet?: (panes: PaneInfo[]) => void;
  onReplay?: (id: string, data: string) => void;
  onData?: (id: string, data: string) => void;
  onStatus?: (id: string, status: SessionStatus) => void;
  onExit?: (id: string, code: number) => void;
  onWishes?: (wishes: WishRow[]) => void;
  onWishContext?: (context: WishContextMsg) => void;
  onChatRoster?: (agents: ChatAgentRow[]) => void;
  onChatMessage?: (line: ChatLine) => void;
  onChatEvent?: (wish: string, event: ChatEventWire) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

// Same origin as the page — the server serves both the client and the ws upgrade
// on one port (index.ts). Works from mac + phone with no host config.
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

export class Transport {
  private ws: WebSocket | null = null;
  private h: Handlers;

  constructor(handlers: Handlers) {
    this.h = handlers;
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => this.h.onOpen?.();
    ws.onclose = () => {
      this.h.onClose?.();
      setTimeout(() => this.connect(), 1000); // survive server restarts
    };
    ws.onmessage = (ev) => this.dispatch(JSON.parse(ev.data) as ServerMsg);
  }

  private dispatch(m: ServerMsg): void {
    switch (m.t) {
      case 'fleet':
        this.h.onFleet?.(m.panes);
        break;
      case 'replay':
        this.h.onReplay?.(m.id, m.data);
        break;
      case 'data':
        this.h.onData?.(m.id, m.data);
        break;
      case 'status':
        this.h.onStatus?.(m.id, m.status);
        break;
      case 'exit':
        this.h.onExit?.(m.id, m.code);
        break;
      case 'wishes':
        this.h.onWishes?.(m.wishes);
        break;
      case 'wish-context':
        this.h.onWishContext?.(m.context);
        break;
      case 'chat-roster':
        this.h.onChatRoster?.(m.agents);
        break;
      case 'chat-message':
        this.h.onChatMessage?.(m.line);
        break;
      case 'chat-event':
        this.h.onChatEvent?.(m.wish, m.event);
        break;
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  input(id: string, data: string): void {
    this.send({ t: 'input', id, data });
  }
  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows });
  }
  spawn(id: string): void {
    this.send({ t: 'spawn', id });
  }
  kill(id: string): void {
    this.send({ t: 'kill', id });
  }
  restart(id: string): void {
    this.send({ t: 'restart', id });
  }
  /** Open a wish's worktree-bound context (G2 genie lane). */
  wishOpen(slug: string): void {
    this.send({ t: 'wish-open', slug });
  }
  /** Send a human line into a wish's group chat (G3). @-mentions route it to agents. */
  chatSend(wish: string, text: string): void {
    this.send({ t: 'chat-send', wish, text });
  }
}
