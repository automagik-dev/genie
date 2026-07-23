# Wish: KHAL NATIVE theme for genie desktop

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `khal-native-theme` |
| **Date** | 2026-07-23 |
| **Author** | Felipe Rosa (decisions) / genie orchestrator session 00dad3c5 (plan) |
| **Appetite** | medium |
| **Branch** | `wish/khal-native-theme` (on khal-os/genie-desktop, off `khal/main`) |
| **Repos touched** | khal-os/genie-desktop (working copy `~/prod/genie-ui-ab/dash-fork`) — renderer only; genie repo only for this ledger |
| **Design** | [DESIGN.md](../../brainstorms/khal-native-theme/DESIGN.md) |

## Summary

Re-skin the genie desktop renderer from dash's "Obsidian Console" onto the genuine KHAL NATIVE design system by adopting `@khal-os/ui` as a dependency (Felipe's pick): dark-first OKLCH with copper accent, bundled Geist/Geist Mono, khalEasing motion, the K dot-matrix loader, and a KHAL terminal palette — with **zero layout/disposition change**. Dash's existing CSS variable names become a bridge onto KHAL tokens so ~1,595 className sites and ~229 `hsl(var())` sites stay untouched. First of Felipe's confirmed Theme → Identity → SSH sequence.

## Scope

### IN

- `.npmrc` scoping `@khal-os` to the Gitea npm registry + `@khal-os/ui` dependency; import `tokens.css` + `khal-os.css` barrel in the documented order under dash's Tailwind v4/PostCSS pipeline.
- Bridge layer in `src/renderer/index.css`: dash var names re-pointed at KHAL token values (triplet-format strategy resolved in Group 2 — preserve HSL-triplet values for triplet-consumed vars; the `@theme` block wraps every var in `hsl(var(--x))`, so triplet preservation is the default path).
- Dark-only v1: `.dark` sole palette, light toggle hidden, `.light.legacy`/`.dark.legacy` deleted, inert `:root` light values and the `legacy` class toggle in `App.tsx` pruned.
- Bundled Geist + Geist Mono woff2 (`@font-face`, offline-safe); Geist Mono + `tabular-nums` on status/ID/timestamp/metric surfaces.
- Motion: khalEasing `[0.22,1,0.36,1]`, blur-in reveals, 120ms list stagger; reduced-motion collapse preserved.
- Element-level restyle in place: PillBadge treatment for eyebrows, StatusDot pulse+glow, SectionCard/glass treatment on existing surfaces, copper = brand/selection, blue = signal/links only; bespoke glass/backdrop classes re-tinted; diff/git status colors remapped.
- K dot-matrix loader (visual matrix + CSS only; canonical source is the vendored [`k-loader-reference.md`](../../brainstorms/khal-native-theme/k-loader-reference.md), captured from old `khal/desktop` `src/desktop/main.tsx:131-202` + `index.css:58-105` — the reference file governs wherever citations differ) on dash's app-loading states.
- KHAL ANSI palette added to `terminal/terminalThemes.ts` as the default terminal theme.

### OUT

