// The Tasks board, read-only: one board per Genie project (a local space folder holding
// `.genie/genie.db`). Tasks come only from `genie-rs list --json --project <p>`; cost and time
// only from usagemeter's `herdr-meter` doc. While the tab is mounted it refreshes each minute and
// runs forge-sync on a budget (data.js `planTick`). `mod.open:genie-herdr` (the footer's Tasks
// entry) opens a 1×1 popup copy of this mod that toggles the tab, refreshes the badge from `list`
// alone and closes itself. The rules live in data.js; this file only spawns and draws.
import { h_flex, v_flex } from 'gpui-base';
import { View, div, svg } from 'gpui-kit';
import {
  appHome,
  closeOverlay,
  exec,
  focused,
  home,
  nextCommand,
  panes,
  props,
  run,
  setShared,
  settings,
  shared,
  spaces,
  terminals,
  theme,
} from 'herdr';
import {
  MOD,
  PROBE_SCRIPT,
  TICK_MS,
  feedRows,
  fmtMin,
  fmtUsd,
  focusedProjectOf,
  forgeNote,
  lanesOf,
  listAge,
  localFolders,
  missingBinaryLine,
  newModel,
  publishWaiting,
  refresh,
  shownProjects,
  skipWhileBusy,
  terminalFor,
  waitingOf,
} from './data.js';

const DRAWER = 360;
const ID_BLUE = '#76a8ff';
const AMBER = '#f1c252';
const AMBER_LINE = '#a37a29';
const LATE = '#e9625a';

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // per viewer only
    }
  },
};

const baseName = (p) =>
  String(p ?? '')
    .replace(/\/+$/, '')
    .split('/')
    .pop() || p;
const when = (at) =>
  at
    ? String(at)
        .replace('T', ' ')
        .replace(/\.\d+Z$|Z$/, '')
    : '–';

// Same rule as spaces-agents' rows: a pane shows the terminal → agent.focus; none does → peek.
function focusTerminal(terminal) {
  const shown = panes().some((p) => p.terminal === terminal);
  run(shown ? 'agent.focus' : 'terminal.peek', { terminal });
}

// Open the Tasks tab, or go back to where the person was when it is already the shown tab.
export function toggleTasks() {
  const f = focused();
  const mine = panes().find((p) => p.mod === MOD);
  const spaceOf = (tab) => spaces().find((s) => s.tabs?.some((t) => t.id === tab));
  if (mine && f?.tab === mine.tab) {
    const prev = /** @type {{space?: string, tab?: string} | null} */ (shared(`${MOD}.prev`));
    const space = spaceOf(mine.tab);
    if (prev?.space && prev.space !== space?.id) run('space.select', { id: prev.space });
    if (prev?.tab && prev.tab !== mine.tab) run('tab.select', { id: prev.tab });
    // Closing a space's only tab closes the space: keep it then.
    if ((space?.tabs?.length ?? 1) > 1) run('tab.close', { id: mine.tab, confirmed: true });
    return;
  }
  if (f?.tab) setShared(`${MOD}.prev`, { space: f.space, tab: f.tab });
  if (mine) {
    const space = spaceOf(mine.tab);
    if (space && space.id !== f?.space) run('space.select', { id: space.id });
    run('tab.select', { id: mine.tab });
  } else {
    run('tab.new', { name: 'Tasks', mod: MOD });
  }
}

