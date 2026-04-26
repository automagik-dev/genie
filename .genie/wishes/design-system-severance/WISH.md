# Wish: Genie Design System Unification — Severance Theme

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `design-system-severance` |
| **Date** | 2026-04-25 |
| **Approved** | 2026-04-26 by Felipe (palette ✅ · variants punted to v2 ✅ · hard-cut aliases ✅ · dispatch via team-lead w/ Genie as orchestrator ✅) |
| **Author** | Genie (per Felipe directive 2026-04-25: "review entire design system, standardize all color scheme, inspired in Severance TV show") |
| **Appetite** | medium (~1.5 weeks across 4 phases) |
| **Branch** | `wish/design-system-severance` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/design-system-severance/DESIGN.md) |
| **Pre-work** | `opentui` skill installed at `~/.claude/skills/opentui/` (2026-04-25) |

## Summary

Genie's design system has fragmented into **three parallel sources of truth** (TUI palette, desktop-app palette, tmux configs — with off-by-one hue drift between TUI `#7c3aed` and tmux `#7b2ff7`) plus **244 hard-coded hex literals across 42 non-test files**. Today's symptom — "left nav was purple, became light green with red at 24% CPU" — is the SystemStats panel's `pickColor` thresholds (`>50` amber, `>80` red) painting the bottom panel in saturated traffic-light colors over a barely-visible purple bg. This wish unifies all color tokens into a single `packages/genie-tokens/` source, swaps the current purple/green/red palette for a Severance-inspired Lumon-MDR aesthetic (petrol bg, mint accent, calm amber/crimson reserved for true alarms), recalibrates `pickColor` thresholds (`>70/>90`), and adds a snapshot harness so future palette drift is caught at PR time.

## Scope

### IN

**Phase A — Token source of truth**
- New `packages/genie-tokens/` package (zero deps): `palette.ts` exporting full Severance palette, `tokens.ts` for semantic aliases (`accent`, `surface`, `surfaceRaised`, `danger`, etc.), `index.ts` re-exporting.
- `src/tui/theme.ts` re-exports from `genie-tokens` — **hard cut**, no backward-compat aliases. Group 3 migrates every `purple`/`violet`/`cyan`/`emerald` reference to a semantic token in the same wish.
- `packages/genie-app/lib/theme.ts` re-exports from `genie-tokens` — its 24 duplicated hex values deleted.
- New `scripts/tmux/generate-theme.sh` reads `genie-tokens/palette.ts` (via `bun -e`), emits `scripts/tmux/.generated.theme.conf` with `set -g status-style "bg=$bg,fg=$text"`, `set -g pane-active-border-style "fg=$accent"`, etc.
- `scripts/tmux/genie.tmux.conf` and `scripts/tmux/tui-tmux.conf` `source-file` the generated file.
- Lint check in CI: `bun run scripts/tmux/generate-theme.sh && git diff --exit-code scripts/tmux/.generated.theme.conf`.

**Phase B — Component hex sweep**
- Replace every literal `#xxxxxx` in non-test source files with `palette.X` references. Targets:
  - `src/tui/components/`: `AgentPicker.tsx`, `TeamCreate.tsx`, `QuitDialog.tsx`, `SpawnTargetPicker.tsx`, `ContextMenu.tsx`, `TreeNode.tsx`, `SystemStats.tsx`.
  - `packages/genie-app/views/**/*.tsx` (15 files): `activity/`, `agents/`, `genie/ui/tabs/*` (5 tabs), `sessions/`, `shared/` (5 files), `tasks/`, `wizard/`.
  - `src/term-commands/`: `agents.ts`, `board.ts`, `msg.ts`, `serve.ts`, `tag.ts`.
  - `src/lib/`: `tmux.ts` (8 window-bg colors → derive from accent via HSL rotation helper), `protocol-router.ts`, `runtime-events.ts`, `task-service.ts`, `board-service.ts`.
  - `scripts/tmux/genie-projects.sh`, `scripts/tmux/genie-sessions.sh` → derive from generated theme.
- Recalibrate `SystemStats.tsx` `pickColor` thresholds from `>50/>80` to `>70/>90` and swap `palette.emerald` → `palette.accent`.

