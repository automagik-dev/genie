# Proposal — Genie Design System Unification (Severance Theme)

| Field | Value |
|-------|-------|
| **Status** | DRAFT — needs Felipe sign-off before dispatch |
| **Date** | 2026-04-25 |
| **Author** | Genie (per Felipe directive: "review entire design system, standardize, inspired in Severance TV show") |
| **Target repo** | `automagik-dev/genie` |
| **Suggested wish slug** | `design-system-severance` |
| **Suggested branch** | `wish/design-system-severance` (worker creates its own worktree) |
| **Appetite** | medium (~1.5 weeks across 4 phases) |
| **Pre-work skill** | `opentui` skill installed at `~/.claude/skills/opentui/` (done 2026-04-25) |

---

## 1. Why now

Felipe observation (2026-04-25): "the terminal was purple, became light green with red" at 24% CPU. Triaged in chat:

- The "purple → green/red" transition is the **SystemStats panel** refreshing (PR #988/#990/#993, 2026-04-02). Initial render shows only `genie vX.Y.Z` on `palette.bgLight=#241838` (purple). After 3s, `pickColor` (`SystemStats.tsx:46-50`) paints CPU/RAM/swap/load bars in **emerald → amber → error-red** thresholded at 50/80%. On a busy machine the bottom panel becomes visually dominated by red+amber bars over a barely-visible purple bg — reads as "grey + red".
- The thresholds are too aggressive (`>50` = amber means a normal multitasked dev box sits permanently in amber).
- The palette itself hasn't changed — the *appearance* changed because color was added without considering the gestalt.

**Root cause is broader than one panel.** The genie design system has **three parallel sources of truth** plus dozens of one-off hex literals:

| Source | File | Brand purple |
|---|---|---|
| TUI palette | `src/tui/theme.ts` | `#7c3aed` |
| Desktop app palette | `packages/genie-app/lib/theme.ts` | `#7c3aed` (duplicated, drifts independently) |
| Tmux configs | `scripts/tmux/genie.tmux.conf`, `scripts/tmux/tui-tmux.conf`, `scripts/tmux/genie-projects.sh`, `scripts/tmux/genie-sessions.sh` | `#7b2ff7` ← **off-by-one hue** |

Plus 244 hex literals across 42 non-test files (`src/tui/components/*.tsx` modal overlays `#0a0a0a`, `src/lib/tmux.ts` 8 distinct window-bg colors, `src/term-commands/*.ts` chalk one-offs, etc).

This proposal ships:
1. A single token source in `packages/genie-tokens/`.
2. A new **Severance-inspired** palette replacing the current purple/green/red traffic-light look.
3. Migration of every hard-coded color to the token reference.
4. Calmer `pickColor` thresholds (`>70` amber, `>90` error) so a normal load reads neutral.

---

## 2. Severance palette — design rationale

Reference points from the show:
- **MDR terminal** (Macro Data Refinement room): black-petrol bg, mint-green monospace text, scary numbers throb in a desaturated red.
- **Lumon offices**: pale beige walls, deep navy carpet, fluorescent overhead light → cool white-grey UI surfaces.
- **Severed/Innie palette is muted** — no saturated brand color anywhere. Warmth (amber) reserved for the Outie world / waking memories.
- **Red is rare and means alarm.** Elevator emergency, blood, the goat room. Not "RAM at 51%".

### Proposed tokens

```ts
// packages/genie-tokens/palette.ts
export const palette = {
  // ── Surfaces (Lumon institutional) ───────────────────────
  bg:           '#0a1d2a',  // MDR terminal petrol / deep carpet navy
  bgRaised:     '#0f2638',  // panel surface (sidebar, cards)
  bgHover:      '#143049',  // hover state
  bgOverlay:    'rgba(10, 29, 42, 0.92)', // modal scrim

  // ── Text (overhead fluorescent) ──────────────────────────
  text:         '#c9cfd4',  // primary — clean white-grey
  textDim:      '#8a9499',  // secondary
  textMuted:    '#5e6e74',  // tertiary / "severed grey"

  // ── Borders ──────────────────────────────────────────────
  border:       '#2a3f4f',  // panel divider
  borderActive: '#7fc8a9',  // active = MDR mint

  // ── Accent (MDR terminal text) ───────────────────────────
  accent:       '#7fc8a9',  // primary mint — replaces brand purple
  accentDim:    '#5a9d82',  // pressed / dim
  accentBright: '#9eddc1',  // hover / glow / selection text

  // ── Status (calmer, fewer alarms) ────────────────────────
  success:      '#7fc8a9',  // mint — same as accent (calm OK)
  warning:      '#d4a574',  // incandescent amber — Outie warmth
  error:        '#a83838',  // deep crimson — true alarm only
  errorBright:  '#c44a4a',  // hover state on error
  info:         '#5a8ca8',  // cool blue — rare attention

  // ── Severance accents (rare) ─────────────────────────────
  beige:        '#d4c5a9',  // Lumon office wall — neutral-warm
  innieGrey:    '#5e6e74',  // muted divider tone
  outieAmber:   '#d4a574',  // memory / warmth flash

  // ── Scrollbar ────────────────────────────────────────────
  scrollTrack:  '#2a3f4f',
  scrollThumb:  '#5e6e74',
} as const;
```

### What changes visually

| Surface | Before | After |
|---|---|---|
| Left nav bg | `#1a1028` deep purple | `#0a1d2a` MDR petrol |
| Sidebar header/footer | `#241838` purple-grey | `#0f2638` raised petrol |
| Selected row | `#7c3aed` electric violet | `#5a9d82` muted mint (selected text in `#9eddc1`) |
| Brand label `genie vX.Y.Z` | `#a855f7` purple "genie" | `#7fc8a9` mint "genie" |
| Tree node — running | `#34d399` lime emerald | `#7fc8a9` mint (matches accent) |
| Tree node — error | `#f87171` salmon red | `#a83838` deep crimson |
| Tree node — warning | `#fbbf24` saturated yellow | `#d4a574` incandescent amber |
| Modal overlay | `#0a0a0a` near-black | `bgOverlay` rgba petrol scrim |
| Tmux pane border (active) | `#7b2ff7` purple | `#7fc8a9` mint |
| Tmux status bar | `#1a1a2e` near-black | `#0a1d2a` petrol (matches TUI bg) |

### `pickColor` calibration

```ts
// Before (SystemStats.tsx:46-50)
function pickColor(percent: number): string {
  if (percent > 80) return palette.error;
  if (percent > 50) return palette.warning;   // ← too eager
  return palette.emerald;
}

// After
function pickColor(percent: number): string {
  if (percent > 90) return palette.error;     // true danger only
  if (percent > 70) return palette.warning;   // genuinely high
  return palette.accent;                       // calm normal
}
```

A 24% CPU now stays mint, not "light green that competes for attention".

---

## 3. Phased execution plan

### Phase A — Token source of truth (1 day)
- Create `packages/genie-tokens/` with `palette.ts`, `tokens.ts`, `index.ts`. Pure constants, zero deps.
- `src/tui/theme.ts` re-exports tokens (keeps backward-compat names where used).
- `packages/genie-app/lib/theme.ts` re-exports tokens (delete its duplicates).
- New `scripts/tmux/tokens.sh` generator emits `set -g status-style "bg=$bg,fg=$text"` etc. into a generated `.conf` file. tmux conf files `source` the generated file. Lint check in CI: regenerate + diff = empty.
- **Deliverable:** Single source. Current colors swapped for Severance values. Visual diff visible immediately.
- **Validation:** `bun run typecheck`, `bun run lint`, `bun run test:tui`, `genie tui` smoke screenshot.

### Phase B — Component hex sweep (2-3 days)
- Replace every literal `#xxxxxx` in 42 non-test files with `palette.X` references.
- Targets:
  - `src/tui/components/AgentPicker.tsx`, `TeamCreate.tsx`, `QuitDialog.tsx`, `SpawnTargetPicker.tsx`, `ContextMenu.tsx`, `TreeNode.tsx` — modal overlays, selected text.
  - `src/tui/components/SystemStats.tsx` — `pickColor` recalibration.
  - `packages/genie-app/views/**/*.tsx` (15 files) — desktop app surfaces.
  - `src/term-commands/agents.ts`, `board.ts`, `msg.ts`, `serve.ts`, `tag.ts` — chalk hex calls.
  - `src/lib/tmux.ts:414-421` — 8 window-bg colors → derive from accent palette via HSL rotation.
  - `src/lib/protocol-router.ts`, `runtime-events.ts`, `task-service.ts`, `board-service.ts` — embedded color metadata.
- **Deliverable:** `grep -RE '#[0-9a-fA-F]{6}' src/ packages/ scripts/ --exclude-dir=test*` returns ONLY `packages/genie-tokens/palette.ts` (and tmux generator output).
- **Validation:** existing test suite green, snapshot tests for TUI components updated once and locked.

### Phase C — Theme variants & toggle (2 days, optional v2)
- Define alternate themes in `packages/genie-tokens/themes/`:
  - `lumon-mdr.ts` (primary — petrol+mint, the default)
  - `optics-design.ts` (warmer — beige+amber, the alt office)
  - `breakroom.ts` (red alarm — desaturated crimson everything, for sec-incident mode)
- `genie config theme set <name>` writes to `~/.genie/config.json`; TUI loads at boot.
- Tmux configs regenerate on theme change.
- **Deliverable:** `genie tui --theme breakroom` works for sec-fix incident UI.
- Felipe call: do we ship variants in this wish or punt to v2? Default recommendation: **punt** — get the unified token + Severance default shipped first.

### Phase D — Visual regression harness (1 day)
- Add `test/visual/tui.snapshot.test.tsx` rendering each major TUI surface to a string snapshot (opentui exposes a `render-to-string` for this).
- Snapshot SystemStats at 10/50/85% load to lock the calmer `pickColor` thresholds.
- CI gate: snapshot diff fails the build, regeneration is intentional.
- **Deliverable:** future palette drift caught at PR-time, not in production.

---

## 4. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Visual change is jarring for current users | Phase C lets users keep purple as a `legacy-purple` theme variant if demand appears. |
| Tmux color generator complicates the build | Generator is a single shell script run pre-commit + in CI; no runtime overhead. |
| Some chalk colors need to map to ANSI 16, not truecolor | `palette.toAnsi(token)` helper that picks the closest 16-color match for chalk fallback. |
| Snapshot tests are brittle | Snapshot only the **palette references used**, not pixel output. Use opentui's tree-to-string. |
| Breaking change for users embedding genie components | Token names are additive; old palette names re-exported as aliases for one minor version then removed. |

---

## 5. Out of scope (this wish)

- Web/marketing site palette (separate repo).
- Icon / logo redesign.
- Font changes (current JetBrains Mono stays — Severance terminals use a similar weight).
- Dark/light mode toggle (Severance is dark-only by aesthetic; light mode = different proposal).
- i18n of color-name strings in CLI help output.

---

## 6. Validation checklist (pre-ship)

- [ ] `grep -RE '#[0-9a-fA-F]{6}' src/ packages/ scripts/` returns only `genie-tokens/` + generated tmux file.
- [ ] `bun run typecheck && bun run lint && bun run test` all green.
- [ ] `genie tui` boots and renders Severance palette by default.
- [ ] `genie team create` modal, `AgentPicker`, `QuitDialog`, `SpawnTargetPicker` all use token references.
- [ ] SystemStats panel at 24% CPU is calm mint, not screaming green-vs-red.
- [ ] Tmux pane borders match TUI accent (no off-by-one hue).
- [ ] Visual regression snapshots committed.
- [ ] Side-by-side screenshots in PR description (before/after for: nav, modal, system stats high-load, system stats normal-load).

---

## 7. Decision needed from Felipe

1. **Approve Severance palette values** (or tweak — full list in §2).
2. **Phase C scope**: ship theme variants in this wish, or punt to follow-up?
3. **Backward-compat aliases**: keep old `palette.purple`, `palette.violet` as aliases for one release cycle, or hard cut?
4. **Worker dispatch**: spawn `genie team create design-system-severance --wish design-system-severance`, or do this manually as you tweak?

On approval I'll convert this proposal into `repos/genie/.genie/wishes/design-system-severance/WISH.md` and dispatch.
