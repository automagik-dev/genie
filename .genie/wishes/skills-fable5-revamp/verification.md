# Verification Report — skills-fable5-revamp (Group 7, Wave 2)

| Field | Value |
|-------|-------|
| **Date** | 2026-07-04 |
| **Worker** | eng-g7 (task `t_mr6u09bi0a5e7255`) |
| **Genie worktree** | `wish/skills-fable5-revamp` @ `7150df62` (G8) ← a665dd80 (G3) ← afb0b171 (G2) ← 064a9b92 (G4) ← 941c4ed3 (G1) ← 821eeb4c (wish docs), merge-base with `origin/dev` = `63015670` |
| **Omni worktree** | `wish/skills-fable5-revamp` @ `60823a0b` (G5) ← `8e409480` (G6) |
| **Verdict** | All 10 wish-level Success Criteria PASS. 2 small in-scope fixes applied (listed at end). No structural gaps. |

Method note: all commands below were executed in this session; outputs are pasted trimmed to the relevant lines. "Baseline" = the WISH.md *Files to Create/Modify* counts; where the merge-base (`63015670`) measurement differs, both are shown (plan-time counts were taken slightly before the branch point — 12-line total drift on the genie side, omni exact).

---

## SC1 — All 36 surface files conform (frontmatter at byte 0, name = dir, trigger-focused description)

```
$ for f in skills/*/SKILL.md; do head -c 4 "$f" | grep -q -- '---' || echo "BAD FM: $f"; done   # genie
OK: all 17 genie SKILL.md start with --- at byte 0
name=dir check: no mismatches (17/17)

$ for f in skills/*/SKILL.md commands/*.md agents/*.md rules/*.md; do head -c 4 "$f" | ... done  # omni (19 files)
BAD FM: rules/omni-agent.md          # see exception below — pre-existing format, not a regression
name=dir check: no mismatches (4/4 omni skills)
```

**Result: PASS (35/36 byte-0 frontmatter + 1 documented format exception).**
`rules/omni-agent.md` has no frontmatter **at baseline either** (verified: `git show origin/dev:plugins/omni/rules/omni-agent.md` starts with `# Omni Agent Rules`). Claude Code rules files carry no frontmatter; `conventions.md` scopes the frontmatter rule to `SKILL.md` (rule 1) and to commands' *existing* shape (rule 3). G6 was a content-only rewrite; adding frontmatter would have changed the file's format. All 35 files that have frontmatter start with `---` at byte 0; all 21 SKILL.md `name` fields match their directory; all 35 descriptions (17 genie skills + 4 omni skills + 11 commands + 3 agents) are one-to-two-sentence trigger hooks (swept via `awk '/^description:/'` over all 35 — e.g. genie `fix`: *"Dispatch fix subagent for FIX-FIRST gaps from /review, re-review, and escalate after 2 failed loops."*; omni `send`: *"Send any message type out-of-turn to any Omni channel instance — text, media, TTS, polls, embeds. Inside a turn, use the verbs..."*).

## SC2 — Budgets

From the `wc -l` runs in SC3: every genie `SKILL.md` ≤ 200 (max **125** `brainstorm`), every omni `SKILL.md` ≤ 200 (max **98** `omni-setup`), every command ≤ 40 (max **36** `chats.md`), every agent ≤ 40 (max **26**), rule ≤ 30 (**12**). Zero ceiling justifications needed. **PASS.**

## SC3 — Total always-loaded lines ≤ 3,300 (same file set as the 5,514 baseline)

```
$ wc -l skills/*/SKILL.md                                    # genie, 17 files
 1385 total
$ wc -l skills/*/SKILL.md commands/*.md agents/*.md rules/omni-agent.md   # omni, 19 files
  631 total
```

| Set | Baseline (WISH) | Baseline (measured @ merge-base) | After | Reduction |
|-----|----------------|----------------------------------|-------|-----------|
| genie 17 × SKILL.md | 4,185 | 4,173 | **1,385** | −66.9% |
| omni 19 files | 1,329 | 1,329 | **631** | −52.5% |
| **Combined** | **5,514** | 5,502 | **2,016** | **−63.4%** (−63.4% vs measured) |

