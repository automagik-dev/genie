# Wish: opentui shell takeover — fullscreen neon-genie splash on a proper opentui-managed TUI

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `opentui-shell-takeover` |
| **Date** | 2026-05-04 |
| **Author** | Felipe Rosa |
| **Appetite** | LARGE (~4-6 weeks; sequential waves; single wish, single review surface) |
| **Branch** | `wish/opentui-shell-takeover` (worktree `/private/tmp/genie-version-fix`) |
| **Repos touched** | `automagik-dev/genie` |
| **Linked issue** | _None — direct wish_ |
| **Design** | _No brainstorm — implementation-led, scope reconciled after first review pass_ |

## Summary

Tmux currently owns genie's windowing: every agent is a tmux pane, every team is a tmux session, the genie TUI is one pane among many. The splash animation built in this wish (neon-coloured genie, 6 scenes, ~775 LoC across `src/tui/components/` + `src/tui/splash-*.tsx`) is worthless if it lands on tmux's lego-block layout — it would either be cropped to a sibling pane or fight tmux for fullscreen.

This wish ships **one cohesive deliverable**: opentui replaces tmux as the windowing primitive, the genie TUI becomes a proper opentui composition tree, and the splash overlays it fullscreen via `<GenieAppShell>` on opentui's `alternate-screen` mode. Multi-agent layouts (lead + workers, side-by-side panes) are rebuilt on opentui's composition primitives with a new genie-supplied `PtyRenderable` hosting each agent process inside a `FrameBufferRenderable` region. Tmux stays as an opt-in fallback for one stable release behind `GENIE_USE_TMUX=1`, then gets deprecated.

There is no "ship Phase 1 first" path here — the splash is meaningless without the proper TUI underneath, and the proper TUI requires the windowing replacement to make sense. The wish covers the whole journey in sequenced execution waves, all gated by the same acceptance criteria.

The opentui APIs that underpin this exist today in the cloned reference at `/private/tmp/opentui-src` — see "OpenTUI primitives we lean on" below. The missing primitive (`PtyRenderable` + VT100 emulator) is built inside genie under `src/tui/components/`.

## Scope

### IN

- **Splash overlay foundation** — `<GenieSplash>` + `<GenieAppShell>` mount, 6-scene neon animation, `genie splash` preview subcommand, deterministic test pinning via `progress`/`blinking` props, snapshot tests for each scene. Foundation already on disk (~775 LoC); this wish locks it in.
- **opentui screen-mode plumbing** — assert `screenMode: "alternate-screen"` for the splash window; surface a `screenMode` option on `resolveTuiRendererConfig()` so post-splash layouts can hot-switch to `split-footer` (pinned panes + scrollback above) or stay alt-screen.
- **`<GenieAppShell>` wired into `src/tui/render.tsx`** so the splash overlays opentui from frame 0 and the real `<App>` mounts beneath; reveal on scene-6 fade-out.
- **`PtyRenderable` (new genie primitive)** — opentui renderable that:
  - Spawns an external command (claude, codex, generic shell) via Bun's pty support; `node-pty` fallback when bun's API is insufficient.
  - Pipes the child's stdout/stderr through an in-process VT100/ANSI emulator (candidate: `xterm-headless`; fallback: `vt100`; last resort: hand-rolled buffer modelled after `FrameBufferRenderable`).
  - Renders the resulting cell grid into a `FrameBufferRenderable` region.
  - Forwards `KeyEvent` / `MouseEvent` to the child pty (raw-mode bytes).
  - Handles container resize → pty resize via `TIOCSWINSZ`.
  - Cleans up on unmount: kill child (SIGTERM → SIGKILL after 500 ms), drain emulator, free FrameBuffer.