**Phase C — Visual regression harness**
- New `test/visual/tui-snapshot.test.tsx` rendering each major TUI surface (Nav, TreeNode states, SystemStats at 10/50/85% load, AgentPicker, QuitDialog, TeamCreate, ContextMenu) to a deterministic string snapshot via opentui's render-to-string.
- Snapshots committed to `test/visual/__snapshots__/`.
- CI gate: snapshot diff fails the build.

**Phase D — Documentation**
- New `docs/design-system.md` documenting tokens, palette rationale (Severance reference), how to add a new color, how to regenerate tmux theme, and the snapshot workflow.
- README.md badge / link added under "Design".

### OUT

- **Theme variants** (`optics-design`, `breakroom`) — defer to follow-up wish `design-system-themes-v2`. Current wish ships only `lumon-mdr` as the default and only theme.
- **Light mode** — Severance is dark-only by aesthetic; light mode is a separate proposal.
- **Web/marketing site palette** — separate repo, separate audience.
- **Icon/logo redesign** — visual identity beyond color is out of scope.
- **Font changes** — current JetBrains Mono stays.
- **i18n of color-name strings** in CLI help.
- **Rewriting opentui** — we use it as a dependency; any opentui-side bug stays upstream.
- **Backward-compat aliases** — explicitly out per Felipe directive 2026-04-26. Old palette names (`purple`, `violet`, `cyan`, `emerald`) are deleted, not aliased. All internal references migrated within this wish (see Group 3); zero external consumers verified before approval.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Create `packages/genie-tokens/` as a separate workspace package, not a `src/lib/` module | Tokens are consumed by both `src/` (TUI/CLI) and `packages/genie-app/` (desktop). A workspace package is the only honest dependency direction. |
| 2 | Tmux theme generated from JS source, not maintained by hand | Eliminates the off-by-one hue drift class of bug. One source of truth. CI lint catches forgotten regenerations. |
| 3 | Severance palette hard-codes the new look — no opt-out flag in this wish | Felipe directive was unambiguous. Variants are Phase C of the proposal but moved OUT to keep this wish shippable in one cycle. |
| 4 | `pickColor` recalibrated to `>70/>90` (was `>50/>80`) | Old thresholds made a normal multitasked dev box sit permanently in amber. New thresholds reserve color for genuine attention. |
| 5 | **Hard cut** — old palette names (`palette.purple`, `violet`, `cyan`, `emerald`) are deleted, not aliased. Every internal reference is migrated by Group 3 of this wish. | Felipe approval 2026-04-26: "no backward compat — break old behavior cleanly so bugs get fixed". External-consumer scan confirms zero non-genie callers. Aliases would only encourage zombie names and undermine the single-source rule. |
| 6 | Snapshot tests use opentui's tree-to-string render, not pixel diffs | Token-level snapshots; immune to terminal-specific rendering quirks. |
| 7 | `src/lib/tmux.ts` window-bg colors derived from accent via HSL rotation, not 8 hand-picked hexes | Removes 8 magic numbers. New windows always look palette-coherent. |
| 8 | Modal overlay backgrounds (currently `#0a0a0a`) become `palette.bgOverlay` (`rgba(10, 29, 42, 0.92)`) | Tints the scrim in palette-petrol so modals feel part of the world, not a black void. |
| 9 | No new runtime dependency for HSL math | A tiny inline HSL rotator (~20 LOC) avoids pulling `chroma-js` or `color`. |

## Success Criteria

- [ ] `grep -RE '#[0-9a-fA-F]{6}' src/ packages/ scripts/ --exclude-dir=test --exclude-dir=__tests__ --exclude-dir=node_modules` returns ONLY `packages/genie-tokens/palette.ts` and `scripts/tmux/.generated.theme.conf`.
- [ ] `bun run typecheck && bun run lint && bun run test` all green on the wish branch.
- [ ] `genie tui` boots and renders Lumon-MDR palette by default (petrol bg, mint accent).
- [ ] Tmux pane-active border (`#7fc8a9`) matches TUI accent token — no off-by-one hue.
- [ ] SystemStats at 24% CPU shows mint bars on petrol bg (no amber/red anywhere) — verified via snapshot test fixture.
- [ ] SystemStats at 95% CPU shows crimson bars (true alarm) — verified via snapshot test fixture.
- [ ] All `packages/genie-app/views/**/*.tsx` import from `genie-tokens`, not local `lib/theme.ts` literals.
- [ ] `scripts/tmux/generate-theme.sh` is idempotent (`git diff --exit-code` passes after re-run).
- [ ] PR description includes side-by-side screenshots: nav (before/after), modal (before/after), SystemStats normal load (before/after), SystemStats high load (before/after).
- [ ] `docs/design-system.md` exists and explains: token list, how to add a new color, how to regenerate tmux theme, snapshot workflow.

