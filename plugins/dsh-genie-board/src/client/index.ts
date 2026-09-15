/**
 * Browser half of the Genie plugin for DSH Web. Registers three global
 * panels: Board, Skills and Workflows. Each is one `sidebar.panellist` icon
 * entry plus one `main` keyed panel with the same id, exactly how the DSH
 * sidebar shell expects plugins to add navigation.
 */
import { createElement } from 'react';
import { BoardPanel } from './BoardPanel';
import { SkillsPanel, WorkflowsPanel } from './CatalogPanel';
import { IconBoard16, IconSkills16, IconWorkflows16 } from './icons';
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
  };
  effect(effect: () => () => void, label?: string): void;
}

/** Services required for slot registration. */
export const inject = ['slots'];

const PANELS = [
  { id: 'genie-board', order: 10, label: 'Genie board', icon: IconBoard16, panel: BoardPanel },
  { id: 'genie-skills', order: 11, label: 'Skills', icon: IconSkills16, panel: SkillsPanel },
  { id: 'genie-workflows', order: 12, label: 'Workflows', icon: IconWorkflows16, panel: WorkflowsPanel },
] as const;

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@automagik/genie-dsh-board';
    tag.textContent = css;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, 'genie: stylesheet');
  for (const { id, order, label, icon, panel } of PANELS) {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, panel as (props: never) => unknown));
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, ((props: IconOwnerProps) =>
        createElement(icon, { size: props.size })) as (props: never) => unknown),
    );
  }
}