- **Multi-agent layout via opentui composition** — `<box flexDirection="row">` with `<PtyRenderable>` children replaces tmux's `split-window` / `select-pane` / `kill-pane` for the team-lead → workers layout. Focus follows mouse + keyboard navigation (arrow keys / `Ctrl+B`-style chord inside opentui).
- **`agent-registry` adaptation** — fill `pane_id`, `window_name`, `window_id`, `sub_panes`, `tmux_window` columns with synthetic identifiers when running under the opentui shell so `genie ls`, `genie agent list`, scheduler accounting, and observability all keep working unchanged. Synthetic format: `opentui:<surface-id>:<region-id>` (or `%opentui-<n>` if Claude Code's native team CLI requires the `%N` shape — see Risk row).
- **`team-auto-spawn` migration** — when `GENIE_USE_TMUX !== "1"`, `ensureTeamSession` mounts a new opentui composition root + region instead of calling `tmux.createSession` / `tmux.split-window`. Team config's `tmuxSessionName` becomes a soft hint; lookup keys on the opentui composition root id.
- **tmux as opt-in legacy** — `GENIE_USE_TMUX=1` keeps the entire current path (tmux session, panes, send-keys injection) for one stable release. Default flips to opentui shell.
- **`genie doctor` updates** — drop the hard `hasBinary('tmux')` requirement; report opentui shell health (composition root count, region count, pty child status). Soft-warn when `GENIE_USE_TMUX=1` is set + tmux missing.
- **`genie install` cleanup** — remove tmux PATH check from default install gates. Add tmux-required guard only when `GENIE_USE_TMUX=1` is set in the install env.
- **Splash inside legacy tmux mode** — when `GENIE_USE_TMUX=1`, the splash claims the active pane via `tmux resize-pane -Z` zoom toggle around the splash render. Idempotent / reversible. Removed when the user upgrades off the legacy flag.
- **Documentation** — `README.md` adds an "opentui shell" section + `GENIE_NO_SPLASH` / `GENIE_USE_TMUX` / `GENIE_TUI_SCREEN_MODE` env-var entries. New page `docs/_internal/architecture/opentui-shell.md` covers composition tree, PtyRenderable contract, screen-mode switching, agent-registry synthetic id format. README's tmux-required language goes away.

### OUT

- **Removing tmux entirely.** Stays as opt-in via `GENIE_USE_TMUX=1` through one full stable release after this wish ships. Removal is a separate decision driven by adoption telemetry.
- **Upstreaming `PtyRenderable` to opentui core.** The primitive lives in `src/tui/components/PtyRenderable.tsx`. Upstreaming is a future-quarter decision.
- **Upstream opentui patches** for the inverted-`autoplay` workaround (`GenieSplash.tsx:106–108`) or darwin render-loop guardrails (`useThread:false` + low FPS caps). Both stay inline; filing upstream fixes is a separate effort.
- **Replacing `ascii.md`.** Source-of-truth ASCII reference; `genie-art.ts` is the hand-tuned derivation.
- **A `genie --version` splash.** `--version` keeps its plain stdout (`src/lib/version.ts` shipped via #1464). The splash is a startup overlay, not a version banner.
- **Per-step progress lines piped from real boot work.** Splash status stays stage-derived (`awakening...`, `manifesting...`, `ready`); wiring live `db init` / `tmux scan` / `registry load` step counts into the splash's `step` / `totalSteps` props is a follow-up.
- **Manual version bump.** `version.yml` auto-bumps on dev push.
- **Migrating `genie serve` infrastructure away from tmux.** The serve daemon's tmux session creation (`src/term-commands/serve.ts`) stays as the bootstrap path even when agents render under opentui; the serve session is a holding pen for the daemon, not a user-visible layout. Re-evaluate when the legacy tmux flag is removed.
- **Native team Claude Code integration changes.** `claude-native-teams.ts` continues to use Claude Code's native team-CLI flags; opentui hosts the resulting Claude Code subprocess just like any other pty child.

## OpenTUI primitives we lean on

Reference paths inside the cloned monorepo at `/private/tmp/opentui-src`:

| Primitive | Path | What it gives us |
|-----------|------|------------------|
| `ScreenMode` | `packages/core/src/renderer.ts:195` (`type ScreenMode = "alternate-screen" \| "main-screen" \| "split-footer"`) | The windowing modes. `alternate-screen` is what the splash + multi-agent layout claim by default. `split-footer` is available for layouts that want pinned panes + scrollback above. `main-screen` is reserved for non-TUI commands that want to print without an alt-buffer flicker. |
| Hot-switch demo | `packages/examples/src/split-mode-demo.ts:457,667,695,1263` | Live runtime toggle: `this.renderer.screenMode = "main-screen"` / `"split-footer"` / `"alternate-screen"`. Confirms we can flip modes without re-creating the renderer. |
| `FrameBufferRenderable` + demo | `packages/core/src/renderables/FrameBuffer.ts` + `packages/examples/src/framebuffer-demo.ts` | Sub-region cell buffer with transparency and overlap. The natural host for `PtyRenderable` output: emulator writes cells into a FrameBuffer, opentui composes it. |
| Composition tree | `packages/core/src/renderables/composition/` (`vnode.ts`, `constructs.ts`, `VRenderable.ts`, `README.md`) | Imperative `h(BoxRenderable, ...children)` API; lets us mount nested boxes side-by-side without a reconciler. Replacement for tmux split-window. |
| Plugin slot registry | `packages/core/src/plugins/core-slot.ts` + demo `packages/examples/src/core-plugin-slots-demo.ts` | Named slots a host fills with renderables. Useful for letting agents register themselves into named layout slots (header / sidebar / footer / pane-N) without hard-coded tree shapes. |
| `nested-zindex` demo | `packages/examples/src/nested-zindex-demo.ts` | Confirms overlapping renderables with explicit z-order — the model `<GenieAppShell>` already uses (`position="absolute"` overlay above children). |
| Terminal startup spec | `packages/core/src/specs/terminal-startup.md` | Explicit gap statement: *"Nested tmux is not modeled. OpenTUI currently treats tmux as a single layer."* Confirms the path forward is to step OUTSIDE tmux, not nest inside it. |
| `useTimeline` (React binding) | `packages/react/src/...` (consumed in `GenieSplash.tsx:24,109`) | Drives splash progress 0→1. NOTE the inverted-`autoplay` bug in 0.2.0 (workaround in `GenieSplash.tsx:106–108`). |

**What opentui does NOT give us today** (so genie supplies it):

- **`PtyRenderable`** — no built-in primitive embeds an external pty stream into a renderable region. This wish builds it under `src/tui/components/PtyRenderable.tsx`.
- **VT100/ANSI emulator** — opentui renders its own char grid; it does not parse another process's escape sequences. This wish wires `xterm-headless` (or fallback) into a thin emulator adapter at `src/tui/components/pty-emulator.ts`.
- **Pty-resize on container-resize** — opentui's resize events are renderable-level; we forward them to the child pty via `TIOCSWINSZ`-equivalent.
- **Input forwarding** — opentui delivers `KeyEvent` / `MouseEvent` to focused renderables; PtyRenderable translates these to the child's stdin (raw mode bytes).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One wish, one review surface. No splitting into "Phase 1 ships now" + "Phase 2-4 later." | The splash is worthless without the proper TUI, and the proper TUI requires the windowing replacement to make sense. Splitting would either ship a splash trapped in a tmux pane (gets reverted) or hold the splash for the umbrella (no benefit). One wish, sequential waves, single acceptance gate. |
| 2 | Tmux stays as opt-in via `GENIE_USE_TMUX=1` for one stable release after this wish ships | Existing genie users have running teams + persistent tmux sessions. A hard cutover risks orphaning live work. The legacy flag preserves the full tmux path verbatim until telemetry shows opentui-shell adoption is stable. Removal is a separate decision. |
| 3 | `PtyRenderable` lives in genie (`src/tui/components/PtyRenderable.tsx`), not upstream opentui | Genie's pty needs are concrete (claude, codex, shells); opentui core is general-purpose. We move faster owning the abstraction. Upstreaming is a future-quarter conversation; until then, the indirection cost is one file in genie. |
| 4 | VT100 emulator is `xterm-headless` first, `vt100` package fallback, hand-rolled last | `xterm-headless` is the reference implementation backing xterm.js — battle-tested, handles 256-colour, mouse, alt-screen, ANSI cursor. `vt100` is lighter but less complete. Hand-rolled is acceptable only if both prove unworkable for genie's agent output. The emulator adapter at `pty-emulator.ts` keeps the choice swappable. |
| 5 | `agent-registry` columns get synthetic `opentui:<surface>:<region>` ids, not new columns | A schema change would force a database migration + downstream readers. Synthetic ids in existing columns let `genie ls`, scheduler accounting, native-team mounting, observability stay code-unchanged. Downstream that needs to distinguish (`tmux capture-pane` calls) checks the prefix. Migration is reversible. |
| 6 | Splash overlay assumes `alternate-screen`; multi-agent layout defaults to `alternate-screen` but exposes `split-footer` via env var | Alt-screen is the cleanest fullscreen claim — restores the user's terminal exactly as it was on exit. Some users prefer scrollback retention; `GENIE_TUI_SCREEN_MODE=split-footer` opts into that. Default stays alt-screen. |
| 7 | `tmux resize-pane -Z` zoom toggle is the ONLY tmux-aware shim in the splash path, and only when `GENIE_USE_TMUX=1` | Inside the legacy tmux flag, the splash needs to claim its active pane fullscreen. Zoom toggle is atomic, reversible, well-supported (tmux ≥ 1.8). Outside the legacy flag, opentui owns the alt-screen directly — no shim needed. |
| 8 | Two-colour neon palette inlined in `GenieSplash.tsx` (`#ff3ff5` / `#39ffff`), not from `theme.ts` | `src/tui/theme.ts` is missing from the graph (the file's own header notes this). Inlined constants keep the splash standalone — renders even when the rest of `src/tui` doesn't compile. Swap for tokens when `theme.ts` returns. |
| 9 | `█` softened to `▓` for body cells; eyes / smile / earrings stay sharp `█` | Reference neon art has thin outline strokes; `█` reads too heavy. `▓` (~75% fill) keeps silhouette but slims body lines while face features stay sharp for contrast. Implemented in `softenChar()`. |
| 10 | Splash tests pin frames via deterministic `progress` / `blinking` props, not via timer advancement | `useTimeline` would emit out-of-`act()` state updates inside the test renderer. Splitting into `<LiveGenieSplash>` (timer-driven) + `<SplashFrame>` (pure prop-driven) lets tests render `<SplashFrame>` directly. |
| 11 | `genie splash` is a registered subcommand, not just a `bun run` script | Visual tuning is recurring. `genie splash --freeze 0.55` is discoverable + scriptable. The `bun run` runners (`splash-cli.ts`, `splash-shell-cli.tsx`) stay as developer-only convenience. |
| 12 | `PtyRenderable` integration tests use a constrained child (`bash -c 'echo hi; read'`), not real claude/codex agents | Real agents have non-deterministic streaming output; constrained shells give us byte-level control. Real-agent smoke tests live in QA criteria, not in the unit suite. |
| 13 | Four sequential execution waves, single acceptance gate covering the whole journey | Sequential because each wave depends on the previous (composition needs PtyRenderable; layout needs composition; tmux deprecation needs everything else). Single gate because the whole wish is the deliverable. |

## Success Criteria

- [ ] `genie` (no args) — outside any tmux session — claims the entire terminal alt-screen, plays the 6-scene neon splash, hands off to the real `<App>` (now opentui-composed) without a visible flash of the bare terminal.
- [ ] `genie` (no args) — inside a multi-pane tmux session with `GENIE_USE_TMUX=1` — uses `tmux resize-pane -Z` zoom shim to claim the active pane fullscreen for the splash, unzooms cleanly on completion, sibling panes restored.
- [ ] `GENIE_NO_SPLASH=1 genie` skips the splash; TUI boots straight to `<App>` within the same wall-clock budget as pre-wish `genie`.
- [ ] `genie splash` standalone — fullscreen on bare terminal, zoomed-fullscreen inside legacy tmux, exits 0 within `--duration` + 200 ms.
- [ ] `genie team create test-shell --repo $PWD --wish smoke` (with `GENIE_USE_TMUX=0`) creates an opentui composition root with one team-lead `<PtyRenderable>` + N worker regions; `genie ls` reports the team with synthetic `opentui:<root>:<region>` ids.
- [ ] `genie spawn engineer --team test-shell` mounts a new `<PtyRenderable>` in the team's composition tree; child claude renders in its region; keyboard focus follows mouse / Ctrl+B + arrow chords.
- [ ] `genie kill engineer --team test-shell` unmounts the renderable, kills the child, drains the emulator, frees the buffer.
- [ ] `genie team disband test-shell` unmounts the entire composition root; all child ptys exit cleanly; `agent-registry` rows transition to `state = 'archived'`.
- [ ] `GENIE_USE_TMUX=1 genie team create legacy-test ...` continues to use real tmux verbatim — no opentui composition, no PtyRenderable, no synthetic ids. Legacy path unchanged.
- [ ] `bun test test/visual/genie-splash.test.tsx` — all 24 cases including 5 snapshots pass on darwin + linux.
- [ ] `bun test test/tui/pty-renderable.test.ts` — input/output round-trip, resize, kill, restart, ANSI sequence handling all pass.
- [ ] `bun test test/tui/composition-multi-agent.test.ts` — multi-region layout with focus / kill / spawn passes.
- [ ] `bun run check` is green (typecheck + lint + dead-code + full test suite).
- [ ] On darwin during splash — single-CPU < 30%. With three active `<PtyRenderable>`s streaming claude output — single-CPU < 60% sustained.
- [ ] `genie doctor` reports opentui shell health when `GENIE_USE_TMUX=0`: composition-root count, total region count, pty-child count + pids. tmux check is a soft warning when `GENIE_USE_TMUX=1` and tmux is missing; not a hard failure.
- [ ] `genie install` on a tmux-less host succeeds when `GENIE_USE_TMUX=0` (default); fails fast with a clear message when `GENIE_USE_TMUX=1` and tmux is missing.
- [ ] README's tmux-required language is removed; replaced with "opentui shell (default) — tmux opt-in via `GENIE_USE_TMUX=1`".
- [ ] `docs/_internal/architecture/opentui-shell.md` exists; covers composition tree, PtyRenderable contract, screen-mode switching, synthetic id format.

## Execution Strategy

Four sequential waves, single agent per wave. Each wave's acceptance feeds the next. The wish ships when wave 4 passes; intermediate waves are reviewable but not shippable on their own.

### Wave 1 — Splash overlay + screen-mode foundation

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Wire `<GenieAppShell>` into `render.tsx`; assert `screenMode: "alternate-screen"`; add `GENIE_TUI_SCREEN_MODE` env var; document `GENIE_NO_SPLASH`; lock visual snapshots |

### Wave 2 — `PtyRenderable` + emulator adapter

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Implement `PtyRenderable.tsx` + `pty-emulator.ts` (xterm-headless wrapper); spawn → emulate → render → input-forward → resize → kill; full test suite |

### Wave 3 — Multi-agent layout via opentui composition

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Replace tmux split-window/select-pane semantics with opentui composition tree; `team-auto-spawn` mounts composition roots; `agent-registry` synthetic ids; focus + keyboard navigation |

### Wave 4 — Tmux deprecation + doctor + docs

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Flip default to opentui shell; `GENIE_USE_TMUX=1` preserves legacy path; `genie doctor` opentui-shell health; `genie install` tmux check moves behind flag; tmux-resize-pane-Z splash shim under legacy flag; README + architecture page |

## Execution Groups

### Group 1: Splash overlay + screen-mode foundation

**Goal:** Get the splash on the screen, claim the alt-screen, lock the visual contract.

**Deliverables:**

1. Wrap `<App>` mount in `src/tui/render.tsx:76–80`:
   ```tsx
   import { GenieAppShell } from './components/GenieAppShell.js';
   // …
   const skipSplash = process.env.GENIE_NO_SPLASH === '1';
   createRoot(renderer).render(
     <KeymapProvider keymap={keymap}>
       <GenieAppShell skipSplash={skipSplash}>
         <App rightPane={rightPane} workspaceRoot={workspaceRoot} initialAgent={initialAgent} />
       </GenieAppShell>
     </KeymapProvider>,
   );
   ```
2. In `resolveTuiRendererConfig()` (`render.tsx:51–62`), make `screenMode: "alternate-screen"` explicit. Add `GENIE_TUI_SCREEN_MODE` env var supporting `"alternate-screen"` (default) and `"split-footer"`. Validate input; throw on unknown value.
3. Run `bun test test/visual/genie-splash.test.tsx` — all 24 cases including 5 snapshots pass clean. Refresh snapshots only if width/height changed (none expected).
4. Add to `README.md`:
   - `GENIE_NO_SPLASH=1` — bypass the neon-genie startup animation.
   - `GENIE_TUI_SCREEN_MODE=alternate-screen|split-footer` — opentui screen mode (default `alternate-screen`).
5. Smoke-run on darwin: `genie`, `GENIE_NO_SPLASH=1 genie`, `genie splash`, `genie splash --freeze 0.55`, `bun run src/tui/splash-shell-cli.tsx`.

**Acceptance Criteria:**

- [ ] Diff bounded: ~10 lines `render.tsx`, 2 lines `README.md`.
- [ ] All visual tests pass; `bun run check` green.
- [ ] Splash → real `<App>` handoff on darwin local pty has no observable terminal-state flicker.
- [ ] `GENIE_TUI_SCREEN_MODE=split-footer genie` boots into split-footer mode (TUI top, scrollback bottom).
- [ ] On darwin, `top -pid <genie>` < 30% CPU during splash.

**depends-on:** none

---

### Group 2: `PtyRenderable` + emulator adapter

**Goal:** Build the missing primitive — embed an external pty inside an opentui region.

**Deliverables:**

1. New `src/tui/components/pty-emulator.ts` — thin adapter around `xterm-headless`:
   - Accepts a stream of bytes from a child pty.
   - Exposes a `getCellGrid()` snapshot (rows × cols of `{ char, fg, bg, attrs }`).
   - Emits `change` events when the grid mutates.
   - Resizable via `resize(rows, cols)` → also resizes the underlying xterm-headless instance.
2. New `src/tui/components/PtyRenderable.tsx` — opentui renderable:
   - Props: `command: string`, `args: string[]`, `env?: Record<string,string>`, `cwd?: string`, `onExit?: (code: number) => void`.
   - Spawns the child via Bun's pty support (or `node-pty` fallback when bun's API is insufficient — gate with feature detect).
   - Wires the pty stdout/stderr through `pty-emulator`.
   - Renders the emulator's cell grid into a `<FrameBufferRenderable>` region sized to its container.
   - On opentui resize event: resize the FrameBuffer, resize the emulator, send `TIOCSWINSZ` to the child pty.
   - On focused `KeyEvent` / `MouseEvent`: translate to bytes (modifier-aware) and write to the child stdin.
   - On unmount: kill the child (SIGTERM → SIGKILL after 500 ms), drain the emulator, free the FrameBuffer.
3. New `test/tui/pty-renderable.test.ts` — bun:test suite:
   - Spawn `bash -c 'echo hello; read; echo done'`, assert "hello\n" appears in the cell grid within 200 ms.
   - Send `\n` via simulated key event; assert the read unblocks and "done\n" appears.
   - Resize from 80×24 to 100×30; assert child receives the new size (echo `tput cols` / `tput lines`).
   - Kill the renderable; assert child exits within 1 s and the FrameBuffer is freed.
   - ANSI-handling smoke: spawn `printf '\\033[31mred\\033[0m\\n'`, assert the cell at (0,0) has `fg=red`.
4. Document the contract in `docs/_internal/architecture/opentui-shell.md` (stub now; complete in Wave 4).

**Acceptance Criteria:**

- [ ] `bun test test/tui/pty-renderable.test.ts` — all cases pass on darwin + linux.
- [ ] `bun run check` green.
- [ ] Round-trip latency (key event → child read → echo → emulator → render) < 50 ms on darwin.
- [ ] No fd leaks across 100 spawn/kill cycles (verified via `lsof -p <bun-pid>` count delta).
- [ ] Resize storm — 50 rapid resizes in 1 s — emulator + child stay coherent; final size matches.

**depends-on:** 1

---

### Group 3: Multi-agent layout via opentui composition

**Goal:** Replace tmux's split-window / select-pane / kill-pane semantics with opentui composition + PtyRenderable.

**Deliverables:**

1. New `src/tui/components/AgentLayout.tsx` — opentui composition for team layouts:
   - Reads team config (lead + workers) from `agent-directory.ts`.
   - Renders `<box flexDirection="row">` with a `<PtyRenderable>` per agent.
   - Manages focus: arrow keys / `Ctrl+B`-style chord moves focus between regions.
   - On `genie spawn` event (via existing event bus): mount a new `<PtyRenderable>` child.
   - On `genie kill` event: unmount the matching renderable.
2. Modify `src/lib/team-auto-spawn.ts`:
   - When `process.env.GENIE_USE_TMUX !== "1"`: bypass `tmux.createSession` / `tmux.findSessionByName`; instead create a composition root id (UUID) and register it in `agent-registry` with synthetic ids.
   - Keep the existing tmux path verbatim under the legacy flag.
3. Modify `src/lib/agent-registry.ts`:
   - When inserting a row under the opentui shell, populate `pane_id` / `window_name` / `window_id` / `sub_panes` / `tmux_window` with `opentui:<root>:<region>` synthetic format.
   - Add a derived helper `isOpenTuiAgent(row): boolean` checking the prefix; no schema change.
   - Update downstream callers (the few that decode tmux ids — check `claude-native-teams.ts`, `protocol-router.ts`, `executor-registry.ts`) to use the helper.
4. New `test/tui/composition-multi-agent.test.ts` — bun:test suite:
   - Mount `<AgentLayout>` with two agents; assert two `<PtyRenderable>` regions side-by-side.
   - Simulate `genie spawn` event for a third agent; assert third region appears.
   - Simulate focus navigation; assert active region updates.
   - Simulate `genie kill` for one agent; assert region unmounts and child exits.
5. Smoke validation:
   - `GENIE_USE_TMUX=0 genie team create smoke-shell --repo $PWD --wish smoke-test`
   - `GENIE_USE_TMUX=0 genie spawn engineer --team smoke-shell`
   - `genie ls` shows the team with `opentui:*` synthetic ids
   - `GENIE_USE_TMUX=0 genie kill engineer --team smoke-shell`
   - `GENIE_USE_TMUX=0 genie team disband smoke-shell`

**Acceptance Criteria:**

- [ ] All composition tests pass; `bun run check` green.
- [ ] Smoke validation completes without manual intervention; `agent-registry` rows transition states correctly.
- [ ] Focus navigation works with arrow keys + `Ctrl+B` chords (matching tmux's pane-navigation muscle memory).
- [ ] No regressions in `GENIE_USE_TMUX=1` mode — legacy tmux path unchanged.
- [ ] Three streaming agents — single-CPU < 60% sustained on darwin.

**depends-on:** 2

---

### Group 4: Tmux deprecation + doctor + install + docs

**Goal:** Flip the default; make tmux opt-in; deliver the architecture doc; clean up tmux-required language.

**Deliverables:**

1. Modify `src/genie-commands/doctor.ts`:
   - When `GENIE_USE_TMUX=1`: existing tmux checks (binary on PATH, server reachable). Soft warn instead of hard fail when tmux missing.
   - When `GENIE_USE_TMUX=0` (default): new opentui-shell health checks — composition-root count from `agent-registry`, region count, pty-child pid liveness via `kill -0`.
   - Add `--shell` flag dumping a shell-specific health report.
2. Modify `src/genie-commands/install.ts`:
   - Drop `tmux` from the default required-binaries list.
   - When `GENIE_USE_TMUX=1` is set in install env: re-add tmux check.
   - Postinstall script logs which shell is active.
3. Add tmux-resize-pane-Z splash shim in `src/tui/splash-render.tsx`:
   - Pre-render: if `process.env.TMUX` AND `process.env.GENIE_USE_TMUX === "1"`, run `tmux resize-pane -Z` (zoom toggle).
   - Post-render: same command (zoom is a toggle). Wrap in try/catch — non-fatal.
   - Skip entirely when `GENIE_USE_TMUX !== "1"` — opentui owns the alt-screen directly.
4. New `docs/_internal/architecture/opentui-shell.md` — full architecture page:
   - Composition tree shape (`AgentLayout` → `PtyRenderable[]`).
   - `PtyRenderable` contract (props, lifecycle, resize/kill semantics, emulator choice).
   - Screen-mode strategy (`alternate-screen` default, `split-footer` opt-in).
   - Synthetic agent-registry id format (`opentui:<root>:<region>`).
   - `GENIE_USE_TMUX=1` legacy flag — when to use it, when to remove it.
   - Performance budget (CPU caps, memory per region, fd discipline).
5. Update `README.md`:
   - Remove tmux-required language from install section.
   - Add "opentui shell (default) — tmux opt-in via `GENIE_USE_TMUX=1`" under environment.
   - Link to `docs/_internal/architecture/opentui-shell.md` (note: excluded from public mintlify build per `.mintignore`; intentional for engineering-internal pages).
6. Final QA pass — run the full `Success Criteria` list end-to-end on a darwin host AND a linux host.

**Acceptance Criteria:**

- [ ] `genie doctor` on a tmux-less host with `GENIE_USE_TMUX=0` returns 0 with opentui-shell health green.
- [ ] `genie doctor` on a tmux-less host with `GENIE_USE_TMUX=1` soft-warns about missing tmux but does not exit non-zero.
- [ ] `genie install` on a fresh tmux-less host succeeds (default).
- [ ] `genie install` with `GENIE_USE_TMUX=1` and tmux missing fails fast with a clear message.
- [ ] `genie splash` inside legacy tmux (`GENIE_USE_TMUX=1`) zooms the active pane, plays, unzooms cleanly.
- [ ] `docs/_internal/architecture/opentui-shell.md` exists and covers all six sections.
- [ ] `bun run check` green.
- [ ] All Success Criteria above pass on darwin + linux.

**depends-on:** 3

---

## QA Criteria

_What must be verified on dev after wish merge. The QA agent runs each criterion._

### Splash + visual

- [ ] **Visual regression:** All 5 snapshot frames in `test/visual/__snapshots__/genie-splash.test.tsx.snap` match byte-for-byte.
- [ ] **Splash fullscreen — bare terminal:** `genie splash` from a non-tmux pty claims the entire terminal alt-screen.
- [ ] **Splash fullscreen — opentui shell:** `genie splash` inside an opentui-shell-managed multi-agent layout claims the full terminal (the layout's regions are alt-screen; splash overlays them).
- [ ] **Splash fullscreen — legacy tmux:** `GENIE_USE_TMUX=1 genie splash` from a multi-pane tmux session zooms the active pane, plays, unzooms cleanly. Sibling panes restored.
- [ ] **Bypass:** `GENIE_NO_SPLASH=1 genie` skips the splash; TUI boot wall-clock unchanged from pre-wish baseline.
- [ ] **Tuning:** `genie splash --freeze 0` shows closed eyes only; `--freeze 0.55` shows partial body; `--freeze 1.0` shows a faded blank frame. Each exits 0 within 2 s.
- [ ] **No leak into `--version` / `--help`:** plain stdout, zero TTY allocation.

### opentui shell + multi-agent

- [ ] **Team create (default shell):** `GENIE_USE_TMUX=0 genie team create qa-shell` creates an opentui composition root; `genie ls` shows synthetic ids; no tmux session created.
- [ ] **Spawn / kill:** `GENIE_USE_TMUX=0 genie spawn engineer --team qa-shell` mounts a region; child claude renders; `genie kill engineer --team qa-shell` unmounts cleanly.
- [ ] **Three concurrent agents:** with three streaming claude agents in a team layout, single-CPU < 60% sustained on darwin.
- [ ] **Round-trip latency:** key event → child stdin → child stdout → emulator → render < 50 ms on darwin.
- [ ] **Resize:** terminal resize during active streaming — all `<PtyRenderable>` regions resize correctly, child ptys receive `TIOCSWINSZ`, no truncation or overflow.
- [ ] **Focus navigation:** arrow keys / `Ctrl+B` + arrow chords move focus between regions; visual focus indicator updates.

### Legacy tmux mode

- [ ] **Legacy team create:** `GENIE_USE_TMUX=1 genie team create legacy-test` creates a real tmux session; `genie ls` shows real tmux pane ids.
- [ ] **Legacy spawn / kill:** behavior identical to pre-wish baseline.
- [ ] **No mixed-mode bugs:** running a legacy team and an opentui-shell team simultaneously — both work; `genie ls` correctly distinguishes them via the `opentui:` prefix.

### Doctor + install

- [ ] **Doctor (default shell):** `genie doctor` reports composition-root count, region count, pty-child pids; tmux check absent.
- [ ] **Doctor (legacy flag):** `GENIE_USE_TMUX=1 genie doctor` includes tmux check; soft-warns when tmux missing.
- [ ] **Install (default):** fresh tmux-less host — `genie install` succeeds.
- [ ] **Install (legacy flag, missing tmux):** fails fast with clear message naming `GENIE_USE_TMUX=1` as the trigger.

### Performance

- [ ] **Splash CPU:** darwin local pty — single-CPU < 30% across full splash duration.
- [ ] **Active layout CPU:** three streaming agents — single-CPU < 60% sustained.
- [ ] **Memory:** per-region RSS delta < 10 MB during active streaming.
- [ ] **Fd discipline:** 100 spawn/kill cycles — no fd leak (verified via `lsof` delta).

### Docs

- [ ] **README:** tmux-required language removed; `GENIE_USE_TMUX=1` legacy flag documented.
- [ ] **Architecture page:** `docs/_internal/architecture/opentui-shell.md` covers composition, PtyRenderable, screen mode, synthetic ids, performance budget.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `xterm-headless` proves too heavy or has unexpected ANSI gaps for genie's agent output (claude streaming, codex tool-use blocks, opencode-style markdown) | High | Decision #4 sequences fallbacks: xterm-headless → vt100 → hand-rolled. Wave 2 acceptance includes ANSI smoke; if it fails, swap the adapter without touching `PtyRenderable` consumers. Spike xterm-headless on day 1 of Wave 2 to surface this risk early. |
| Bun's pty support is incomplete (sigwinch propagation, raw-mode toggling, signal forwarding) | High | `node-pty` fallback path designed in from Wave 2. Feature-detect bun's API at module load; degrade silently to node-pty if any required call is missing. node-pty is well-tested but adds a native dep + install-time compilation. |
| Tmux integration is deeply entrenched (pane_id columns, send-keys injection in claude-native-teams, scheduler-daemon, executor-registry) and migration causes silent data corruption in `agent-registry` | Medium | Decision #5 keeps the schema unchanged — synthetic ids fit existing columns. `isOpenTuiAgent()` helper centralises decoding. Wave 3 includes a sweep of all tmux-id consumers + adaptation; smoke validation in Group 3 catches missed call sites. |
| `<GenieAppShell>` mounts `<App>` from frame 0 — async boot effects fire while user can't interact. If `<App>` grabs stdin focus during the splash window, key events leak into the hidden app | Medium | `GenieAppShell.tsx:36` notes the issue. Add a `splashActive` context provider in Wave 1 if QA observes leaked input; defer focus / input handlers behind the context. |
| opentui 0.2.0 inverted-`autoplay` check regresses in a patch release | Low | `GenieSplash.tsx:106–108` documents the workaround inline. Snapshot tests catch a regression. |
| `tmux resize-pane -Z` zoom shim races with concurrent tmux activity | Low | Zoom toggle is atomic from tmux's perspective; worst case is the unzoom call running after a manual zoom by the user. Document inline. Only fires under `GENIE_USE_TMUX=1` so default users are unaffected. |
| Snapshot drift from cosmetic palette / width tweaks creates churn | Low | The 5 snapshots are intentional checkpoints. Reviewers should only `--update-snapshots` when an art / scene-boundary change is the *intent* of the diff. |
| Splash adds ~2 s perceived latency for users running `genie` repeatedly in scripts | Medium | `GENIE_NO_SPLASH=1` is the documented bypass. CI runners should set it. README entry calls this out. |
| Darwin render-loop guardrail (`useThread:false`, `targetFps:8`) gives darwin users a slightly choppier animation than linux | Low | Acceptable trade-off — without it, CPU pins to 70%+. Documented in `splash-render.tsx`. |
| Tmux deprecation breaks users on `GENIE_USE_TMUX=0` if `PtyRenderable` has unhandled edge cases (256-colour escape sequences claude emits during streaming, mouse-tracking sequences from interactive tools) | High | `GENIE_USE_TMUX=1` stays as the escape hatch through one full stable release. Wave 4 doesn't *remove* tmux — only flips the default. Removal is a separate decision after telemetry shows opentui-shell adoption is stable across all agent types. |
| Native-team Claude Code integration (`claude-native-teams.ts`) breaks because it expects a tmux pane id rather than a synthetic opentui id when registering with Claude Code's experimental team CLI | Medium | Wave 3 sweep includes this file. If synthetic ids that don't match tmux's `%N` format break Claude Code's pane registration, generate ids that *look* like tmux pane ids (`%opentui-<n>`) but are clearly tagged. Acceptance includes a native-team smoke test. |
| Existing standalone runners (`splash-cli.ts`, `splash-shell-cli.tsx`, `genie-launcher.tsx`) become tech-debt after the shell wire-up lands | Low | Keep them: `splash-cli.ts` and `splash-shell-cli.tsx` are visual-tuning entry points; `genie-launcher.tsx` is the legacy alias path. Re-evaluate at the next stable release. |

---

## Files to Create/Modify

### New files

```
src/tui/components/PtyRenderable.tsx                         # Wave 2 — opentui renderable hosting an external pty
src/tui/components/pty-emulator.ts                           # Wave 2 — VT100/ANSI emulator adapter (xterm-headless wrapper)
src/tui/components/AgentLayout.tsx                           # Wave 3 — multi-agent composition layout
test/tui/pty-renderable.test.ts                              # Wave 2 — input/output round-trip, resize, kill, restart, ANSI
test/tui/composition-multi-agent.test.ts                     # Wave 3 — multi-region focus / spawn / kill
docs/_internal/architecture/opentui-shell.md                 # Wave 4 — architecture page (composition, PtyRenderable, screen mode, synthetic ids)
```

### Modified files

```
src/tui/render.tsx                                          # Wave 1 — wrap <App> in <GenieAppShell>; assert screenMode; expose GENIE_TUI_SCREEN_MODE
src/tui/splash-render.tsx                                   # Wave 4 — tmux resize-pane -Z shim under GENIE_USE_TMUX=1
src/lib/team-auto-spawn.ts                                  # Wave 3 — bypass tmux when GENIE_USE_TMUX=0; mount opentui composition root
src/lib/agent-registry.ts                                   # Wave 3 — synthetic opentui ids; isOpenTuiAgent helper
src/lib/claude-native-teams.ts                              # Wave 3 — adapt to synthetic ids (or generate %opentui-N format)
src/lib/protocol-router.ts                                  # Wave 3 — handle synthetic ids in dir: chokepoint resolution
src/lib/executor-registry.ts                                # Wave 3 — handle synthetic ids in transport routing
src/genie-commands/doctor.ts                                # Wave 4 — opentui shell health checks; tmux check behind flag
src/genie-commands/install.ts                               # Wave 4 — drop tmux from default required-binaries; gate behind flag
src/tui/app.tsx                                             # Wave 3 — render <AgentLayout> in addition to existing chrome
README.md                                                   # Wave 1 + Wave 4 — env var docs + remove tmux-required language
```

### Already on disk (foundation — verify, don't recreate)

```
src/tui/components/genie-art.ts                323 lines    # GENIE_ART grid + EYE/MOUTH coords + categorizeCell + bodyCellDelay
src/tui/components/GenieSplash.tsx             458 lines    # 6-scene animation, scatter reveal/fade, status + progress
src/tui/components/GenieAppShell.tsx            67 lines    # overlay wrapper (splash atop children)
src/tui/splash-render.tsx                       77 lines    # standalone renderer for genie splash subcommand
src/tui/splash-cli.ts                           42 lines    # bun run preview entry point
src/tui/splash-shell-cli.tsx                   125 lines    # demo runner (overlay → fake-app handoff)
src/tui/genie-launcher.tsx                     130 lines    # legacy stop-gap: splash → exec genie
src/genie.ts:229–244                                         # genie splash subcommand registration
test/visual/genie-splash.test.tsx              255 lines    # 24 cases — scenes, status, progress, snapshots, art invariants
test/visual/__snapshots__/genie-splash.test.tsx.snap         # 5 captured frames
```

### Source-of-truth references

```
ascii.md                                                    # original genie ASCII reference; genie-art.ts is hand-tuned from this
/private/tmp/opentui-src                                    # cloned opentui monorepo — see "OpenTUI primitives we lean on"
```
