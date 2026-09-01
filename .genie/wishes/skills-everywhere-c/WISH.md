# Wish: skills-everywhere — Wish C: skill-content lint + docs/CLAUDE.md/AGENTS.md rewrite

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `skills-everywhere-c` |
| **Date** | 2026-08-31 |
| **Author** | Felipe Rosa (orchestrated by Claude Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/skills-everywhere-c` |
| **Repos touched** | automagik-dev/genie (base `dev`) + automagik-dev/docs (via the `.docs-vendor` submodule) |
| **Design** | [DESIGN.md](../../brainstorms/skills-everywhere/DESIGN.md) |

## Summary

Third and last wish of the `skills-everywhere` umbrella (A → B → C). Wish A shipped the skills.sh channel and the host-side retirement; Wish B (`skills-everywhere-b`) repairs the install channel (local-path source, honest `agentDirs` recording, collision snapshot) and then deletes the Codex/Claude/Kimi/Hermes/pi integrations, all six hook handlers and `agent-sync.ts`. Wish C makes the *words* match that repo: it teaches `scripts/skills-lint.ts` to reject plugin-only agent names and undiscoverable skill directories, fixes the five skill files that still carry those tokens, rewrites `CLAUDE.md`/`AGENTS.md`/`README.md` down to "signed binary + `npx skills add automagik-dev/genie` + the Orca plugin", rewrites the public docs in the `.docs-vendor` submodule (installation bootstrap, doctor surface, uninstall semantics), and publishes a release-notes page naming the four capabilities the deletion accepts (design Risks 3–6). This wish satisfies design criteria C5 and C10; it deliberately changes no release workflow (C7 stays owned by Wish B).

**Every install-channel sentence this wish writes is a description of Wish B's merged code, never of this plan's reading of it.** The argv, the record shape and the doctor comparison below are transcribed from Wish B's Group 1 contract at authoring time; the executing agent re-reads `src/lib/skills-installer.ts` and `src/genie-commands/doctor.ts` on the merged `dev` and finalizes the wording from the code, not from this table. A divergence between B-as-merged and the text below is a Wish C bug, and B's code wins.

No production code path changes here. The only non-markdown edits are `scripts/skills-lint.ts` (+ its test), one explanatory comment in `src/lib/skills-installer.ts`, one drift test, one stale script docstring, and the docs-lint globs.

## Scope

### IN

- **`scripts/skills-lint.ts` token rule (design Decision 7).** Reject **BANNED-13** (Decision 8) as a **plain substring** — no word boundaries, no "used as an agent name" judgement call, no allowlist — anywhere under `skills/**`, in **every file the walk finds, `.md` and non-`.md` alike**: `SKILL.md`, `references/`, `templates/`, `README.md`, and `agents/openai.yaml` (Decision 10). Extends the existing gate — no parallel script, no new `check` entry.
- **`scripts/skills-lint.ts` structure rules.** A top-level directory under `skills/` with no `SKILL.md` at its root is an error ("empty skill dir"); a `SKILL.md` at depth ≥ 2 (`skills/<a>/<b>/SKILL.md`) is an error ("nested skill dir — skills.sh does not discover it, and `--full-depth` collides with the top-level name"). Today `main()` silently `continue`s past both (`scripts/skills-lint.ts:336-337`).
- **The five files that carry BANNED-13 today** (measured on `dev` @ `df45bde28`, 2026-08-31 — 13 hits): `skills/work/SKILL.md` (7, lines 56–62 role table), `skills/wish/templates/wish-template.md` (2, lines 66–67 routing rubric), `skills/README.md` (2, lines 8 and 12 `$genie:` selectors), `skills/trace/SKILL.md` (1, line 40 `genie_scout`), `skills/genie-hacks/references/catalog.md` (1, line 141 `engineer-trivial`). All re-worded to the **BANNED-13 → portable-role mapping** in Decision 8.
- **Two `genie_*` runtime-profile sentences that the rule does not catch but the vocabulary decision does**: `skills/work/SKILL.md:52` ("the matching `genie_*` custom-agent profile when the runtime has one installed") and `skills/wish/templates/wish-template.md:69` ("such as the `genie_*` profiles where installed"). Neither matches BANNED-13 as a literal, and neither is added to it (`genie_*` with a glob would over-match nothing useful); both are re-worded by hand so the two files do not half-adopt the new vocabulary.
- **`skills/work/SKILL.md` states the git-state freeze and the branch rule as operator policy**, with no claim that any hook, guard or dispatch layer enforces them after Wish B.
- **A `SKILLS_CLI_VERSION` comment** at `src/lib/skills-installer.ts:52` tying every bump to a re-audit of `KNOWN_AGENT_SKILL_HOMES` (umbrella review non-blocking note).
- **`CLAUDE.md` + `AGENTS.md` + root `README.md` rewrite** to the post-deletion world, plus their drift guard `src/__tests__/claude-md-drift.test.ts`. Root `README.md` carries **7 RETIRED-9 lines** (measured on `dev` @ `df45bde28`: 30, 32, 171, 201, 219, 241, 248 — the `--integrations` delivery paragraph, the `genie init` → `genie setup --codex` bootstrap paragraph, the `setup` command-table row, the role-agent CLI-integration row, the `~/.agents/skills` quarantine paragraph, the "restart Codex … review with `/hooks`" paragraph, and the `genie@automagik` verification line). It is the most-read operator surface in the repo and was missing from the plan entirely; it joins the C10-repo grep pathspec.
- **Public docs in `.docs-vendor` (automagik-dev/docs)**: `installation.mdx` bootstrap rewrite (drop the Claude marketplace step), `genie doctor` skills lines, `genie uninstall` semantics, and a **new release-notes page** listing design Risks 3–6 as accepted behavior changes. Merged to docs `main`, then the genie superproject `.docs-vendor` pointer is bumped.
- **Docs-lint coverage** for the new page (`lint:docs-markdown`, `lint:docs-links`, `.github/workflows/docs-lint.yml` paths) and a CI-side retired-terminology assertion over `docs/` where the submodule is guaranteed checked out.

### OUT

- **Any release-workflow change.** `release-publish.yml`, `skills-install-smoke`, `release-update-path-smoke`, `musl-adapter-smoke.yml` are owned by Wish B (design C7). This wish asserts a zero diff on them.
- **The genie-orca skill rename.** Already landed in PR #2870 as top-level `skills/genie-orca-wish`, `skills/genie-orca-work`, `skills/genie-orca-review`, each with its own `agents/openai.yaml`. Wish C only lints and documents them; it does not move, merge or re-name a skill directory.
- **Any deletion of source, plugin, hook or workflow code.** All of it belongs to Wish B; if a retired file still exists when C starts, C is blocked, not extended.
- **Skill behavior changes.** Re-wording is terminology-only: no step, gate, ordering or acceptance rule inside any skill changes meaning.
- **`.genie/wishes/**` and `.genie/brainstorms/**` prose.** Historical records may quote retired role names; the token rule is scoped to `skills/**`.
- **Project-scoped skill installs, skill signing, per-agent docs pages.** Deferred by the design.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Extend `scripts/skills-lint.ts`; never add a second skills gate — and reuse `scanRepoSkills` from `scripts/skills-inventory-parity.ts` for the structure rules rather than re-implementing them | The gate already walks `skills/**`, already owns the `<!-- skills-lint:ignore -->` bailout and the `SKILLS_LINT_DIR` fixture hook, and is already wired into `check`. A parallel script would double the surface and split the ignore semantics. Separately, the nested/empty detection this wish wants **already exists**: `scanRepoSkills` (`scripts/skills-inventory-parity.ts:182`, exported) already reports directories without a top-level `SKILL.md` and `SKILL.md` nested deeper than `skills/<name>/SKILL.md` (plus symlink and name-pattern checks), and its results are already CI-gated by the `skills-inventory-parity` job. Re-deriving that walk inside `skills-lint` would create two implementations of one contract that can disagree. Group 1 **imports** it. |
| 2 | The token rule has **no** allowlist — `RESOURCE_ALLOWLIST_SEGMENTS` (`genie-hacks`) and the `README.md` exemption stay scoped to the *resource-path* rule only | Those exemptions exist because catalog/recipe prose may quote repo-root command recipes verbatim. A hack recipe that names a deleted agent profile misleads exactly as much as an executable skill does — Risk 7 is "skills referencing plugin-only agents degrade silently", and a recipe is copied, not read. |
| 8 | **The role vocabulary is replaced, not conditionally permitted.** BANNED-13 is banned as a plain substring everywhere under `skills/**`; the replacement names are fixed by the mapping table below | The first draft tried to have it both ways — ban `engineer-trivial` as "an agent/role name" while the role table and the wish template kept using it as exactly that. A substring ban with a fixed replacement set is the only rule a `grep -F` can prove, and "used as a role name" is not a property a lint can decide. The three tier names change because their old spellings are the banned substrings; `reviewer`, `fixer`, `final-gate` and `scout` keep their names because only the `genie_*` runtime-profile spellings were ever banned. |
| 9 | The token rule runs **before and independently of** the `<!-- skills-lint:ignore -->` bailout — an ignored file is still token-scanned | The bailout exists so a file may show a repo-root command fence the resource rule would reject (`scripts/skills-lint.ts:348` `continue`s past the whole file). Retired vocabulary is not a false positive anyone should be able to opt out of: an ignore marker added for a command fence would silently disable the vocabulary contract for that file. No file under `skills/` carries the marker today, so this costs nothing now and closes the hole permanently. |
| 10 | The token scan covers **non-`.md` files** under `skills/`, not just markdown | The 22 (post-#2870: 25) `agents/openai.yaml` starter prompts are shipped skill content that an agent reads and acts on, and `skills/README.md:12` documents them as the surface most at risk of naming a selector. They carry zero BANNED-13 hits today (`git grep` over `skills/`, non-`.md` files: empty), so extending the walk is free now and prevents the obvious regression later. Restricting the rule to `.md` would have been a documented exemption with a known hole; there is no reason to accept it. |
| 11 | The docs-side retired-term gate accepts a **between-bumps regression window** | The CI assertion reads `docs/` at the pinned `.docs-vendor` commit, so a violation landed on docs `main` after the last pointer bump is invisible to genie CI until the next bump. Closing it would mean genie CI fetching docs `origin/main` on every run — a cross-repo network dependency in a required gate, for a class of regression the docs repo's own lint should catch. Accepted and recorded here rather than left implicit. |
| 3 | Nested/empty detection keys on `SKILL.md` placement, not on directory names | `skills/*/references/` and `skills/*/templates/` are legitimate and carry no `SKILL.md`. Depth-≥2 `SKILL.md` is exactly the failure mode Risk 12 describes (the pre-#2870 `skills/genie-orca/{wish,work,review}` shape), and a top-level dir with no root `SKILL.md` is exactly the untracked-`skills/quick` shape. |
| 4 | `src/__tests__/claude-md-drift.test.ts` is owned by **Group 2**, not Group 4 | The test asserts CLAUDE.md/AGENTS.md content (today including `plugins/genie/references/native-surfaces.md`, a file Wish B deletes). Splitting the content edit from its guard would leave Group 2 red at its own validation command and violate "test alongside implementation". Group 4 keeps the surfaces the drift test cannot reach: the docs submodule and the lint globs. |
| 5 | The docs release-notes page is written for operators, not as a changelog entry | Risks 3–6 remove capabilities a user may be relying on (remote Omni approval, stale-wish warnings). Each entry states what is gone, what still works, and the replacement action — a bare "removed" line would generate support load. |
| 6 | The docs change ships as its own PR to automagik-dev/docs, with the superproject pointer bump as a separate commit | The documented workflow in `CLAUDE.md`; docs `main` is shared with other genie docs work (PRs docs#79/#80 landed there out of band), so re-reading docs `main` before writing is mandatory. |
| 7 | Wish C is gated on `skills-everywhere-b` being merged to `dev`, not merely approved | Every sentence this wish writes describes a repo state that only exists after B's deletion. Documenting a world that has not landed is the exact failure Risk 11 warns about, inverted. |

### Named lists (referenced verbatim; defined once)

**RETIRED-9** — the retired-terminology token list. Every grep in this wish that "checks for retired terms" uses exactly these nine, in this order, and no other set:

```
setup --codex   agent-sync   H3/H4/H6   .curated   LENS_ROOT
CLAUDE_PLUGIN_ROOT   genie@automagik   council.js   hook dispatch
```

As one regex: `setup --codex|agent-sync|H3/H4/H6|\.curated|LENS_ROOT|CLAUDE_PLUGIN_ROOT|genie@automagik|council\.js|hook dispatch`. The docs-facing greps (Group 3, Group 4) additionally carry **`plugin marketplace add`** — a docs-only bootstrap step with no counterpart in the repo — and that addition is the *only* permitted deviation from RETIRED-9.

**BANNED-13** — the skills-content vocabulary ban, matched as plain substrings:

```
genie_engineer_trivial   genie_engineer_standard   genie_engineer_complex
genie_reviewer   genie_fixer   genie_final_gate   genie_scout
engineer-trivial   engineer-standard   engineer-complex
$genie:   CLAUDE_PLUGIN_ROOT   LENS_ROOT
```

**BANNED-13 → portable-role mapping** (Decision 8). Every rewrite in Group 1 uses the right-hand column and nothing else:

| Retired token(s) | Portable role name | Where it appears today |
|------------------|--------------------|------------------------|
| `engineer-trivial`, `genie_engineer_trivial` | `implementor-low` | `work/SKILL.md:56`, `wish-template.md:66`, `genie-hacks/references/catalog.md:141` |
| `engineer-standard`, `genie_engineer_standard` | `implementor-mid` | `work/SKILL.md:57`, `wish-template.md:66` |
| `engineer-complex`, `genie_engineer_complex` | `implementor-high` | `work/SKILL.md:58`, `wish-template.md:67` |
| `genie_reviewer` | `reviewer` | `work/SKILL.md:59` |
| `genie_fixer` | `fixer` | `work/SKILL.md:60` |
| `genie_final_gate` | `final-gate` | `work/SKILL.md:61`, `wish-template.md:67` |
| `genie_scout` | `scout` | `work/SKILL.md:62`, `trace/SKILL.md:40` |
| `$genie:<name>` selectors | skills.sh discovery (`$wish`, `$work`, a bare name, or natural language) | `README.md:8`, `README.md:12` |

`reviewer`, `fixer`, `final-gate` and `scout` are **not** in BANNED-13 and need no rename — only their `genie_*` runtime-profile spellings are banned, so the parenthetical is deleted and the bare name stays. `.genie/wishes/**` and `.genie/brainstorms/**` are historical records and exempt (Scope OUT); this wish's own Execution Strategy therefore keeps the pre-rename spellings in its Model column.

## Simplicity Case

- **Simplest complete design:** one existing lint gains one new rule family (the token rule) and **imports** the structure checks that `scanRepoSkills` already implements; five markdown files, three contract files (`CLAUDE.md`, `AGENTS.md`, root `README.md`) and their one drift test are corrected; the public docs get one rewrite plus one new page. No new script, no new `check` entry, no new CI job, no production code path.
- **Machinery deliberately NOT added:** a second nested/empty skill-directory walk. `scanRepoSkills` already does it and is already CI-gated; Group 1 imports the exported function rather than re-deriving the contract (Decision 1). The only genuinely new logic in `skills-lint.ts` is a substring scan.
- **Added machinery:** the `docs/`-scoped retired-terminology grep in `.github/workflows/docs-lint.yml` (Group 4) — pays for C10 remaining true after this wish, in the one place where the `.docs-vendor` submodule is guaranteed checked out (`actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5`, the SHA-pinned action the repo already uses in `docs-lint.yml:51,72` and throughout `ci.yml`, with `submodules: recursive`). It is deliberately **not** a local `check` gate: a contributor with an unpopulated submodule would see a false failure. Its blind spot is recorded as Decision 11.
- **Deferred until measured:** a generalized "retired vocabulary" lint over the whole repo — the three surfaces that matter each already have an owner (skills-lint, the drift test, docs-lint); a fourth abstraction over them buys nothing until a fourth surface appears. Per-agent installation pages — until an agent home needs instructions the shared page cannot carry. Machine-checked skill-prose review — until a token rule proves insufficient.
- **Complexity removed:** eight plugin-era gotcha blocks in `CLAUDE.md`, seven plugin-era passages in root `README.md`, and five plugin-era lines in `AGENTS.md` (two delivery/activation owner contracts, a hook-trust matrix, a fallback-retirement rule, a stamp-root rule, a `.curated` rule, a SessionStart parity gate); one contradictory bootstrap path in `installation.mdx`; and the silent-pass branches in `skills-lint`'s directory scan.

## Dependencies

**depends-on:** skills-everywhere-b
**blocks:** none

Wish C **starts after Wish B is merged to `dev`** (Decision 7), not after B is approved: every sentence this wish writes describes a repo state B creates. Wish B's own pre-condition **P2** (Wish A released stable) gates B's deletion waves, so C's start is transitively behind that release too — C is not schedulable until B's wave 6 lands. Inside C, Group 3's docs-PR **merge** is a human-gated external dependency in `automagik-dev/docs` (see the Execution Strategy note); Group 4 inherits it.

**Bookkeeping:** `.genie/INDEX.md` currently carries one umbrella entry (line 21) naming only the design and Wish A. This wish adds Wish B and Wish C to it. The umbrella's roadmap cards already exist in `genie.db` (created out of band, `t_mthed3*`); they are not present in this base's `.genie/roadmap.json` snapshot, so no card needs creating — `genie task sync` reconciles the snapshot, and Wish C creates no new cards.

## Success Criteria

- [ ] **C5-tokens** (design C5) — `bun run skills:lint` fails with a non-zero exit and a path-naming message on every BANNED-13 token, proven by one negative fixture per token family under `SKILLS_LINT_DIR`; the repo's own `skills/` passes.
- [ ] **C5-structure** (design C5) — the same gate fails on a nested `skills/<a>/<b>/SKILL.md` and on a top-level skill dir with no root `SKILL.md`, each proven by a negative fixture.
- [ ] **C5-vocabulary** (design C5, Decision 8) — `git grep -F -n -e genie_engineer_trivial -e genie_engineer_standard -e genie_engineer_complex -e genie_reviewer -e genie_fixer -e genie_final_gate -e genie_scout -e engineer-trivial -e engineer-standard -e engineer-complex -e '$genie:' -e CLAUDE_PLUGIN_ROOT -e LENS_ROOT -- skills/` returns nothing (baseline: 13 hits across 5 files). Plain substrings, no regex, no `-E`, no allowlist.
- [ ] **C5-policy** (design C5) — **positive** assertion: `skills/work/SKILL.md` contains the new policy sentence, provable by `grep -F -q 'operator policy carried in briefs and AGENTS.md, enforced by server-side branch protection on `main` and by nothing client-side' skills/work/SKILL.md`. The exact sentence Group 1 writes is quoted verbatim in Group 1 deliverable 3 and in this criterion, and the two must match. The former negative grep (`mechanically enforced|enforced by a hook|blocked by (the )?guard`) is retained only as a **secondary** check — it returns nothing on today's `skills/` too, so on its own it proves nothing about whether the sentence was ever added.
- [ ] **C10-repo** (design C10) — `git grep -nE 'setup --codex|agent-sync|H3/H4/H6|\.curated|LENS_ROOT|CLAUDE_PLUGIN_ROOT|genie@automagik|council\.js|hook dispatch' -- CLAUDE.md AGENTS.md README.md skills/` (RETIRED-9 over four pathspecs, root `README.md` included) returns nothing; the empty result is pasted into Review Results. Baselines on `dev` @ `df45bde28`: `CLAUDE.md` 11 hits, `AGENTS.md` 0 regex hits (its fossils are the separate list in Group 2 deliverable 5), `README.md` 7 hits, `skills/` 0.
- [ ] **C10-docs** (design C10) — RETIRED-9 **plus `plugin marketplace add`** over `docs/` (submodule populated at the bumped pointer) returns nothing; Mintlify docs-lint green on the docs PR. Baseline on the pointer at authoring: **27 hits across 10 files** (Group 3 carries the enumerated worklist).
- [ ] **C10-notes** (design C10) — a release-notes page exists in the docs site, reachable from the navigation, listing design Risks 3–6 (branch-guard, git-freeze-guard, Omni in-session approvals, SessionStart context injection) each with its replacement action.
- [ ] **C7-untouched** (design C7 note) — `git diff --stat origin/dev...HEAD -- .github/workflows/release-publish.yml .github/workflows/musl-adapter-smoke.yml` is empty. Release-gate composition is Wish B's criterion; this wish neither adds nor removes a gate.
- [ ] **genie-orca parity** — `skills/genie-orca-wish`, `skills/genie-orca-work`, `skills/genie-orca-review` each pass the new rules unchanged, each has `SKILL.md` + `agents/openai.yaml`, and the parity script lists all three, run in the **`ci.yml` form** (`.github/workflows/ci.yml:258-270`), which is the only invocation that exists:
  ```bash
  npx -y skills@1.5.23 add "$PWD" --list > /tmp/skills-list.txt \
    && bun scripts/skills-inventory-parity.ts --repo . --list-file /tmp/skills-list.txt
  ```
  The script takes the CLI's `--list` output on stdin or via `--list-file`; `bun scripts/skills-inventory-parity.ts` with no list is not a valid invocation and must not appear anywhere in this wish. The `"$PWD"` local-path source mirrors Wish B G1's local-source switch (B G1 deliverable 6 owns making CI use it).
- [ ] **No behavior drift** — `bun run check` green on the final branch; `bun run wishes:lint` green over every wish (the `skills/wish/templates/wish-template.md` structural contract is unchanged).
- [ ] **Pointer bumped** — `git submodule status .docs-vendor` resolves to a commit that is an ancestor of docs `origin/main`.

## Execution Strategy

**Schedule gate — Wish C does not start until Wish B is merged to `dev`.** This is Decision 7 and the `depends-on` below, restated where the waves are read: Wave 1 does not open on approval of this plan, it opens on B's merge commit landing on `dev`. Every group rebases onto that `dev` (which must also contain PR #2870) before its first edit, and Group 2 and Group 3 transcribe the install-channel contract from B's merged `src/lib/skills-installer.ts`, not from this document.

### Wave 1 (parallel — disjoint file sets; opens after `skills-everywhere-b` is merged to `dev`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 (+1 prompt-skill change, +1 prior rework — the token list already failed one review round in the umbrella) | `engineer-standard` / medium | skills-lint token rule + imported structure checks, the five skill-content fixes, the two `genie_*` sentences, the `SKILLS_CLI_VERSION` comment, the parity-script docstring |
| 2 | engineer | 2 (+1 prompt-skill change, +1 no deterministic test beyond the drift guard the group itself writes) | `engineer-standard` / medium | CLAUDE.md + AGENTS.md + root README.md rewrite and their drift guard |
| 3 | engineer | 5 (+1 multi-package — genie + docs submodule, +1 CI/release-adjacent, +1 no local deterministic test for Mintlify, **+2 subjective acceptance** — an operator-facing release-notes page and a rewritten install page whose correctness is judged by reading, not by a gate) | `engineer-complex` / high | Public docs rewrite (10 files, 27 hits) + release-notes page in `.docs-vendor`, docs PR, pointer bump |

**Group 3 carries a human-gated external dependency inside its own wave.** Deliverables 1–5 are agent work; the docs PR **merging** into `automagik-dev/docs` `main` is a human review-and-merge in a repository this wish cannot merge into, and deliverable 6 (the superproject pointer bump) is blocked on it. Group 3 therefore does not "complete" in one agent pass: it completes, pauses at the open PR, and resumes for the pointer bump after a human merges. Group 4 depends on Group 3 and inherits that pause. Plan the wave for it rather than treating a stalled Group 3 as a failure.

### Wave 2 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 2 (+1 CI work, +1 no deterministic local test for a workflow edit) | `engineer-standard` / medium | Docs-lint globs + workflow paths + the CI retired-term assertion; full `bun run check` |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Each runtime maps
these to its matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: skills-lint rules + skill-content corrections

**Goal:** Make `scripts/skills-lint.ts` mechanically reject plugin-only agent names and undiscoverable skill directories, and correct every skill file that currently trips the new rules.

**Deliverables:**
1. **Token rule** in `scripts/skills-lint.ts`, applied to **every file** the existing `walk()` finds under `SKILLS_DIR` — `.md` and non-`.md` alike, so `agents/openai.yaml` is in scope (Decision 10) — matching each of **BANNED-13** as a plain substring (`String.includes`, not a regex; no word boundaries). Each violation reports `<path>:<line>` plus the offending token and the mapped replacement from the BANNED-13 → portable-role table ("name the portable role `implementor-mid`, not the runtime profile `genie_engineer_standard`"). No allowlist (Decision 2) — do not route this through `isResourceAllowlisted`. The scan runs **before** the `<!-- skills-lint:ignore -->` early-`continue` at `scripts/skills-lint.ts:348`, so an ignored file is still token-scanned (Decision 9); restructure that loop so the bailout skips only the command/resource checks.
2. **Structure rules by import, not re-implementation** (Decision 1). Import `scanRepoSkills` from `scripts/skills-inventory-parity.ts:182` and surface its already-computed findings as `skills-lint` errors, replacing the silent `continue` at `scripts/skills-lint.ts:336-337`: (a) a top-level entry that is a directory but has no root `SKILL.md` → error `empty skill dir`; (b) any `SKILL.md` at depth ≥ 2 → error `nested skill dir`, naming the top-level dir it hides under and the fix (a uniquely named top-level directory). Do **not** write a second walk. If `scanRepoSkills`'s shape needs a small widening (e.g. it must accept the `SKILLS_LINT_DIR` fixture root rather than a repo root), widen the exported function and keep one implementation; `scripts/skills-inventory-parity.test.ts` must stay green.
3. `skills/work/SKILL.md` — (a) rewrite the role table (lines 56–62) to the **BANNED-13 → portable-role mapping**: `implementor-low`, `implementor-mid`, `implementor-high`, `reviewer`, `fixer`, `final-gate`, `scout`, each as a bare name with the runtime-profile parenthetical deleted; (b) rewrite line 52 so it no longer promises a `genie_*` custom-agent profile — the runtime's native named-role surface is the only mechanism after Wish B; (c) add this sentence, **verbatim**, to the shared-workspace paragraph and to the freeze block quoted into every brief (it is the string the C5-policy criterion greps for):

   > The git-state freeze and the "agents merge to `dev`; `main` is humans-only" rule are operator policy carried in briefs and AGENTS.md, enforced by server-side branch protection on `main` and by nothing client-side.

   D3 is **additive**: nothing in the freeze block is removed, and the block stays verbatim-quotable.
4. `skills/wish/templates/wish-template.md` — routing rubric (lines 66–67) re-worded to `implementor-low` / `implementor-mid` / `implementor-high` / `final-gate`, and line 69's "(such as the `genie_*` profiles where installed)" deleted. The structural contract (`# Wish:` title, the `##` section list, the `### IN`/`### OUT` subsections, the `### Group N:` heading shape, `**Acceptance Criteria:**` and `**Validation:**` markers, the `- [ ]` checkbox shape) is byte-identical in meaning — `parseWishTemplateContract` reads this file as the single source of truth.
5. `skills/README.md` lines 8 and 12 — describe skill invocation as skills.sh discovery (`$wish`, `$work`, bare names or natural language) instead of `$genie:<name>` plugin selectors; keep the point that `agents/openai.yaml` starter prompts are selector-free. Note that line 12 is itself the sentence that explains why a selector inside a starter card is dangerous — it must survive the edit as a reason, not be deleted with the token.
6. `skills/trace/SKILL.md` line 40 — drop the `genie_scout` profile reference, keep "a fresh read-only `scout` role on the active runtime".
7. `skills/genie-hacks/references/catalog.md` line 141 — the recipe comment names `implementor-low`, not `engineer-trivial`.
8. `src/lib/skills-installer.ts` — extend the `SKILLS_CLI_VERSION` comment (`:51-52`): bumping the pin requires re-verifying `KNOWN_AGENT_SKILL_HOMES` and the post-install discovery scan against what the new CLI writes, because the homes table is Genie-owned and the CLI's discovery is not. **Also fix the stale count** in the `SKILLS_INSTALL_TIMEOUT_MS` comment at `:60-61` ("npm download + 22 skills across every detected agent home"): 22 is the pre-#2870 top-level inventory, and Wish B measured a local-path source producing **25**. Re-measure `ls -d skills/*/ | wc -l` on the merged `dev` and write that number, or drop the literal count in favour of "the full inventory".
9. `scripts/skills-inventory-parity.ts` — update the **stale header docstring** (`:5-8`, `:14-15`). It still documents the published inventory as `skills@<PINNED> add automagik-dev/genie@<ref> --list`, which Wish B G1 proved is a fiction (the `@<ref>` suffix is ignored; the CLI's third capture binds to `skillFilter`, and the default branch is served). Rewrite it to the local-source form actually used by `ci.yml:256-268` after B, and state the ref caveat in one line so the next reader does not re-derive it.
10. `scripts/skills-lint.test.ts` — fixtures via `SKILLS_LINT_DIR`: one negative fixture per BANNED-13 token, one negative fixture placing a banned token in a non-`.md` file (`agents/openai.yaml`), one negative fixture placing a banned token in a file that also carries `<!-- skills-lint:ignore -->` (proving Decision 9), one nested-`SKILL.md` fixture, one empty-skill-dir fixture — each asserting a non-zero exit **and** the specific message; plus one positive fixture proving legitimate prose (`genie task checkout`, `bun run check`, the word "engineer" standing alone, the words "reviewer", "fixer", "final-gate", "scout") still passes.

**Acceptance Criteria:**
- [ ] `bun run skills:lint` exits 0 against the repo's own `skills/`, including `skills/genie-orca-{wish,work,review}` and every `agents/openai.yaml`.
- [ ] **C5-vocabulary's plain-substring grep** (Success Criteria) returns nothing over `skills/` — 13 hits → 0.
- [ ] Every BANNED-13 token and both structure rules have a failing fixture; each asserts the exit code **and** the message text. The non-`.md` fixture and the `skills-lint:ignore` fixture both fail.
- [ ] `skills/work/SKILL.md` contains the policy sentence **verbatim** as quoted in deliverable 3, provable by `grep -F`; the freeze paragraph quoted into briefs still reads as a verbatim-quotable block and lost nothing.
- [ ] `bun test scripts/skills-inventory-parity.test.ts` green — the imported `scanRepoSkills` still satisfies its own contract.
- [ ] `bun run wishes:lint` green over every wish after the template edit — the structural contract still parses.
- [ ] No skill's steps, ordering, gates or acceptance rules changed meaning; only role vocabulary.

**Validation:**
```bash
bun run skills:lint \
  && bun test scripts/skills-lint.test.ts scripts/skills-inventory-parity.test.ts \
  && bun run wishes:lint \
  && bun run lint
```

**depends-on:** none (within Wish C; the whole wish is gated on `skills-everywhere-b` merged to `dev`)

---

### Group 2: CLAUDE.md + AGENTS.md + README.md rewrite and drift guard

**Goal:** Reduce all three contract files to the world Wish B leaves behind — signed binary, `npx skills add automagik-dev/genie`, the Orca plugin — and make the drift test enforce it.

**Deliverables:**
1. `CLAUDE.md` — delete the plugin-era gotchas: "Codex ships exactly H3/H4/H6", "Hook dispatch is provider-aware and fail-closed", the `AskUserQuestion` PreToolUse carve-out, "Codex delivery and activation have separate mutation owners", "`.codex/skills/.curated` is a legacy uninstall-only lane", "Generated SessionStart parity is a release gate", "One stamp root, never CLAUDE_PLUGIN_ROOT-primary". Rewrite (do **not** delete) "Post-delivery convergence is an argv-only handoff" — the binary's argv protocol survives Wish B; only the `genie setup --codex` second hop leaves. Rewrite the Codex-OTel gotcha to point at the retirement module Wish A shipped.
2. `CLAUDE.md` — the itemized non-gotcha hits, all six, measured on `dev` @ `df45bde28`:
   - **`:64` and `:66`** — the `src/hooks/` architecture-tree rows ("Provider-neutral Claude/Codex hook dispatch and wire adapters"; "`dispatch-command.ts` CLI entry: `genie hook dispatch`"). Wish B G4 deletes `src/hooks/**`; both rows leave the tree.
   - **`:75`** — "**Sixteen** top-level commands" → **fifteen** (`hook` leaves the surface).
   - **`:82`** — the `hook` row in the commands table ("Hook middleware for Claude Code (`genie hook dispatch` runs in-process)") → deleted.
   - **`:88`** — the `setup` row: drop the `setup --codex` clause (it keeps the Orca `--orchestration-mode` surface only).
   - **`:143` and `:144`** — the `GENIE_AGENT_NAME` ("Agent identity for hook dispatch") and `GENIE_AGENT_ID` ("Agent id used by hook identity injection") env rows. The variables survive Wish B and still configure the CLI; only their *descriptions*, which name a deleted hook subsystem, are rewritten. Do not delete the rows.
   - **`:186`** — the Orca subtree gotcha's version-file count ("the `version.yml` JSON_FILES list (still **nine** version files)"). Wish B G6 reduces the stamped set to `package.json` + `plugins/genie/{package.json,orca-plugin.json}`. **Coordinate with Wish B**: B's Decision 12 permits the minimum CLAUDE.md edits a test or lint forces, so B may already have corrected this line. Read it on merged `dev` first; if B fixed it, assert it and move on — do not re-edit it to a different number.
3. `CLAUDE.md` new gotchas, four, each with the fact that makes it actionable. **The first is transcribed from Wish B G1's merged code, not from this plan** (see Summary):
   - **skills.sh is the one skills channel** — `genie install` / `genie update` run the pinned skills CLI against the **local delivered tree**, not a GitHub ref: `npx -y skills@<SKILLS_CLI_VERSION> add <local source root under $GENIE_HOME> --all --copy -g`. There is **no** `automagik-dev/genie@v<ver>` argument (Wish B G1 Decision 1: `skills@1.5.23` ignores an `@<ref>` suffix and serves the repository's default branch, so the only genuinely pinned source is the signed tarball's own bytes), and there is **no second `-y` after `--copy`** (the one `-y` is npx's). The record written to `$GENIE_HOME/skills-install.json` after a zero exit is `{ref, cliVersion, inventory[], agentDirs[], source, collisions, installedAt}`, where `ref` stays the delivered binary's release tag, `source` is `local:<abs root>`, and `agentDirs` comes from the **post-install `$HOME` discovery scan** unioned with the known-home floor — *not* from the four-row `KNOWN_AGENT_SKILL_HOMES` table, which under-reported 57 real homes as 4 on the dogfood host. `genie doctor` compares the recorded set against what it discovers now. **Finalize every literal in this bullet — the exact argv, the exact field names, the optionality of `source`/`collisions`, and the doctor comparison — by reading `src/lib/skills-installer.ts` and `src/genie-commands/doctor.ts` on the merged `dev`; B's code is authoritative and this text is a transcription target, not a specification.**
   - **The retirement window is `>= 5.260711.6`** — the legacy-integration retirement only removes marker-owned assets produced by releases at or after the post-two-hop contract; older hosts follow the documented manual steps, and the module is deleted two stable releases after Wish B.
   - **`--all` writes every supported home** — the accepted consent widening: `~/.agents/skills` **is** the Codex home (`.codex/skills` and `.cursor/skills` are deliberately absent from the table, because listing them made doctor report a permanent false `skills: codex 0/n`).
   - **Integration consent `none` skips the skills channel entirely** — the run reports `skills: skipped (consent: none)`, no record is written, and nothing is retired on that host.
4. Root `README.md` — the seven RETIRED-9 passages, measured on `dev` @ `df45bde28`: **`:30`** (the `--integrations auto|codex|claude|all|none` delivery-vs-activation paragraph), **`:32`** (the `genie init` → external-terminal `genie setup --codex` bootstrap paragraph), **`:171`** (the `genie setup` row in the command table), **`:201`** (the "Seven optional `genie_*` role-agent TOMLs under `~/.codex/agents/`" CLI-integration row), **`:219`** (the "Older Genie releases seeded up to 23 digest-managed product skills into `~/.agents/skills/` … quarantine transaction" paragraph), **`:241`** (the "restart Codex … review the three hook definitions with `/hooks`" paragraph), **`:248`** (`genie --version matches the enabled genie@automagik plugin`). Rewrite the file's install/verify story to the same three surfaces as `CLAUDE.md`; where a passage describes only deleted machinery (`:201`, `:241`, `:248`) delete it, and where it describes a surviving command whose Codex clauses die (`:30`, `:32`, `:171`), rewrite the clause. `:219`'s quarantine paragraph is replaced by a pointer to Wish B's `legacy-integration-retirement` behavior and the `>= 5.260711.6` window.
5. `AGENTS.md` — rewrite the five plugin-era lines: line 19 (`src/hooks/` no longer exists), line 21 (`plugins/genie/` is the Orca payload only), line 22 (drop `plugins/genie/references/native-surfaces.md`; the skills themselves are the runtime-neutral guidance), line 57 release contract (binary + Orca manifest + skills + templates + `VERSION`; no "both plugin manifests, both marketplaces"), line 62 Codex runtime note (skills are discovered from the global skills home; no `.codex-plugin/plugin.json`, no `/hooks` review step). Add one line under Engineering rules recording that the shared-workspace git-state freeze is policy, not a hook — the answer to issue [#2705](https://github.com/automagik-dev/genie/issues/2705) after Wish B.
6. `src/__tests__/claude-md-drift.test.ts` — four mechanical edits:
   - **Remove** the `expect(shared).toContain('plugins/genie/references/native-surfaces.md')` assertion (`:61`), which asserts a file Wish B deletes. **Premise check first:** B's Decision 12 allows B to make the minimum contract-file/test edits a gate forces, and this assertion is exactly such a forcing gate — so B may already have removed line 61. Group 2 **verifies first, then extends**: read the file on merged `dev`; if the assertion is gone, record that and skip; if it is still there, remove it. Do not plan on either state.
   - **Remove `'hook'` from `REQUIRED_V5_COMMANDS`** (`:39-50`, the list currently reads `board, context, doctor, hook, idea, init, omni, setup, shortcuts, task, uninstall, …`). It asserts that `CLAUDE.md` still documents a command Wish B deletes; leaving it makes the test red the moment the `hook` row is dropped from the commands table.
   - **Extend `RETIRED_FOSSILS`** (`:19-34`) with all nine of **RETIRED-9** — `setup --codex`, `agent-sync`, `H3/H4/H6`, `.curated`, `LENS_ROOT`, `CLAUDE_PLUGIN_ROOT`, `genie@automagik`, `council.js`, `hook dispatch` — plus the three **AGENTS.md-specific fossils** the RETIRED-9 regex does not catch but which are equally dead after B: **`native-surfaces.md`** (`AGENTS.md:22`), **`.codex-plugin`** (`AGENTS.md:62`), and **`both marketplaces`** (`AGENTS.md:57`). Adding these three is what makes deliverable 5's rewrite mechanically enforced instead of merely promised.
   - **Assert the fossil list against both files** (today `RETIRED_FOSSILS` is checked only against `CLAUDE.md`), and assert both contain `npx skills add automagik-dev/genie` and `skills-install.json`. Root `README.md` is checked by the C10-repo grep, not by this test — it is not one of the two files the drift test loads, and widening the test to a third file is not worth the coupling.

**Acceptance Criteria:**
- [ ] RETIRED-9 over `CLAUDE.md AGENTS.md README.md` returns nothing (baselines: 10 / 0 / 7 hits).
- [ ] `git grep -F -n -e native-surfaces.md -e .codex-plugin -e 'both marketplaces' -- AGENTS.md` returns nothing.
- [ ] All three files name exactly three delivery surfaces: the signed binary, `npx skills add automagik-dev/genie`, and the Orca plugin.
- [ ] All four new gotchas present, each carrying its concrete fact — and the skills-channel gotcha's argv, record fields and doctor comparison are byte-checked against merged `dev`'s `src/lib/skills-installer.ts` (no `automagik-dev/genie@`, no `-y` after `--copy`, `agentDirs` sourced from the discovery scan), with the check recorded in Review Results.
- [ ] `CLAUDE.md` says **fifteen** top-level commands and the count matches the rows in the table.
- [ ] `bun test src/__tests__/claude-md-drift.test.ts` green, with the twelve-entry fossil extension asserted against both files and `'hook'` gone from `REQUIRED_V5_COMMANDS`.
- [ ] Every retained `CLAUDE.md` / `README.md` section still describes something that exists after Wish B (spot-checked against `git grep` for each named file/command).

**Validation:**
```bash
bun test src/__tests__/claude-md-drift.test.ts && bun run wishes:lint && bun run lint
git grep -nE 'setup --codex|agent-sync|H3/H4/H6|\.curated|LENS_ROOT|CLAUDE_PLUGIN_ROOT|genie@automagik|council\.js|hook dispatch' -- CLAUDE.md AGENTS.md README.md; test $? -eq 1
```

**depends-on:** none

---

### Group 3: public docs rewrite + release-notes page (.docs-vendor submodule)

**Goal:** Make the public Mintlify site describe the two-step install, the new doctor/uninstall surface, and the four capabilities the deletion accepts.

**Measured worklist (pointer at authoring, RETIRED-9 + `plugin marketplace add`): 27 hits across 10 files.** This is the whole of Group 3's grep-provable surface; the release-notes page is the one addition.

| File | Lines | Disposition |
|------|-------|-------------|
| `docs/installation.mdx` | 51, 168, 177, 178, 190, 206, 218 | Rewrite (deliverable 2) |
| `docs/config/hooks.mdx` | 13, 16, 141, 145, 148, 151 | **Delete the whole page** + remove its nav entry (deliverable 3a) |
| `docs/config/setup.mdx` | 65, 89 | Rewrite the `setup --codex` clauses |
| `docs/config/files.mdx` | 251, 255 | Rewrite |
| `docs/index.mdx` | 75 | Rewrite |
| `docs/quickstart.mdx` | 44 | Rewrite |
| `docs/architecture/overview.mdx` | 106 | Rewrite |
| `docs/_internal/architecture.mdx` | 37, 185, 266 | Rewrite |
| `docs/_internal/sdk-executor-guide.mdx` | 521, 558 | Rewrite |
| `docs/_internal/cli-reference.mdx` | 32, 1396 | Rewrite |

Line numbers are the authoring-time measurement against the pointer this wish records; **re-run the grep on the freshly fetched docs `origin/main` before editing** — docs `main` moves out of band (docs#79/#80 already landed) and the file list, not the line numbers, is the contract.

**Deliverables:**
1. `git submodule update --init .docs-vendor`, then a branch inside `.docs-vendor` off a freshly fetched docs `origin/main` (PRs docs#79/#80 already landed there out of band — re-read before writing), PR to `automagik-dev/docs` `main`. Re-measure the worklist above on that head and record any delta in Review Results.
2. `docs/installation.mdx` — **the `-g --all` "Skills for any agent" section is already live** on docs `main` (lines 106–120, landed via docs#79/#80): it already carries `npx skills add automagik-dev/genie -g --all`, already explains that the bare command is project-scoped, and already says `genie update` performs the global install itself. Do **not** re-write it as if it were missing. The residual work on this page is (a) the **marketplace bootstrap steps** at `:51`, `:177`, `:178`, `:206`, `:218` — delete the Claude `/plugin marketplace add …` registration path entirely and rewrite "One-line bootstrap" down to the two supported steps (the signed binary via `genie update`, which runs the skills install itself; and the manual `npx skills add` for people who want skills without the genie CLI); (b) the **hook-dispatch row** at `:190`; (c) `:168`; and (d) stating that Orca is the only plugin Genie ships.
3. **The `@<ref>` caveat on the public command** (owned by Wish C per Wish B OUT scope (skills-everywhere-b/WISH.md:50), which assigns the public-command caveat to this wish). Wherever `docs/installation.mdx` shows `npx skills add automagik-dev/genie -g --all`, it must state plainly that this installs the **repository's default branch (`main`)**, and that this is true *independent of any `@<ref>` suffix a reader might add* — `skills@1.5.23` binds the third capture of its source spec to `skillFilter`, not to a ref, so `automagik-dev/genie@v5.260830.21` resolves to `main`'s tree with a skill filter, not to the tag; a `#fragment` is the only ref form the CLI honors. State the consequence in the same breath: the public path tracks `main` and can be ahead of or behind any release, whereas **`genie update` installs the exact delivered release** because Wish B switched the CLI to a local-path source under `$GENIE_HOME` (Wish B G1 Decision 1). Readers who need the version that matches their binary use `genie update`, not the public command.
3a. `docs/config/hooks.mdx` — **delete the page** (all six of its RETIRED-9 hits are the page's own subject; there is nothing left to rewrite after Wish B removes `src/hooks/**` and `genie hook dispatch`) and **remove its navigation entry** from `.docs-vendor/docs.json` (`"genie/config/hooks"`, line 113 at authoring). Add a redirect if the docs repo's convention has one; a 404 on a page that has been linked from the site is worse than a stub. The only real inbound link is `docs/hacks.mdx:318` ("See the [Hooks reference](/genie/config/hooks)…") — `docs/hacks.mdx` joins the worklist as the 11th file and that sentence is repointed to the Omni docs (the NATS subjects it names are Omni's and survive); the four RETIRED-9 grep hits in index/quickstart/setup/files are `setup --codex` rows, not links, and are handled by those files' own rewrites.
4. `genie doctor` documentation — the skills lines: `skills: <agent> <n>/<n> @ v<ver>` for a detected home, `not detected` (info) for an absent one, a warn with `genie update` / `genie doctor --fix` as the remedy for missing or stale skills. Remove every plugin/hook/role-agent/stamp doctor line.
5. `genie uninstall` semantics — deletes the recorded inventory skill directories from the **recorded `agentDirs`** (which, after Wish B, is the discovery-scan set, not the four known homes), removes the install record, runs the legacy collectors, removes the binary; skills the user added themselves are left in place, and a foreign directory `--copy` overwrote is *not* restored (Wish B records and backs it up; restoration is explicitly out of scope there and here).
6. New release-notes page listing design Risks 3–6 as accepted behavior changes, each with what is gone / what still works / what to do instead:
   - client-side branch guard gone — `main` is protected server-side by rulesets (PR required, direct pushes blocked, a required reviewer who is not the author); the actor gap (an agent uses the human's `gh` credentials) is stated as accepted;
   - git-freeze guard gone — the shared-workspace git-state freeze is `AGENTS.md` policy carried in briefs; worktree isolation is the structural mitigation;
   - Omni in-session permission approvals gone — `genie omni serve` keeps its approval queue and inbox for CLI-originated approvals; a remote agent permission prompt is no longer approvable from a chat;
   - SessionStart context injection gone — no stale-wish freshness warning, no injected agent identity, no audit lines; skills read wish state explicitly and `GENIE_AGENT_*` still configures the CLI.
   Register the page in the docs repo navigation config (`.docs-vendor/docs.json`).
7. **After a human merges the docs PR** (external, human-gated — see the Execution Strategy note): bump the genie superproject `.docs-vendor` pointer as its own commit.

**Acceptance Criteria:**
- [ ] Docs PR merged into `automagik-dev/docs` `main` **by a human reviewer** (this wish opens the PR; it cannot merge it); **every check that repository actually runs on the PR is green, with the check list recorded in Review Results.** `automagik-dev/docs` has no `.github/workflows/` directory — there is no Mintlify docs-lint run to cite there, and the docs-lint gate is genie-side (Group 4, deliverable 3). The checks that do run on the docs PR are CodeRabbit, GitGuardian, and the two Socket Security reports; local markdownlint evidence goes in the PR body.
- [ ] `grep -c 'plugin marketplace add' docs/installation.mdx` is 0, and the page contains `npx skills add automagik-dev/genie -g --all` **with the default-branch caveat of deliverable 3 attached to it**.
- [ ] RETIRED-9 **plus `plugin marketplace add`** over `docs/` returns nothing — 27 hits → 0, with every one of the ten worklist files touched or, in `hooks.mdx`'s case, deleted.
- [ ] `docs/config/hooks.mdx` no longer exists and `"genie/config/hooks"` is gone from `.docs-vendor/docs.json`; no page links to it.
- [ ] The release-notes page lists all four losses, each with a replacement action, and is reachable from the site navigation.
- [ ] `git submodule status .docs-vendor` resolves to a commit that is an ancestor of docs `origin/main`; the pointer bump is a separate commit.
- [ ] **Bounded `_internal` criterion:** none of the three enumerated `_internal` pages — `docs/_internal/architecture.mdx`, `docs/_internal/sdk-executor-guide.mdx`, `docs/_internal/cli-reference.mdx` — documents a Wish-B-deleted subsystem as live at the enumerated lines. The wish makes **no claim** about `_internal` pages outside that list: `docs/_internal/` is a large engineering archive, an exhaustive "no page documents anything deleted" sweep is unbounded and unverifiable, and the grep-provable contract is the 27-hit worklist.

**Validation:**

> **Do not run `git submodule update --init .docs-vendor` while deliverable 7 is still pending.** It checks the submodule back out at the superproject-recorded pointer (still the pre-wish commit until the pointer bump lands), which wipes the docs branch checkout: `docs/config/hooks.mdx` reappears, `test ! -e` and the RETIRED-9 grep fail as false negatives, and `merge-base --is-ancestor HEAD origin/main` reports a false pass because it tests the old pointer rather than the branch head. Run the block below as written, which checks out the docs work branch instead of resetting to the pointer. Once deliverable 7 has bumped the pointer, `git submodule update --init .docs-vendor` is the correct first line again. Note that `merge-base --is-ancestor HEAD origin/main` **legitimately fails** on the work branch until a human merges the docs PR; that is the human gate on deliverable 7, not a regression. Verify the remaining four lines independently of it while the PR is open.

```bash
git -C .docs-vendor fetch origin \
  && git -C .docs-vendor checkout docs/skills-everywhere-c \
  && git -C .docs-vendor merge-base --is-ancestor HEAD origin/main \
  && grep -q 'npx skills add automagik-dev/genie -g --all' docs/installation.mdx \
  && test ! -e docs/config/hooks.mdx \
  && ! grep -rqnE 'setup --codex|agent-sync|H3/H4/H6|\.curated|LENS_ROOT|CLAUDE_PLUGIN_ROOT|genie@automagik|council\.js|hook dispatch|plugin marketplace add' docs/
```

**depends-on:** none (within Wish C; the whole wish is gated on `skills-everywhere-b` merged to `dev`, and deliverable 7 is additionally gated on a human merging the docs PR)

---

### Group 4: docs-lint coverage + final gate

**Goal:** Put the new docs page and the retired-terminology contract under a CI gate, and prove the whole branch green.

**Deliverables:**
1. `package.json` — extend `lint:docs-markdown` (markdownlint-cli2) and `lint:docs-links` (markdown-link-check) to cover `docs/installation.mdx` and the new release-notes page, alongside the existing `SECURITY.md` + `docs/incident-response/canisterworm.mdx` targets.
2. `.github/workflows/docs-lint.yml` — confirm the `.docs-vendor` / `.gitmodules` path triggers still fire for the new page (they do today via the pointer bump) and add any new config path the scripts read.
3. A retired-terminology assertion step in `docs-lint.yml`, running only in CI where the SHA-pinned `actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5` (the pin already used at `docs-lint.yml:51,72`) with `submodules: recursive` guarantees `docs/` is populated: fail the job if `docs/` matches **RETIRED-9 plus `plugin marketplace add`**, i.e. `setup --codex|agent-sync|H3/H4/H6|\.curated|LENS_ROOT|CLAUDE_PLUGIN_ROOT|genie@automagik|council\.js|hook dispatch|plugin marketplace add`. Byte-identical to the Group 3 validation grep — one list, two call sites. Deliberately **not** a local `check` entry (Simplicity Case); its blind spot is Decision 11.
4. Verify the parity script enumerates all three `genie-orca-*` skills after PR #2870, using the `ci.yml` invocation (`npx -y skills@1.5.23 add "$PWD" --list > f && bun scripts/skills-inventory-parity.ts --repo . --list-file f`); extend its fixture only if it does not.
5. Full-branch validation and the evidence grep list for Review Results.

**Acceptance Criteria:**
- [ ] `bun run lint:docs-markdown` and `bun run lint:docs-links` pass with the new page in scope (submodule populated).
- [ ] The docs-lint workflow's retired-term step fails on a seeded violation and passes on the branch (proof: a local run of the same grep, and the CI run on the PR).
- [ ] The `ci.yml`-form parity run lists `genie-orca-wish`, `genie-orca-work`, `genie-orca-review`, and the script's header docstring (Group 1 deliverable 9) matches the invocation it documents.
- [ ] The workflow's grep string is byte-identical to Group 3's validation grep (diffed, not eyeballed).
- [ ] `git diff --stat origin/dev...HEAD -- .github/workflows/release-publish.yml .github/workflows/musl-adapter-smoke.yml` is empty.
- [ ] `bun run check` green.

**Validation:**
```bash
bun run check && bun run lint:docs-markdown && bun run lint:docs-links
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional** — on a clean checkout of `dev`, `bun run skills:lint` exits 0; seeding `genie_reviewer` into any file under `skills/` — including a non-`.md` file such as `skills/work/agents/openai.yaml`, and including a file carrying `<!-- skills-lint:ignore -->` — makes it exit non-zero naming that file and line; creating `skills/tmp-nested/inner/SKILL.md` and an empty `skills/tmp-empty/` each make it exit non-zero with the matching message. Fixtures removed afterwards.
- [ ] **Functional** — the published Mintlify page for installation shows only the binary + `npx skills add automagik-dev/genie -g --all` path, states that the public command serves the repository's default branch regardless of any `@<ref>`, and `config/hooks` 404s or redirects; the release-notes page is reachable from the site navigation and names all four accepted behavior changes.
- [ ] **Integration** — a fresh agent session (Claude Code and Codex) loading the rewritten `skills/work/SKILL.md` dispatches to portable roles without naming a `genie_*` profile, and its brief still carries the freeze block verbatim.
- [ ] **Integration** — RETIRED-9 over `CLAUDE.md`, `AGENTS.md`, `README.md` and `skills/` on merged `dev` returns nothing, and RETIRED-9 + `plugin marketplace add` over `docs/` returns nothing; `bun test src/__tests__/claude-md-drift.test.ts` green.
- [ ] **Integration** — the CLAUDE.md skills-channel gotcha matches the shipped binary: run `genie update` on a real host and confirm the argv it spawns, the fields in `$GENIE_HOME/skills-install.json`, and the `agentDirs` count `genie doctor` reports are the ones the gotcha describes.
- [ ] **Regression** — `bun run check` green on `dev`; `bun run wishes:lint` still parses every wish against the edited template; `.github/workflows/release-publish.yml` byte-identical to its pre-wish state.
- [ ] **Regression** — `genie doctor` output on a real host matches what the rewritten docs describe, line for line, for both a detected and an undetected agent home.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Wish B slips or lands partially, so the docs describe a repo that does not exist | High | `depends-on: skills-everywhere-b` is a hard gate; Group 3's docs PR opens only after B is merged to `dev`. If any retired file still exists when C starts, C reports blocked rather than documenting a half-deleted world. |
| The `skills/wish/templates/wish-template.md` edit breaks `parseWishTemplateContract` and invalidates every wish | High | The template is the single source of truth for `validate-wish`; only prose inside the routing rubric changes. `bun run wishes:lint` over all wishes is in Group 1's validation, not just Group 4's. |
| The token rule over-matches legitimate prose (a wish quoting a retired role, the plain word "engineer") | Medium | Scoped to `skills/**` only; `.genie/wishes/**` and `.genie/brainstorms/**` are historical records and exempt. A positive fixture proves ordinary prose passes. |
| The nested/empty rule false-positives on `references/` and `templates/` subdirectories | Medium | The rule keys on `SKILL.md` placement, never on directory names (Decision 3); a positive fixture covers a skill with both subdirectories. |
| Docs `main` moves under the branch (it already did — docs#79/#80 merged out of band) | Medium | Group 3 fetches and re-reads docs `origin/main` before writing; the pointer bump is a separate commit made after the docs PR merges. |
| The docs submodule is unpopulated in a contributor checkout, so a local retired-term gate false-fails | Medium | The `docs/` assertion lives in the CI workflow (submodules checked out), never in `bun run check` — recorded in the Simplicity Case. |
| The worktree base predates PR #2870, so `skills/genie-orca-*` is absent on disk here | Low | Planning-only artifact. Every group rebases on a `dev` containing #2870 **and** Wish B before starting; Group 1's acceptance explicitly names the three directories. |
| Removing the `AskUserQuestion` carve-out gotcha loses a hard-won Claude Code detail | Low | The carve-out only had meaning inside the hook envelope Wish B deletes; if hooks ever return, the incident is recorded in this wish, the Wish B ledger, and the design's Simplicity Case ("re-adding any hook is cheap"). |
| `CLAUDE.md` is loaded by live agent sessions mid-wish, so a half-rewritten file misroutes an agent | Low | Group 2 lands as one commit; no partial state is pushed. |
| Wish C's install-channel prose is transcribed from Wish B's *plan* rather than B's *merged code*, and B's execution diverged (a different local source root, a renamed record field, a different doctor comparison) | High | The Summary makes B's code authoritative and this text a transcription target; Group 2's acceptance byte-checks the argv, the record fields and the doctor comparison against merged `dev` and records the check in Review Results. |
| Group 2 collides with a `CLAUDE.md` edit Wish B already made under its Decision 12 (the `:186` version count, the drift test's `:61` assertion) | Medium | Both are called out as **verify-then-extend**: read the file on merged `dev` first, record the observed state, and only edit what is still wrong. Never plan on either state. |
| Root `README.md` was missing from the plan entirely and is the most-read operator surface | Medium | Now a Group 2 deliverable with its seven measured lines enumerated, and inside the C10-repo grep pathspec — the same gate that proves `CLAUDE.md` proves it. |
| The docs worklist's line numbers go stale because docs `main` moves out of band | Medium | The **file list**, not the line numbers, is the contract; Group 3 deliverable 1 re-runs the grep on the fetched head and records the delta. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Execution review — Group 4 — 2026-09-01T08:00:00Z — SHIP

- Engineer/reviewer: ultracode wave-2 agents (opus/high, reviewer ≠ engineer), session 17ecb3d2. PR #2889 (11/11 checks pass), commits `25fb1ca94` `655098418` + fix loop, merged to `wish/skills-everywhere-c` at `72abd7941`.
- The docs-lint retired-terminology job's grep is proven byte-identical to the ratified G3 validation grep (137 bytes, sha256 `12fe1d4a…` both sides, programmatic extraction + `cmp`); proven both ways against the docs work branch (`db8bddd`): real tree passes, each of the ten tokens individually fails a seeded probe. The ci.yml-form parity run lists all three `genie-orca-*` skills (25 agree). C7-untouched empty. Disclosed out-of-list edit ratified: `.github/markdown-link-check.json` gains a `/genie/<page>[#anchor]` → file resolution pattern so the release-notes page's one internal link is verified rather than skipped.
- **Pointer-bump-pending acceptance (recorded, not ticked):** the three docs-lint jobs on the dev-targeting PR #2888 are EXPECTED RED until G3 deliverable 7 lands — the recorded `.docs-vendor` pointer (`b700cb611`) predates the wish and still carries the 27 retired-term hits with no release-notes page. **Orchestrator instruction to self: #2888 must not merge to dev before a human merges automagik-dev/docs#81 and the pointer bump lands.** C10-docs, AC2's CI half, and the "Pointer bumped" criterion remain post-human-merge acceptance.

### Execution review — Wave 1 (G1, G2, G3) — 2026-09-01T07:00:00Z — SHIP ×3

- Engineers/reviewers: ultracode wave-1 agents (opus/high, reviewer ≠ engineer per group), session 17ecb3d2, base `0efc288b5` (post-Wish-B dev). G1 PR #2887 SHIP r1; G2 PR #2886 SHIP r1; G3 docs PR automagik-dev/docs#81 SHIP r2 after one fix loop. All three merged to `wish/skills-everywhere-c` (`d3b884f6d`, `db4de7d6d`, `403fe5c26`).
- **Baseline correction (ledger-recorded per G1's review):** the C10-repo `skills/` baseline was 2 hits, not the recorded 0 — `skills/README.md:50` (`genie setup --codex`) and `skills/genie-hacks/references/catalog.md:113` (`hook dispatch`); both fixed in G1. G1's gate-forced out-of-list edits (build-tarballs.yml parity path, release-docs.test.ts skills-README retarget) are disclosed in PR #2887.
- **Orchestrator ratification (2026-09-01, session 17ecb3d2):** G3's in-branch amendment `1f69e4044` is RATIFIED — the docs repo has no `.github/workflows/`, so the "Mintlify docs-lint run" AC is replaced by "every check the repo actually runs is green + local markdownlint evidence in the PR body", and the Validation block is corrected so `git submodule update --init` is not run while the pointer bump is pending (it would reset the submodule to the pre-wish pointer and produce false failures/passes).
- **Cross-group seam fixed by the orchestrator (`bbc8de72d`):** `release-docs.test.ts`'s "manual docs use explicit tiers" test required `$genie:<skill>` in the two READMEs — banned vocabulary post-Decision-8; each branch passed only via the other file's stale tokens and the union failed. Rewritten to assert the discovery forms (`$name`, `/name`) and `not.toContain('$genie:')`.
- **G3 completes at the open, human-gated docs PR (#81)** per the Execution Strategy; deliverable 7 (the `.docs-vendor` pointer bump) executes after a human merges it. G3's card stays in progress until then.
- LOW residuals recorded, none blocking: full test gate pending on the dev-targeting PR (opened after the first merge, per protocol); two docs prose leftovers (`config/files.mdx:233` GENIE_AGENT_NAME description, `architecture/messaging.mdx` fire-and-forget sentence) and the no-redirect 404 for the deleted hooks page, all noted in docs#81; the two-walk symlink/binary divergence comment suggestion.

### Plan review — 2026-08-31T16:02:02Z — SHIP (round 2)
- Reviewer: genie:reviewer (session e7edce9e/ae37f64b), rounds 1 (FIX-FIRST, sha `8924f5ad…`) and 2 (SHIP, sha `8e5611226…`), base 67be5c46d. All H/M closed and independently re-verified (Decision 10 proven empirically: 0 violations across the 29 non-.md files). Binding erratum applied by the orchestrator in this revision: G3's inbound-link contract corrected to `docs/hacks.mdx:318` (11th worklist file, repoint to Omni docs). LOW errata applied (11 hits count, BANNED-13 naming, B:50 citation, ci.yml:258-270, final-gate line ref). Reviewer verifies the erratum at execution review.
- Status set to APPROVED by the orchestrator on this evidence (execution still gated on `depends-on: skills-everywhere-b`).

### Plan review — 2026-08-31T15:44:20Z — FIX-FIRST (round 1)

- **Reviewer:** `genie:reviewer session e7edce9e/ae37f64b`
- **Plan sha:** `8924f5ad907abe684b2da149a17f26758cc044aa261a07fa5c7e2af88143ccc8`
- **Base:** `67be5c46d`

**Findings**

| ID | Sev | Finding |
|----|-----|---------|
| H1 | High | The CLAUDE.md gotcha 1/3 and G3 deliverable 3 described the *pre-B* install channel — a `automagik-dev/genie@v<ver>` ref, a stray `-y` after `--copy`, a 4-row `agentDirs`. All three contradict Wish B G1's post-B contract (local-path source, discovery-scan `agentDirs`, `{ref, cliVersion, inventory[], agentDirs[], source, collisions, installedAt}`). |
| H2 | High | G1's D1/D3/D4 contradicted each other: D1 banned `engineer-*` "used as an agent/role name" while D3/D4 kept using those exact names as role names, and no replacement vocabulary was defined. |
| H3 | High | Root `README.md` — 7 retired-term lines, the most-read operator surface — was absent from every group and from the C10-repo pathspec. |
| H4 | High | The public `npx skills add automagik-dev/genie` command serves the repository's default branch regardless of any `@<ref>`; Wish B G1 assigned that caveat's wording to Wish C and it was missing. |
| H5 | High | G3 was scoped to `installation.mdx` alone; the measured surface is 10 files / 27 hits including an entire `config/hooks.mdx` page, and its complexity was under-scored at 3. |
| M1 | Med | G1 re-implemented nested/empty skill-dir detection that `scanRepoSkills` already implements and CI already gates. |
| M2 | Med | The retired-term list was spelled out three times with drifting members. |
| M3 | Med | The C5-policy acceptance grep was vacuous — it returns nothing on today's tree too. |
| M4 | Med | Six further `CLAUDE.md` hits (`:64`, `:66`, `:75`, `:82`, `:143`, `:144`, `:186`) were unitemized. |
| M5 | Med | The parity-script invocation was written in a form the script does not accept, and the script's own header docstring is stale. |
| M6 | Med | The token scan was `.md`-only, leaving the 25 `agents/openai.yaml` starter prompts unscanned. |
| M7 | Med | G2 D5's premise assumed the drift test's `:61` assertion still exists when Wish B may already have removed it. |
| M8 | Med | `REQUIRED_V5_COMMANDS` still requires `'hook'`, and the AGENTS.md fossils (`native-surfaces.md`, `.codex-plugin`, `both marketplaces`) were unenforced. |
| L1–L7 | Low | `skills-lint:ignore` interaction undecided; `checkout@v4` cited where the repo pins v5; `work/SKILL.md:52` missing from the worklist; the stale "22 skills" installer comment; no INDEX entry; the between-bumps regression window implicit; `CLAUDE.md:186`'s version count unlisted. |

**Disposition: applied in this revision.**

Re-measured during the fix (worktree base `df45bde28`): `README.md` RETIRED-9 = **7 lines** (30, 32, 171, 201, 219, 241, 248 — the extra one is `:30`); `docs/` RETIRED-9 + `plugin marketplace add` = **27 hits across 10 files** (not 26); `skills/` BANNED-13 = **13 hits across 5 files**, with **zero** hits in non-`.md` files today; `actions/checkout` is pinned to `93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5` throughout `ci.yml` and `docs-lint.yml`; `docs/installation.mdx:106-120` already carries the `-g --all` section live; `scanRepoSkills` is exported at `scripts/skills-inventory-parity.ts:182`; no file under `skills/` uses the `<!-- skills-lint:ignore -->` marker today. H2's replacement vocabulary is now fixed as Decision 8's BANNED-13 → portable-role mapping (`implementor-low` / `implementor-mid` / `implementor-high`, with `reviewer` / `fixer` / `final-gate` / `scout` keeping their bare names).

---

## Files to Create/Modify

```
# Group 1 — skills lint + content
scripts/skills-lint.ts                        (modify: token rule, nested/empty rules)
scripts/skills-lint.test.ts                   (modify: negative + positive fixtures)
scripts/skills-inventory-parity.ts            (modify: stale header docstring :5-8, :14-15; widen scanRepoSkills only if the import needs it)
skills/work/SKILL.md                          (modify: 7 hits lines 56-62 + line 52 genie_* + verbatim policy sentence)
skills/wish/templates/wish-template.md        (modify: 2 hits lines 66-67 + line 69 genie_*)
skills/README.md                              (modify: 2 hits, lines 8, 12)
skills/trace/SKILL.md                         (modify: 1 hit, line 40)
skills/genie-hacks/references/catalog.md      (modify: 1 hit, line 141)
src/lib/skills-installer.ts                   (modify: SKILLS_CLI_VERSION comment :51-52; stale "22 skills" count :60-61)

# Group 2 — contract files
CLAUDE.md                                     (modify: remove 7 gotchas, rewrite 2, add 4; lines 64, 66, 75, 82, 88, 143, 144, 186)
AGENTS.md                                     (modify: lines 19, 21, 22, 57, 62 + freeze-policy line)
README.md                                     (modify: 7 RETIRED-9 passages, lines 30, 32, 171, 201, 219, 241, 248)
src/__tests__/claude-md-drift.test.ts         (modify: drop :61 native-surfaces assert, drop 'hook' from REQUIRED_V5_COMMANDS, extend RETIRED_FOSSILS +12, assert both files)

# Group 3 — public docs (.docs-vendor submodule -> automagik-dev/docs) — 10 files, 27 hits
docs/installation.mdx                         (modify: marketplace steps 51/177/178/206/218, hook row 190, 168; @ref caveat)
docs/config/hooks.mdx                         (DELETE: whole page)
docs/config/setup.mdx                         (modify: 65, 89)
docs/config/files.mdx                         (modify: 251, 255)
docs/index.mdx                                (modify: 75)
docs/quickstart.mdx                           (modify: 44)
docs/architecture/overview.mdx                (modify: 106)
docs/_internal/architecture.mdx               (modify: 37, 185, 266)
docs/_internal/sdk-executor-guide.mdx         (modify: 521, 558)
docs/_internal/cli-reference.mdx              (modify: 32, 1396)
docs/<release-notes page>.mdx                 (create: Risks 3-6 behavior changes)
.docs-vendor/docs.json                        (modify: register the new page; remove "genie/config/hooks" nav entry, line 113)
.docs-vendor                                  (modify: superproject pointer bump, separate commit)

# Wish bookkeeping
.genie/INDEX.md                               (modify: add the Wish B / Wish C umbrella entry)

# Group 4 — lint coverage + gate
package.json                                  (modify: lint:docs-markdown, lint:docs-links globs)
.github/workflows/docs-lint.yml               (modify: paths + retired-term assertion step)
scripts/skills-inventory-parity.ts            (verify; modify only if genie-orca-* missing)
```
