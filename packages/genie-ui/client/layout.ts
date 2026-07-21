// layout.ts — vanilla reimplementation of Lane A's grid concept: tabs (swap the
// visible agent), horizontal splits (2+ panes side by side), and maximize (one cell
// fills the stage). Panes stay mounted; the layout only toggles CSS visibility, so
// switching never loses scrollback. Rendering only — talks to no server module.

import type { Pane } from './pane';

const MAX_CELLS = 4;

export class LayoutManager {
  private stage: HTMLElement;
  private panes = new Map<string, Pane>();
  private fleetOrder: string[] = [];
  private cells: string[] = [];
  private maximizedId: string | null = null;
  private activeId: string | null = null;
  private onActive: (id: string) => void;

  constructor(stage: HTMLElement, onActive: (id: string) => void) {
    this.stage = stage;
    this.onActive = onActive;
  }

  register(pane: Pane): void {
    this.panes.set(pane.id, pane);
    pane.cell.style.display = 'none';
    this.stage.appendChild(pane.cell);
    this.fleetOrder = [...this.panes.keys()];
    if (!this.activeId) this.solo(pane.id);
  }

  /** Tab click: show this pane alone (swap the agent in view). */
  solo(id: string): void {
    if (!this.panes.has(id)) return;
    this.cells = [id];
    this.maximizedId = null;
    this.activeId = id;
    this.render();
  }

  /** Add the next fleet pane not already visible, beside the current cells. */
  split(id: string): void {
    if (this.maximizedId) this.maximizedId = null;
    if (!this.cells.includes(id)) this.cells = [id];
    if (this.cells.length >= MAX_CELLS) return;
    const next = this.fleetOrder.find((f) => !this.cells.includes(f));
    if (next) this.cells.push(next);
    this.activeId = id;
    this.render();
  }

  /** Toggle a single cell filling the stage. */
  maximize(id: string): void {
    this.maximizedId = this.maximizedId === id ? null : id;
    if (!this.cells.includes(id)) this.cells = [id];
    this.activeId = id;
    this.render();
  }

  /** Remove a cell from the split; never leave the stage empty. */
  close(id: string): void {
    if (this.maximizedId === id) this.maximizedId = null;
    this.cells = this.cells.filter((c) => c !== id);
    if (this.cells.length === 0) {
      const fallback = this.fleetOrder[0];
      if (fallback) this.cells = [fallback];
    }
    this.activeId = this.cells[0] ?? null;
    this.render();
  }

  focus(id: string): void {
    if (!this.visibleIds().includes(id)) {
      this.solo(id);
      return;
    }
    this.activeId = id;
    this.render();
  }

  private visibleIds(): string[] {
    return this.maximizedId ? [this.maximizedId] : this.cells;
  }

  private render(): void {
    const shown = this.visibleIds();
    for (const [id, pane] of this.panes) {
      const visible = shown.includes(id);
      pane.cell.style.display = visible ? 'flex' : 'none';
      pane.cell.classList.toggle('active', id === this.activeId);
    }
    if (this.activeId) this.onActive(this.activeId);
    // Let CSS apply the new layout before measuring, then fit each shown pane.
    requestAnimationFrame(() => {
      for (const id of shown) this.panes.get(id)?.refit();
      if (this.activeId) this.panes.get(this.activeId)?.focus();
    });
  }
}
