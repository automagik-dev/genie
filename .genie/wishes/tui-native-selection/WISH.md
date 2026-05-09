# Wish: TUI native terminal selection

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tui-native-selection` |
| **Date** | 2026-05-09 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | small (~1–2 engineer-days; mostly mechanical edits + tests + one upstream PR) |
| **Branch** | `wish/tui-native-selection` |
| **Repos touched** | `automagik-dev/genie` (primary), `anomalyco/opentui` (Jaw C, non-blocking) |
| **Design** | [DESIGN.md](../../brainstorms/tui-native-selection/DESIGN.md) |
| **Target release** | v5 |
| **Sister wish** | [v5-major-cutover-handoff](../v5-major-cutover-handoff/WISH.md) (same v4-final / v5-launch boundary) |
| **Supersedes brainstorms** | `tui-click-only-mouse` (folded into Jaw A); `tui-split-footer-host` (architectural rewrite explicitly rejected — v4 sidebar+content UX preserved) |

## Summary

`genie tui` captures drag events in the OpenTUI Nav (via `?1002h` xterm mouse-tracking emit hardcoded inside OpenTUI 0.2.6's `setMouseMode`) and routes copy through OSC 52 escape sequences (via tmux's `set-clipboard external` + `Ms` cap override + `osc52-copy.sh` pipe). This breaks native drag-to-select + Cmd+C in terminals that don't implement OSC 52 — notably Warp on macOS — even though the v4 sidebar+content layout itself is what users want preserved. This wish ships three coordinated jaws in v5: (A) emit `\e[?1002l` after `createCliRenderer()` to disable OpenTUI's drag-tracking subscription so the terminal owns drag events natively; (B) strip the OSC 52 plumbing from tmux configs since drag is now terminal-owned and Felipe explicitly rejected auto-clipboard-on-release semantics; (C) file a non-blocking upstream PR to `anomalyco/opentui` wiring the existing-but-dormant `MouseLevel` enum through `setMouseMode` so genie can eventually delete the local override. v4 stays frozen on npm; v5 launches with the fix.

## Scope

### IN

- **Jaw A — Local mouse override:** patch `src/tui/render.tsx` to emit `\e[?1002l` immediately after `createCliRenderer(resolveTuiRendererConfig())` returns, plus a lifecycle hook that re-emits the override whenever OpenTUI re-runs its mouse setup (suspend/resume + the runtime `useMouse` setter). Audit `src/tui/components/**` to confirm zero `onMouseDrag` / `onMouseDragEnd` consumers (Nav and modals use clicks only).
- **Jaw B — Strip OSC 52 plumbing:** edit `scripts/tmux/genie.tmux.conf` and `scripts/tmux/tui-tmux.conf` to set `set -g set-clipboard off` (was `external`), drop `set -ga terminal-overrides ",*:Ms=\E]52;c;%p2%s\7"`, and replace `copy-pipe-and-cancel "~/.genie/scripts/osc52-copy.sh"` bindings with `copy-selection-and-cancel`. Invert the OSC 52 invariant assertions in `src/__tests__/tmux-config.test.ts`. Keep `allow-passthrough on` (other tools use DCS passthrough). Keep `scripts/tmux/osc52-copy.sh` on disk (D7) for ad-hoc operator use; just stop invoking it from tmux config.
- **Jaw C — Upstream PR (non-blocking):** file a PR on `anomalyco/opentui` wiring the existing `MouseLevel` enum (`packages/core/src/zig/terminal.zig:33-39`) through `setMouseMode`; surface `mouseLevel?: MouseLevel | "none" | "basic" | "drag" | "motion"` in `CliRendererConfig`; add backward-compat shim mapping legacy `useMouse` + `enableMouseMovement` to `MouseLevel`; tests covering each level. Once accepted and 0.2.7+ ships, follow-up minor in genie bumps `@opentui/core`, sets `mouseLevel: 'basic'` natively, and deletes the Jaw A local override.
- **CHANGELOG entry:** name the user-visible contract — *"v5 TUI uses terminal-native selection. Drag to highlight, Cmd+C to copy. tmux's automatic OSC 52 emit is disabled — the terminal owns the entire selection lifecycle."*
- **Doc note** appended to `.docs-vendor/genie/config/tmux.mdx` (canonical TUI/tmux user docs target; `docs/` symlinks to `.docs-vendor/genie/`) describing the user-facing semantics and the `GENIE_TUI_MOUSE=0` escape hatch for hostile terminals. Submodule pointer bump on the genie-repo side after the doc edit lands in `.docs-vendor`.
- **Smoke gate** (launch criterion): drag-select + Cmd+C verified on Warp + Terminal.app on macOS only (Felipe directive — trust xterm-spec native protocols).

### OUT

- The split-footer architectural rewrite (rejected; v4 sidebar+content layout preserved).
- Any change to the agent server `-L genie` other than the tmux config cleanup.
- Any change to OpenTUI's render path or non-mouse subsystems.
- Replacement of OpenTUI as the renderer.
- Browser/Tauri-based TUI (separate khal-os surface, already shipped).
- Any change to `genie agent send-clipboard` / programmatic clipboard helpers (those use OSC 52 deliberately; unaffected by this wish).
- Smoke testing beyond Warp + Terminal.app.
- Pre-built `GENIE_TUI_CLIPBOARD_AUTO=1` re-enable toggle (don't anticipate; add only on user complaint per D9).
- Maintenance of a "documented unsupported terminals" tier (D10).
- Any v4 backport (v4 stays frozen on npm).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Ship as one mega wish targeting v5; v4 stays frozen on npm. | Felipe direct ask 2026-05-09. v5 cutover (`v5-major-cutover-handoff`) is the natural release boundary and aligns with the CDN/sovereignty story. |
| D2 | Preserve the v4 sidebar+content layout. No split-footer rewrite. | Felipe: "people love current behavior, it's just buggy." The architectural rewrite was solving the wrong problem. |
| D3 | Jaw A (local `\e[?1002l` override) ships immediately, regardless of upstream PR status. | Decoupled from anomalyco's review cadence. Closes the user pain on day one of v5. |
| D4 | Jaw B (strip OSC 52 plumbing) ships in the same wish, not deferred. | Felipe explicit: "classic select and cmd + c, no auto-clipboard-on-release." OSC 52 path is dead weight; leaving it in produces user confusion (selection silently triggers a clipboard write when the user only wanted to highlight). |
| D5 | Jaw C (upstream PR) is part of the wish but not blocking. | Right long-term solution. We file it; if it merges before v5 ships, we use it natively and drop the local override; if not, the local override ships and is replaced in a follow-up minor when upstream lands. |
| D6 | Use the existing `MouseLevel` enum, not a new `useMouseDrag` flag. | The enum already exists in 0.2.6 source. Author intent is clear. Wiring an existing enum is a smaller, more reviewable PR than introducing a new boolean. |
| D7 | Keep `scripts/tmux/osc52-copy.sh` on disk; just stop invoking from tmux config. | Some operator scripts may use it ad-hoc (e.g., `cat file.txt \| ~/.genie/scripts/osc52-copy.sh` from a non-TUI shell). Deletion is breaking; keeping is harmless. |
| D8 | Smoke gate is Warp + Terminal.app on macOS only. | Felipe directive: "people only use either of them, and it's hard to actually smoke test. Make it work with native protocols, and I'm pretty sure it will work." Trust xterm-spec compliance over exhaustive matrix testing. |
| D9 | No pre-built `GENIE_TUI_CLIPBOARD_AUTO=1` re-enable toggle. | YAGNI. If a user complains, add it. Don't pre-build configs against speculation. |
| D10 | No "documented unsupported terminals" tier; users with niche terminals fall back to `GENIE_TUI_MOUSE=0` + `prefix+[` tmux copy-mode. | Felipe directive removes the over-engineering. Best-effort beyond the smoke gate; CHANGELOG points to the env-var escape hatch. |

## Success Criteria

- [ ] Drag-select inside the OpenTUI Nav under `genie tui` (v5) attached from Warp on macOS, release (no auto-copy fires), Cmd+C → text in Mac clipboard.
- [ ] Same flow on Terminal.app on macOS.
- [ ] Click-to-spawn / click-to-focus / click-to-expand still works in Nav under both Warp and Terminal.app.
- [ ] Right tmux mirror pane: drag-select + Cmd+C works (preserves the in-session tmux mouse-off fix already proven to work).
- [ ] After `genie tui` is suspended (Ctrl+Z) and resumed, drag-select still works (re-override path verified).
- [ ] No `?1002h` reaches the SSH PTY when `genie tui` is running (verified by capturing stdout during a smoke run and grepping).
- [ ] No OSC 52 escape (`\e]52;c;`) reaches the SSH PTY during normal user interaction.
- [ ] `tmux show-options -g set-clipboard` returns `off` after `genie tui` first launch.
- [ ] `tmux show-options -g terminal-overrides` does NOT contain `Ms=`.
- [ ] `bun test src/tui/` and `bun test src/__tests__/tmux-config.test.ts` green.
- [ ] PR opened on `anomalyco/opentui` proposing `MouseLevel`-through-`setMouseMode` + `mouseLevel` config surface, with tests for each level + backward-compat shim. PR URL recorded in this wish's Review Results.

## Execution Strategy

### Wave 1 (parallel — Jaws A and B can land in any order; Jaw C is independent)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Jaw A — `?1002l` override in `src/tui/render.tsx` + lifecycle hook + audit comment in `Nav.tsx` + unit test |
| 2 | engineer | Jaw B — flip tmux conf clipboard semantics + invert `tmux-config.test.ts` invariants + CHANGELOG entry + doc note |
| 3 | engineer | Jaw C — upstream PR to `anomalyco/opentui` (separate repo, non-blocking) |

### Wave 2 (sequential — depends on Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | qa | Smoke gate: Warp + Terminal.app on macOS, verify all functional success criteria |
| review | reviewer | Final review of Groups 1-3 + smoke results from Group 4 |

## Execution Groups

### Group 1: Jaw A — Local mouse override

**Goal:** Disable OpenTUI's hardcoded `?1002h` drag-tracking subscription so the terminal owns drag events natively, while preserving click handling for Nav navigation.

**Deliverables:**

0. **Bump `@opentui/core`, `@opentui/keymap`, `@opentui/react` from `0.2.0` to `0.2.6` in `package.json`.** This wish's source-line citations (`terminal.zig:33-39`, `terminal.zig:593-596`, `renderer.ts:1367 / 2702-2774 / 3625 / 3690`) are verified against `anomalyco/opentui@v0.2.6` (HEAD `e663959`, npm `latest` as of 2026-05-09). The current pin (`0.2.0`) does not contain those exact line numbers. Run `bun install` after the bump and re-verify the cited lines in `node_modules/@opentui/core/dist/...` (or wherever bun resolves the package source) match before proceeding to deliverables 1–4. If a citation drifted, update WISH.md inline before continuing.
1. `src/tui/render.tsx`: in `renderNav()`, immediately after `createCliRenderer(resolveTuiRendererConfig())` returns and before `createRoot(...)`, write `\e[?1002l` to `process.stdout`. Wrap in a small reusable helper `disableDragTracking()` (or inline; engineer's call) with a comment block referencing this wish + the upstream OpenTUI source line (`packages/core/src/zig/terminal.zig:593-596`, verified at `@opentui/core@0.2.6`).
2. Lifecycle hook: subscribe to whatever event OpenTUI emits when its mouse-init re-runs (suspend/resume cycle, runtime `useMouse` setter). Re-emit `\e[?1002l` from the handler. The exact event name to be confirmed during implementation — read `packages/core/src/renderer.ts:2702-2774` for the mouse-lifecycle entry points (`enableMouse`, `disableMouse`, `_useMouse` setter at line 1367, suspend at `:3625`, resume at `:3690`). **If `0.2.6` does not expose a clean public hook** (e.g. the lifecycle is fully internal), **escalate rather than stub** — open a question on the wish review thread, do not paper over with a polling fallback. Acceptable resolutions: extend Jaw C's upstream PR to include a public `onMouseSetup` event; or accept a small `MutationObserver`-style override that re-emits `?1002l` on every render frame (last resort, costs minimal CPU).
3. `src/tui/components/Nav.tsx` (and other components if needed): add a top-of-file or near-mouse-handler comment confirming "no `onMouseDrag` / `onMouseDragEnd` registrations — drag is intentionally terminal-owned in v5; see `wish/tui-native-selection`."
4. Unit test in `src/tui/render.test.ts` (or sibling): mock the renderer's stdout, instantiate via `resolveTuiRendererConfig()`, confirm the override sequence `\x1b[?1002l` is written after init and again after a synthetic suspend/resume.

**Acceptance Criteria:**
- [ ] `package.json` pins `@opentui/core`, `@opentui/keymap`, `@opentui/react` at `0.2.6` (not `0.2.0`); `bun install` succeeds.
- [ ] Cited line numbers in WISH.md (`terminal.zig:593-596`, `terminal.zig:33-39`, `renderer.ts:1367/2702/3625/3690`) still match the installed `node_modules/@opentui/core/...` at `0.2.6`. If any drifted, WISH.md is updated inline.
- [ ] `\e[?1002l` is emitted to stdout exactly once per `enableMouse()` call.
- [ ] No `onMouseDrag` / `onMouseDragEnd` registrations appear under `src/tui/`.
- [ ] Unit test passes; test asserts override is re-applied after suspend/resume.
- [ ] `bun run typecheck` and `bun run lint` green for the changes.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie/.worktrees/tui-native-selection && \
  grep -q '"@opentui/core": "0.2.6"' package.json && \
  bun install && \
  bun run typecheck && \
  bun run lint && \
  bun test src/tui/render.test.ts && \
  ! grep -rE 'onMouseDrag|onMouseDragEnd' src/tui/components/
```

**depends-on:** none

---

### Group 2: Jaw B — Strip OSC 52 plumbing

**Goal:** Remove the no-longer-necessary OSC 52 emit path from tmux configs since Jaw A makes drag terminal-owned and Felipe rejected auto-clipboard-on-release semantics.

**Deliverables:**

1. `scripts/tmux/genie.tmux.conf`: change `set -g set-clipboard external` to `set -g set-clipboard off`. Remove the `set -ga terminal-overrides ",*:Ms=\E]52;c;%p2%s\7"` line. Keep `set -g allow-passthrough on`. Replace any `copy-pipe-and-cancel "~/.genie/scripts/osc52-copy.sh"` binding with `copy-selection-and-cancel`.
2. `scripts/tmux/tui-tmux.conf`: same three edits.
3. `src/__tests__/tmux-config.test.ts`: invert the OSC 52 invariants — assert `set-clipboard off` (not `external`); assert no `Ms=` in `terminal-overrides`; assert `copy-selection-and-cancel` (not `copy-pipe-and-cancel`); keep the `allow-passthrough on` assertion. Update the test descriptions to reflect the new contract.
4. CHANGELOG.md entry under the v5-launch heading: *"v5 TUI uses terminal-native selection. Drag to highlight, Cmd+C to copy. tmux's automatic OSC 52 emit is disabled — the terminal owns the entire selection lifecycle. Operators on terminals that misbehave with the new mouse mode can fall back to `GENIE_TUI_MOUSE=0` and use `prefix+[` tmux copy-mode."*
5. Doc note: edit **`.docs-vendor/genie/config/tmux.mdx`** (the canonical existing tmux/clipboard doc target — `docs/` is a symlink to `.docs-vendor/genie/`; ensure `git submodule update --init .docs-vendor` is run first if it isn't already initialized in the worktree) appending a "TUI clipboard semantics in v5" section that describes: (a) drag highlights via terminal-native selection, (b) Cmd+C / Ctrl+Shift+C copies via the user's normal terminal hotkey, (c) tmux's automatic OSC 52 emit is disabled, and (d) `GENIE_TUI_MOUSE=0` is the escape hatch for terminals that misbehave with the mouse override. Doc edit must land in the `.docs-vendor` submodule's own commit + push (separate from the genie-repo commit), then bump the submodule pointer in genie. The wish-level acceptance ties to the genie-repo submodule pointer being bumped.
6. Do NOT delete `scripts/tmux/osc52-copy.sh` — D7 says keep on disk for ad-hoc operator use.

**Acceptance Criteria:**
- [ ] Both tmux confs contain `set -g set-clipboard off`.
- [ ] Neither tmux conf contains `Ms=` or `osc52-copy.sh`.
- [ ] `src/__tests__/tmux-config.test.ts` passes with inverted invariants.
- [ ] CHANGELOG entry exists under v5-launch heading.
- [ ] `scripts/tmux/osc52-copy.sh` still exists on disk and is executable.
- [ ] `.docs-vendor/genie/config/tmux.mdx` contains a section referencing TUI clipboard semantics (`grep -q 'GENIE_TUI_MOUSE'` + `grep -q 'drag-select'` or equivalent) and the `.docs-vendor` submodule pointer in the genie-repo commit is bumped to a SHA that includes the doc edit.
- [ ] `bun run typecheck` and `bun run lint` green.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie/.worktrees/tui-native-selection && \
  git submodule update --init .docs-vendor && \
  bun run typecheck && \
  bun run lint && \
  bun test src/__tests__/tmux-config.test.ts && \
  grep -q 'set -g set-clipboard off' scripts/tmux/genie.tmux.conf && \
  grep -q 'set -g set-clipboard off' scripts/tmux/tui-tmux.conf && \
  ! grep -q 'Ms=' scripts/tmux/genie.tmux.conf && \
  ! grep -q 'Ms=' scripts/tmux/tui-tmux.conf && \
  ! grep -q 'osc52-copy.sh' scripts/tmux/genie.tmux.conf && \
  ! grep -q 'osc52-copy.sh' scripts/tmux/tui-tmux.conf && \
  test -x scripts/tmux/osc52-copy.sh && \
  grep -q 'GENIE_TUI_MOUSE' .docs-vendor/genie/config/tmux.mdx && \
  grep -q 'drag' .docs-vendor/genie/config/tmux.mdx
```

**depends-on:** none

---

### Group 3: Jaw C — Upstream PR to anomalyco/opentui

**Goal:** Wire the existing-but-dormant `MouseLevel` enum through `setMouseMode` + surface `mouseLevel` in `CliRendererConfig`, so genie can eventually drop the local override from Group 1.

**Deliverables:**

1. Open an issue on `anomalyco/opentui` describing the click-only mouse use case (genie's Nav doesn't need drag tracking) and proposing the `MouseLevel`-through-`setMouseMode` plumbing. Reference the existing dormant enum at `packages/core/src/zig/terminal.zig:33-39`.
2. Open a draft PR with:
   - `packages/core/src/zig/terminal.zig`: change `setMouseMode(enable: bool, enable_movement: bool)` to take a `MouseLevel`. Emit DECSET sequences appropriate to the level: `none` → disable all; `basic` → `?1000h + ?1006h` (clicks + SGR encoding only); `drag` → add `?1002h`; `motion` → add `?1002h + ?1003h`; `pixels` → reserved for future.
   - `packages/core/src/renderer.ts`: surface `mouseLevel?: MouseLevel | "none" | "basic" | "drag" | "motion"` in `CliRendererConfig`. Backward-compat shim: when `mouseLevel` is unset, derive from legacy `useMouse` + `enableMouseMovement` per the mapping in DESIGN.md.
   - Tests: opentui's existing test harness for each `MouseLevel` plus the legacy-config mapping.
3. Link this wish from the PR body. Tag this wish's URL once it has a PR-merged commit.
4. Do NOT block merge of Groups 1–2 on this PR landing. Group 3's only acceptance is "PR exists and is recorded in this wish's Review Results."

**Acceptance Criteria:**
- [ ] Issue + draft PR exist on `anomalyco/opentui`, both linkable.
- [ ] PR diff covers terminal.zig + renderer.ts + tests.
- [ ] PR body links back to this wish.
- [ ] PR URL recorded in this wish's Review Results section.

**Validation:**
```bash
# No local validation; this is upstream work.
# Reviewer confirms PR exists by visiting the linked URL.
echo "Manual: confirm PR exists at https://github.com/anomalyco/opentui/pull/<N>"
```

**depends-on:** none

**Note:** Independent of Groups 1–2. Can be filed before, during, or after they merge — Jaw C is explicitly non-blocking per D5.

---

### Group 4: QA smoke gate

**Goal:** Verify functional success criteria on Warp + Terminal.app on macOS, the only two terminals in the launch gate per D8.

**Deliverables:**

1. Build a fresh v5 binary from `wish/tui-native-selection` after Groups 1–2 merge.
2. SSH from a Mac running Warp into a Linux host running the v5 binary. Launch `genie tui`. Drag-select inside the OpenTUI Nav. Verify no auto-copy fires on release. Cmd+C → confirm Mac clipboard now contains the dragged text. Click on Nav rows → confirm navigation still works. Suspend (Ctrl+Z) and `fg` → confirm drag-select still works after resume.
3. Repeat the entire flow from Terminal.app on the same Mac.
4. Capture `script` (or `tmux capture-pane -p`) output of the SSH session during a representative drag → Cmd+C cycle. Grep for `?1002h` and `\e]52;c;` — both must be absent.
5. Document results in this wish's Review Results section: PASS/FAIL per terminal, paste any anomalies for follow-up.

**Acceptance Criteria:**
- [ ] Warp: drag-select highlights text; Cmd+C produces correct content in Mac clipboard.
- [ ] Terminal.app: same.
- [ ] Click-to-nav works under both.
- [ ] Suspend/resume preserves the override under both.
- [ ] `?1002h` and `\e]52;c;` absent from session capture.

**Validation:**
```bash
# Manual smoke; agent runs locally on macOS, not on the genie server.
echo "Manual smoke: see wish Review Results for PASS/FAIL per terminal"
```

**depends-on:** Group 1, Group 2

---

## Dependencies

- **Internal:**
  - Group 4 depends on Groups 1 and 2 (Jaw C is independent).
- **Cross-wish (upstream / sibling):**
  - Sister to `[v5-major-cutover-handoff](../v5-major-cutover-handoff/WISH.md)` (same v4-final / v5-launch boundary; not a hard dependency, but they ship together).
- **Upstream:**
  - Group 3 lands in `anomalyco/opentui`. Eventual genie follow-up minor (post-this-wish) bumps `@opentui/core` and removes the Group 1 override; that follow-up is NOT part of this wish.

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On a fresh v5 build, attached from Warp on macOS to a Linux host: drag-select in Nav + Cmd+C produces correct Mac clipboard content; no auto-copy fires.
- [ ] Same on Terminal.app on macOS.
- [ ] Click-to-spawn / click-to-focus / click-to-expand still works in Nav under both terminals.
- [ ] After Ctrl+Z + `fg`, drag-select still works (override re-applied on resume).
- [ ] `tmux show-options -g set-clipboard` returns `off` for both `-L genie` and `-L genie-tui` servers.
- [ ] No `?1002h` or `\e]52;c;` sequences appear in a normal-use SSH session capture.
- [ ] `bun test src/tui/` green (no regression in TUI unit tests).
- [ ] `bun test src/__tests__/tmux-config.test.ts` green (inverted invariants pass).
- [ ] `genie tui` still launches cleanly with both `-L genie` and `-L genie-tui` tmux servers (architecture preserved per D2).

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Terminal interprets `?1002l` after `?1002h` differently than xterm spec (drag still captured, or clicks also disabled). | Medium | Smoke gate (Warp + Terminal.app) catches the two real-user cases. Users on hostile terminals fall back to `GENIE_TUI_MOUSE=0`; documented in CHANGELOG. |
| OpenTUI 0.2.7+ changes mouse setup such that the local override stops working before upstream PR lands. | Low | Pin `@opentui/core` version explicitly during the override window; bump deliberately and re-verify on bump. |
| anomalyco rejects or sits on the upstream PR. | Low | Wish ships fine without it (Jaw C is non-blocking). If rejection: maintain local override indefinitely as the long-term solution; document why in code comment. |
| Stripping OSC 52 plumbing breaks operator scripts that depended on `set-clipboard external` for non-interactive clipboard writes. | Low | The script `osc52-copy.sh` stays on disk (D7). Anyone using it explicitly continues to work. The change is only that *tmux's automatic* clipboard write is disabled. |
| Some user genuinely loved auto-clipboard-on-release. | Low | Felipe explicitly chose the opposite (D9). Document the trade-off in CHANGELOG; if any user complains, add the env-var toggle ad-hoc. |
| Test inversion in `tmux-config.test.ts` cherry-picks back wrong onto a v4 hot fix branch. | Low | The wish targets v5 only. v4 codebase doesn't see this change. |
| Visual conflict between terminal-native selection highlight and OpenTUI's render in the Nav region. | Low | Acceptable. Terminal selection styles are universally readable. No need to redesign. |

---

## Review Results

_Populated by `/review` after execution completes._

- Plan review (this wish): _pending_
- Group 1 review: _pending_
- Group 2 review: _pending_
- Group 3 (upstream PR URL): _pending_
- Group 4 (smoke results): _pending_
- Final post-merge review: _pending_

---

## Files to Create/Modify

```
# Genie repo (this wish)
src/tui/render.tsx                         (MODIFY — Jaw A: emit ?1002l after createCliRenderer; lifecycle hook)
src/tui/components/Nav.tsx                 (MODIFY — Jaw A: audit comment confirming no drag handlers)
src/tui/render.test.ts                     (MODIFY or CREATE — Jaw A: assert override sequence written)
scripts/tmux/genie.tmux.conf               (MODIFY — Jaw B: set-clipboard off; drop Ms; copy-selection-and-cancel)
scripts/tmux/tui-tmux.conf                 (MODIFY — Jaw B: same three edits)
src/__tests__/tmux-config.test.ts          (MODIFY — Jaw B: invert OSC 52 invariants)
CHANGELOG.md                               (MODIFY — Jaw B: v5-launch entry naming the contract)
.docs-vendor/genie/config/tmux.mdx         (MODIFY — Jaw B: append TUI clipboard semantics section; ships in .docs-vendor submodule)
package.json                               (MODIFY — Jaw A deliverable #0: bump @opentui/{core,keymap,react} 0.2.0 → 0.2.6)
.gitmodules / .docs-vendor pointer         (MODIFY — Jaw B: bump submodule pointer in genie-repo commit after .docs-vendor doc edit lands)

# Upstream (Jaw C, separate repo: anomalyco/opentui)
packages/core/src/zig/terminal.zig         (MODIFY — wire MouseLevel through setMouseMode)
packages/core/src/renderer.ts              (MODIFY — surface mouseLevel in CliRendererConfig + back-compat)
packages/core/src/tests/renderer.mouse.test.ts  (MODIFY — tests for each MouseLevel)
```
