/**
 * Browser half of the Genie plugin for DSH Web. Registers two global panels:
 * Board and Workflows. Each is one `sidebar.panellist` icon entry plus
 * one `main` keyed panel with the same id, exactly how the DSH sidebar shell
 * expects plugins to add navigation.
 *
 * ONE bundle, ONE `exports["./client"]`. The host half is three cordis rows, but
 * the client half deliberately is not: DSH's `dsh-client-modules` keys its
 * module table by PACKAGE name (lib/index.js l.825) and resolves only
 * `exports["./client"]` (`clientExportOf`, l.155-165), while
 * `exactPackageSpecifier` (l.132-138) returns undefined for a three-segment
 * scoped specifier — so a subpath-only row resolves no client half at all.
 * Instead each panel is its own labelled `ctx.effect` inside this single
 * bundle, gated on what the manager row reports as `mounted`, never on loader
 * row state. See README.md for the full decision.
 */
import { createElement } from 'react';
import { BoardPanel } from './BoardPanel';
import { WorkflowsPanel } from './CatalogPanel';
import { api } from './api';
import { IconBoard16, IconWorkflows16 } from './icons';
import { css } from './styles';

interface IconOwnerProps {
  size: number;
  active: boolean;
}
interface SlotRegistration {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string;
}
interface ClientContext {
  slots: {
    inject(slot: string, register: () => () => void): void;
    register(options: SlotRegistration, component: (props: never) => unknown): () => void;
    entriesOfSlot?(slot: string): readonly { options?: { id?: string } }[];
  };
  effect(effect: () => () => void, label?: string): void;
}

/** Services required for slot registration. */
export const inject = ['slots'];

type PanelKey = 'board' | 'workflows';

const PANELS = [
  { key: 'board', id: 'genie-board', order: 10, label: 'Genie board', icon: IconBoard16, panel: BoardPanel },
  {
    key: 'workflows',
    id: 'genie-workflows',
    order: 12,
    label: 'Workflows',
    icon: IconWorkflows16,
    panel: WorkflowsPanel,
  },
] as const satisfies readonly {
  key: PanelKey;
  id: string;
  order: number;
  label: string;
  icon: unknown;
  panel: unknown;
}[];

/**
 * Refuse to own a panel id another plugin already registered. Reading the slot
 * is best-effort: a DSH without `entriesOfSlot` reports no occupancy, which
 * keeps today's behaviour rather than silently dropping every panel.
 */
export function occupiedBy(ctx: ClientContext, slot: string, id: string): boolean {
  const read = ctx.slots.entriesOfSlot;
  if (typeof read !== 'function') return false;
  try {
    return (read.call(ctx.slots, slot) ?? []).some((entry) => entry?.options?.id === id);
  } catch {
    return false;
  }
}

function registerPanel(ctx: ClientContext, panel: (typeof PANELS)[number]): () => void {
  if (occupiedBy(ctx, 'sidebar.panellist', panel.id)) {
    console.warn(`[@automagik/genie-dsh-board] sidebar panel "${panel.id}" is already registered; leaving it alone.`);
    return () => {};
  }
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: panel.id }, panel.panel as (props: never) => unknown),
  );
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: panel.id, order: panel.order, label: panel.label }, ((
      props: IconOwnerProps,
    ) => createElement(panel.icon, { size: props.size })) as (props: never) => unknown),
  );
  return () => {};
}

/**
 * Which sub-rows the manager says are mounted. A profile that disabled a row by
 * id must not leave a panel behind that 404s on its first request, so the
 * answer comes from the Host, once, at apply.
 */
async function mountedRows(): Promise<Record<PanelKey, boolean>> {
  try {
    const health = await api.health();
    const mounted = health.mounted;
    // A Host older than the row split reports no `mounted` at all; its single
    // row served every route, so every panel is correct there.
    if (!mounted) return { board: true, workflows: true };
    return { board: !!mounted.board, workflows: !!mounted.workflows };
  } catch {
    // Health itself is unreachable. Register everything: the panels render
    // their own error state, which is more useful than an empty sidebar.
    return { board: true, workflows: true };
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@automagik/genie-dsh-board';
    tag.textContent = css;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, 'genie: stylesheet');
  let live = true;
  ctx.effect(
    () => () => {
      live = false;
    },
    'genie: panel gating',
  );
  void mountedRows().then((mounted) => {
    if (!live) return;
    for (const panel of PANELS) {
      if (!mounted[panel.key]) continue;
      ctx.effect(() => registerPanel(ctx, panel), `genie: ${panel.key} panel`);
    }
  });
}