export default class Tasks extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    // The board's model (data.js `newModel`): what one refresh leaves for the next.
    this.m = newModel();
    this.tick = skipWhileBusy((acx, opts) => this.refresh(acx, opts));
    if (this.overlay) {
      // Opened by mod.open: toggle the tab, refresh the badge from `list` alone (A11), go away.
      cx.spawn(async (acx) => {
        toggleTasks();
        try {
          await this.refresh(acx, { sync: false, feed: false });
        } catch {
          // the badge keeps its value
        }
        closeOverlay(this.overlay);
      });
      return;
    }
    this.proj = store.get('proj', null);
    this.selected = store.get('selected', {}); // project -> card key
    this.copied = null;
    this.handle = cx.focus_handle();
    this.tick(cx);
    cx.timer.every(TICK_MS, (acx) => this.tick(acx));
    cx.spawn(async (acx) => {
      for (;;) {
        if ((await nextCommand()) === 'focus') {
          this.handle.focus();
          acx.notify();
        }
      }
    });
  }

  // ---------- refresh: data.js `refresh` with this host ----------

  focusedFolder() {
    const f = focused();
    return spaces().find((s) => s.id === f?.space && !s.machine)?.folder || null;
  }

  focusedProject() {
    return focusedProjectOf(this.m, this.focusedFolder());
  }

  publish() {
    publishWaiting(waitingOf(this.m, terminals()), { shared, setShared });
  }

  refresh(cx, opts) {
    return refresh(
      this.m,
      {
        exec,
        probe: (folders) => exec('sh', ['-c', PROBE_SCRIPT, 'sh', ...folders]),
        spaces,
        home,
        terminals,
        focusedFolder: () => this.focusedFolder(),
        workersFile: `${appHome()}/automagik-herdr/workers.jsonl`,
        now: () => Date.now(),
        notify: () => cx.notify(),
        publish: () => this.publish(),
      },
      opts,
    );
  }

  forgeNote(p) {
    if (p in this.m.results) return this.m.results[p] ? null : 'forge not synced';
    return forgeNote(this.m.sched, p);
  }

  // ---------- state ----------

  setProj(p) {
    this.proj = p;
    store.set('proj', p);
  }

  select(key) {
    this.selected = { ...this.selected, [this.proj]: key };
    store.set('selected', this.selected);
    this.copied = null;
  }

  // ---------- pieces ----------

  // The only way into a worker: a small terminal icon. Its press never reaches the card under it.
  termIcon(id, terminal, t, size = 13) {
    if (!terminal) return div();
    return press(id, t)
      .size(size + 9)
      .justify_center()
      .text_color(t.muted)
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        focusTerminal(terminal);
      })
      .child(svg(`mods/${MOD}/terminal.svg`).size(size));
  }

  header(t, shown) {
    const tab = (p) => {
      const rows = this.m.lists[p]?.rows ?? [];
      const open = rows.filter((r) => isOpen(r.lane)).length;
      const on = p === this.proj;
      const [bg, fg] = on ? [t.selected, t.foreground] : [t.surface, t.muted];
      return press(`proj-${p}`, t)
        .gap(6)
        .px(10)
        .h(26)
        .text_size(12.5)
        .bg(bg)
        .text_color(fg)
        .on_click((_e, cx) => {
          this.setProj(p);
          this.handle.focus();
          cx.notify();
        })
        .child(baseName(p))
        .child(text(String(open), 11, t.dim, MONO));
    };
    const close = press('tasks-close', t).px(8).h(24).text_size(12).text_color(t.muted);
    return h_flex()
      .items_center()
      .gap(10)
      .pb(12)
      .flex_none()
      .child(svg(`mods/${MOD}/tasks.svg`).size(16).text_color(t.muted))
      .child(text('Tasks', 15, t.foreground, BOLD))
      .child(h_flex().gap(2).p(2).rounded(7).bg(t.surface).children(shown.map(tab)))
      .child(div().flex_1())
      .child(text('read-only', 11, t.dim))
      .child(close.on_click(() => toggleTasks()).child('Close'));
  }

  // The project's notes: the last forge-sync failed, or `list` failed and an older list shows.
  notes(now) {
    const entry = this.m.lists[this.proj];
    const notes = [];
    const forge = this.forgeNote(this.proj);
    if (forge) notes.push(forge);
    if (entry?.stale)
      notes.push(entry.at == null ? 'list failed' : `list failed: the list from ${listAge(entry, now)} ago`);
    if (!notes.length) return null;
    return h_flex()
      .gap(12)
      .pb(10)
      .flex_none()
      .children(notes.map((n) => text(n, 11.5, AMBER)));
  }

  worker(x) {
    return terminalFor(x, this.terms, { realpaths: this.m.realpaths, workers: this.m.workers });
  }

  card(x, t, selKey) {
    const selected = selKey === x.key;
    const terminal = this.worker(x);
    const num = (s, color) => text(s, 12, color ?? (s === '–' ? t.dim : t.foreground), MONO_BOLD);
    const idColor = x.untracked ? AMBER : ID_BLUE;
    const titleColor = isOpen(x.lane) ? t.foreground : t.muted;
    const etaColor = x.eta === 'over' ? LATE : null;
    const line1 = h_flex()
      .items_center()
      .gap(6)
      .child(text(x.id, 11.5, idColor, MONO_BOLD))
      .child(div().flex_1())
      .child(this.termIcon(`term-${x.key}`, terminal, t, 12));
    const clock = h_flex()
      .items_center()
      .gap(3)
      .child(svg(`mods/${MOD}/clock.svg`).size(11).text_color(t.dim));
    const stats = h_flex()
      .mt(6)
      .items_center()
      .gap(6)
      .text_size(12)
      .child(clock.child(num(x.time)))
      .child(div().flex_1())
      .when(isOpen(x.lane), (el) => el.child(text('left', 10.5, t.dim)).child(num(x.eta, etaColor)))
      .child(div().w(4))
      .child(num(x.cost));
    const border = selected ? t.accent : x.untracked ? AMBER_LINE : t.border;
    const [bg, hoverBorder, hoverBg] = selected ? [t.selected, t.accent, t.selected] : [t.background, t.input, t.hover];
    return v_flex()
      .id(`card-${x.key}`)
      .flex_none()
      .px(10)
      .py(9)
      .rounded(7)
      .border(selected ? 1.5 : 1)
      .bg(bg)
      .border_color(border)
      .when(x.untracked && !selected, (e) => e.border_dashed())
      .cursor_pointer()
      .hover((s) => s.border_color(hoverBorder).bg(hoverBg))
      .on_click((_e, cx) => {
        // A card click only toggles the drawer.
        this.select(selected ? null : x.key);
        this.handle.focus();
        cx.notify();
      })
      .child(line1)
      .child(text(x.title, 13, titleColor).mt(4).w_full().whitespace_normal())
      .child(
        text(x.lead ?? 'no lead', 11.5, t.dim, MONO)
          .mt(6)
          .truncate(),
      )
      .child(stats);
  }

  column(lane, t, selKey) {
    const dot = { Working: t.working, Review: t.accent, Merged: t.done }[lane.key] ?? t.dim;
    const count = lane.cards.length === lane.total ? String(lane.total) : `${lane.cards.length}/${lane.total}`;
    const head = h_flex()
      .items_center()
      .gap(7)
      .px(4)
      .pt(2)
      .pb(9)
      .flex_none()
      .child(div().size(8).rounded_full().bg(dot))
      .child(text(lane.label.toUpperCase(), 11, t.muted, BOLD))
      .child(div().flex_1())
      .child(text(count, 11, t.dim, MONO_BOLD));
    const empty = text('Nothing here', 12, t.dim).py(18).flex().justify_center();
    const cards = v_flex()
      .id(`col-${lane.key}`)
      .flex_1()
      .min_h(0)
      .gap(6)
      .overflow_y_scrollbar()
      .children(lane.cards.map((x) => this.card(x, t, selKey)))
      .when(lane.total === 0, (el) => el.child(empty));
    return v_flex().flex_1().min_w(0).min_h(0).h_full().rounded(9).bg(t.surface).p(8).child(head).child(cards);
  }

  // ---------- drawer ----------

  drawer(x, t) {
    const open = isOpen(x.lane);
    const section = (label) => text(label.toUpperCase(), 10.5, t.dim, BOLD).mt(16).mb(6);
    const kv = (k, v, color) =>
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .px(10)
        .py(8)
        .rounded(7)
        .bg(t.background)
        .child(text(k, 10.5, t.dim))
        .child(text(v, 13, color ?? t.foreground, MONO_BOLD));
    const line = (k, v) =>
      h_flex()
        .gap(8)
        .py(2)
        .child(text(k, 11.5, t.dim).w(70).flex_none())
        .child(text(v, 11.5, t.muted, MONO).flex_1().min_w(0).truncate());
    const row = (id) => press(id, t).gap(8).px(10).h(32).rounded(7).bg(t.background);
    const close = press('drawer-close', t).size(22).justify_center().text_color(t.dim);
    const copied = this.copied === x.key;
    const lane = text(x.lane, 10.5, t.muted).px(6).h(18).flex().items_center().rounded(4).bg(t.background);
    const head = h_flex()
      .items_center()
      .gap(8)
      .child(text(x.id, 12.5, x.untracked ? AMBER : ID_BLUE, MONO_BOLD))
      .child(lane)
      .child(div().flex_1())
      .child(this.termIcon('drawer-term', this.worker(x), t, 14))
      .child(
        close
          .on_click((_e, cx) => {
            this.select(null);
            cx.notify();
          })
          .child('×'),
      );

    let el = v_flex()
      .id('drawer')
      .w(DRAWER)
      .flex_none()
      .h_full()
      .ml(12)
      .rounded(9)
      .bg(t.surface)
      .p(14)
      .overflow_y_scrollbar()
      .child(head)
      .child(text(x.title, 14.5, t.foreground, BOLD).mt(8).whitespace_normal());

    if (x.url || x.branch) el = el.child(section('Change'));
    if (x.url) {
      const url = text(x.url, 11.5, t.foreground, MONO).flex_1().min_w(0).truncate();
      el = el.child(
        row('drawer-url')
          .on_click((_e, cx) => cx.open_url(x.url))
          .child(url)
          .child(text('↗', 12, t.dim)),
      );
    }
    if (x.branch) {
      const branch = text(x.branch, 11.5, t.muted, MONO).flex_1().min_w(0).truncate();
      const copy = text(copied ? 'Copied' : 'Copy', 11, copied ? t.done : t.dim).flex_none();
      const onCopy = (_e, cx) => {
        cx.write_to_clipboard(x.branch);
        this.copied = x.key;
        cx.notify();
      };
      el = el.child(row('drawer-branch').mt(6).on_click(onCopy).child(branch).child(copy));
    }

    const time = open ? kv('Elapsed', fmtMin(x.elapsed)) : kv('Lead time', fmtMin(x.lead_min));
    const basis = x.est?.basis != null ? `${x.est.basis} of ${x.merges} merges` : `${x.merges} merges`;
    el = el
      .child(section('Time and cost'))
      .child(
        h_flex()
          .gap(6)
          .child(kv('Cost', fmtUsd(x.usd)))
          .child(kv('Work', fmtMin(x.work_min)))
          .child(time),
      )
      .when(open, (e) =>
        e.child(
          h_flex()
            .mt(6)
            .gap(6)
            .child(kv('Left', x.eta, x.eta === 'over' ? LATE : null))
            .child(kv('From', basis)),
        ),
      );

    el = el.child(section(`Bots · ${x.bots.length}`));
    if (!x.bots.length) el = el.child(text('No usage recorded.', 12, t.dim));
    for (const b of x.bots) {
      const name = text(String(b?.bot ?? '–'), 12, t.foreground, MONO)
        .flex_1()
        .min_w(0)
        .truncate();
      const work = text(fmtMin(b?.work_min ?? null), 12, t.muted, MONO);
      el = el.child(
        h_flex()
          .gap(8)
          .px(8)
          .py(5)
          .child(name)
          .child(work)
          .child(text(fmtUsd(b?.usd ?? null), 12, t.muted, MONO).w(60)),
      );
    }

    return el
      .child(section('Events'))
      .child(line('created', when(x.created_at)))
      .child(line('opened', when(x.opened_at)))
      .child(line('merged', when(x.merged_at)))
      .child(line('closed', when(x.closed_at)))
      .child(line('worktree', x.worktree ?? '–'));
  }

  // ---------- render ----------

  onKey(e, cx, sel, selX) {
    const k = e.keystroke;
    if (k === 'o' && selX?.url) cx.open_url(selX.url);
    else if (k === 'escape' && sel) this.select(null);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    if (this.overlay) return div();
    const t = theme();
    const now = Date.now();
    this.terms = terminals();
    const root = v_flex().id('root').size_full().bg(t.background).p(16).text_color(t.foreground);
    if (!this.m.bin) return root.child(text('Loading…', 13, t.dim));
    if (!this.m.bin.found) return root.child(text(missingBinaryLine(this.m.bin.path), 13, LATE));

    // A space came or went: re-probe and list now (no forge-sync: that stays once a minute).
    if (this.m.foldersKey !== null && localFolders(spaces(), home()).join('\n') !== this.m.foldersKey)
      cx.spawn((acx) => this.tick(acx, { sync: false }));
    // The badge follows the workers' live status between refreshes too.
    this.publish();

    const shown = shownProjects(this.m.projects, this.m.lists);
    if (!shown.length)
      return root.child(text('No Genie project: no local space folder holds .genie/genie.db.', 13, t.dim));
    if (!shown.includes(this.proj)) this.proj = this.focusedProject() ?? shown[0];

    const rows = this.m.lists[this.proj]?.rows ?? [];
    const lanes = lanesOf(this.proj, rows, feedRows(this.m.feed, this.proj), now);
    const sel = this.selected[this.proj] ?? null;
    const selX = sel ? (lanes.flatMap((l) => l.cards).find((x) => x.key === sel) ?? null) : null;
    const notes = this.notes(now);
    const board = h_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .gap(12)
      .children(lanes.map((lane) => this.column(lane, t, sel)));
    const hints = ['click a card: details', 'terminal icon: open the worker', 'o open the PR', 'esc close'];

    return root
      .track_focus(this.handle)
      .on_key_down((e, kcx) => this.onKey(e, kcx, sel, selX))
      .child(this.header(t, shown))
      .when(Boolean(notes), (el) => el.child(notes))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .items_start()
          .child(board)
          .when(Boolean(selX), (el) => el.child(this.drawer(selX, t))),
      )
      .child(
        h_flex()
          .pt(10)
          .flex_none()
          .gap(14)
          .children(hints.map((h) => text(h, 10.5, t.dim))),
      );
  }
}

const isOpen = (lane) => lane === 'Working' || lane === 'Review';
const MONO = { mono: true };
const BOLD = { bold: true };
const MONO_BOLD = { mono: true, bold: true };

/** Text in `size` and `color`, in the terminal font and/or bold. */
function text(s, size, color, { mono = false, bold = false } = {}) {
  let el = div().text_size(size).text_color(color);
  if (mono) el = el.font_family(String(settings().font_family ?? 'JetBrains Mono'));
  if (bold) el = el.font_semibold();
  return el.child(s);
}

/** A pressable row or chip. */
function press(id, t) {
  return h_flex()
    .id(id)
    .items_center()
    .rounded(5)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground));
}
