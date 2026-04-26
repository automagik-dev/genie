# Genie Design System

Genie ships a single, dark-only color palette inspired by **Severance** (Apple TV+) — the Lumon Macro Data Refinement room. One source of truth, three consumers (TUI, desktop app, tmux). No backward-compat aliases.

## Why Severance

The MDR terminal is the design reference: black-petrol surfaces, mint-green monospace text, alarms reserved for genuine danger. Lumon's institutional cool greys carry the chrome; the Outie's incandescent amber is warmth in reserve. Red means *the goat room*, not "RAM at 51%". This forces calm defaults and makes attention states actually attentive.

The previous palette fragmented into three drifting sources of truth (TUI `#7c3aed` vs. tmux `#7b2ff7` — an off-by-one hue) and 244 hex literals across 42 files. The unified token system eliminates that class of bug.

## Architecture

```
packages/genie-tokens/        single source of truth (zero deps)
├── palette.ts                primitive hex values (Severance Lumon-MDR)
├── tokens.ts                 semantic aliases (accent, surface, danger, …)
├── hsl.ts                    rotateHue() helper for derived colors
├── index.ts                  re-exports
└── __tests__/palette.test.ts WCAG AA contrast assertions

src/tui/theme.ts              re-exports genie-tokens
packages/genie-app/lib/theme.ts re-exports genie-tokens (+ CSS var map)
scripts/tmux/.generated.theme.conf  generated from genie-tokens
```

`genie-tokens` is a workspace package because both `src/` (TUI/CLI) and `packages/genie-app/` (desktop) consume it. A workspace package is the only honest dependency direction.

## Tokens

### Surfaces — Lumon institutional

| Token | Hex | Use |
|-------|-----|-----|
| `bg` | `#0a1d2a` | App background — MDR terminal petrol |
| `bgRaised` | `#0f2638` | Panels, sidebars, cards |
| `bgHover` | `#143049` | Hover state on rows |
| `bgOverlay` | `rgba(10, 29, 42, 0.92)` | Modal scrim (tinted, not pure black) |

### Text — overhead fluorescent

| Token | Hex | Use |
|-------|-----|-----|
| `text` | `#c9cfd4` | Primary copy |
| `textDim` | `#8a9499` | Secondary copy |
| `textMuted` | `#5e6e74` | Tertiary / "severed grey" |

### Accent — MDR terminal text

| Token | Hex | Use |
|-------|-----|-----|
| `accent` | `#7fc8a9` | Brand mint (replaces old purple) |
| `accentDim` | `#5a9d82` | Pressed / selected-row bg |
| `accentBright` | `#9eddc1` | Hover, selection text, glow |

### Status — calmer alarms

| Token | Hex | Use |
|-------|-----|-----|
| `success` | `#7fc8a9` | OK = mint (same as accent — calm) |
| `warning` | `#d4a574` | Incandescent amber — Outie warmth |
| `error` | `#a83838` | Deep crimson — true alarm only |
| `errorBright` | `#c44a4a` | Error hover |
| `info` | `#5a8ca8` | Cool blue — rare attention |

### Severance accents (rare)

`beige` (`#d4c5a9`), `innieGrey` (`#5e6e74`), `outieAmber` (`#d4a574`).

### Semantic aliases

`tokens.ts` re-exports the palette under intent-based names — `surface`, `surfaceRaised`, `danger`, `dangerStrong`, `attention`, `severed`, `outieWarm`, `lumonBeige`. Prefer these in new code; they survive palette rebalancing without churning import sites.

## How to add a new color

1. Add the primitive to `packages/genie-tokens/palette.ts` with a one-line comment naming the Severance reference (which surface, which scene).
2. Add a semantic alias to `packages/genie-tokens/tokens.ts` if consumers will refer to it by intent.
3. Update `packages/genie-tokens/__tests__/palette.test.ts` — assert the new key exists and (for text/accent values over a surface) meets WCAG AA contrast.
4. If the color belongs in tmux too, extend `scripts/tmux/generate-theme.ts` and regenerate (next section).
5. Run `bun test test/visual/ -u` to refresh snapshots if the color appears in any captured TUI surface.

**Never inline a hex in a component.** The repo-wide grep gate (`#[0-9a-fA-F]{6}` outside `palette.ts` / `.generated.theme.conf`) fails CI.

## How to regenerate the tmux theme

Tmux configs do not maintain hex by hand — they `source-file` a generated file:

```bash
bash scripts/tmux/generate-theme.sh
```

This runs `scripts/tmux/generate-theme.ts`, which imports from `packages/genie-tokens` and emits `scripts/tmux/.generated.theme.conf` (status styles, pane borders, mode, clock, format strings, plus `set-environment -g GENIE_TMUX_*` exports for shell consumers).

CI runs the script and fails on a non-empty `git diff` — forgetting to regenerate after a token change is a build failure, not a silent drift.

`scripts/tmux/genie-projects.sh` and `scripts/tmux/genie-sessions.sh` read tokens via `tmux show-environment -g GENIE_TMUX_*`, so they inherit the generated palette automatically.

## How to update visual snapshots

`test/visual/tui-snapshot.test.tsx` renders every major TUI surface (Nav, TreeNode states, SystemStats at 10/50/85/95% load, AgentPicker, QuitDialog, TeamCreate, ContextMenu) to a deterministic string snapshot.

```bash
bun run test:visual         # check — fails on drift
bun test test/visual/ -u    # update snapshots after an intentional change
```

Snapshots live in `test/visual/__snapshots__/`. Commit them alongside the palette change. CI runs `bun test test/visual/` — any unintended palette drift fails the build.

**When to update:** intentional palette change, intentional component-token swap, new component added to the snapshot suite. **When not to update:** to silence a failing test you don't understand — read the diff first, the snapshot is doing its job.

## Out of scope (today)

- Theme variants (`optics-design`, `breakroom`) — defer to `design-system-themes-v2`.
- Light mode — Severance is dark-only.
- Web/marketing site palette — separate repo, separate audience.
- Backward-compat aliases — old names (`purple`, `violet`, `cyan`, `emerald`) are deleted. External consumers must migrate to the semantic tokens.
