import type { Aggregate } from './schema';

interface ClientContext {
  effect(effect: () => () => void, label?: string): void;
}
const css = `
.genie-launch{position:fixed;right:20px;bottom:20px;z-index:9000;padding:12px 18px;background:#185a4e;color:white;border:1px solid #398774;border-radius:8px;font:600 15px system-ui;cursor:pointer}
.genie-board{box-sizing:border-box;width:min(1400px,96vw);height:90vh;padding:0;border:1px solid #687a74;border-radius:10px;color:#1d2925;background:#f5f7f6;font:15px system-ui}.genie-board::backdrop{background:#10251cb0}.genie-board *{box-sizing:border-box}.genie-board header{padding:20px 24px;border-bottom:1px solid #cdd8d2;display:flex;align-items:center;gap:14px;flex-wrap:wrap}.genie-board h1{font-size:22px;margin:0 auto 0 0}.genie-board h2{font-size:16px;margin:0 0 16px}.genie-board button,.genie-board select,.genie-board input,.genie-board textarea{font:inherit;border:1px solid #9bafa4;border-radius:5px;padding:8px;background:white;color:inherit}.genie-board button{cursor:pointer}.genie-board button:hover{background:#e4eee8}.genie-board :focus-visible{outline:3px solid #347a69;outline-offset:2px}.genie-board button:disabled{opacity:.55;cursor:wait}.genie-board label{display:flex;gap:6px;align-items:center}.genie-status{min-height:24px;padding:12px 24px}.genie-status[role=alert]{color:#9d2525}.genie-content{display:flex;min-height:60vh;overflow:auto}.genie-lanes{display:flex;gap:16px;padding:0 24px 24px;flex:1;overflow:auto;align-items:flex-start}.genie-lane{flex:1;min-width:220px}.genie-card{display:block;text-align:left;width:100%;margin:0 0 10px;border-left:3px solid #34816b!important;padding:14px!important}.genie-card small{display:block;color:#4c6258;margin-top:8px}.genie-detail{width:360px;flex-shrink:0;padding:0 24px 24px;border-left:1px solid #cdd8d2;overflow:auto}.genie-detail p{white-space:pre-wrap;overflow-wrap:anywhere}.genie-detail h3{font-size:15px;margin:22px 0 8px}.genie-detail textarea{width:100%;min-height:80px}.genie-actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.genie-create{display:flex;gap:8px;padding:0 24px 20px}.genie-create input{flex:1;min-width:0}.genie-empty{color:#52665b;line-height:1.6}.genie-detail ol{padding-left:20px}.genie-detail li{margin-bottom:12px;overflow-wrap:anywhere}@media(max-width:720px){.genie-board{width:100vw;height:100dvh;max-height:none;border-radius:0}.genie-content{display:block}.genie-detail{width:100%;border-left:0;border-top:1px solid #cdd8d2;padding-top:20px}.genie-board header{padding:16px}.genie-board label{width:100%}.genie-board select{flex:1;min-width:0}.genie-lanes{padding-left:16px}.genie-lane{min-width:230px}.genie-launch{bottom:12px;right:12px}}
`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(
    `/api/genie-board/${path}`,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = element('style', css);
    const launch = element('button', 'Genie board');
    launch.className = 'genie-launch';
    const dialog = element('dialog');
    dialog.className = 'genie-board';
    dialog.setAttribute('aria-label', 'Genie board');
    const header = element('header');
    header.append(element('h1', 'Genie board'));
    const workspace = element('select');
    workspace.setAttribute('aria-label', 'Workspace');
    const board = element('select');
    board.setAttribute('aria-label', 'Board');
    for (const [name, control] of [
      ['Workspace', workspace],
      ['Board', board],
    ] as const) {
      const label = element('label', name);
      label.append(control);
      header.append(label);
    }
    const refresh = element('button', 'Refresh');
    const close = element('button', 'Close');
    header.append(refresh, close);
    const status = element('div');
    status.className = 'genie-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const create = element('form');
    create.className = 'genie-create';
    const title = element('input');
    title.placeholder = 'New task title';
    title.setAttribute('aria-label', 'New task title');
    title.required = true;
    const add = element('button', 'Create task');
    create.append(title, add);
    const content = element('div');
    content.className = 'genie-content';
    const lanes = element('div');
    lanes.className = 'genie-lanes';
    const detail = element('aside');
    detail.className = 'genie-detail';
    content.append(lanes, detail);
    dialog.append(header, status, create, content);
    document.head.append(style);
    document.body.append(launch, dialog);
    let snapshot: Aggregate | undefined;
    let selected: string | undefined;
    let busy = false;
    const showStatus = (message: string, error = false) => {
      status.textContent = message;
      status.setAttribute('role', error ? 'alert' : 'status');
    };
    const run = async (operation: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select'))
        control.disabled = true;
      showStatus('Loading…');
      try {
        await operation();
        showStatus('Board confirmed by Genie');
      } catch (error) {
        snapshot = undefined;
        lanes.replaceChildren();
        detail.replaceChildren();
        showStatus(error instanceof Error ? error.message : 'Request failed', true);
      } finally {
        busy = false;
        for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select'))
          control.disabled = false;
      }
    };
    const request = (action: string, extra = {}) =>
      api('action', {
        action,
        workspaceId: workspace.value,
        ...(action === 'list' ? {} : { boardRef: board.value }),
        ...extra,
      });
    const mutate = (action: string, extra = {}) =>
      run(async () => {
        snapshot = (await request(action, extra)) as Aggregate;
        render();
      });
    const render = () => {
      lanes.replaceChildren();
      detail.replaceChildren();
      for (const lane of snapshot?.lanes ?? []) {
        const column = element('section');
        column.className = 'genie-lane';
        column.append(element('h2', `${lane.label ?? lane.name} · ${lane.cards.length}`));
        if (!lane.cards.length) {
          const empty = element('p', 'No tasks');
          empty.className = 'genie-empty';
          column.append(empty);
        }
        for (const card of lane.cards) {
          const button = element('button', card.title);
          button.className = 'genie-card';
          button.append(
            element(
              'small',
              [
                card.status,
                card.claimedBy,
                card.liveness,
                card.enforcedBlock ? `Blocked: ${card.enforcedBlock.reason}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          );
          button.onclick = () => {
            selected = card.id;
            render();
          };
          column.append(button);
        }
        lanes.append(column);
      }
      const card = snapshot?.lanes.flatMap((lane) => lane.cards).find((entry) => entry.id === selected);
      if (!card) {
        detail.append(element('p', 'Select a task to see its details and history.'));
        return;
      }
      detail.append(
        element('h2', card.title),
        element('small', card.id),
        element('p', `${card.status} · ${card.liveness ?? 'Unclaimed'}`),
      );
      if (card.claimedBy) detail.append(element('p', `Owner: ${card.claimedBy} (${card.agentKind ?? 'unknown'})`));
      if (card.assignedAgent)
        detail.append(element('p', `Assigned: ${card.assignedAgent} — ${card.assignedReason ?? ''}`));
      if (card.enforcedBlock)
        detail.append(
          element('p', `${card.enforcedBlock.kind === 'hold' ? 'On hold' : 'Blocked'}: ${card.enforcedBlock.reason}`),
        );
      const destination = element('select');
      destination.setAttribute('aria-label', 'Destination lane');
      for (const lane of snapshot?.lanes ?? []) {
        const option = element('option', lane.label ?? lane.name);
        option.value = lane.name;
        option.selected = lane.name === card.lane;
        destination.append(option);
      }
      const move = element('button', 'Move');
      move.onclick = () => void mutate('move', { id: card.id, lane: destination.value });
      const actions = element('div');
      actions.className = 'genie-actions';
      actions.append(destination, move);
      for (const action of ['checkout', 'release', 'unblock', 'done']) {
        const button = element(
          'button',
          { checkout: 'Claim', release: 'Release', unblock: 'Unblock', done: 'Complete' }[action],
        );
        button.onclick = () => void mutate(action, { id: card.id });
        actions.append(button);
      }
      detail.append(actions);
      const note = element('textarea');
      note.setAttribute('aria-label', 'Comment or block reason');
      detail.append(note);
      const notes = element('div');
      notes.className = 'genie-actions';
      for (const [label, action, hold] of [
        ['Comment', 'comment', false],
        ['Block', 'block', false],
        ['Hold', 'block', true],
      ] as const) {
        const button = element('button', label);
        button.onclick = () =>
          void mutate(action, { id: card.id, text: note.value, ...(action === 'block' ? { hold } : {}) });
        notes.append(button);
      }
      detail.append(notes);
      detail.append(element('h3', 'Dependencies'));
      for (const dependency of card.dependencies)
        detail.append(element('p', `${dependency.title} · ${dependency.status}`));
      if (!card.dependencies.length) detail.append(element('p', 'No dependencies'));
      detail.append(element('h3', 'Comments'));
      for (const comment of card.comments)
        detail.append(element('p', `${comment.author ?? 'Unknown'}: ${comment.note}`));
      detail.append(element('h3', 'History'));
      const history = element('ol');
      for (const event of card.timeline)
        history.append(
          element(
            'li',
            `${new Date(event.createdAt).toLocaleString()} · ${event.kind} · ${event.author ?? 'Unknown'}${event.note ? ` — ${event.note}` : ''}`,
          ),
        );
      detail.append(history);
    };
    const load = async () => {
      if (!board.value) {
        snapshot = undefined;
        render();
        return;
      }
      snapshot = (await request('load')) as Aggregate;
      render();
    };
    const list = async () => {
      const previous = board.value;
      const entries = (await request('list')) as { id: string; name: string }[];
      board.replaceChildren();
      for (const entry of entries) {
        const option = element('option', entry.name);
        option.value = entry.id;
        board.append(option);
      }
      if (entries.some((entry) => entry.id === previous)) board.value = previous;
      await load();
    };
    launch.onclick = () => {
      dialog.showModal();
      void run(async () => {
        const health = (await api('health')) as { compatible: boolean; error: string };
        if (!health.compatible) throw new Error(health.error);
        const entries = (await api('workspaces')) as { id: string; title: string }[];
        workspace.replaceChildren();
        for (const entry of entries) {
          const option = element('option', entry.title);
          option.value = entry.id;
          workspace.append(option);
        }
        if (!entries.length) throw new Error('Add a repository workspace in DSH to open its Genie board.');
        await list();
      });
    };
    close.onclick = () => dialog.close();
    workspace.onchange = () => void run(list);
    board.onchange = () => void run(load);
    refresh.onclick = () => void run(list);
    create.onsubmit = (event) => {
      event.preventDefault();
      void mutate('create', { title: title.value });
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && dialog.open) void run(list);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      style.remove();
      launch.remove();
      dialog.remove();
    };
  }, 'Genie board view');
}