## Execution Strategy

### Wave 1 (parallel) — foundation

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Create `packages/genie-tokens/` with full Severance palette + semantic tokens + tests |
| 2 | engineer | Tmux theme generator script + wire into both tmux configs + CI lint check |

### Wave 2 (parallel, after Wave 1) — migration

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Migrate TUI components (`src/tui/components/*.tsx`) + recalibrate `pickColor` |
| 4 | engineer | Migrate desktop app (`packages/genie-app/views/**/*.tsx` + `lib/theme.ts`) |
| 5 | engineer | Migrate term-commands chalk usage (`src/term-commands/*.ts` + `src/lib/*.ts` window-bg derivations) |

### Wave 3 (after Wave 2) — verification

| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Visual regression snapshot harness (`test/visual/`) + commit snapshots |
| 7 | engineer | `docs/design-system.md` + README link |
| review | reviewer | Full review of Groups 1-7 against success criteria |

### Wave 4 (after review SHIP)

| Group | Agent | Description |
|-------|-------|-------------|
| qa | qa | Manual `genie tui` + `genie team create` + `genie tui agent <x>` smoke; capture before/after screenshots for PR |

## Execution Groups

### Group 1: Token source of truth
**Goal:** Single `packages/genie-tokens/` workspace package exporting the full Severance palette + semantic aliases.
**Deliverables:**
1. `packages/genie-tokens/package.json` — workspace package, `"private": true`, no runtime deps.
2. `packages/genie-tokens/palette.ts` — primitive hex values per the Severance spec in DESIGN.md §2.
3. `packages/genie-tokens/tokens.ts` — semantic aliases (`accent`, `surface`, `surfaceRaised`, `surfaceHover`, `danger`, `dangerStrong`, `attention`, `info`, `severed`, `outieWarm`, `lumonBeige`).
4. `packages/genie-tokens/hsl.ts` — minimal `rotateHue(hex, deg)` helper for derived colors.
5. `packages/genie-tokens/index.ts` — re-exports.
6. `packages/genie-tokens/__tests__/palette.test.ts` — assert palette shape, contrast ratios (text on bg ≥ 4.5:1, accent on bg ≥ 3:1), and that no value is `undefined`.

**Acceptance Criteria:**
- [ ] `bun run --cwd packages/genie-tokens test` passes.
- [ ] `bun -e 'import {palette} from "./packages/genie-tokens/index.ts"; console.log(palette.bg)'` prints `#0a1d2a`.
- [ ] `packages/genie-tokens/__tests__/palette.test.ts` enforces WCAG AA contrast for `text` over `bg` and `bgRaised`.

**Validation:**
```bash
cd packages/genie-tokens && bun test
```

**depends-on:** none

---

### Group 2: Tmux theme generator
**Goal:** Tmux configs derive their colors from `genie-tokens`, eliminating the off-by-one hue drift.
**Deliverables:**
1. `scripts/tmux/generate-theme.sh` — runs `bun scripts/tmux/generate-theme.ts`, writes `scripts/tmux/.generated.theme.conf` with all tmux color directives.
2. `scripts/tmux/generate-theme.ts` — imports from `packages/genie-tokens`, emits `set -g status-style`, `set -g pane-border-style`, `set -g pane-active-border-style`, message styles, mode styles.
3. `scripts/tmux/genie.tmux.conf` and `scripts/tmux/tui-tmux.conf` add `source-file ~/.config/tmux/.generated.theme.conf` (or relative path) and remove their hard-coded color lines.
4. `scripts/tmux/genie-projects.sh` and `scripts/tmux/genie-sessions.sh` refactored to read tokens via `bun -e` substitution.
5. CI step in `.github/workflows/lint.yml`: regenerate theme + assert clean diff.