- Any layout/disposition change — element positions/sizes must be pixel-structurally identical (hard exclusion).
- Wholesale `@khal-os/ui` React-component replacement (styles/tokens/classes only; swap only provable drop-ins).
- App identity/branding (name, `ai.khal.genie`, icons, env, dirs) — owned by the approved khal-rebrand wish.
- Light theme (`.khal-light` mapping) — explicit follow-up.
- Wallpaper/MeshGradient heroes; `src/main` changes; the old loader's auth/retry wiring (`useRetryStore`, `/auth/reset`).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Adopt `@khal-os/ui` as dependency, not a token-value port | Felipe's explicit pick: genuine design system, lockstep with app-kit, opens later component adoption |
| 2 | Bridge dash var names onto KHAL values | Keeps ~1,595 className + ~229 `hsl(var())` sites unchanged — the mechanism enforcing "theme only" |
| 3 | Dark-only v1, light toggle hidden | Felipe pick; KHAL is dark-canonical; halves QA surface |
| 4 | Delete legacy palettes + prune inert light/legacy toggle paths | Felipe pick; dead palettes tax every future token edit (reviewer informational #3 folded in) |
| 5 | Bundle Geist woff2 in-repo | Felipe pick; Electron offline boot, no font flash |
| 6 | K-loader = visual matrix + CSS only | Reviewer finding #1: source carries auth/retry wiring dash doesn't have; port the visual, target dash's real loading states |
| 7 | KHAL ANSI xterm palette as default | Terminal is the biggest surface; `terminalThemes.ts` is the largest off-theme leak otherwise |
| 8 | Triplet-preserve is the default bridge strategy | Reviewer-verified: `@theme` wraps every var in `hsl(var())`; preserving triplet values touches zero call sites; any migration to `var(--x)` needs explicit justification in-group |
| 9 | `legacy` teardown split precisely: group-2 removes the CSS palettes (`.light.legacy`/`.dark.legacy`), the `.legacy .sidebar-shell`/`.legacy .right-inspector-shell` cosmetic rules, and the `App.tsx:629` `legacy` body-class branch; the `legacy` *terminal theme* (an xterm palette in `terminalThemes.ts`) stays selectable | Plan-review finding #5: `legacy` in App.tsx is driven by `terminalTheme`, not the light/dark toggle; removing app-chrome overrides while keeping the xterm palette preserves user choice without dead CSS |
| 10 | Loader source vendored at [k-loader-reference.md](../../brainstorms/khal-native-theme/k-loader-reference.md) | Plan-review finding #4: the old-desktop clone was session-ephemeral; matrix values + CSS + JSX pattern now live in git; loader CSS ships in its own file (not `index.css`) to keep group-5 conflict-free |
| 11 | All suite validations run through `pnpm test` (the repo's `ELECTRON_RUN_AS_NODE=1 electron … vitest` harness), never bare `vitest` | Plan-review finding #1: native modules (better-sqlite3, node-pty) are ABI-built for Electron; bare vitest fails on module load regardless of theme correctness |

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] Before/after screenshots of kanban, task view, terminal, diff editor, settings: element positions and dimensions identical — theme only.
- [ ] Five "instantly KhalOS" signals present: dark `--khal-bg` base; copper brand/selection; Geist Mono + tabular-nums on statuses/metrics; khalEasing + 120ms stagger; layered surfaces.
- [ ] Zero anti-pattern hits (raw Tailwind grays, body-font metrics, generic ease-in-out, global light invert, decorative status colors).
- [ ] K dot-matrix loader renders on app boot/loading states.
- [ ] Terminal defaults to the KHAL ANSI palette.
- [ ] Legacy palettes gone; light toggle hidden; offline boot shows bundled Geist without fallback flash.
- [ ] Full dash suite green against a re-baselined count (baseline at execution start; last known 118 files / 1085 pass / 1 skip); `git diff --stat` shows zero `src/main` changes.
- [ ] Felipe visual QA pass on the live HMR loop.

## Execution Strategy

### Wave 1 (sequential — foundation)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| group-1 | engineer | 2 (+1 multi-package/registry infra, +1 CI/release-adjacent `.npmrc`/build surface) | engineer-standard / medium | Registry access proof, `@khal-os/ui` dependency, CSS import smoke test |

### Wave 2 (solo — the core re-skin; `index.css` has one owner at a time)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| group-2 | engineer | 4 (+2 subjective acceptance, +1 no deterministic test for visual parity, +1 wide single-file blast radius in index.css) | engineer-complex / high | Token bridge + dark-only consolidation (the core re-skin) |

### Wave 3 (parallel after group-2 — disjoint files: group-3 owns `index.css`, group-5 owns its own CSS file + `terminalThemes.ts`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| group-3 | engineer | 3 (+2 subjective acceptance on type/motion feel, +1 font vendoring + 34-animation sweep) | engineer-standard / high | Typography (bundled Geist) + motion system |
| group-5 | engineer | 3 (+1 cross-repo port from vendored reference, +1 no deterministic test, +1 loading-state discovery in dash) | engineer-standard / medium | K dot-matrix loader + KHAL xterm default |

### Wave 4 (after group-3 — serialized on `index.css`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| group-4 | engineer | 3 (+2 subjective acceptance, +1 scattered call-site sweep) | engineer-standard / high | Element restyle sweep: badges/dots/cards/glass + diff/git colors |

### Wave 5 (after all)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| group-6 | engineer | 3 (+2 subjective acceptance, +1 evidence-pack discipline) | engineer-standard / high | QA evidence pack + Felipe live QA handoff |

`index.css` serialization rule (plan-review finding #6): after group-1's import lines land (wave 1 strictly precedes everything), groups 2 → 3 → 4 are the only groups that edit `index.css`, and they run strictly in that order. Group-5's loader CSS lives in its own file; `terminalThemes.ts`/`terminalFonts.ts` are untouched by other groups. Note: this ordering is **documentary** — task rows in genie.db carry no dependency edges (same convention as khal-rebrand), so orchestrators and `genie launch` consumers must honor the waves from this document, not the ready-set.

## Execution Groups

### Group 1: Registry + dependency + import smoke test (group-1)

**Goal:** `@khal-os/ui` resolves, installs, and its CSS imports cleanly under dash's Vite/Tailwind v4 pipeline before any restyle work builds on it.

**Deliverables:**
1. Verified `@khal-os` credential flow on this box (`khal source` / `khal registry` per app-kit conventions); documented steps for the Mac (DMG build) in the group evidence.
2. Fork `.npmrc` scoping `@khal-os` → `https://git.namastex.io/api/packages/khal/npm/`; `@khal-os/ui` added to `package.json`.
3. `src/renderer/index.css` (or entry stylesheet) importing `@khal-os/ui/tokens.css` + `@khal-os/ui/styles/khal-os.css` in the documented order; check whether any `@source "<pkg>/dist"` directive is needed (reviewer #2) and record the finding.
4. App boots via the dock launcher/HMR with imports active and zero visual regression (nothing consumes the new tokens yet).

**Acceptance Criteria:**
- [ ] `pnpm install` succeeds from a clean state with the `.npmrc` in place.
- [ ] `pnpm dev` boots; renderer console free of CSS-resolution errors; `.k-*` classes and `--khal-*` vars observable in devtools.
- [ ] No visible UI change yet (imports are inert until the bridge lands).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && pnpm install --no-frozen-lockfile && pnpm build:renderer
```

**depends-on:** none

---

### Group 2: Token bridge + dark-only consolidation (group-2)

**Goal:** Dash's existing variable names carry KHAL NATIVE values everywhere, dark-only, with the legacy palettes gone — the app *is* KHAL-colored after this group with zero call-site edits.

**Deliverables:**
1. Bridge block in `index.css`: every dash token (`--background`, `--foreground`, `--primary`, `--card`, `--muted`, `--accent`, `--destructive`, `--border`, `--ring`, `--surface-0..3`, `--git-*`, `--status-*`, `--cat-1..8`, `--shade-*`, `--terminal-service`) re-valued from KHAL tokens. Default strategy: HSL-triplet values converted from the OKLCH reference (decision #8); any deviation documented in-group.
2. Legacy teardown per decision #9 — all five `legacy` hits in `index.css` removed: the `.light.legacy` and `.dark.legacy` palette blocks plus the `.legacy .sidebar-shell` / `.legacy .right-inspector-shell` cosmetic rules (`index.css:802-809`); the `App.tsx:629` `legacy` body-class branch deleted (the `legacy` terminal theme itself stays selectable in `terminalThemes.ts`); `:root` light palette pruned/re-pointed so dark is canonical; light toggle hidden in settings UI.
3. Copper/blue discipline applied at the token level (selection, links, focus rings).

**Acceptance Criteria:**
- [ ] Main screens render in KHAL dark palette with identical layout (spot-check screenshots vs pre-group baseline).
- [ ] `grep -c 'legacy' src/renderer/index.css` → 0; settings shows no light-theme toggle.
- [ ] No `hsl(var(--x))` call site broken (visual sweep + console clean).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && ! grep -q 'legacy' src/renderer/index.css && pnpm test
```

**depends-on:** group-1

---

### Group 3: Typography + motion (group-3)

**Goal:** Geist/Geist Mono ship in-repo and every animation follows the khalEasing motion language.

**Deliverables:**
1. Geist + Geist Mono woff2 files vendored (renderer assets), `@font-face` declarations, `--font-sans`/`--font-mono`/`--terminal-font` re-pointed; no network font fetch.
2. Geist Mono + `tabular-nums` applied to status/ID/timestamp/metric/shortcut surfaces (typography utility or targeted class updates — no layout moves).
3. Motion pass: existing animation curves in `index.css` and motion-lib usages replaced with khalEasing/blur-in/stagger per the reference; reduced-motion collapse verified.

**Acceptance Criteria:**
- [ ] Offline boot (network disabled) renders Geist with no fallback flash.
- [ ] Metrics/timestamps render in Geist Mono with tabular-nums (devtools computed-style spot checks).
- [ ] No generic curves remain in `index.css` animation/transition declarations: zero `ease-in-out`/`ease-in`/`ease-out` keywords and zero non-khal `cubic-bezier` values (khalEasing `[0.22,1,0.36,1]` and the overshoot spring `cubic-bezier(0.34,1.56,0.64,1)` are the only allowed curves).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && ls src/renderer/assets/fonts/*.woff2 && ! grep -rqE 'fonts\.googleapis|fonts\.gstatic' src/ && pnpm test
```

**depends-on:** group-2 (index.css serialization — decision at Execution Strategy; logically needs only group-1)

---

### Group 4: Element restyle sweep + status colors (group-4)

**Goal:** Element-level surfaces (badges, dots, cards, glass, diff/git colors) read as KHAL NATIVE per the reference, in place, no layout moves.

**Deliverables:**
1. Eyebrow/section labels restyled to PillBadge treatment (uppercase wide-tracking rounded-full) inside existing components.
2. Status indicators adopt StatusDot pulse+glow semantics; live states pulse.
3. Bespoke glass/backdrop/modal/sidebar classes (`index.css` ~750-1453) re-tinted onto KHAL surface layering; floating surfaces only get shadows/glass.
4. Diff editor / git status / PR badge colors remapped onto KHAL status tokens (`prStatusColors.ts`, monaco decorations, `--git-*` consumers); remaining stray hex normalized to tokens — current count in `src/renderer/components/**/*.tsx` is 16 by occurrence (the gate's own `grep -rhoE … | wc -l` metric): `components/terminal/TerminalSearch.tsx` 5 (xterm search-match colors), `components/terminal/TerminalPane.tsx` 5 (incl. a decorative non-KHAL `#00ff88` SVG gradient), `RemoteControlModal.tsx` 2, diffEditor 4 (`DiffEditor.tsx` 2 + `EditorPane.tsx` 2).

**Acceptance Criteria:**
- [ ] Anti-pattern sweep of touched surfaces: no rectangular badge-as-eyebrow, no decorative status colors, no raw grays.
- [ ] Total hardcoded hex across `src/renderer/components/**/*.tsx` ≤ 5 (down from the current 16; stragglers justified in-group) — `terminalThemes.ts` palettes excluded by path and owned by group-5.
- [ ] Layout intact on every touched component (before/after pairs).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && [ "$(grep -rhoE '#[0-9a-fA-F]{6}' src/renderer/components --include='*.tsx' | wc -l)" -le 5 ] && pnpm test
```

**depends-on:** group-2, group-3 (index.css serialization — decision at Execution Strategy; logically needs only group-2)

---

### Group 5: K dot-matrix loader + KHAL terminal palette (group-5)

**Goal:** The boot/loading experience shows the K dot-matrix Felipe loves, and terminals default to the KHAL ANSI palette.

**Deliverables:**
1. `KDotMatrix` component (13×14 `K_MATRIX`, `connecting-dot pulse/off` CSS, 0.07s row stagger) ported visual-only from the vendored source of truth at [`k-loader-reference.md`](../../brainstorms/khal-native-theme/k-loader-reference.md) (matrix values + CSS + JSX pattern in git; decision #10); loader CSS in its own file, not `index.css`; wired into dash's actual app-loading/initialization states (identify them first — dash has no network-connect phase; candidate: initial data load / project open / update-restart splash); pulse peak aligned to the imported `--khal-accent` token.
2. KHAL ANSI theme added to `terminal/terminalThemes.ts` (contract from `khal-tokens.css:94-121`) with `id` selectable in settings and set as default; `terminalFonts.ts` gains Geist Mono option consistent with group-3.

**Acceptance Criteria:**
- [ ] Loader visible on app boot (and any loading state chosen), pulsing in copper on `--khal-bg`.
- [ ] New terminal sessions open with the KHAL palette without user action; existing theme selection still honored if previously customized.
- [ ] No auth/retry logic from the source port present.

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && grep -rq 'K_MATRIX' src/renderer && grep -qi 'khal' src/renderer/terminal/terminalThemes.ts && pnpm test src/renderer/terminal
```

**depends-on:** group-2

---

### Group 6: QA evidence pack + live QA handoff (group-6)

**Goal:** Prove "theme only, fully KHAL" with evidence, then hand Felipe a live QA session on the HMR loop.

**Deliverables:**
1. Re-baselined test count (reviewer #4) recorded, full suite run green against it.
2. Before/after screenshot pairs for kanban, task view, terminal, diff editor, settings; structural-identity check.
3. Anti-pattern + Top-10 rubric sweep (KHALOS-DESIGN-REFERENCE) documented with pass/fail per item.
4. `git diff --stat khal/main..` proof of zero `src/main` changes.
5. Felipe live QA on the dock-app HMR loop; his verdict recorded as the final gate.

**Acceptance Criteria:**
- [ ] All Success Criteria checkboxes above evidenced (each with a command, screenshot, or Felipe confirmation).
- [ ] Suite green; zero `src/main` diff.
- [ ] Felipe pass recorded verbatim.

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && [ "$(git diff --stat khal/main.. -- src/main | wc -l)" -eq 0 ] && pnpm test
```

**depends-on:** group-2, group-3, group-4, group-5

---

## QA Criteria

_What must be verified on the live app after merge to fork main._

- [ ] Dock-launched app boots dark KHAL with the K loader, bundled Geist, copper selection — layout identical to pre-theme screenshots.
- [ ] Terminal opens with KHAL ANSI palette; agent hire/unhire flow (genie-ui-dash QA path) visually KHAL end-to-end.
- [ ] Existing behavior unbroken: HMR loop, kanban, diff editor, settings all functional; suite green; no `src/main` regressions.
- [ ] Offline boot (no network) shows no font flash and no CSS 404s.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@khal-os` Gitea registry credentials unavailable (dev box / Mac DMG build) | Medium | Group-1 proves the flow first and documents Mac steps; nothing else starts until it lands |
| `hsl(var())` triplet-format breakage | High | Decision #8: triplet-preserve default; reviewer verified `@theme` wraps every var — migration only with in-group justification |
| `@khal-os/ui` CSS vs Tailwind v4/PostCSS pipeline | Medium | Group-1 smoke test incl. `@source` directive check before dependent groups start |
| xterm/monaco/diff palette leaks | Medium | Groups 4+5 own explicit remaps; grep floor in G4 acceptance |
| khal-rebrand wish collision | Low | Branding OUT here; rebrand owns identity/icons |
| Perceptual "looks KHAL" acceptance | Low | Reference Top-10/anti-pattern rubric + Felipe live QA as the gate |
| Fork remote trap (local `main` tracks upstream) | Low | Branch `wish/khal-native-theme` tracks `khal/main`; server-side merge per standing workflow |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — round 1: FIX-FIRST (2026-07-23T17:08:07Z)

- **Reviewer:** genie:reviewer (plan-review, session 00dad3c5)
- **Verdict:** FIX-FIRST — design fidelity clean (all 4 design-review findings verified folded in; decision #8's `@theme` premise re-verified against the fork), but the validation harness was systematically non-gating.
- **Findings (11):** [High] bare `vitest` bypasses the repo's Electron test harness (native-module ABI failure); [High] `| tail` masked every exit code (group-4 passed unconditionally); [High] group-5 `grep -q` on a directory could never pass; [Medium] K-loader source existed only in an ephemeral session clone; [Medium] `legacy` is a terminal theme, not the light toggle — teardown mis-scoped; [Medium] wave-2 groups 2+3 both rewrote the same `index.css` block in parallel; [Low×4] path/portability/command nits; [Info] g3/g5 complexity undercounted.
- **Disposition:** all 11 addressed in-document (decisions #9–#11 added; loader source vendored to `.genie/brainstorms/khal-native-theme/k-loader-reference.md`; waves restructured with an `index.css` single-writer serialization rule g2→g3→g4; every validation now gates through `pnpm test`/`pnpm build:renderer` with no exit-masking).

### Plan review — round 2: SHIP (2026-07-23T17:14:06Z)

- **Reviewer:** genie:reviewer (plan-review, session 00dad3c5)
- **Verdict:** **SHIP** — "All eleven prior findings are closed with fixes verified against the code, the loader source is now vendored in git, the index.css single-writer serialization is real, and every validation command gates on a genuine nonzero-on-failure signal through the repo's actual Electron test harness. The plan remains design-faithful."
- Reviewer independently verified the group-4 hex gate counts 16 today and fails until remapped (a real gate).
- **Residual:** one [Info] finding — name the two high-count terminal-component hex files and refresh the stale "~27" baseline. Applied post-SHIP exactly as suggested (group-4 deliverable 4 + acceptance updated; no scope change).

**Status set to APPROVED by the invoking orchestrator (session 00dad3c5) on plan SHIP, 2026-07-23.**

---

## Files to Create/Modify

```
# khal-os/genie-desktop (fork)
.npmrc                                        # new — @khal-os scope → Gitea registry
package.json / pnpm-lock.yaml                 # @khal-os/ui dependency
src/renderer/index.css                        # token bridge, legacy deletion, motion, glass re-tint
src/renderer/App.tsx                          # theme-class logic simplification (dark-only)
src/renderer/main.tsx                         # font var wiring (if touched)
src/renderer/assets/fonts/*.woff2             # new — Geist + Geist Mono
src/renderer/components/KDotMatrix.tsx        # new — ported loader (visual only, from vendored k-loader-reference.md)
src/renderer/components/k-dot-matrix.css      # new — loader CSS in its own file (index.css stays 3-owner serialized)
src/renderer/terminal/terminalThemes.ts       # KHAL ANSI palette + default
src/renderer/terminal/terminalFonts.ts        # Geist Mono option
src/renderer/components/ui/*                  # element restyle (class-level only)
src/renderer/components/ui/prStatusColors.ts  # status color remap
src/renderer/components/diffEditor/*          # decoration color remap (renderer-side only)
src/renderer/components/settings/*            # hide light toggle, terminal theme default

# genie repo (this ledger only)
.genie/wishes/khal-native-theme/WISH.md
.genie/INDEX.md
```
