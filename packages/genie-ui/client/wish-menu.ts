// wish-menu.ts — the genie lane's left menu (G2): lists genie WISHES (replacing dash's
// Projects) and, on select, opens that wish's worktree-bound context by filtering the tab
// strip down to the wish's hired agents (panes whose `wishId` matches). "All fleet" resets.
//
// Rendering only. The data arrives over `transport` (server/genie-lane.ts is the source of
// truth); this module never touches the PTY layer or genie state directly. Wish
// slugs/titles are markdown-derived, so every rendered string is escaped before innerHTML.

import type { WishContextMsg, WishRow } from './transport';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** null ⇒ "All fleet" (no wish filter); a slug ⇒ show only that wish's hired agents. */
export type WishSelection = string | null;

export class WishMenu {
  private root: HTMLElement;
  private onSelect: (slug: WishSelection) => void;
  private wishes: WishRow[] = [];
  private selected: WishSelection = null;
  /** The opened context (groups + task state) for the currently-selected wish. */
  private context: WishContextMsg | null = null;

  constructor(root: HTMLElement, onSelect: (slug: WishSelection) => void) {
    this.root = root;
    this.onSelect = onSelect;
  }

  /** Replace the menu with a fresh wish list (server pushes this on attach). */
  setWishes(wishes: WishRow[]): void {
    this.wishes = wishes;
    if (this.selected && !wishes.some((w) => w.slug === this.selected)) {
      this.selected = null;
      this.context = null;
    }
    this.render();
  }

  /** Apply a wish's opened worktree-bound context (server reply to a selection). */
  setContext(context: WishContextMsg): void {
    // Ignore a stale reply for a wish the operator already navigated away from.
    if (context.slug !== this.selected) return;
    this.context = context;
    this.render();
  }

  private select(slug: WishSelection): void {
    this.selected = slug;
    this.context = null;
    this.render();
    this.onSelect(slug);
  }

  private render(): void {
    this.root.replaceChildren();
    this.root.appendChild(this.item(null, 'All fleet', ''));
    for (const w of this.wishes) {
      this.root.appendChild(this.item(w.slug, w.title || w.slug, w.status));
      if (w.slug === this.selected && this.context) this.root.appendChild(this.contextPanel(this.context));
    }
  }

  private item(slug: WishSelection, label: string, status: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'wish';
    btn.classList.toggle('active', slug === this.selected);
    const badge = status ? `<span class="wstatus">${esc(status)}</span>` : '';
    btn.innerHTML = `<span class="wname">${esc(label)}</span>${badge}`;
    btn.onclick = () => this.select(slug);
    return btn;
  }

  /** The opened wish's worktree-bound state: one row per group + a task count. */
  private contextPanel(ctx: WishContextMsg): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'wctx';
    const rows = ctx.groups
      .map(
        (g) =>
          `<div class="wgroup"><span class="gname">${esc(g.name)}</span><span class="gstatus ${esc(g.status)}">${esc(g.status)}</span></div>`,
      )
      .join('');
    const empty = ctx.groups.length === 0 ? '<div class="wgroup dim">no group state</div>' : '';
    panel.innerHTML = `${rows}${empty}<div class="wtasks">${ctx.taskCount} task(s)</div>`;
    return panel;
  }
}