2,016 ≤ 3,300 with 1,284 lines of headroom; ≥ 40% reduction target exceeded. Per-file table at the end. **PASS.**

## SC4 — Genie lints green, zero ignore markers

```
$ bun run skills:lint
skills-lint: OK (28 files scanned, 0 missing)        EXIT: 0
$ bun run wishes:lint
wishes-lint: OK (21 files scanned, 0 broken brainstorm links)   EXIT: 0
$ grep -rn 'skills-lint:ignore' skills/
(no output)                                          grep exit 1 = zero matches
```

Baseline was exit 1 with 118 missing-command references in 13 files → now 0 missing across 28 scanned files, with no suppression markers anywhere in `skills/`. **PASS.**

## SC5 — Omni structural check exits 0

G5 and G6 validation blocks from WISH.md, run verbatim in the omni worktree:

```
$ cd "$(git rev-parse --show-toplevel)"/plugins/omni && for f in skills/*/SKILL.md; do head -c 4 ... ; done && echo G5-OK
G5-OK
$ ... for f in commands/*.md agents/*.md; do [ ≤40 ] ...; done && [ "$(wc -l < rules/omni-agent.md)" -le 30 ] && echo G6-OK
G6-OK
```

**PASS.**

## SC6 — Zero reasoning-extraction language

```
$ grep -riEn 'chain.of.thought|thinking block|internal reasoning|show your (full )?reasoning|transcribe (your )?(thinking|reasoning)' \
    <genie>/skills/ <omni>/plugins/omni/skills/ .../commands/ .../agents/ .../rules/
(no output)                                          grep exit 1 = zero matches
```

**PASS** across both repos' full surface trees (including sibling `references/` and `prompts/` files).

## SC7 — Frozen contracts intact (conventions.md § Preserve)

| Contract | Evidence (file:line, quoted) |
|----------|------------------------------|
| Template path + cp rule | `skills/wish/SKILL.md:36` — `cp templates/wish-template.md .genie/wishes/<slug>/WISH.md`; reinforced at :65 *"Never write WISH.md from scratch — always `cp templates/wish-template.md`, then edit."* |
| `wishes:lint` gate placement | `skills/wish/SKILL.md:47` — *"**Handoff:** run `bun run wishes:lint`. If it reports any error, surface it and stop… Only after lint passes, auto-invoke `/review` (plan review)"* |
| Five task-linkage command forms | `skills/pm/SKILL.md:62-67` carries all five in one fence: `genie task create --title "<title>" [--wish <slug> --group <name>]`, `list`, `status <id>`, `checkout <id> --worker <name>`, `done <id>`; wish-group linkage form verbatim at `skills/genie/reference/lifecycle.md:41` — `genie task create --wish <slug> --group <name>`. All six live `genie task` subcommands confirmed against `genie task --help` (checkout/create/done/export/list/status) |
| DRAFT / SHIP / FIX-FIRST / BLOCKED + severity vocab | `skills/wish/SKILL.md:53` — *"Status: DRAFT on creation"*; `skills/review/SKILL.md:25` — *"Return verdict — SHIP, FIX-FIRST, or BLOCKED"*; severity table `review/SKILL.md:56-59` (CRITICAL/HIGH/MEDIUM/LOW) |
| Artifact paths + exact stub | `skills/wish/SKILL.md:26` — *"emit `\| **Design** \| _No brainstorm — direct wish_ \|`… The linter accepts the literal stub text"*; path at `wish/SKILL.md:8` — `.genie/wishes/<slug>/WISH.md` |
| Reviewer ≠ engineer / ≤ 2 fix loops / orchestrator-only `task done` | `skills/work/SKILL.md:49` — *"Reviewer ≠ engineer is a hard rule"*; `skills/fix/SKILL.md:62` — *"Never exceed 2 fix loops — escalate, don't spin."*; `skills/review/SKILL.md:97` — *"`genie task done` belongs to the orchestrator, after a clean verdict — never to the reviewer."* (also `work/SKILL.md:76` *"Engineers never call `genie task done`"*) |
| Session-close outcome words in work/review/fix/trace | All four end with the identical block — `work:97`, `review:108`, `fix:69`, `trace:48`: *"End with exactly one terminal outcome as the last word"* → **done / blocked / failed**, with *"`blocked` / `failed` must include a one-line reason."* |
| Omni three-tier routing + `allowed-tools` + genie omni skill | Router `plugins/omni/skills/omni/SKILL.md:9` — *"Pure dispatcher — probe health, match intent, load exactly one tier"* (tiers 1/2/3 → omni-agent / omni-setup / omni-ops); omni-ops keyword table has **10 rows**, each resolving to an existing `references/<domain>.md` (see cross-ref audit 3); `allowed-tools` present on all four omni skills (each at line 4, e.g. `omni-ops:4` — `allowed-tools: Bash(omni *), Bash(jq *)`) and on the genie omni skill (`skills/omni/SKILL.md:4` — `allowed-tools: Bash(omni *), Bash(genie *)`) |

