# Design: TUI native terminal selection

| Field | Value |
|-------|-------|
| **Slug** | `tui-native-selection` |
| **Date** | 2026-05-09 |
| **WRS** | 100/100 |
| **Target release** | v5 |
| **Author** | Felipe Rosa <felipe@namastex.ai> + Genie (genie-configure agent) |
| **Supersedes** | `tui-click-only-mouse` (folded into Jaw A), `tui-split-footer-host` (architectural rewrite explicitly rejected) |
| **Sister wishes** | `v5-major-cutover-handoff` (same v4-final / v5-launch boundary) |

## Problem

`genie tui` captures drag events in the OpenTUI Nav (via OpenTUI's hardcoded `?1002h` xterm mouse-tracking emit) and routes copy through OSC 52 escape sequences (via tmux's `set-clipboard external` + `Ms` capability override + `osc52-copy.sh` pipe). This breaks native drag-to-select + Cmd+C in terminals that don't implement OSC 52 — notably Warp on macOS — even though the underlying v4 sidebar+content layout is the UX users want preserved.

## Scope

### IN

**Jaw A — Local mouse override (ships day-one of v5)**
- `src/tui/render.tsx`: emit `\e[?1002l` to stdout immediately after `createCliRenderer(resolveTuiRendererConfig())` returns, to disable OpenTUI's `?1002h` drag-tracking subscription while leaving `?1000h` (clicks) intact. Per xterm "last sequence wins" semantics (confirmed in `terminal.zig:588` source comment), the terminal then reports only press/release events to OpenTUI; drag events return to local-terminal control where they trigger native text selection.
- Hook into renderer lifecycle so the override is re-applied whenever OpenTUI re-runs its mouse setup: subscribe to suspend/resume events and the runtime `useMouse` setter.
- Audit `src/tui/components/**` for any `onMouseDrag` / `onMouseDragEnd` registrations. Confirm zero consumers exist (Nav and modals use clicks only). Commit the audit result as a short comment in `Nav.tsx`.

**Jaw B — Strip OSC 52 plumbing (ships with Jaw A)**
- `scripts/tmux/genie.tmux.conf`: change `set -g set-clipboard external` to `set -g set-clipboard off`; remove `set -ga terminal-overrides ",*:Ms=\E]52;c;%p2%s\7"`.
- `scripts/tmux/tui-tmux.conf`: same two edits.
- Tmux copy-mode bindings in both confs: replace `copy-pipe-and-cancel "~/.genie/scripts/osc52-copy.sh"` with `copy-selection-and-cancel`. Tmux buffer is still maintained for users who explicitly hit `prefix + ]` to paste; no automatic clipboard side effect.
- `scripts/tmux/osc52-copy.sh`: keep on disk (D7) for ad-hoc operator use outside the TUI; just stop invoking from tmux config.
- `src/__tests__/tmux-config.test.ts`: invert the OSC 52 invariant assertions:
  - assert `set-clipboard off` (not `external`)
  - assert no `Ms` terminal-override
  - assert `copy-selection-and-cancel` (not `copy-pipe-and-cancel ... osc52-copy.sh`)
  - keep `allow-passthrough on` assertion (other tools may use DCS passthrough)
- CHANGELOG entry naming the contract: *"v5 TUI uses terminal-native selection. Drag to highlight, Cmd+C to copy. tmux's automatic OSC 52 emit is disabled — the terminal owns the entire selection lifecycle."*
- Doc note in `docs/configuration.md` (or equivalent) describing the user-facing semantics.

**Jaw C — Upstream PR to `anomalyco/opentui` (parallel; non-blocking)**
- File a PR wiring the existing `MouseLevel` enum in `packages/core/src/zig/terminal.zig:33-39` through `setMouseMode`. Today the enum is declared (`none`, `basic` *(click only)*, `drag` *(click + drag — current default)*, `motion`, `pixels`) but unused.
- Surface `mouseLevel?: MouseLevel | "none" | "basic" | "drag" | "motion"` in `CliRendererConfig` (`packages/core/src/renderer.ts`).
- Backward-compat shim: keep `useMouse` and `enableMouseMovement` working as today, with implicit mapping:
  - `useMouse: false` → `MouseLevel.none`
  - `useMouse: true, enableMouseMovement: false` → `MouseLevel.drag` (preserves current default)
  - `useMouse: true, enableMouseMovement: true` → `MouseLevel.motion`
  - `mouseLevel: 'basic'` → `MouseLevel.basic` (NEW path, not reachable via legacy flags)
- Tests covering each level in opentui.
- Once the PR merges and 0.2.7+ is published, follow-up minor in genie: bump `@opentui/core`, set `mouseLevel: 'basic'` natively in `resolveTuiRendererConfig`, delete the Jaw A local override.

