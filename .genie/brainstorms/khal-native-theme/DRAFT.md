# DRAFT — khal-native-theme

**Date:** 2026-07-23
**Status:** Simmering (first of three; order Felipe-confirmed Theme → Identity → SSH)
**Target repo:** khal-os/genie-desktop (`~/prod/genie-ui-ab/dash-fork`)
**Shared research:** [khal-native-desktop umbrella](../khal-native-desktop/DRAFT.md)

## Problem

Genie desktop still looks like dash's "Obsidian Console" design system. It should look **KHAL NATIVE** (the KhalOS design language: dark-first OKLCH, copper accent, Geist/Geist Mono, glass surfaces, PillBadge eyebrows, StatusDot pulses, khalEasing motion) — **without changing layout/disposition; theme only** (Felipe verbatim).

## What makes this tractable (explorer evidence)

- Dash styling is overwhelmingly token-driven: one 1453-line `src/renderer/index.css` owns every CSS variable; ~1413 of ~1595 className sites use token utilities; only ~27 hardcoded hex (mostly terminal/diff/git colors).
- No `cn()` indirection to fight; Tailwind v4 `@theme` maps utilities → the same vars.
- The KHALOS-DESIGN-REFERENCE.md (in the omni repo) is a complete distilled contract: two token namespaces (`--ds-*` Geist-grayscale + `--khal-*` OKLCH copper), stylesheet import order, motion spec (one easing `[0.22,1,0.36,1]`, blur-in, 120ms stagger), type scale, radii 6/10/12/16, anti-pattern list.
- The **K dot-matrix loader** Felipe loves is a self-contained pattern in old `desktop/src/desktop/main.tsx:136-202` (13×14 matrix, `connecting-dot pulse/off`, 0.07s row stagger) — trivially portable.

## Scope (proposed)

**IN:**
- Replace dash token values with KHAL NATIVE equivalents across `:root`/`.dark` (mapping `--background→--khal-bg`, `--primary→--khal-accent` copper, surfaces→layered `--khal-surface`…), keeping dash's variable NAMES so the ~1595 call sites don't change.
- Fonts → Geist + Geist Mono (mono on statuses/IDs/timestamps/metrics, tabular-nums).
- Motion → khalEasing + blur-in reveals + list stagger (replace existing animation curves in index.css / motion usages).
- Element-level restyle inside existing components: Button/badge/card/status-dot visual treatments per the reference (PillBadge look for eyebrow labels, StatusDot pulse+glow, glass treatment on floating surfaces only).
- xterm terminal palette: add a KHAL theme to `terminalThemes.ts` (ANSI contract from khal-tokens.css:94-121) and make it the default.
- **K dot-matrix loading screen** — port from old desktop for app-loading/connecting states.
- Diff/git status colors re-mapped onto KHAL status tokens (sparingly, per "status colors never decorative").

**OUT:**
- Any layout/disposition change (grid structure, panel arrangement, component placement) — hard exclusion.
- Component API changes or replacing dash primitives with `@khal-os/ui` React components wholesale.
- App identity/branding (name, `ai.khal.genie`, icons, env vars) — owned by the khal-rebrand wish.
- Light-theme redesign beyond a faithful `.khal-light`-derived mapping (dark is canonical).
- Wallpaper/MeshGradient hero moments (optional later polish).

## Decisions (Felipe, 2026-07-23 picker — all four locked)

1. **Adopt `@khal-os/ui` as a real dependency** (Felipe pick, over my port-tokens recommendation): `.npmrc` for the Gitea registry, import `tokens.css` + `khal-os.css` barrel, use the genuine `--khal-*` tokens and `.k-*` classes; dash's existing var names become a bridge layer mapped onto khal tokens so the ~1595 call sites keep working. Component-level adoption only where drop-in (no layout change).
2. **Dark-only first** — KHAL is dark-canonical; hide the light toggle; `.khal-light` mapping is a follow-up if missed.
3. **Delete legacy palettes** (`.light.legacy`/`.dark.legacy`) — deprecate loudly, remove decisively.
4. **Bundle Geist/Geist Mono woff2 in the repo** — offline-safe Electron boot, no Google Fonts import.

Implementation note (not a Felipe decision): ~229 `hsl(var(--x))` call sites assume HSL-triplet var format. The bridge either keeps triplet-format values (converted from OKLCH) for those vars, or migrates the call sites to `var(--x)` full-color format. Resolve in the wish plan; the constraint is zero visual/layout drift.

## Risks

- xterm/diff/monaco hardcoded palettes are the biggest "off-theme" leak surface (~27 hex + `terminalThemes.ts`).
- Glass/backdrop-filter bespoke classes (index.css ~750-1453) need per-class re-tint — mechanical but wide.
- khal-rebrand overlap: both touch visual identity; theme must not pre-empt rebrand's icon/name work (rebrand G6 icons await Felipe art).
- OKLCH → dash's HSL-triplet var format: Tailwind v4 handles raw color values fine, but any `hsl(var(--x))` call sites (~229) assume triplet format — mapping must preserve the format or migrate those call sites.
- Perceptual QA is Felipe's eye — no automated "looks KHAL" check; anti-pattern list is the review rubric.

## Acceptance criteria (draft)

- [ ] Side-by-side before/after: identical layout (no element moved/resized) — spot-check the main screens (kanban, task view, terminal, settings, diff).
- [ ] All five "instantly KhalOS" signals present: dark `--khal-bg` base, copper selection/brand accent, Geist Mono on statuses/metrics with tabular-nums, khalEasing motion with stagger, layered surfaces (no raw bordered divs on floating chrome).
- [ ] Zero hits for the anti-patterns: raw Tailwind grays, body-font metrics, generic ease-in-out, global light invert.
- [ ] K dot-matrix loader renders on app boot/connecting.
- [ ] Terminal defaults to the KHAL ANSI palette.
- [ ] Full dash suite still green (baseline 118 files / 1085 pass / 1 skip); no `src/main` changes at all.
- [ ] Felipe visual QA pass on the live HMR loop.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
All four Felipe decisions locked 2026-07-23 → crystallized to [DESIGN.md](DESIGN.md).

Additional risk from decision 1: `@khal-os` Gitea registry credentials must be available wherever the fork installs deps (dev boxes + the Mac DMG build) — `khal source`/`khal registry` CLI commands manage these; verify before execution.
