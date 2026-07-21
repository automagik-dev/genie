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
import { WishMenu, type WishSelection } from './wish-menu';

const tabsEl = document.getElementById('tabs') as HTMLElement;
const stageEl = document.getElementById('stage') as HTMLElement;
const connEl = document.getElementById('conn') as HTMLElement;
const metaEl = document.getElementById('active-meta') as HTMLElement;
const wishesEl = document.getElementById('wishes') as HTMLElement;

const panes = new Map<string, Pane>();
const infos = new Map<string, PaneInfo>();
const tabs = new Map<string, HTMLButtonElement>();
let activeId: string | null = null;
// The genie lane (G2): null ⇒ show the whole fleet; a slug ⇒ show only that wish's hires.
let activeWish: WishSelection = null;

// Escape config-/state-derived strings before they touch innerHTML. Trusted today
// (operator owns fleet.json), but G2 feeds this strip from genie state (wish slugs,
// markdown-derived roles) per the SEAM above — a wish title must not inject markup.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const layout = new LayoutManager(stageEl, (id) => {
  activeId = id;
  syncTabs();
  renderMeta(id);
});

const wishMenu = new WishMenu(wishesEl, (slug) => selectWish(slug));

const transport = new Transport({
  onOpen: () => setConn(true),
  onClose: () => setConn(false),
  onFleet: (list) => syncFleet(list),
  onReplay: (id, data) => panes.get(id)?.write(data),
  onData: (id, data) => panes.get(id)?.write(data),
  onStatus: (id, status) => updateStatus(id, status),
  onExit: (id, code) => updateStatus(id, 'exited', code),
  onWishes: (wishes) => wishMenu.setWishes(wishes),
  onWishContext: (context) => wishMenu.setContext(context),
});

/**
 * Select a wish in the left lane: open its worktree-bound context (server reads it
 * read-only from genie.db) and filter the tab strip to that wish's hired agents (panes
 * whose `wishId` matches). `null` restores the whole fleet. A pane with no `wishId` belongs
 * to no wish, so it is hidden under a wish filter and shown only in "All fleet".
 */
function selectWish(slug: WishSelection): void {
  activeWish = slug;
  if (slug !== null) transport.wishOpen(slug);
  applyWishFilter();
}

/** Whether a pane is visible under the current wish filter. */
function paneInWish(info: PaneInfo): boolean {
  return activeWish === null || info.wishId === activeWish;
}

/** Show/hide tabs by the wish filter; solo the first visible pane if the active one is hidden. */
function applyWishFilter(): void {
  let firstVisible: string | null = null;
  for (const [id, btn] of tabs) {
    const info = infos.get(id);
    const visible = info ? paneInWish(info) : true;
    btn.style.display = visible ? '' : 'none';
    if (visible && firstVisible === null) firstVisible = id;
  }
  const activeInfo = activeId ? infos.get(activeId) : undefined;
  if (firstVisible && (!activeInfo || !paneInWish(activeInfo))) layout.solo(firstVisible);
}

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
  // Keep the tab strip consistent with the active wish filter when panes (re)arrive.
  if (activeWish !== null) applyWishFilter();
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
  const role = info.role ? `<span class="role">${esc(info.role)}</span>` : '';
  btn.innerHTML = `<span class="dot ${info.status}"></span><span class="tname">${esc(info.name)}</span>${role}`;
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
  const cmd = `${esc(info.command)} ${info.args.map(esc).join(' ')}`.trim();
  const exit = info.status === 'exited' && info.exitCode !== null ? ` (exit ${info.exitCode})` : '';
  const wish = info.wishId ? ` · wish <code>${esc(info.wishId)}</code>` : '';
  metaEl.innerHTML = `<b>${esc(info.name)}</b> · <code>${cmd}</code> · ${info.status}${exit}${wish}`;
}
