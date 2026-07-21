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

type ServerMsg =
  | { t: 'fleet'; panes: PaneInfo[] }
  | { t: 'replay'; id: string; data: string }
  | { t: 'data'; id: string; data: string }
  | { t: 'status'; id: string; status: SessionStatus }
  | { t: 'exit'; id: string; code: number };

interface Handlers {
  onFleet?: (panes: PaneInfo[]) => void;
  onReplay?: (id: string, data: string) => void;
  onData?: (id: string, data: string) => void;
  onStatus?: (id: string, status: SessionStatus) => void;
  onExit?: (id: string, code: number) => void;
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
}
