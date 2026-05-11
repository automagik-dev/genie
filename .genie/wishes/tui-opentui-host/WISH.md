# Wish: OpenTUI hosts the TUI; tmux is the agent substrate only

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tui-opentui-host` |
| **Date** | 2026-05-10 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | large (~5–8 engineer-days; new widget + VT integration + control-mode port + legacy deletion + smoke matrix) |
| **Branch** | `wish/tui-opentui-host` |
| **Repos touched** | `automagik-dev/genie` (primary, v5 only); reference: `automagik-dev/khal-os` (port source, no commits here) |
| **Design** | [DESIGN.md](../../brainstorms/tui-opentui-host/DESIGN.md) |
| **Target release** | v5 |
| **Sister wishes** | [v5-major-cutover-handoff](../v5-major-cutover-handoff/WISH.md) (distribution cutover); [aegis-distribution-sovereignty](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) (launch umbrella) |
| **Supersedes** | `tui-split-footer-host` brainstorm (architectural-collapse direction was correct; layout target was wrong) |
| **Makes permanent** | `tui-native-selection` drag-select override (re-homed inside the new host's mouse contract) |

## Summary

Collapse the genie TUI display layer from two glued tmux servers + one OpenTUI process down to one OpenTUI process. OpenTUI becomes the sole host: existing `<Nav>` keeps the left side, a new `<TerminalPane>` Renderable widget (built on `OptimizedBuffer.setCell` + a `@xterm/headless` cell buffer + a `tmux -CC` control-mode link, ported from khal-os) replaces the right-side passthrough mirror pane. Visual UX (sidebar+content layout, split ratio, theme, click-to-focus) is preserved exactly; the `-L genie-tui` display tmux server and its config file are deleted; the `-L genie` agent server is untouched. v5-only — v4 stays frozen on dual-tmux indefinitely.

## Scope

### IN

- New `TerminalPane` Renderable widget (`src/tui/widgets/TerminalPane.tsx`) extending OpenTUI's `Renderable` base. Owns one `@xterm/headless` instance, blits cells into `OptimizedBuffer` each render frame, handles focus/keystroke routing.
- New `src/tui/tmux-control/` module: ports khal-os's `tmux-control.ts` (control connection + octal-escape `%output` decoder + `%exit` handling), `tmux-input.ts` (`send-keys -H` hex writer + `paste-buffer -p` fallback), and `tmux-resize.ts` (`refresh-client -C <w>x<h>`) verbatim, adapted to bun + the existing genie module structure.
- Add `@xterm/headless` (MIT, ~150 KB) as a runtime dependency.
- `<App>` layout swap in `src/tui/app.tsx`: replace today's right-side tmux mirror with `<TerminalPane>`; preserve current split ratio + theme + click-to-focus + spawn-target picker plumbing.
- Re-home the drag-select override (`?1002l + ?1003l`) inside `TerminalPane`'s mount lifecycle as the documented mouse contract; reuse `src/tui/render.test.ts` assertions verbatim.
- End-to-end removal of the display tmux server: delete `tmux-theme-sync.ts`, `attachTuiSession`, `ensureTuiSession`, `isTuiSessionReady`, the `_genie_*` mirror pane creator in `src/tui/tmux.ts`, and `tui-tmux.conf` (both the template and the runtime-generated file). Scrub `genie doctor` and `genie serve` for the now-orphan checks.
- Collapse `genie app --tui` to a thin wrapper over `renderNav()` — no tmux session orchestration before render.
- Cross-terminal smoke matrix as v5 launch gate: Warp, iTerm2, Ghostty, Terminal.app, Wezterm, Alacritty, kitty, foot.
- Microbenchmark fixture (`src/tui/widgets/__benches__/terminal-pane.bench.ts`) emitting 10 000 lines @ 1 ms intervals; validates the ≤100 ms p95 emit→render budget.
- v5-only cutover. The legacy code paths above are deleted in the same PR that flips embed to default; no `embed=off` escape hatch ships in v5.

### OUT

- `-L genie` agent tmux server lifecycle — untouched.
- Replacing tmux as the agent execution substrate (e.g., node-pty).
- Replacing OpenTUI as the renderer.
- khal-os browser-side `genie-workspace-canvas` (different surface, already shipped).
- `screenMode: "split-footer"` adoption (layout incompatible with the sidebar+content directive).
- Mounting multiple `<TerminalPane>` instances simultaneously (only the focused agent renders).
- Cross-major flag plumbing between v4 and v5 (v5 ships embed-only).
- Backporting any of this to v4 on npm.
- Custom VT parser implementation (we adopt `@xterm/headless` rather than rolling our own).
- Replacing the existing `<Nav>` React tree (only the right-side surface changes).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Visual UX preserved exactly: Nav (left) + content (right), same split ratio, same theme, same click-to-focus. No footer mode. | Operator directive 2026-05-10. The prior split-footer rejection was layout, not architecture. |
| 2 | Tmux retained for agent execution only. `-L genie-tui` deleted; `-L genie` untouched. | Dual-tmux is the bug; the agent substrate is correct as-is. |
| 3 | Embed mechanism = new `TerminalPane` Renderable + `@xterm/headless` cell buffer. | OpenTUI 0.2.6 has no PTY widget; `ScrollbackSurface` is split-footer-locked. `@xterm/headless` is MIT, ~150 KB, used by VS Code Terminal — battle-tested parser without rolling our own. |
| 4 | Tmux↔host data link = `tmux -CC` control mode. Implement from the khal-os `tmux-control-mode-terminal` wish spec (the implementation source was removed from khal-os post-ship; the spec at `/home/genie/workspace/repos/khal-os/genie/.genie/wishes/tmux-control-mode-terminal/WISH.md` is the canonical reference). | The original "port verbatim" instruction was based on file paths that no longer exist (`packages/genie-app/views/genie/service/`). The shipped wish remains the highest-fidelity contract — execution-group API surface is fully specified there. |
| 4b | Group 6's deletion list pins concrete paths verified against the worktree as of 2026-05-10: `scripts/tmux/tui-tmux.conf` (template), the runtime-generated `~/.genie/tui-tmux.conf` (must stop being emitted), `src/tui/tmux-theme-sync.ts` (+ test), and the `_genie_*`/`attachTuiSession`/`ensureTuiSession`/`isTuiSessionReady` portions of `src/tui/tmux.ts`. No "or equivalent" hedging. | Reviewer plan-review feedback (2026-05-10, LOW): concrete paths prevent ambiguity at execution time. |
| 5 | v5-only cutover. v4 stays frozen on dual-tmux indefinitely. No flag, no migration. | Sister to `v5-major-cutover-handoff`. Eliminates two-surface tax. Operators move via `genie v4-upgrade`. |
| 6 | Drag-select override (`?1002l + ?1003l`) carried forward as `TerminalPane`'s documented mouse contract. | Clicks ON (Nav + focus), drag tracking OFF (native selection). Same contract that shipped in `tui-native-selection`; tests reused unchanged. |
| 7 | Initial buffer replay on focus = control-mode `dump-history`, capped at `max(tmux history-limit, 10 000)` lines. | Matches khal-os. Prevents multi-MB blast when focusing a long-running agent. |
| 8 | Focus & input model: TerminalPane focused → keystrokes via `send-keys -H`; Nav focused → keystrokes drive Nav. Mouse click transfers focus; keymap hotkey toggles. | Matches today's click-left-to-choose / click-right-to-type flow. Modal "send mode" rejected as redundant. |
| 9 | One `<TerminalPane>` mounted at a time (focused agent). Background agents keep running on `-L genie` but consume no `TerminalPane` resources. | Matches today's "right side shows one agent at a time" UX exactly; avoids unbounded memory/CPU. |
| 10 | Perf budget: ≤100 ms p95 emit→render on Linux, ≤150 ms on macOS, ≤8 % single-core idle CPU. Microbenchmark fixture validates as part of CI. | Matches khal-os measured budget; tighter than today's dual-tmux passthrough (~150 ms steady). |
| 11 | Theme: `-L genie` keeps consuming `.generated.theme.conf`; the `tui-tmux.conf` generation path is removed. OpenTUI side keeps `src/tui/theme.ts`. | One fewer config file; one fewer place for theme drift. |
| 12 | Deletion order: Group 4 ships `TerminalPane` + tmux-control behind `GENIE_TUI_HOST=embed`; Group 5 validates smoke matrix; Group 6 flips default + deletes legacy code paths in one PR. No long-running `embed=off`. | Prove-then-collapse; avoids two-codepath debt. |

## Success Criteria

- [ ] `genie tui`, `genie`, and `genie app --tui` launch a single OpenTUI process; `pgrep -f "tmux -L genie-tui"` returns zero rows after a clean start.
- [ ] `~/.genie/tui-tmux.conf` is not generated at runtime and the template file is removed from the repo.
- [ ] Visual parity gate: split ratio, theme, and click-to-focus identical to v4. `.genie/runbooks/tui-host/smoke-matrix.md` carries the before/after screenshots cross-reference + reviewer `Signed-off-by:` trailer.
- [ ] Drag-select inside the `TerminalPane` region copies via host-terminal-native clipboard in Warp (macOS), iTerm2, Ghostty, Terminal.app, Wezterm, Alacritty, kitty, foot. No OSC 52, no tmux DCS, no `pbcopy` bridge.
- [ ] Click-to-focus from `<Nav>` mounts/refocuses `TerminalPane`; initial scrollback replay completes ≤500 ms.
- [ ] Keystrokes typed while `<TerminalPane>` is focused reach the agent's tmux pane (golden test against a live agent that echoes input back).
- [ ] `tmux -L genie kill-server` (operator wipes the agent server) surfaces a clean "agent server unreachable; restart with `genie serve`" status in `<Nav>` — no crash, no OpenTUI hang.
- [ ] `genie doctor` reports the single-host TUI architecture and the legacy "TUI server up" check is replaced.
- [ ] Perf: ≤100 ms p95 emit→render on Linux, ≤150 ms p95 on macOS, measured by the microbenchmark fixture (10 000 lines @ 1 ms intervals).
- [ ] Idle CPU: ≤8 % single-core with focused agent idle (60 s `top` sample).
- [ ] All existing `tui-native-selection` `render.test.ts` assertions pass against the new host.
- [ ] Deletion checklist complete in the same PR that flips embed to default: `tmux-theme-sync.ts`, the `_genie_*` mirror pane creator in `src/tui/tmux.ts`, `attachTuiSession`, `ensureTuiSession`, `isTuiSessionReady`, and `tui-tmux.conf` template all removed.

## Execution Strategy

Six groups across four waves. Wave 1 is the foundational spike + dependency add; Wave 2 stands up the tmux-control client; Wave 3 ships the renderable widget; Wave 4 wires it into `<App>`, validates, and collapses the legacy paths.

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Spike `@xterm/headless` attribute coverage; add as runtime dep; lock fallback strategy if attribute gaps surface |

### Wave 2 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Port khal-os `tmux-control-mode-terminal` client to `src/tui/tmux-control/` |

### Wave 3 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Implement `TerminalPane` Renderable widget; wire to tmux-control; mouse-contract override |

### Wave 4 (sequential — depends on visual + smoke gates)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Wire `<TerminalPane>` into `<App>` behind `GENIE_TUI_HOST=embed`; preserve visual parity |
| 5 | qa | Smoke matrix across 8 terminals + microbenchmark fixture; visual parity screenshots |
| 6 | engineer | Flip embed to default; delete `-L genie-tui` lifecycle, `tui-tmux.conf`, `tmux-theme-sync.ts`, `_genie_*` creator, attach/ensure/isReady helpers; refresh `genie doctor` |

## Execution Groups

### Group 1: `@xterm/headless` spike + dependency add

**Goal:** Verify `@xterm/headless`'s cell-buffer surface is rich enough to drive OpenTUI's `OptimizedBuffer.setCell`. Lock dependency. Decide fallback path if attribute gaps surface.

**Deliverables:**
1. `package.json` gains `@xterm/headless` at the latest 5.x release (currently `^5.5.0`); `bun.lockb` regenerated; license entry verified MIT.
2. New scratch script `scripts/tui-spike/xterm-headless-attrs.ts` (kept committed under `scripts/tui-spike/` and referenced from the wish but **not** part of the runtime build) that pipes a fixture-stream of ANSI sequences (true-color, bold, underline, hyperlink, mouse passthrough, wide chars) through `@xterm/headless` and dumps every cell's attributes. Output committed to `.genie/runbooks/tui-host/xterm-attr-coverage.md`.
3. `.genie/runbooks/tui-host/xterm-attr-coverage.md` documents which attributes are first-class on `headless.Buffer.getCell()` and which (if any) require ANSI passthrough fallback (`OptimizedBuffer.drawText` with escape sequences).

**Acceptance Criteria:**
- [ ] `@xterm/headless` resolves cleanly under bun (`bun install` succeeds, no peer-dep warnings).
- [ ] Spike script runs end-to-end and emits the coverage doc.
- [ ] Coverage doc names every attribute Group 3 will rely on, with a verdict (PASS / FALLBACK / OUT OF SCOPE) per attribute.
- [ ] If any required attribute lands in FALLBACK, the doc names the fallback strategy and points to the exact call site (e.g., "underline curly → `OptimizedBuffer.drawText` ANSI passthrough at `TerminalPane.renderCell`").

**Validation:**
```bash
# First run: G1 adds the @xterm/headless entry, so lockfile is rewritten.
# CI on subsequent runs uses --frozen-lockfile to guard against drift.
bun install && bun run scripts/tui-spike/xterm-headless-attrs.ts > /tmp/xterm-attrs.txt && grep -q "PASS\|FALLBACK\|OUT OF SCOPE" .genie/runbooks/tui-host/xterm-attr-coverage.md && grep -q '"@xterm/headless"' package.json
```

**depends-on:** none

---

### Group 2: Implement `tmux-control` client from the khal-os spec

> **Engineer trap warning (added 2026-05-10 after G2 retro):** The original
> wish text said "port khal-os's tmux-control-mode-terminal client verbatim"
> and named source files at `packages/genie-app/views/genie/service/`. That
> directory **no longer exists** in the current `khal-os` checkout — the
> wish (slug `tmux-control-mode-terminal`, status SHIPPED 2026-03-18) DID
> ship, but the implementation has since been removed/relocated to a repo
> not currently in `/home/genie/workspace/repos/`. **Port the SPEC, not the
> code.** The full spec lives at
> `/home/genie/workspace/repos/khal-os/genie/.genie/wishes/tmux-control-mode-terminal/WISH.md`
> (267 lines, with execution-group-level API contracts including
> `attachSession`, `decodeOctalEscapes`, `sendKeys`, `resizeClient`, and the
> tmux version requirement). Adapt every API name to genie's module shape
> (e.g., separate `control.ts` / `input.ts` / `resize.ts` files rather than
> a single class).

**Goal:** Stand up the data link between OpenTUI and the `-L genie` agent server. Single `tmux -CC` connection per focused pane; `%output` push; `send-keys -H` input; `refresh-client -C` resize.

**Reference spec (read these BEFORE writing any code):**
- `/home/genie/workspace/repos/khal-os/genie/.genie/wishes/tmux-control-mode-terminal/WISH.md` — full spec, decision table, success criteria, and per-group API contracts.
- `tmux(1)` man page section "CONTROL MODE" — protocol-level reference for `%output`, `%exit`, `%error`, `%begin`/`%end` framing.

**Deliverables:**
1. `src/tui/tmux-control/control.ts` — control-mode client. Implements `attachSession(sessionName: string): ControlSession` (khal-os spec G1 deliverable #1). One `child_process.spawn('tmux', ['-L', 'genie', '-CC', 'attach', '-t', sessionName])` per instance. Emits `output(paneId, data)`, `exit(code)`, `error(err)` events. Handles `%begin`/`%end` block framing, `%exit` notification, and process-crash auto-reconnect.
2. `src/tui/tmux-control/octal.ts` — `decodeOctalEscapes(input: string): Buffer` per the khal-os spec (`\ooo` → byte, `\\` → literal backslash, everything else passes through as UTF-8). Pure function, easy to fuzz.
3. `src/tui/tmux-control/input.ts` — `sendKeys(paneId, data)` writes `send-keys -H -t <paneId> <hex bytes>` to control stdin. tmux 3.2+ supports `-H`; smoke test asserts the host meets the version requirement. Adds a `paste-buffer -p` fallback path for payloads ≥256 bytes or semicolon-laden multi-codepoint pastes.
4. `src/tui/tmux-control/resize.ts` — `resizeClient(cols, rows)` writes `refresh-client -C ${cols},${rows}` to control stdin; debounced 50 ms (final-value-wins) to avoid resize storms.
5. `src/tui/tmux-control/__tests__/control.test.ts` — fixture-driven tests parsing canned `%output` payloads (including octal-encoded UTF-8, partial frames straddling chunks, `%exit 0`/`%exit 1`, `%error`). Cover `%begin`/`%end` framing.
6. `src/tui/tmux-control/__tests__/octal.test.ts` — comprehensive byte-table for `decodeOctalEscapes`: every octal in `[0o0-0o377]`, `\\` literal, mixed strings, partial-escape edge cases (e.g., string ending in `\1`).
7. `src/tui/tmux-control/__tests__/input.test.ts` — hex-encoding correctness across ASCII, UTF-8 multibyte (2/3/4 byte), and the `;`-bearing edge case; verifies the `paste-buffer -p` fallback threshold.
8. `src/tui/tmux-control/__tests__/resize.test.ts` — debounce window + final-value-wins invariants.
9. `src/tui/tmux-control/PORT-NOTES.md` — documents every place the implementation diverges from the khal-os spec (e.g., module structure split into 4 files vs khal-os's single-class arrangement), with rationale.

**Acceptance Criteria:**
- [ ] All khal-os `tmux-control-mode-terminal` spec semantics replicated (per G1 deliverables 1–3 in the khal-os WISH.md). Divergences documented in `PORT-NOTES.md` with rationale.
- [ ] `bun test src/tui/tmux-control/` — full suite green, ≥90 % line coverage.
- [ ] Manual smoke: `bun run scripts/tui-spike/tmux-control-attach.ts <agent-session-name>` connects, streams `%output` for 10 s, and disconnects cleanly. Captures sample transcript to `/tmp/tmux-control-smoke.log`.
- [ ] No `node-pty` import added (we are explicitly using tmux as the multiplexer, not raw PTYs).
- [ ] tmux version probe: `tmux -V` reports ≥3.2 (assert in the smoke script; fail loudly on lower versions since `send-keys -H` requires 3.2+).

**Validation:**
```bash
# Sanity: tmux version supports send-keys -H (≥3.2)
tmux -V | awk '{split($2,v,"."); if (v[1] < 3 || (v[1] == 3 && v[2] < 2)) { print "FAIL: tmux " $2 " < 3.2"; exit 1 } else { print "OK: tmux " $2 }}' && \
# Unit suite
bun test src/tui/tmux-control/ && \
# Manual smoke against an existing agent session
bun run --silent scripts/tui-spike/tmux-control-attach.ts $(tmux -L genie list-sessions -F '#{session_name}' | head -n1) 2>&1 | head -20
```

**depends-on:** none (independent of Group 1)

---

### Group 3: `TerminalPane` Renderable widget

**Goal:** Build the OpenTUI widget that renders an `@xterm/headless` cell buffer fed by a `tmux-control` client. Mount/unmount lifecycle, focus handling, mouse-contract override.

**Deliverables:**
1. `src/tui/widgets/TerminalPane.tsx` — exports `class TerminalPane extends Renderable`. Public props: `sessionName: string`, `paneId?: string`, `focused: boolean`, `onResize?: (cols, rows) => void`.
2. Internal: instantiates `@xterm/headless`, owns a `TmuxControlClient` from Group 2, pumps `%output` bytes into `xterm.write()`, and on each OpenTUI render frame walks `xterm.buffer.active.getLine(y).getCell(x)` and `setCell`s into `OptimizedBuffer`.
3. Focus contract: when `focused` flips to true, install keystroke listener that hex-encodes & forwards via `tmux-control/input.ts`. When `focused` flips to false, uninstall listener.
4. Resize contract: on `OptimizedBuffer` viewport change, debounce to 50 ms and call `tmux-control/resize.ts` with the new `(cols, rows)`.
5. Mouse contract: on mount AND on every `renderer.enableMouse()` invocation (renderer-internal `setupTerminal` already fires it once), emit `\x1b[?1002l\x1b[?1003l` via the same wrapper pattern shipped in `tui-native-selection`. Re-use `disableDragTracking` from `src/tui/render.tsx` (do not duplicate the constant).
6. Initial-buffer replay: on first mount for a session, request `tmux -CC` `dump-history -p -S -<historyLimit>` and pre-feed `xterm.write()` before the live `%output` stream begins.
7. `src/tui/widgets/__tests__/TerminalPane.test.tsx` — unit tests for: cell-blit correctness against a canned `xterm` buffer, focus toggle install/uninstall, resize debounce, initial-replay cap.
8. `src/tui/widgets/__benches__/terminal-pane.bench.ts` — microbenchmark fixture (deliverable surfaces in Group 5 measurement).

**Acceptance Criteria:**
- [ ] `TerminalPane` mounts cleanly under `createCliRenderer({ useMouse: true, enableMouseMovement: false })`.
- [ ] Cell-blit correctness: 1 000-cell golden fixture maps 1:1 from `xterm.buffer` to `OptimizedBuffer` (snapshot test).
- [ ] Focus toggle install/uninstall is symmetric (no listener leak across 100 mount/unmount cycles — verified by counting `process.stdin.listenerCount('data')`).
- [ ] Mouse contract: emitted bytes contain BOTH `\x1b[?1002l` and `\x1b[?1003l` after every `enableMouse` invocation (regression assertion mirrors `render.test.ts:103`).
- [ ] Resize: 10 rapid resize events within 50 ms produce exactly one `refresh-client -C` invocation with the final size.
- [ ] Initial-replay cap honored: history bigger than the cap emits exactly `cap` lines, then transitions to live stream.

**Validation:**
```bash
bun test src/tui/widgets/TerminalPane.test.tsx && bun test src/tui/widgets/__tests__/
```

**depends-on:** Group 1 (`@xterm/headless` dep + attr coverage doc), Group 2 (`tmux-control` client)

---

### Group 4: Wire `<TerminalPane>` into `<App>` behind embed flag

**Goal:** Replace the right-side tmux mirror in `<App>` with `<TerminalPane>`, gated by `GENIE_TUI_HOST=embed`. Preserve visual parity. Click-to-focus from `<Nav>` mounts the correct pane.

**Deliverables:**
1. `src/tui/app.tsx` swap: when `GENIE_TUI_HOST=embed` (or, in v5, the unflagged default — but Group 4 ships with the flag; Group 6 flips), render `<TerminalPane>` instead of the existing right-side tmux mirror. Split ratio + theme preserved.
2. `<Nav>`'s `onFocusAgent` handler updates a shared focus context that `<TerminalPane>` subscribes to (one mounted instance, swaps `sessionName` prop).
3. `src/tui/render.tsx` no longer needs `installNativeSelectionOverride` at the renderer level — the override moves into `TerminalPane`. Keep `disableDragTracking` exported for `TerminalPane` to import; remove the renderer-level wrap. Update `render.test.ts` to assert the new contract.
4. `genie app --tui` (in `src/term-commands/app.ts`) collapses to: import `renderNav()`, await it, exit. Remove `handleTuiMode`'s `ensureTuiSession`/`isTuiSessionReady` calls when `GENIE_TUI_HOST=embed`.
5. `.genie/runbooks/tui-host/embed-flag.md` documents the `GENIE_TUI_HOST` flag, its values (`embed` | `legacy`), and the expected default flip in Group 6.

**Acceptance Criteria:**
- [ ] `GENIE_TUI_HOST=embed genie tui` launches a single OpenTUI process; right side renders the focused agent via `<TerminalPane>`.
- [ ] `GENIE_TUI_HOST=legacy genie tui` still launches the dual-tmux path unchanged (regression coverage during transition).
- [ ] Visual split ratio + theme byte-for-byte identical to legacy mode (verified by side-by-side screenshots committed to `.genie/runbooks/tui-host/visual-parity-before.png` and `…-after.png`).
- [ ] Click-on-Nav-node in embed mode focuses the corresponding agent's `<TerminalPane>` within 200 ms.
- [ ] `bun test src/tui/render.test.ts` passes with the new contract (override re-homed inside `TerminalPane`).
- [ ] `bun run check` clean.

**Validation:**
```bash
bun run check && bun test src/tui/render.test.ts && GENIE_TUI_HOST=embed timeout 5 bun run src/genie.ts tui --no-attach 2>&1 | head -10
```

**depends-on:** Group 3

---

### Group 5: Cross-terminal smoke matrix + perf microbenchmark

**Goal:** Validate embed mode across the eight launch-gate terminals; capture before/after performance numbers.

**Deliverables:**
1. `.genie/runbooks/tui-host/smoke-matrix.md` — table per terminal (Warp, iTerm2, Ghostty, Terminal.app, Wezterm, Alacritty, kitty, foot) covering: mount, click-to-focus, drag-select copy, paste, resize, exit cleanup. Each row carries a verdict (PASS / FAIL / WORKAROUND) + the operator screenshot artifact.
2. Microbenchmark execution: run `bun run src/tui/widgets/__benches__/terminal-pane.bench.ts` on Linux + macOS hosts. Output committed to `.genie/runbooks/tui-host/perf-baseline.md` with p50 / p95 / max emit→render latency and idle CPU sampled over 60 s.
3. Visual-parity screenshots (before = legacy, after = embed) for all eight terminals committed under `.genie/runbooks/tui-host/visual-parity/<terminal>/{before,after}.png`.

**Acceptance Criteria:**
- [ ] Smoke matrix PASSes on at least 6 of 8 terminals; remaining 2 carry a WORKAROUND or a documented launch-list exclusion (release notes carry the compat caveat).
- [ ] Perf: Linux p95 ≤100 ms emit→render; macOS p95 ≤150 ms emit→render; idle CPU ≤8 %. Failures block Group 6.
- [ ] Visual parity reviewer-signed in `smoke-matrix.md`. The doc MUST carry a literal `Signed-off-by: <name> <email>` trailer line authored by Felipe or a designated human reviewer. The validation command below greps for that trailer.
- [ ] Drag-select copy verified working (without OSC 52 / tmux DCS) in Warp + iTerm2 + Ghostty at minimum.

**Validation:**
```bash
# Perf gate (machine-checkable):
bun run src/tui/widgets/__benches__/terminal-pane.bench.ts | tee .genie/runbooks/tui-host/perf-baseline.md && \
grep -E "^p95.*(emit_render|idle_cpu)" .genie/runbooks/tui-host/perf-baseline.md && \
# Smoke-matrix human sign-off gate (the manual 8-terminal verification cannot be machine-validated, but the artifact MUST land before Group 6 ships):
grep -E "^Signed-off-by: " .genie/runbooks/tui-host/smoke-matrix.md
```

**depends-on:** Group 4

---

### Group 6: Flip embed to default + delete legacy code paths

**Goal:** In one PR, make embed the unflagged default in v5 and remove all dual-tmux display code. v5 ships embed-only; v4 is untouched.

**Deliverables:**
1. `src/tui/app.tsx`: drop the `GENIE_TUI_HOST` branch; `<TerminalPane>` is the unconditional right-side renderer.
2. Delete `src/tui/tmux-theme-sync.ts` + its tests.
3. Delete `src/tui/tmux.ts`'s `_genie_*` mirror pane creator, `attachTuiSession`, `ensureTuiSession`, `isTuiSessionReady`. Keep only helpers Group 2 + Group 3 need.
4. Delete `templates/tui-tmux.conf` (or equivalent template path); remove its codegen in the theme generator. Verify `genie doctor`'s `~/.genie/tui-tmux.conf` check is replaced by a "single-host TUI" check.
5. Update `src/term-commands/app.ts` `handleTuiMode`: collapse to `await renderNav();`.
6. Update `src/term-commands/serve.ts`: remove `ensureTuiSession`/`isTuiSessionReady` exports; collapse to single-tmux (`-L genie`) lifecycle.
7. Scrub `genie doctor` (`src/term-commands/doctor.ts`) for orphan `-L genie-tui` references.
8. Release-notes draft entry in `.genie/runbooks/tui-host/release-notes.md` (kept in-repo for this PR; promote to the public `docs/v5-launch/release-notes.md` via a separate docs-submodule PR after merge) + a one-line `genie doctor` advisory for v4-on-npm operators who attach into a v5 host. **Engineer note:** `docs/` is a symlink into the `.docs-vendor` submodule — writing there from this wish requires a separate docs-vendor PR with its own lifecycle. Land in-repo paths only inside this wish.
9. CHANGELOG entry + delete migration note.

**Acceptance Criteria:**
- [ ] After this group: `rg "genie-tui|tui-tmux\.conf|attachTuiSession|ensureTuiSession|isTuiSessionReady" src/` returns zero matches.
- [ ] `bun run check` clean; `bun test` clean; `bun run typecheck` clean.
- [ ] `pgrep -f "tmux -L genie-tui"` returns zero rows on a fresh `genie tui` invocation (verified by an integration test).
- [ ] `~/.genie/tui-tmux.conf` is not created by `genie serve` or `genie init` (verified by a fixture test).
- [ ] `genie doctor` reports the single-host architecture (the legacy "TUI server up" check replaced).
- [ ] All Wave 2–5 acceptance criteria still hold (regression coverage).

**Validation:**
```bash
bun run check && bun test && rg "genie-tui|tui-tmux\.conf|attachTuiSession|ensureTuiSession|isTuiSessionReady" src/ | grep -v "PORT-NOTES\|release-notes" | (! grep -q .)
```

**depends-on:** Group 5

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Bare `genie` (no flag, no `--tui`) launches a single OpenTUI process; right pane renders the first focusable agent via `<TerminalPane>`.
- [ ] `genie app --tui` does the same; no "no sessions" race surfaces under repeated invocation (loop test: 50× start/stop).
- [ ] Drag-select inside the right pane copies via host-terminal-native clipboard in Warp (macOS) and at least 5 other terminals from the smoke matrix.
- [ ] Click-on-Nav-node refocuses the right pane within 200 ms.
- [ ] Keystrokes typed in the right pane reach the agent (`genie agent log <agent>` shows the input).
- [ ] `tmux -L genie kill-server` while the TUI is open surfaces a "agent server unreachable" status in Nav (no crash, no hang); restart with `genie serve` restores the pane.
- [ ] `genie doctor` reports single-host architecture (no `-L genie-tui` row).
- [ ] No regression on existing TUI shortcuts (theme toggle, help overlay, quit dialog, agent picker, spawn target picker, context menu).
- [ ] Idle CPU ≤8 % single-core (60 s `top` sample).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@xterm/headless` cell-attribute gap (curly underline, hyperlinks, true-color) under bun | Medium | Group 1 spike documents per-attribute verdict; fallback path = `OptimizedBuffer.drawText` ANSI passthrough at named call sites. |
| OpenTUI frame-rate vs. VT update rate produces visible tearing under high-throughput agents | Medium | `TerminalPane.render()` coalesces VT updates to the next `targetFps`-aligned frame (same pattern khal-os's xterm.js render service uses). |
| `tmux -CC` silent stall after agent server restart | Medium | 5 s `display-message #{client_pid}` health-check; reconnect on miss; port khal-os reconnect code. |
| Cross-terminal mouse-protocol drift (e.g., foot's selection model) | Medium | Smoke matrix is launch-gate, not per-PR gate; release notes carry compat caveats. |
| `send-keys -H` semicolon edge cases on multi-codepoint paste | Low | Port khal-os's `load-buffer` + `paste-buffer -p` fallback (deliverable in Group 2). |
| Operator surprise: no `-L genie-tui` server in v5 | Low | Release-notes line + `genie doctor` advisory ("display tmux server retired in v5; only `-L genie` exists now"). |
| Visual parity drift if `<Nav>`'s right-pane interaction has hidden side effects on tmux state | Medium | Side-by-side screenshot diff in Group 5 is reviewer-signed before Group 6 ships; Group 4 keeps `GENIE_TUI_HOST=legacy` as a fallback during validation. |
| `@xterm/headless` carries a transitive dep that breaks the v5 CDN binary build (`bun build --compile`) | Low | Run `bun build --compile` against a probe project in Group 1 as part of the spike. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

> **Engineer trap warning (added 2026-05-10 after G1 retro):** `docs/` is a
> symlink into the `.docs-vendor` git submodule (its own repo,
> `automagik-dev/docs.git`). Writes inside `docs/` land in a SEPARATE repo
> with a SEPARATE PR lifecycle, NOT in `wish/tui-opentui-host`. All
> in-progress wish deliverables MUST land under `.genie/runbooks/tui-host/`
> (in-repo). The `docs/v5-launch/` promotion happens as a follow-up
> docs-submodule PR after this wish ships. The G1 spike originally wrote to
> `docs/v5-launch/tui-host/` and got relocated; do not repeat the mistake.

```
# CREATE
src/tui/widgets/TerminalPane.tsx
src/tui/widgets/__tests__/TerminalPane.test.tsx
src/tui/widgets/__benches__/terminal-pane.bench.ts
src/tui/tmux-control/control.ts
src/tui/tmux-control/input.ts
src/tui/tmux-control/resize.ts
src/tui/tmux-control/PORT-NOTES.md
src/tui/tmux-control/__tests__/control.test.ts
src/tui/tmux-control/__tests__/input.test.ts
src/tui/tmux-control/__tests__/resize.test.ts
scripts/tui-spike/xterm-headless-attrs.ts
scripts/tui-spike/tmux-control-attach.ts
.genie/runbooks/tui-host/xterm-attr-coverage.md
.genie/runbooks/tui-host/embed-flag.md
.genie/runbooks/tui-host/smoke-matrix.md
.genie/runbooks/tui-host/perf-baseline.md
.genie/runbooks/tui-host/visual-parity-before.png
.genie/runbooks/tui-host/visual-parity-after.png
.genie/runbooks/tui-host/visual-parity/warp/{before,after}.png
.genie/runbooks/tui-host/visual-parity/iterm2/{before,after}.png
.genie/runbooks/tui-host/visual-parity/ghostty/{before,after}.png
.genie/runbooks/tui-host/visual-parity/terminal-app/{before,after}.png
.genie/runbooks/tui-host/visual-parity/wezterm/{before,after}.png
.genie/runbooks/tui-host/visual-parity/alacritty/{before,after}.png
.genie/runbooks/tui-host/visual-parity/kitty/{before,after}.png
.genie/runbooks/tui-host/visual-parity/foot/{before,after}.png

# MODIFY (Group 4 — gated; Group 6 — final)
src/tui/app.tsx
src/tui/render.tsx
src/tui/render.test.ts
src/term-commands/app.ts
src/term-commands/serve.ts
src/term-commands/doctor.ts
package.json
bun.lockb
docs/v5-launch/release-notes.md
CHANGELOG.md

# DELETE (Group 6)
src/tui/tmux-theme-sync.ts
src/tui/tmux-theme-sync.test.ts
src/tui/tmux.ts  # only the _genie_* / attachTuiSession / ensureTuiSession / isTuiSessionReady portions
scripts/tmux/tui-tmux.conf  # actual repo path (the v4 display-server template; verified 2026-05-10)
~/.genie/tui-tmux.conf  # runtime-generated copy in operator HOME; not committed, but `genie serve`/`genie init` must stop emitting it
```
