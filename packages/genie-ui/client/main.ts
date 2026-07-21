// main.ts — client composition root. Builds a tab per pane, keeps every Pane mounted,
// and routes transport events to the right Pane. The fleet roster drives everything, so
// the UI has no hard-coded knowledge of any agent — add a line to fleet.json and it
// appears. Talks to the server EXCLUSIVELY over `transport`.
//
// SEAM: this tab strip is where the genie lane (G2 — wishes / roster / roles) slots in;
// group tabs by PaneInfo.wishId/role or add a second nav. The pane grid stays as-is.

import { LayoutManager } from './layout';
import { Pane } from './pane';
import { type PaneInfo, type SessionStatus, Transport } from './transport';

const tabsEl = document.getElementById('tabs') as HTMLElement;
const stageEl = document.getElementById('stage') as HTMLElement;
const connEl = document.getElementById('conn') as HTMLElement;
const metaEl = document.getElementById('active-meta') as HTMLElement;

const panes = new Map<string, Pane>();
const infos = new Map<string, PaneInfo>();
const tabs = new Map<string, HTMLButtonElement>();
let activeId: string | null = null;

const layout = new LayoutManager(stageEl, (id) => {
  activeId = id;
  syncTabs();
  renderMeta(id);
});

const transport = new Transport({
  onOpen: () => setConn(true),
  onClose: () => setConn(false),
  onFleet: (list) => syncFleet(list),
  onReplay: (id, data) => panes.get(id)?.write(data),
  onData: (id, data) => panes.get(id)?.write(data),
  onStatus: (id, status) => updateStatus(id, status),
  onExit: (id, code) => updateStatus(id, 'exited', code),
});

function setConn(on: boolean): void {
  connEl.textContent = on ? 'connected' : 'disconnected';
  connEl.className = `conn ${on ? 'on' : 'off'}`;
}

function syncFleet(list: PaneInfo[]): void {
  for (const info of list) {
    infos.set(info.id, info);
    if (panes.has(info.id)) refreshTab(info.id);
    else createPane(info);
  }
}

function createPane(info: PaneInfo): void {
  const pane = new Pane(info, transport, layout);
  panes.set(info.id, pane);
  layout.register(pane);

  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.id = info.id;
  btn.onclick = () => layout.solo(info.id);
  tabsEl.appendChild(btn);
  tabs.set(info.id, btn);
  refreshTab(info.id);
}

function refreshTab(id: string): void {
  const info = infos.get(id);
  const btn = tabs.get(id);
  if (!info || !btn) return;
  const role = info.role ? `<span class="role">${info.role}</span>` : '';
  btn.innerHTML = `<span class="dot ${info.status}"></span><span class="tname">${info.name}</span>${role}`;
  btn.classList.toggle('active', id === activeId);
}

function syncTabs(): void {
  for (const [id, btn] of tabs) btn.classList.toggle('active', id === activeId);
}

function updateStatus(id: string, status: SessionStatus, code?: number): void {
  const info = infos.get(id);
  if (!info) return;
  info.status = status;
  if (code !== undefined) info.exitCode = code;
  panes.get(id)?.setStatus(status);
  refreshTab(id);
  if (id === activeId) renderMeta(id);
}

function renderMeta(id: string): void {
  const info = infos.get(id);
  if (!info) return;
  const cmd = `${info.command} ${info.args.join(' ')}`.trim();
  const exit = info.status === 'exited' && info.exitCode !== null ? ` (exit ${info.exitCode})` : '';
  const wish = info.wishId ? ` · wish <code>${info.wishId}</code>` : '';
  metaEl.innerHTML = `<b>${info.name}</b> · <code>${cmd}</code> · ${info.status}${exit}${wish}`;
}