**Acceptance Criteria:**
- [ ] `bash scripts/tmux/generate-theme.sh` produces `scripts/tmux/.generated.theme.conf`.
- [ ] Re-running yields zero diff.
- [ ] `tmux -L genie-tui-test new-session -d -x 80 -y 24` boots without error using the generated config.
- [ ] No hex literal remains in `scripts/tmux/*.conf` or `scripts/tmux/*.sh` (only in the generated file).

**Validation:**
```bash
bash scripts/tmux/generate-theme.sh && git diff --exit-code scripts/tmux/.generated.theme.conf
grep -E '#[0-9a-fA-F]{6}' scripts/tmux/genie.tmux.conf scripts/tmux/tui-tmux.conf scripts/tmux/genie-projects.sh scripts/tmux/genie-sessions.sh && exit 1 || exit 0
```

**depends-on:** Group 1

---

### Group 3: TUI component migration
**Goal:** Every `src/tui/components/*.tsx` file references `palette.X` from `genie-tokens`. `pickColor` recalibrated.
**Deliverables:**
1. `src/tui/theme.ts` becomes a thin re-export of `genie-tokens`. **Hard cut** — old names (`purple`, `violet`, `cyan`, `emerald`) deleted; every reference in `src/tui/components/*.tsx` migrated to semantic tokens (`accent`, `accentBright`, `success`, etc.) within this group.
2. `src/tui/components/SystemStats.tsx`: `pickColor` thresholds `>70/>90`; `palette.emerald` → `palette.accent` (Severance mint).
3. `src/tui/components/AgentPicker.tsx`, `TeamCreate.tsx`, `QuitDialog.tsx`, `SpawnTargetPicker.tsx`: modal overlay `#0a0a0a` → `palette.bgOverlay`; modal interior `#111111` → `palette.bgRaised`.
4. `src/tui/components/TreeNode.tsx`, `ContextMenu.tsx`: `#ffffff` selected text → `palette.accentBright`.
5. `src/tui/components/Nav.tsx`: no changes if it only uses `palette.X` already (verified — already token-clean).

**Acceptance Criteria:**
- [ ] `grep -E '#[0-9a-fA-F]{6}' src/tui/components/*.tsx src/tui/theme.ts` returns nothing.
- [ ] `bun test test/tui` passes (existing TUI tests still green).
- [ ] `bun run typecheck` passes.
- [ ] Manual: `genie tui` renders petrol bg, mint accent, no purple anywhere.

**Validation:**
```bash
grep -E '#[0-9a-fA-F]{6}' src/tui/components/*.tsx src/tui/theme.ts && exit 1
bun run typecheck && bun test test/tui
```

**depends-on:** Group 1

---

### Group 4: Desktop app migration
**Goal:** All `packages/genie-app/views/**/*.tsx` and `lib/theme.ts` use `genie-tokens`.
**Deliverables:**
1. `packages/genie-app/lib/theme.ts` re-exports `genie-tokens`. Local `theme` object becomes `cssVars` map only (mapping `--genie-*` to token values).
2. `packages/genie-app/index.html` <style> block uses `var(--genie-*)`, no hex literals.
3. Migrate every hex in `packages/genie-app/lib/StatusBar.tsx`, `views/activity/`, `views/agents/`, `views/genie/ui/tabs/*` (5 tabs), `views/sessions/`, `views/shared/*` (5 files), `views/tasks/`, `views/wizard/`.

**Acceptance Criteria:**
- [ ] `grep -RE '#[0-9a-fA-F]{6}' packages/genie-app/` returns nothing outside generated/dist.
- [ ] `bun run --cwd packages/genie-app build` succeeds.
- [ ] Visual smoke: `bun run --cwd packages/genie-app dev` opens the app, sidebar/cards render in Severance palette.

**Validation:**
```bash
grep -RE '#[0-9a-fA-F]{6}' packages/genie-app/ --exclude-dir=node_modules --exclude-dir=dist && exit 1
bun run --cwd packages/genie-app build
```

**depends-on:** Group 1

---

