// transport.ts — the wire protocol as a pure codec + constants so the server
// (index.ts) and the browser client agree on one message shape. Swapping ws for
// SSE/WebTransport later means reimplementing only send/recv, not the schema.
// Serialization only: knows PtySessionManager's event shape, not node-pty or ACP.
//
// Client -> Server:
//   { t: 'input',   id, data }          keystrokes
//   { t: 'resize',  id, cols, rows }    fit-addon geometry
//   { t: 'spawn',   id }                (re)start an idle/exited pane
//   { t: 'kill',    id }
//   { t: 'restart', id }
//   { t: 'list' }                       request the fleet snapshot
//
// Server -> Client:
//   { t: 'fleet',  panes: PaneInfo[] }  full roster + statuses
//   { t: 'replay', id, data }           snapshot dump on attach (from TerminalMirror)
//   { t: 'data',   id, data }           live pty bytes
//   { t: 'status', id, status }         idle | running | exited
//   { t: 'exit',   id, code }

export const MSG = Object.freeze({
  INPUT: 'input',
  RESIZE: 'resize',
  SPAWN: 'spawn',
  KILL: 'kill',
  RESTART: 'restart',
  LIST: 'list',
  FLEET: 'fleet',
  REPLAY: 'replay',
  DATA: 'data',
  STATUS: 'status',
  EXIT: 'exit',
  // G2 (genie lane): the left menu's wish list + a selected wish's worktree-bound context.
  // Serialization only — the schema stays agnostic of genie-lane's internals (index.ts maps
  // its WishSummary/WishContext onto these rows).
  WISHES: 'wishes',
  WISH_OPEN: 'wish-open',
  WISH_CONTEXT: 'wish-context',
  // G3 (ACP control channel): the wish group chat. Serialization ONLY — the schema knows
  // NOTHING about chat-backend's internals; index.ts (the composition root) maps
  // chat-backend's ChatEvents onto CHAT_EVENT and routes CHAT_SEND into it. This keeps the
  // chat wall intact: transport never imports chat-backend, chat-backend never imports transport.
  CHAT_ROSTER: 'chat-roster', // server → client: which hired agents have a chat face + badges
  CHAT_SEND: 'chat-send', // client → server: a human line typed into the drawer
  CHAT_MESSAGE: 'chat-message', // server → client: a completed room line (human or agent)
  CHAT_EVENT: 'chat-event', // server → client: a streamed chat event (chunk / done / fail-loud)
} as const);

export type SessionStatus = 'idle' | 'running' | 'exited';

/** Which real harness a chat agent runs — mirrors genie-lane's `Harness`. */
export type HarnessName = 'claude' | 'codex' | 'hermes' | 'rlmx';

/** A hired agent that has a read-only ACP chat face, rendered in the drawer's roster (G3). */
export interface ChatAgentRow {
  id: string;
  name: string;
  harness: HarnessName;
  /** Minimal hire-time badges from the capability table ("shared memory" for Hermes only). */
  badges: string[];
  /** The wish this agent's chat face is scoped to. */
  wish: string | null;
}

/** A completed room line rendered in the drawer transcript (G3). */
export interface ChatLine {
  wish: string;
  from: string; // 'human' or an agent id
  text: string;
}

/**
 * A streamed chat event mapped 1:1 from chat-backend's `ChatEvent` (the composition root does
 * the mapping — transport never imports chat-backend). The named fail-loud variants
 * (`spawn-failed` / `delivery-failed`) are what the drawer renders instead of silence (D9).
 */
export type ChatEventWire =
  | { kind: 'message-chunk'; agentId: string; text: string }
  | { kind: 'thought-chunk'; agentId: string; text: string }
  | { kind: 'reply-done'; agentId: string; stopReason: string }
  | { kind: 'spawn-failed'; agentId: string; message: string }
  | { kind: 'delivery-failed'; agentId: string; message: string };

/** One row of the genie-lane left menu (G2). */
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

/** The worktree-bound context selecting a wish opens: its group + task state (G2). */
export interface WishContextMsg {
  slug: string;
  groups: WishGroupRow[];
  taskCount: number;
}

/** The roster row the client renders as a tab. */
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

export type ClientMsg =
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'spawn'; id: string }
  | { t: 'kill'; id: string }
  | { t: 'restart'; id: string }
  | { t: 'list' }
  | { t: 'wish-open'; slug: string }
  | { t: 'chat-send'; wish: string; text: string };

export type ServerMsg =
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

export function encode(obj: ServerMsg | ClientMsg): string {
  return JSON.stringify(obj);
}

export function decode(raw: string): ClientMsg | null {
  try {
    return JSON.parse(raw) as ClientMsg;
  } catch {
    return null;
  }
}
