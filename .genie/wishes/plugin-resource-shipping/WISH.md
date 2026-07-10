# Wish: Plugin Resource Shipping — skills carry their own resources

| Field | Value |
|-------|-------|
| **Status** | DRAFT — plan review SHIP (2026-07-09, 2 fix loops; Hermes counter-read unavailable — logged, retry next gate) |
| **Slug** | `plugin-resource-shipping` |
| **Date** | 2026-07-09 |
| **Author** | Felipe (planned with Fable 5) |
| **Appetite** | small |
| **Branch** | `wish/plugin-resource-shipping` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/genie-token-efficiency-program/DESIGN.md) · [track DRAFT](../../brainstorms/plugin-resource-shipping/DRAFT.md) |

## Summary

A fresh plugin install breaks `/wish` outside the genie repo: the skill instructs `cp templates/wish-template.md` and `bun run wishes:lint`, both of which exist only in the genie repo's working tree (observed live on a fresh install, 2026-07-09). This wish makes skills self-contained — resources ship inside the skill dir addressed via `${CLAUDE_SKILL_DIR}` (the proven council pattern), repo-only commands go behind existence probes, and a lint + CI smoke make the regression class impossible.

## Scope

### IN

- Canonical wish template moves to `skills/wish/templates/wish-template.md`; `skills/wish/SKILL.md` scaffolds via `cp "${CLAUDE_SKILL_DIR}/templates/wish-template.md"`; repo-root `templates/wish-template.md` deleted and all tooling/doc references repointed.
- Dual-backend lint invocation: the in-skill structural checklist always applies; `bun run wishes:lint` invoked only behind the guard `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint` — in `skills/wish/SKILL.md` and the `skills/brainstorm/SKILL.md:85` reference.
- Resource-shipping lint rule in `scripts/skills-lint.ts`: skill files may not contain imperative repo-root resource references (`cp templates/…`, unguarded `bun run wishes:lint`, runtime instructions pointing at `scripts/*.ts`); skill-shipped files must be addressed via `${CLAUDE_SKILL_DIR}`/`${CLAUDE_PLUGIN_ROOT}`. Reference-content allowlist (e.g. genie-hacks catalog recipes) supported.
- Fresh-install CI smoke: script asserting (a) every `${CLAUDE_SKILL_DIR}` path referenced by any SKILL.md resolves inside that skill's dir, and (b) the wish scaffold flow works in a bare tmp git repo with no genie CLI and no repo-root resources; wired as a CI job step.
- Release-lag note in `plugins/genie/README.md`: installed plugin versions ride releases (`/plugin update` cadence), documented with the observed pin example.

### OUT