### Group 5: term-commands + lib migration
**Goal:** All chalk-style hex calls and `lib/tmux.ts` derived colors use tokens.
**Deliverables:**
1. `src/term-commands/agents.ts`, `board.ts`, `msg.ts`, `serve.ts`, `tag.ts`: every hex literal → `palette.X`. Where chalk truecolor isn't supported, fallback via `palette.toAnsi(token)`.
2. `src/lib/tmux.ts:414-421`: replace 8 hand-picked window-bg colors with derivation `[0..7].map(i => rotateHue(palette.accent, i*45))`.
3. `src/lib/protocol-router.ts`, `runtime-events.ts`, `task-service.ts`, `board-service.ts`: any embedded color metadata uses tokens.

**Acceptance Criteria:**
- [ ] `grep -RE '#[0-9a-fA-F]{6}' src/term-commands/ src/lib/` (excluding test files) returns nothing.
- [ ] `bun run typecheck && bun run lint` pass.
- [ ] `bun test src/lib src/term-commands` passes.

**Validation:**
```bash
grep -RE '#[0-9a-fA-F]{6}' src/term-commands/ src/lib/ --exclude='*.test.*' --exclude-dir=__tests__ && exit 1
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1

---

### Group 6: Visual regression snapshot harness
**Goal:** Lock the Severance look in via deterministic snapshot tests.
**Deliverables:**
1. `test/visual/tui-snapshot.test.tsx` covering: Nav (empty + populated), TreeNode (each `wsAgentState`), SystemStats at 10/50/85/95% load, AgentPicker (empty/filtered), QuitDialog, TeamCreate, ContextMenu.
2. `test/visual/__snapshots__/` committed.
3. `package.json` script `test:visual` added.
4. CI workflow runs `bun test test/visual/` and fails on snapshot diff.

**Acceptance Criteria:**
- [ ] `bun test test/visual/` passes locally.
- [ ] Modifying any palette value and re-running causes the snapshot test to fail.
- [ ] Re-running `bun test test/visual/ -u` regenerates snapshots cleanly.

**Validation:**
```bash
bun test test/visual/
```

**depends-on:** Groups 1, 3

---

### Group 7: Documentation
**Goal:** Future contributors know how the design system works.
**Deliverables:**
1. `docs/design-system.md` (~400-600 words) — Severance rationale, token list with semantic mapping, "how to add a color", "how to regenerate tmux theme", "how to update visual snapshots".
2. `README.md` adds a "Design" section linking to `docs/design-system.md`.
3. `CHANGELOG.md` entry under upcoming version: "**BREAKING**: Unified design system on Severance Lumon-MDR palette. Old palette names (`palette.purple`, `violet`, `cyan`, `emerald`) deleted — replaced by semantic tokens (`accent`, `accentBright`, `success`, `info`). Internal callers migrated; external consumers must switch to the new token names."

**Acceptance Criteria:**
- [ ] `docs/design-system.md` exists and renders cleanly in GitHub markdown preview.
- [ ] `markdownlint docs/design-system.md` passes.
- [ ] README has the Design link.
- [ ] CHANGELOG entry present.

**Validation:**
```bash
test -f docs/design-system.md && markdownlint-cli2 docs/design-system.md
grep -q "design-system" README.md
```

**depends-on:** Groups 1-5

---

## Dependencies

- **depends-on:** none (this wish is self-contained on the genie repo).
- **blocks:** future wish `design-system-themes-v2` (variant themes — needs this token foundation).
- **adjacent:** `sec-fix-one-shot` (its TTY UI uses the SystemStats `pickColor` — this wish recalibrates it; that wish should pull the new defaults when it ships).

## QA Criteria

- [ ] `genie tui` opens with petrol bg + mint accent (no purple visible anywhere on the chrome).
- [ ] Selected tree row uses `accentDim` bg + `accentBright` text — readable, not jarring.
- [ ] SystemStats panel at typical idle load (CPU < 30%, RAM ~ 50%) shows ALL bars in mint — no amber, no red.
- [ ] SystemStats panel at high load (forced via `stress-ng --cpu 8 --timeout 30s`) shows red only for items above 90%.
- [ ] `Ctrl+N` in workspace mode opens TeamCreate modal with palette-tinted scrim, not pure black.
- [ ] `genie team create <name>` from CLI emits chalk colors that read coherently with the TUI.
- [ ] `tmux -L genie-tui ls` shows pane-active borders in mint matching the TUI accent.
- [ ] No regression in keyboard navigation, focus indicators remain visible against the new bg.
- [ ] Desktop app (`bun run --cwd packages/genie-app dev`) renders in matching Severance palette.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Visual change is jarring for users who liked the purple | Medium | CHANGELOG marked **BREAKING** so the swap is visible; future `design-system-themes-v2` wish can ship a `legacy-purple` variant if user demand appears. No alias bridge — clean break per Felipe directive. |
| Tmux generator complicates the build for contributors who don't use tmux | Low | Generator runs only when tmux configs are touched; produces a static file that's also committed. |
| Some chalk consumers run on terminals that downgrade truecolor | Low | `palette.toAnsi(token)` helper picks closest 16-color fallback. |
| Snapshot tests are brittle across opentui versions | Medium | Snapshot the `palette.X` tokens used (token-level), not raw rendered output. Keep snapshots small. |
| Hidden hex literals discovered during migration | Medium | Group 5 explicitly enumerates all `src/lib/` files; final success criterion is a repo-wide grep that must return only the token file. |
| HSL rotation produces ugly intermediate hues for window backgrounds | Low | Snapshot test in Group 1 verifies all 8 derived window colors meet contrast minimums. |
| `packages/genie-tokens` breaks workspace resolution in some build modes | Low | Add as `workspaces` entry in root `package.json`; verify both `bun build` and `npm pack` work. |
| Existing PRs in flight conflict with hex sweep | Medium | Sweep is mechanical; merge conflicts resolve trivially. Coordinate via PM if active PRs touch the same files. |

---

## Review Results

_Populated by `/review` after this wish is dispatched._

---

## Files to Create/Modify

```
packages/genie-tokens/                              [NEW]
├── package.json
├── palette.ts
├── tokens.ts
├── hsl.ts
├── index.ts
└── __tests__/palette.test.ts