**PASS — all eight contract families intact.**

## SC8 — Diff shape: only M + A, zero deletions/renames

```
$ git diff $(git merge-base HEAD origin/dev) --name-status | cut -f1 | sort | uniq -c
  genie:  12 A   27 M          # zero D, zero R
  omni:   10 A   19 M          # zero D, zero R
```

Genie A-files: 3 wish artifacts (`WISH.md`, `conventions.md`, `reports/g8-v4-footprint.md`), 5 skill siblings (`genie-hacks/references/{catalog,contributing}.md`, `pm/references/modes.md`, `refine/prompts/optimizer.md`, `report/references/issue-template.md`), 4 G8 sources (`src/genie-commands/{install.ts,install.test.ts,legacy-v4.ts,legacy-v4.test.ts}`). Genie M-files: 17 SKILL.md + 4 pre-existing skill siblings (`brainstorm/references/design-template.md`, `council/members/config.md`, `council/templates/report.md`, `genie/reference/lifecycle.md`) + the G8 enumerated surface exactly: `install.sh`, `src/genie-commands/{uninstall.ts,update.ts,__tests__/update.test.ts}`, `src/genie.ts`, `src/lib/interactivity.ts`. **No file outside `skills/`, `.genie/wishes/skills-fable5-revamp/`, or G8's enumerated list.**
Omni A-files: 10 × `plugins/omni/skills/omni-ops/references/*.md`. Omni M-files: the 19 surface files, nothing else. **PASS.**

## SC9 — G8 code criteria

```
$ bash -n install.sh                                  # clean, exit 0
$ cd "$(git rev-parse --show-toplevel)" && bash -n install.sh && \
    grep -rqE 'detectV4|v4[A-Za-z]*[Cc]lean' src/genie-commands/ && \
    bun test $(ls src/genie-commands/*v4*.test.ts src/genie-commands/install.test.ts 2>/dev/null) && echo G8-OK
 16 pass / 0 fail (67 expect() calls, 2 files)        # legacy-v4.test.ts + install.test.ts, pgserve-free
G8-OK                                                 # bun test exit 0 (verified un-piped)
$ bun run lint
Checked 111 files in 38ms. No fixes applied.          EXIT: 0
$ bunx tsc --noEmit                                   EXIT: 0
```

**PASS** — G8 validation block from WISH.md runs verbatim to `G8-OK`; repo-wide biome and typecheck clean.

## SC10 — Dead-namespace grep repo-wide (genie skills/)

```
$ grep -rEn 'genie (agent|team|wish|events|project|metrics|spawn|sessions|send|chat|broadcast|dir)\b' skills/
(no output)                                          grep exit 1 = zero matches
```

