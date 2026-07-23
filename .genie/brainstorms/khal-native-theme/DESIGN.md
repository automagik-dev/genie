# Design: KHAL NATIVE theme for genie desktop

| Field | Value |
|-------|-------|
| **Slug** | `khal-native-theme` |
| **Date** | 2026-07-23 |
| **WRS** | 100/100 |

## Problem

Genie desktop still wears dash's "Obsidian Console" design system; it should look KHAL NATIVE — the KhalOS design language (dark-first OKLCH, copper accent, Geist/Geist Mono, layered glass surfaces, khalEasing motion) — **without changing any layout or disposition; theme only** (Felipe verbatim). It matters because this app is becoming the Khal-branded genie surface (khal-rebrand wish already APPROVED for identity), and the visual language is the most user-visible half of that story.

## Scope

### IN
- Add `@khal-os/ui` as a real dependency of the fork: `.npmrc` scoping `@khal-os` to the Gitea npm registry (`https://git.namastex.io/api/packages/khal/npm/`), import `@khal-os/ui/tokens.css` + `@khal-os/ui/styles/khal-os.css` (barrel: khal-tokens → khal-motion → khal-components → khal-light) in the documented order.
- **Bridge layer:** dash's existing CSS variable names (`--background`, `--primary`, `--card`, `--muted`, `--surface-0..3`, `--git-*`, `--status-*`, `--cat-1..8`, …) are re-pointed at KHAL token values so the ~1,595 existing className call sites and ~229 inline `hsl(var(--x))` usages keep working unchanged. Format constraint resolved at wish-plan time: either keep HSL-triplet values (converted from OKLCH) for triplet-consumed vars, or migrate those call sites to `var(--x)` — the acceptance bar is zero layout drift either way.
- Typography: bundle Geist + Geist Mono woff2 files in the repo (`@font-face`, no network fetch); Geist Mono + `tabular-nums` on every status/ID/timestamp/metric surface.
- Motion: khalEasing `[0.22,1,0.36,1]` + blur-in reveals + 120ms list stagger replacing dash's existing curves; reduced-motion collapse preserved.
- Element-level restyle inside existing components (no layout moves): PillBadge treatment for eyebrow/section labels, StatusDot pulse+glow for live states, SectionCard/glass treatment on existing card/floating surfaces, copper for brand/selection, blue restricted to operational signal/links.
- **K dot-matrix loader**: port the 13×14 `K_MATRIX` connecting/boot screen from old `khal/desktop` (`src/desktop/main.tsx:136-202` + its CSS) into dash's app-loading and connecting states. Felipe explicitly loves this element.
- xterm: add a KHAL ANSI palette to `terminal/terminalThemes.ts` (contract from `khal-tokens.css:94-121`) and make it the default terminal theme.
- Diff/git status colors remapped onto KHAL status tokens (status colors sparingly, never decorative).
- Dark-only: `.dark` is the sole shipped palette; the light toggle is hidden; legacy palettes (`.light.legacy`, `.dark.legacy`) deleted from `index.css`.

### OUT
- Any layout/disposition change — grid structure, panel arrangement, component placement, sizes. Hard exclusion; before/after screens must be structurally identical.
- Wholesale replacement of dash's React components with `@khal-os/ui` components (adopt styles/tokens/classes; swap a component only when it is a drop-in with identical layout).
- App identity/branding (product name, `ai.khal.genie`, app icons, env vars, dirs) — owned entirely by the approved khal-rebrand wish.
- A light theme (`.khal-light` mapping) — explicit follow-up, not v1.
- Wallpaper/MeshGradient hero moments — later polish if wanted.
- Any `src/main` (main-process) change.

## Approach