scripts/tmux/
├── generate-theme.sh                               [NEW]
├── generate-theme.ts                               [NEW]
├── .generated.theme.conf                           [NEW, generated]
├── genie.tmux.conf                                 [MODIFY: source-file + remove hex]
├── tui-tmux.conf                                   [MODIFY: source-file + remove hex]
├── genie-projects.sh                               [MODIFY: derive from tokens]
└── genie-sessions.sh                               [MODIFY: derive from tokens]

src/tui/
├── theme.ts                                        [MODIFY: re-export tokens; hard-cut old names]
└── components/
    ├── SystemStats.tsx                             [MODIFY: pickColor thresholds + accent]
    ├── AgentPicker.tsx                             [MODIFY: overlay/interior tokens]
    ├── TeamCreate.tsx                              [MODIFY: overlay/interior tokens]
    ├── QuitDialog.tsx                              [MODIFY: overlay/interior tokens]
    ├── SpawnTargetPicker.tsx                       [MODIFY: overlay tokens]
    ├── TreeNode.tsx                                [MODIFY: selected text token]
    └── ContextMenu.tsx                             [MODIFY: selected text token]

packages/genie-app/
├── index.html                                      [MODIFY: var(--genie-*)]
├── lib/theme.ts                                    [MODIFY: re-export tokens]
├── lib/StatusBar.tsx                               [MODIFY: token refs]
└── views/                                          [MODIFY: 15 .tsx files, all hex → token]

src/term-commands/
├── agents.ts, board.ts, msg.ts, serve.ts, tag.ts   [MODIFY: chalk → palette.toAnsi]

src/lib/
├── tmux.ts                                         [MODIFY: HSL-derived window bgs]
├── protocol-router.ts                              [MODIFY: token refs]
├── runtime-events.ts                               [MODIFY: token refs]
├── task-service.ts                                 [MODIFY: token refs]
└── board-service.ts                                [MODIFY: token refs]

test/visual/                                        [NEW]
├── tui-snapshot.test.tsx
└── __snapshots__/

docs/design-system.md                               [NEW]
README.md                                           [MODIFY: Design link]
CHANGELOG.md                                        [MODIFY: entry]
package.json                                        [MODIFY: workspaces + test:visual script]
.github/workflows/lint.yml                          [MODIFY: tmux theme regen check]
```