- Auto-update machinery for the marketplace clone or plugin cache (docs note only).
- Hook-contract fixtures and SessionStart rework (own wish: always-on-genie).
- Global↔repo lifecycle-skill convergence and dispatch-contract rewrite (own wish: control-plane-contract) — this wish edits the two offending references in place, no restructuring.
- `templates/genie-config.template.json` relocation (CLI-owned, ships with the CLI, stays at repo root).
- Any docs-site (`docs/` submodule) changes — the release-lag note lives in the plugin README, avoiding the submodule PR flow.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Template moves INTO the skill (single canonical home) rather than inlining into SKILL.md prose or double-homing | Council precedent (`${CLAUDE_SKILL_DIR}/templates/report.md`) proven in-repo; file stays diffable/lintable; inline would bloat the always-loaded body; two homes drift |
| 2 | Repo-only commands go behind an existence probe instead of being removed | Genie repo keeps its stricter CI linter as a bonus gate (dual-backend pattern already used by the work skill's `genie task --help` probe) |
| 3 | Enforce by lint + CI smoke, not by convention | 3 of 5 hook scripts already died silently by convention-drift; the sweep found offenders only because we looked — make the regression class mechanically impossible |
| 4 | Cross-wish dependency: Group 1 waits for routing-matrix G3 | routing-matrix (SHIP-reviewed) edits the same template file (Complexity/Model columns); land those first, then move the file — never reopen a reviewed wish |

## Success Criteria

- [ ] `skills/wish/templates/wish-template.md` exists (with routing-matrix's columns); repo-root `templates/wish-template.md` is gone; zero references to the old path outside `.genie/` history docs.
- [ ] No skill file contains `cp templates/` or an unguarded `bun run wishes:lint` (lint-enforced).
- [ ] `bun run skills:lint` fails on a fixture skill referencing a repo-root resource and passes on the repo.
- [ ] Fresh-install smoke passes: all `${CLAUDE_SKILL_DIR}` references resolve; wish scaffold works in a bare tmp repo without the genie CLI.
- [ ] CI runs the smoke; `plugins/genie/README.md` documents the release-lag/`/plugin update` cadence.

## Execution Strategy

### Wave 1

| Group | Agent | Complexity | Model | Description |
|-------|-------|-----------|-------|-------------|
| 1 | engineer | 3 (cross-wish coupling, prompt+file surface) | opus·high | Template move + probe-guarded lint refs |

### Wave 2 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|-----------|-------|-------------|
| 2 | engineer | 3 (lint rule + fixtures) | opus·high | Resource-shipping lint rule |
| 3 | engineer | 3 (CI wiring) | opus·high | Fresh-install smoke + README note |

## Execution Groups

### Group 1: Template move + probe-guarded references

**Goal:** The wish skill scaffolds and lints correctly in any repo, with the template shipped inside the skill.

**Deliverables:**
1. `templates/wish-template.md` → `skills/wish/templates/wish-template.md` (git mv, post routing-matrix G3 content).
2. `skills/wish/SKILL.md`: scaffold step uses `cp "${CLAUDE_SKILL_DIR}/templates/wish-template.md"`; **executable invocations** of `bun run wishes:lint` (bash fences / the handoff step) get the probe guard `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint`; descriptive prose mentions are reworded as genie-repo-only context, NOT probe-wrapped.
3. `skills/brainstorm/SKILL.md:85`: descriptive sentence reworded (genie-repo-only context) — it is prose, not an invocation. **Reword rule (applies to all prose edits in this group): paraphrase the literal tokens away** — "the genie repo's wish linter" instead of `` `bun run wishes:lint` ``, "copy the in-skill template" instead of `cp templates/…` — so G2's inline-code scan stays clean with zero per-file allowlisting.
4. `tests/e2e/v5-lifecycle.sh:156` repointed to `$REPO_ROOT/skills/wish/templates/wish-template.md` (required CI e2e consumer).
5. `skills/README.md:19` repointed (template path + guarded lint form).
6. Extension-agnostic sweep: ALL remaining references to the old repo-root path repointed (no `--include` filters — the `.sh` consumer proved filtered sweeps false-pass).

**Acceptance Criteria:**
- [ ] Template exists in-skill; repo-root copy deleted.
- [ ] Zero unguarded `bun run wishes:lint` in skill files; scaffold path uses `${CLAUDE_SKILL_DIR}`.
- [ ] `bun run wishes:lint` and `bun run check` green in the genie repo.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
test -f skills/wish/templates/wish-template.md || { echo "template not in skill"; exit 1; }
test ! -e templates/wish-template.md || { echo "repo-root template still present"; exit 1; }
grep -q 'CLAUDE_SKILL_DIR}/templates/wish-template.md' skills/wish/SKILL.md || { echo "scaffold not CLAUDE_SKILL_DIR-addressed"; exit 1; }
grep -nE '^\s*(bash )?bun run wishes:lint' skills/wish/SKILL.md skills/brainstorm/SKILL.md skills/README.md | grep -v 'grep -q' && { echo "unguarded executable lint invocation remains"; exit 1; }
grep -q 'cp templates/wish-template.md' skills/wish/SKILL.md && { echo "old bare cp form survives in wish skill"; exit 1; }
# git grep is tracked-only (auto-skips node_modules/.git and the .docs-vendor submodule);
# :(exclude) drops .genie history docs and the lint rule's own negative fixtures
# (skills-lint.test.ts intentionally ships bare `cp templates/...` strings) so the
# sweep stays replay-safe post-G2 while still catching a real stale old-path reference.
git grep -In 'templates/wish-template\.md' -- ':(exclude).genie/' ':(exclude)scripts/skills-lint.test.ts' | grep -v 'skills/wish/templates/wish-template.md' | grep -v 'CLAUDE_SKILL_DIR}/templates/wish-template.md' && { echo "stale old-path reference (any extension)"; exit 1; }
grep -rn 'REPO_ROOT/templates' tests/ && { echo "e2e still reads repo-root template"; exit 1; }
bun run wishes:lint || exit 1
bun run check || exit 1
```

**depends-on:** routing-matrix:3 (cross-wish — template column edits land before the move; note: replaying routing-matrix G3's one-time validation after the move would fail on the old path — expected, its persistent tooling is path-agnostic)

---

### Group 2: Resource-shipping lint rule

**Goal:** Skills referencing repo-root resources fail lint forever after.

**Deliverables:**
1. `scripts/skills-lint.ts` rule — scan surface: bash/sh fences AND inline-code spans (today's linter reads fences only — must widen); "guarded" discriminator: same-line presence of the package.json probe; flags: `cp templates/…`, unguarded `bun run wishes:lint`, runtime `scripts/*.ts` instructions; requires `${CLAUDE_SKILL_DIR}`/`${CLAUDE_PLUGIN_ROOT}` for skill-shipped file paths; path-based allowlist for reference content (genie-hacks catalog; skills/README.md NOT allowlisted — it gets fixed in G1).
2. `scripts/skills-lint.test.ts` fixtures: offending fixture fails, `${CLAUDE_SKILL_DIR}` fixture passes, allowlisted content passes.

**Acceptance Criteria:**
- [ ] Fixture with `cp templates/foo.md` in a SKILL.md exits non-zero.
- [ ] Repo passes the new rule post-Group-1.
- [ ] Allowlist keeps genie-hacks catalog green.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bun test scripts/skills-lint.test.ts || exit 1
bun run skills:lint || exit 1
```

**depends-on:** 1

---

### Group 3: Fresh-install CI smoke + release-lag note

**Goal:** A broken fresh install can never reach a release unnoticed.

**Deliverables:**
1. `scripts/fresh-install-smoke.ts`: (a) parse every `skills/*/SKILL.md` for `${CLAUDE_SKILL_DIR}` paths and assert each resolves within that skill dir; (b) create a bare tmp git repo, copy the plugin skill tree as an install would, execute the wish scaffold step (template copy + structural checklist) with no genie CLI on PATH and assert success; cleans up after itself.
2. CI step invoking the smoke in `ci.yml`'s `unit` job (alongside the existing skills:lint/wishes:lint steps — no new workflow file).
3. `plugins/genie/README.md`: release-lag section — installed versions pin to releases, `/plugin update` cadence, the 5.260703.5 example.

**Acceptance Criteria:**
- [ ] Smoke exits 0 on the repo; exits non-zero when a fixture SKILL.md references a missing `${CLAUDE_SKILL_DIR}` path (covered by its test).
- [ ] CI workflow contains the smoke step.
- [ ] README documents `/plugin update` + release lag.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bun run scripts/fresh-install-smoke.ts || exit 1
bun test scripts/fresh-install-smoke.test.ts || exit 1
grep -q 'plugin update' plugins/genie/README.md || { echo "README missing release-lag note"; exit 1; }
grep -rn 'fresh-install-smoke' .github/workflows/ | grep -q . || { echo "smoke not wired into CI"; exit 1; }
```

**depends-on:** 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: in a bare repo with the built plugin installed (or skill tree copied), `/wish` scaffolds a WISH.md from the in-skill template with zero missing-resource errors.
- [ ] Integration: genie repo CI green including the new smoke + lint rule; `bun run wishes:lint` still works in-repo via the probe path.
- [ ] Regression: existing wishes lint green; council/genie skills (already `${CLAUDE_SKILL_DIR}`-based) untouched and green.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| routing-matrix G3 lands late, blocking Wave 1 | Low | Cross-wish dep declared; groups 2-3 only depend on G1 internally, wish stays coherent whenever it starts |
| Lint rule false-positives on prose that mentions paths descriptively | Medium | Rule targets imperative patterns (`cp `, command invocations), not bare path mentions; allowlist for reference content; fixtures encode the boundary |
| Smoke script flaky in CI sandbox (tmp dirs, PATH) | Low | CLI-free by design; bun-only; tmpdir with cleanup (house test pattern) |
| `${CLAUDE_SKILL_DIR}` semantics differ for plugin-shipped vs user-dir skills | Medium | Smoke asserts resolution against the plugin tree layout; QA criterion 1 verifies live on an installed plugin |

---

## Review Results

**Plan review (2026-07-09): SHIP** after 2 fix loops. R1 FIX-FIRST: CRITICAL — repo-root template deletion would break the required CI e2e (`tests/e2e/v5-lifecycle.sh:156` consumer invisible to the extension-filtered sweep) + 3 MEDIUM (README consumer unplanned; invocation-vs-prose guard scope; G2 scan-surface underspec). R2: residual G1↔G2 self-contradiction → paraphrase rule; sweep hardening. R3: SHIP with one mechanical correction (raw-new-path content exclusion in the G1 sweep — applied to this document at gate close, reviewer-supplied line). **Hermes counter-read: UNAVAILABLE both attempts** (cegonha unreachable) — degradation policy applied, retry at execution review.

**Execution review (final gate fable·high, 2026-07-10): FIX-FIRST → SHIP after branch surgery.** All three groups landed with 0 fix loops each (engineers opus·high, reviewers opus·xhigh — first wish executed under the routing matrix); full repo gate exits 0 (773 pass / 1 skip / 0 fail) and all 5 Success Criteria proven with fresh gate-produced evidence: template ships in-skill with routing-matrix columns and the repo-root copy is gone; no `cp templates/` or unguarded wish-linter invocations in skill files; skills:lint enforces the resource rule (15/15 fixture tests incl. the must-fail case); fresh-install smoke resolves both `${CLAUDE_SKILL_DIR}` refs and scaffolds a wish in a bare repo with no genie CLI; CI runs the smoke and the release-lag note is live. The gate's only HIGH/MEDIUM findings were topology, not code: a concurrent session had switched the shared checkout to `wish/agent-sync`, so the group commits landed there and the template rename rode a foreign docs commit. **Surgery (orchestrator, evidenced inline):** branch rebuilt off origin/dev in an isolated worktree — G1 recreated with the R100 rename folded in (`ecbb67fc`: rename + exactly the 4 reference repoints), G3/G2 cherry-picked clean (`203c97df`, `bbd6439e`); tree vs the gate-validated tip differs only by the dropped foreign `.genie/agent-sync` docs and the newer dev version strings. QA watch items (LOW, follow-up): `fresh-install-smoke.ts` temp-dir cleanup is bypassed by `process.exit` on phase-b failures; G1's validation sweep is not replay-safe post-G2 (trips on the lint rule's own negative fixtures); G2's same-line guard discriminator is substring-based ("package.json" mention passes). Live installed-plugin scaffold QA (wish QA criterion 1) pending the next plugin release. **Hermes counter-read: cegonha still unreachable — fail-open applied (third consecutive gate), logged.**

---

## Files to Create/Modify

```
skills/wish/templates/wish-template.md          (moved from templates/)
templates/wish-template.md                      (deleted)
skills/wish/SKILL.md                            (scaffold path + probe guards)
skills/brainstorm/SKILL.md                      (prose reword, line 85)
skills/README.md                                (template path + guarded lint form)
tests/e2e/v5-lifecycle.sh                       (template path repoint — CI e2e consumer)
scripts/skills-lint.ts                          (resource-shipping rule)
scripts/skills-lint.test.ts                     (fixtures, new)
scripts/fresh-install-smoke.ts                  (new)
scripts/fresh-install-smoke.test.ts             (new)
.github/workflows/ci.yml                        (smoke step in unit job)
plugins/genie/README.md                         (release-lag note)
```