**PASS** — the 118 stale daemon-era references are fully gone from the entire `skills/` tree (SKILL.md + all sibling files).

---

## Cross-reference audit

**1. genie `skills/omni/SKILL.md` ↔ omni plugin skills — PASS.** Its three pointers (`/omni:omni-setup` at lines 11/22/41/72, `/omni:omni-agent` at 12, `/omni:omni-ops` at 13) all name skills that exist in the omni worktree (`plugins/omni/skills/{omni-setup,omni-agent,omni-ops}/SKILL.md`). Every fenced command was re-verified against the live CLIs: `genie omni handshake --rotate/--hostname`, `status --json`, `inbox --unhandled`, `serve`, and **`genie omni test-approval [--live]`** all exist (`test-approval` is registered at `src/term-commands/omni.ts:523` and answers `--help`; it is merely omitted from the parent command's one-line description). `omni auth status`, `omni instances list`, `omni connect <instance-id> <agent-name>` confirmed against installed omni CLI 2.260704.3.

**2. wish / work / review mutual references — PASS.** `wish:47` hands to `/review` (plan) and never suggests `/work` directly ↔ `review:72` "Plan review (after /wish) → Proceed to /work"; `work:35` closes with "All work groups complete. Run /review." ↔ `review:37` Execution Review pipeline; the fix-loop limit is **2 everywhere** (`work:27` "max 2 loops", `work:82` "fix-loop limit (2)", `review:78` "max 2 fix loops", `fix:23-24` loop<2/loop=2, `fix:8`); verdict→next-step tables agree (`review:93` SHIP → orchestrator `genie task done` ↔ `work:30-32` done only after clean review AND validation); `review:81` → `/trace` before `/fix` ↔ `trace` description "reports root cause for /fix handoff". No skill cites a step another no longer has.

**3. omni commands → omni-ops § pointers — PASS.** Nine commands defer to omni-ops by § name; each § resolves to a routing-table row in `omni-ops/SKILL.md` AND an existing reference file: automate→§ Automations→`references/automations.md`; batch→§ Batch→`batch.md`; chats→§ Instances + § Batch; config→§ Config→`config.md`; events→§ Events→`events.md`; instances→§ Instances→`instances.md`; monitor→§ Instances; search→§ Events; trace→§ Events. `send.md` and `tts.md` defer to the **omni-agent** skill instead — correct, that is their canonical tier (verbs/send edge cases). All 10 routing rows ↔ all 10 files in `references/` (automations, batch, config, events, instances, persons, prompts, providers, routes, webhooks) — 1:1, nothing dangling in either direction.

**4. conventions.md accuracy — PASS after 1 fix.** § Preserve matches what shipped (verified throughout SC7); § Current CLI reality's task-namespace list (checkout/create/done/export/list/status) matches `genie task --help` exactly. One drift found: the live-surface list predated G8, which added `genie install` back (`src/genie-commands/install.ts`, registered in `genie --help`) — fixed in place (Fix 1). No skill fences `genie install`, so no skill/conventions contradiction existed.

**5. WISH.md internal consistency — PASS after 1 fix.** *Files to Create/Modify* ↔ actual commit set: every entry materialized (placeholders resolved: `genie-hacks/references/<catalog>.md` → `catalog.md` + `contributing.md`; `skills/*/references/<as needed>` → `pm/references/modes.md`, `report/references/issue-template.md`; omni `references/<domain>.md` → 10 files; G8 "modify/create" list matches the diff exactly, including the recreated `install.ts` and the `__tests__/update.test.ts` colocated test). *Review Results* correctly carries plan + delta reviews with the execution-review placeholder untouched. The *Status* field still read "ready for `/work`" after Wave 1 was fully committed — annotation updated in place (Fix 2), vocabulary (`DRAFT`) unchanged. Plan-time baseline counts drift from the merge-base measurement by 12 lines total on the genie side (largest: work 192→181, review 178→171, brainstorm 233→230; omni exact) — recorded here, WISH plan table left as historical record.

---

## Per-file line counts (36 surfaces, before → after)

**genie repo — 17 × `skills/*/SKILL.md`** (before per WISH.md; †= merge-base measures differently: shown as WISH/mb)

| File | Before | After | Δ | File | Before | After | Δ |
|------|--------|-------|---|------|--------|-------|---|
| refine | 803 | **48** | −94% | trace | 108/109† | **54** | −50% |
| genie-hacks | 626/627† | **47** | −92% | learn | 108 | **61** | −44% |
| pm | 395/396† | **108** | −73% | wish | 106/105† | **71** | −33% |
| report | 281/282† | **101** | −64% | docs | 82/83† | **43** | −48% |
| council | 258/259† | **107** | −59% | genie | 185/186† | **94** | −49% |
| brainstorm | 233/230† | **125** | −46% | omni | 164 | **74** | −55% |
| dream | 195/196† | **103** | −47% | wizard | 160/161† | **57** | −64% |
| work | 192/181† | **103** | −46% | review | 178/171† | **114** | −36% |
| fix | 111/112† | **75** | −32% | | | | |
| **genie total** | **4,185** (mb 4,173) | **1,385** | **−66.9%** | | | | |

**omni repo — 19 files under `plugins/omni/`** (before = merge-base, exact)

| File | Before | After | File | Before | After |
|------|--------|-------|------|--------|-------|
| skills/omni-ops | 484 | **41** | commands/instances | 24 | 25 |
| skills/omni-setup | 261 | **98** | commands/monitor | 25 | 25 |
| skills/omni-agent | 117 | **79** | commands/search | 23 | 25 |
| skills/omni | 53 | **38** | commands/send | 24 | 25 |
| commands/chats | 85 | **36** | commands/trace | 22 | 25 |
| commands/automate | 24 | 25 | commands/tts | 24 | 25 |
| commands/batch | 24 | 25 | agents/omni-automation-builder | 26 | 26 |
| commands/config | 24 | 25 | agents/omni-bot-framework | 28 | 26 |
| commands/events | 24 | 25 | agents/omni-feature-implementor | 26 | 25 |
| | | | rules/omni-agent | 11 | **12** |
| **omni total** | **1,329** | | | | **631** (−52.5%) |

**Combined: 5,514 → 2,016 (−63.4%), binding constraint ≤ 3,300 met with 1,284 lines of headroom.**
(Thin omni commands were normalized to 25 lines — a few grew by 1–3 lines to gain trigger text and an omni-ops pointer; all far under the 40-line ceiling. Bulk moved on demand: genie gained 5 new sibling files, omni gained 10 `omni-ops/references/` files — on-demand content is excluded from always-loaded totals by design.)

---

## In-scope fixes applied by G7 (uncommitted — orchestrator commits)

1. **`conventions.md` § Current CLI reality** — added `install` to the live genie v5 surface list with a G8 attribution note (list predated G8's recreation of the `genie install` finisher; without the fix the doc contradicted the shipped CLI).
2. **`WISH.md` Status field annotation** — updated from "ready for `/work` (dispatch gate: G7 last)" to reflect reality: Wave 1 (G1–G6, G8) committed, G7 verification complete, awaiting execution review. Status vocabulary word (`DRAFT`) unchanged — flipping it belongs to the execution `/review`.

## Notes / documented exceptions (no action required)

- `plugins/omni/rules/omni-agent.md` carries no frontmatter — identical to its baseline format; conventions.md requires frontmatter for SKILL.md only (SC1 exception, detailed above).
- WISH.md plan-time genie baselines differ from the merge-base measurement by 12 lines total (0.3%); omni baselines are exact. Both baselines yield −63.4% reduction.
- `genie omni --help`'s parent description omits `test-approval` from its summary line although the subcommand exists and is documented in `skills/omni/SKILL.md` — CLI cosmetic, source surface out of wish scope.

## Gaps

None. No structural violations found; both branches are lint-clean and PR-ready.
