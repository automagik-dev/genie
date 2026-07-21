// pane.ts — the renderer boundary. One Pane wraps one xterm.js Terminal bound to one
// server session id, inside a "cell" (header + terminal) that the LayoutManager shows,
// hides, splits, or maximizes. Panes stay MOUNTED for their whole lifetime and are
// shown/hidden by CSS — that preserves scrollback + screen across tab/split switches
// (no re-render, no replay needed when flipping between already-open panes).

import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { FitScheduler } from './reused/FitScheduler';
import { Utf8Base64 } from './reused/Utf8Base64';
import type { PaneInfo, SessionStatus, Transport } from './transport';

/** Layout actions a pane's header can trigger (implemented by LayoutManager). */
export interface PaneHost {
  split(id: string): void;
  maximize(id: string): void;
  close(id: string): void;
  focus(id: string): void;
}

export class Pane {
  readonly id: string;
  readonly cell: HTMLDivElement;
  private term: Terminal;
  private fit: FitAddon;
  private transport: Transport;
  private mount: HTMLDivElement;
  private dot: HTMLSpanElement;
  private scheduler: FitScheduler;
  private lastGeom = { cols: 0, rows: 0 };

  constructor(info: PaneInfo, transport: Transport, host: PaneHost) {
    this.id = info.id;
    this.transport = transport;

    this.cell = document.createElement('div');
    this.cell.className = 'cell';
    this.cell.dataset.id = info.id;

    this.dot = document.createElement('span');
    this.cell.appendChild(this.buildHeader(info, host));

    this.mount = document.createElement('div');
    this.mount.className = 'term';
    this.cell.appendChild(this.mount);

    this.term = new Terminal({
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: '#0b0e14', foreground: '#c5c8c6', cursor: '#e06c75' },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    // OSC 52 copy/paste with UTF-8-correct base64 (salvaged Utf8Base64).
    this.term.loadAddon(new ClipboardAddon(new Utf8Base64()));
    this.term.open(this.mount);
    this.term.onData((data) => this.transport.input(this.id, data));

    // Debounced fit (salvaged FitScheduler): cancel any fit scheduled while the
    // cell is collapsing so FitAddon never clamps a hidden cell to 1 row.
    this.scheduler = new FitScheduler(() => this.refit(), 60);
    new ResizeObserver((entries) => {
      this.scheduler.onResize(entries[0].contentRect.height);
    }).observe(this.mount);
  }

  private buildHeader(info: PaneInfo, host: PaneHost): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'cell-head';
    this.dot.className = `dot ${info.status}`;

    const name = document.createElement('span');
    name.className = 'cname';
    name.textContent = info.name;

    header.append(this.dot, name);
    if (info.role) {
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = info.role;
      header.appendChild(role);
    }

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    header.appendChild(spacer);

    header.appendChild(this.button('start', 'act', () => this.transport.spawn(this.id)));
    header.appendChild(this.button('restart', 'act', () => this.doRestart()));
    header.appendChild(this.button('kill', 'act danger', () => this.transport.kill(this.id)));
    header.appendChild(this.button('split', 'act', () => host.split(this.id)));
    header.appendChild(this.button('max', 'act', () => host.maximize(this.id)));
    header.appendChild(this.button('×', 'act', () => host.close(this.id)));

    header.onclick = () => host.focus(this.id);
    return header;
  }

  private button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `${cls}`;
    b.textContent = label;
    b.onclick = (ev) => {
      ev.stopPropagation();
      onClick();
    };
    return b;
  }

  private doRestart(): void {
    this.clear();
    this.transport.restart(this.id);
  }

  write(data: string): void {
    this.term.write(data);
  }

  setStatus(status: SessionStatus): void {
    this.dot.className = `dot ${status}`;
  }

  /** Fit to the container and push the new geometry to the pty (idempotent). */
  refit(): void {
    if (this.mount.clientWidth === 0) return; // hidden cells have no box to measure
    try {
      this.fit.fit();
    } catch {
      return;
    }
    const { cols, rows } = this.term;
    if (cols !== this.lastGeom.cols || rows !== this.lastGeom.rows) {
      this.lastGeom = { cols, rows };
      this.transport.resize(this.id, cols, rows);
    }
  }

  clear(): void {
    this.term.reset();
  }

  focus(): void {
    this.term.focus();
  }
}