**Adopt `@khal-os/ui` (Felipe's pick) with a variable-name bridge.** The package's genuine token sheets and `.k-*`/component CSS come in as a dependency from the Gitea registry, so the theme stays upstream-true and future component adoption is free. Dash's own token names survive as a thin mapping layer onto `--khal-*` values, which is what keeps ~1,595 call sites untouched and guarantees the "theme only, no disposition change" bar. Since v1 is dark-only, the two-namespace theming complexity (`--ds-*` next-themes `.dark` vs `--khal-*` `.khal-light`) collapses: mount `.dark` permanently and skip the resolvedTheme mirroring entirely.

Alternatives considered: (a) *port token values only, no package* — my original recommendation (zero registry dependency, smallest diff) — lost because Felipe wants the real design system in the tree, keeping it in lockstep with app-kit and opening the door to component adoption; (b) *full component adoption* — rejected as it inevitably changes layout and violates the theme-only mandate.

Rollout inside the fork follows the live-dev-loop workflow: changes land on a branch off `khal/main`, reviewed on the HMR loop where Felipe can judge the skin live.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Adopt `@khal-os/ui` as dependency (Gitea registry + `.npmrc`), not a token-value port | Felipe's explicit pick over the port-only recommendation: genuine design system, stays current with app-kit, enables later component adoption |
| 2 | Bridge dash's existing var names onto KHAL tokens | Keeps ~1,595 className sites + ~229 `hsl(var())` sites unchanged — the mechanism that enforces "theme only" |
| 3 | Dark-only v1; hide light toggle | KHAL is dark-canonical; halves the QA surface; `.khal-light` is a clean follow-up |
| 4 | Delete `.light.legacy` / `.dark.legacy` palettes | Deprecate loudly, remove decisively — dead palettes tax every future token edit |
| 5 | Bundle Geist/Geist Mono woff2 in-repo | Electron must boot offline without font flash; Google Fonts import rejected |
| 6 | Port the K dot-matrix loader from old khal/desktop | Felipe: "I absolutely LOVE the loading K made of dots"; self-contained, proven pattern |
| 7 | xterm gets a KHAL ANSI palette as default | Terminal is the app's biggest surface; hardcoded xterm palettes are the largest off-theme leak otherwise |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | `@khal-os` Gitea registry credentials unavailable where deps install (dev boxes, Mac DMG build) | Medium | Verify `khal source`/`khal registry` credential flow on both machines before execution starts; document in the wish as a group-0 precondition |
| 2 | `hsl(var(--x))` triplet-format sites (~229) break if vars get full-color values | High | Explicit resolution step in the wish plan (convert values to triplets or migrate call sites); acceptance criterion is zero visual/layout drift |
| 3 | xterm/monaco/diff hardcoded palettes leak the old look (~27 hex + `terminalThemes.ts`) | Medium | Enumerated in the explorer inventory; each gets an explicit remap task |
| 4 | Bespoke glass/backdrop classes (`index.css` ~750-1453) need per-class re-tint | Medium | Mechanical sweep, guided by the KHALOS-DESIGN-REFERENCE anti-pattern list |
| 5 | Collision with khal-rebrand wish (icons/branding) | Low | Branding is OUT here; rebrand owns it; both wishes note the boundary |
| 6 | "Looks KHAL" is perceptual — no automated check | Low | Felipe live-QA on the HMR loop is the gate; the reference's Top-10/anti-pattern lists are the review rubric |
| 7 | Assumption: `@khal-os/ui` CSS imports work under dash's Tailwind v4/PostCSS pipeline | Medium | Smoke-test the import in group 1 before any restyle work builds on it |

## Success Criteria

- [ ] Side-by-side before/after screenshots of the main screens (kanban, task view, terminal, diff editor, settings): element positions and dimensions identical — theme only.
- [ ] All five "instantly KhalOS" signals present: dark `--khal-bg` base; copper brand/selection accent; Geist Mono + tabular-nums on statuses/IDs/metrics; khalEasing motion with 120ms stagger; layered surfaces (no raw bordered divs on floating chrome).
- [ ] Zero anti-pattern hits: no raw Tailwind grays, no body-font metrics, no generic ease-in-out, no global light invert, no decorative status colors.
- [ ] K dot-matrix loader renders on app boot/connecting states.
- [ ] Terminal defaults to the KHAL ANSI palette.
- [ ] Legacy palettes gone; light toggle hidden; app boots offline with bundled Geist (no font flash).
- [ ] Full dash suite green (baseline 118 files / 1085 pass / 1 skip); zero `src/main` diffs.
- [ ] Felipe visual QA pass on the live HMR loop.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `bdd54325803cdcf56d5afdf06b5763f4005bc7a4bb5c1ee0102f921efb0563f7`
- **Reviewer:** genie:reviewer (design-review, session 00dad3c5)
- **Reviewed at:** 2026-07-23T16:55:11.000Z
<!-- genie-design-review:end -->