**Smoke gate (launch criterion)**
- Warp on macOS — drag → highlight → Cmd+C → Mac clipboard
- Terminal.app on macOS — same
- Click-to-nav still works under both
- Suspend/resume preserves the override

### OUT
- The split-footer architectural rewrite (rejected; v4 sidebar+content layout preserved)
- Any change to the agent server `-L genie` other than the tmux config cleanup
- Any change to OpenTUI's render path or non-mouse subsystems
- Replacement of OpenTUI as the renderer
- Browser/Tauri-based TUI (separate khal-os surface, already shipped)
- Any change to `genie agent send-clipboard` / programmatic clipboard helpers (those use OSC 52 deliberately; unaffected)
- Smoke testing beyond Warp + Terminal.app — explicitly out of scope per Felipe directive
- Pre-built `GENIE_TUI_CLIPBOARD_AUTO=1` re-enable toggle (don't anticipate; add only on user complaint)

## Approach

The design rests on a single empirical fact verified against `anomalyco/opentui@v0.2.6` (cloned to `/home/genie/workspace/repos/opentui-investigate/`, HEAD `e663959`):

> When OpenTUI's `useMouse: true`, `setMouseMode` unconditionally emits `\e[?1000h\e[?1002h\e[?1006h`. There is no exposed knob to emit only `?1000h`. The `MouseLevel.basic` enum value naming "click only" exists but is dead code — the enum is declared and never consumed by `setMouseMode`.

Three jaws follow from that fact, each addressing a different time horizon:

- **Jaw A is the immediate fix:** override `?1002l` after OpenTUI's setup runs. Self-contained in genie. No upstream dependency. Ships with v5 day-one.
- **Jaw B is the cleanup that follows:** because drag is now terminal-owned, OSC 52 is no longer the path used for user-driven clipboard writes. Felipe explicitly rejected auto-clipboard-on-release ("classic select and cmd + c"), so leaving the OSC 52 plumbing in place actively confuses semantics — every drag would silently emit OSC 52, which Warp drops and Terminal.app handles, producing inconsistent feedback. Strip it.
- **Jaw C is the long-term right:** wire the existing-but-dormant enum upstream so genie eventually drops the local override. Non-blocking; if anomalyco moves slow, Jaw A persists fine.

The architectural rewrite previously brainstormed (`tui-split-footer-host`) was rejected at scope-discussion time because it solved the wrong problem. Felipe wants the existing UX preserved — sidebar+content, click left → render right, "Chrome with left bar instead of top tabs." This wish leaves that intact and fixes the implementation.

### Design-for-isolation notes
- **Single purpose per jaw:** Jaw A patches one concern (mouse mode) in one file (`src/tui/render.tsx`). Jaw B patches one concern (clipboard plumbing) in two tmux conf files + one test file. Jaw C ships in the opentui repo, not genie. Each jaw can land in a separate commit and be reviewed independently.
- **Well-defined interfaces:** Jaw A's contract is "after `createCliRenderer()` returns and on every mouse-relevant lifecycle event, ensure `?1002` is disabled." Jaw B's contract is "tmux confs assert `set-clipboard off` and `copy-selection-and-cancel`." Jaw C's contract is the standard opentui PR review process. None depend on the others' internals.
- **Independent testability:** Jaw A is testable via a synthetic terminal write capture in unit tests; Jaw B is testable via the existing `tmux-config.test.ts` regex assertions; Jaw C is testable inside opentui's own test harness. No combined-system integration test required for unit-level confidence.
- **File size signal:** the changes are small (~30 LOC for Jaw A, <50 LOC of conf + test edits for Jaw B). Nothing crosses a complexity threshold.
- **Explicit dependencies:** Jaw A → no dependencies. Jaw B → no dependencies (tmux config is read-only from genie's side). Jaw C → opentui maintainer review. The wish ships when Jaws A+B merge; Jaw C lands separately on its own cadence.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | Ship as one mega wish targeting v5; v4 stays frozen on npm | Felipe direct ask 2026-05-09. v5 cutover (`v5-major-cutover-handoff`) is the natural release boundary and aligns with the CDN/sovereignty story. |
| **D2** | Preserve the v4 sidebar+content layout. No split-footer rewrite | Felipe: "people love current behavior, it's just buggy." The architectural rewrite was solving the wrong problem. |
| **D3** | Jaw A (local `\e[?1002l` override) ships immediately, regardless of upstream PR status | Decoupled from anomalyco's review cadence. Closes the user pain on day one of v5. |
| **D4** | Jaw B (strip OSC 52 plumbing) ships in the same wish, not deferred | Felipe explicit: "classic select and cmd + c, no auto-clipboard-on-release." OSC 52 path is now dead weight; leaving it in produces user confusion (selection silently triggers a clipboard write when the user only wanted to highlight). |
| **D5** | Jaw C (upstream PR) is part of the wish but not blocking | Right long-term solution. We file it; if it merges before v5 ships, we use it natively and drop the local override; if not, the local override ships and is replaced in a follow-up minor. |
| **D6** | Use the existing `MouseLevel` enum, not a new `useMouseDrag` flag | The enum already exists in 0.2.6 source. Author intent is clear. Wiring an existing enum is a smaller, more reviewable PR than introducing a new boolean. |
| **D7** | Keep `osc52-copy.sh` script on disk; just stop invoking from tmux config | Some operator scripts may use it ad-hoc (e.g., `cat file.txt \| ~/.genie/scripts/osc52-copy.sh` from a non-TUI shell). Deletion is breaking; keeping is harmless. |
| **D8** | Smoke gate is Warp + Terminal.app on macOS only | Felipe directive: "people only use either of them, and it's hard to actually smoke test. Make it work with native protocols, and I'm pretty sure it will work." Trust xterm-spec compliance over exhaustive matrix testing. |
| **D9** | No pre-built `GENIE_TUI_CLIPBOARD_AUTO=1` re-enable toggle | YAGNI. If a user complains, add it. Don't pre-build configs against speculation. |
| **D10** | No "documented unsupported terminals" tier; users with niche terminals fall back to `GENIE_TUI_MOUSE=0` + `prefix+[` tmux copy-mode | Felipe directive removes the over-engineering. Best-effort beyond the smoke gate; CHANGELOG points to the env-var escape hatch. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Terminal interprets `?1002l` after `?1002h` differently than xterm spec (drag still captured, or clicks also disabled) | Medium | The smoke gate (Warp + Terminal.app) catches the two real-user cases. Users on hostile terminals fall back to `GENIE_TUI_MOUSE=0`; documented in CHANGELOG. |
| OpenTUI 0.2.7+ changes mouse setup such that the local override stops working before upstream PR lands | Low | Pin `@opentui/core` version explicitly during the override window; bump deliberately and re-verify on bump. |
| anomalyco rejects or sits on the upstream PR | Low | Wish ships fine without it (Jaw C is non-blocking). If rejection: maintain local override indefinitely as the long-term solution; document why in code comment. |
| Stripping OSC 52 plumbing breaks operator scripts that depended on `set-clipboard external` for non-interactive clipboard writes | Low | The script `osc52-copy.sh` stays on disk (D7). Anyone using it explicitly continues to work. The change is only that *tmux's automatic* clipboard write is disabled. |
| Some user genuinely loved auto-clipboard-on-release | Low | Felipe explicitly chose the opposite. Document the trade-off in CHANGELOG; if any user complains, add the env-var toggle ad-hoc (D9). |
| Test inversion in `tmux-config.test.ts` cherry-picks back wrong onto a v4 hot fix branch | Low | The wish targets v5 only. v4 codebase doesn't see this change. |
| Visual conflict between terminal-native selection highlight and OpenTUI's render in the Nav region | Low | Acceptable. Terminal selection styles are universally readable. No need to redesign. |

## Success Criteria

### Functional (smoke gate)
- [ ] Warp on macOS, attached to Linux server, `genie tui` running under v5: drag-select inside the OpenTUI Nav, release (no auto-copy fires), Cmd+C → text in Mac clipboard
- [ ] Same flow on Terminal.app
- [ ] Click-to-spawn / click-to-focus / click-to-expand still works in Nav under both Warp and Terminal.app
- [ ] Right tmux mirror pane: drag-select + Cmd+C works
- [ ] After `genie tui` is suspended (Ctrl+Z) and resumed, drag-select still works (re-override path verified)
- [ ] `bun test src/tui/` and `bun test src/__tests__/tmux-config.test.ts` green

### Architecture / code health
- [ ] No `?1002h` reaches the SSH PTY when `genie tui` is running (verified by `tmux capture-pane -p` snapshot grep, or by `script` capture during a smoke run)
- [ ] No OSC 52 escape (`\e]52;c;`) reaches the SSH PTY during normal use
- [ ] `tmux show-options -g set-clipboard` returns `off` after `genie tui` first launch
- [ ] `tmux show-options -g terminal-overrides` does NOT contain `Ms=`
- [ ] `src/__tests__/tmux-config.test.ts` asserts the inverted invariants

### Upstream
- [ ] PR opened on `anomalyco/opentui` proposing `MouseLevel`-through-`setMouseMode` + `mouseLevel` config surface
- [ ] PR has tests for each level + backward-compat shim
- [ ] PR linked from this wish's status report
