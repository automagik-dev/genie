# Group 3 evidence — explore microagent + mining harness

Live capture backing the Group 3 acceptance boxes. Host: this machine,
`~/prod/rlmx` on `wish/rlmx-explore-offload`, 2026-07-26. `KHAL_API_KEY` is
env-only and appears in no tracked file.

Everything below was re-run on the shipped code after the verifier's second
FIX-FIRST round. That round found that the *labels* on the checklist were not
backed by the checks behind them — 29 of 72 facts were "kind `line`", which
meant only "the cited line is not blank", and several `exact` facts were
anchored on a token that happened to sit near the citation rather than on the
claim's subject. The harness was corrected at the root and the suite re-mined;
the numbers here are from that suite, not the previous one. What changed and
what it removes is spelled out under AC2.

## AC1 — `rlmx_explore` visible and callable from `~/workspace`

The dogfood install lives at `~/workspace/.rlmx/agents/explore/` (workspace
convention, shadows global) and is byte-identical to
`examples/agents/explore/`. An MCP client spawned in `/tmp` against
`rlmx mcp --dir /home/namastex/workspace` sees it and calls it:

```
rlmx mcp: 4 microagents discovered (changelog, codebase-qa, explore, log-triage)
tools: rlmx_query, rlmx_changelog, rlmx_codebase-qa, rlmx_explore, rlmx_log-triage
rlmx_explore listed: true
description: Launch the "explore" rlmx agent to handle a task autonomously. Answers a
question about the codebase in the server's working directory and returns the answer wi…

isError: false
The explore agent declares model `khal/deepseek-v4-flash` on line 9 of `.rlmx/agents/explore/agent.yaml`.

Citations:
- .rlmx/agents/explore/agent.yaml:9 — the model declaration

---
rlmx · agent=explore · khal/deepseek-v4-flash · 6 iterations · 8,413 in / 1,265 out · $0.0014 · 23.0s · session sess_b5a0ce722a0713c3
structuredContent: {"session_id":"sess_b5a0ce722a0713c3"}
```

`~/workspace/.rlmx/agents/explore/agent.yaml:9` is `model: khal/deepseek-v4-flash`
— the citation resolves and the answer is right.

## AC2 — ≥5 mined tasks, each with a repo-verified required-facts checklist

```
$ node scripts/mine-explore-tasks.mjs
# mine-explore-tasks: 2 selectable task(s) in 24h (3 candidate(s), floor is 5, caps 2/session 3/repo) — widening to 168h
# mine-explore-tasks: scanned 613 transcript(s) over 168h → 8 explore-class task(s), writing 6 from 4 session(s) across 2 repo(s)
#  1. score 76 · 14 facts · 19 read ops · ~/prod/brain · Read-only exploration of /home/namastex/prod/brain (do NOT e
#  2. score 63 · 10 facts · 19 read ops · ~/workspace/repos/genie · In the repo /home/namastex/workspace/repos/genie (branch dev
#  3. score 56 · 11 facts · 15 read ops · ~/prod/brain · In /home/namastex/prod/brain (READ-ONLY — never edit), map t
#  4. score 55 · 12 facts · 11 read ops · ~/prod/brain · In /home/namastex/prod/brain (read-only, do not edit anythin
#  5. score 45 · 5 facts · 17 read ops · ~/workspace/repos/genie · In the repo /home/namastex/workspace/repos/genie (branch dev
#  6. score 36 · 8 facts · 6 read ops · ~/workspace/repos/genie · Repo: /home/namastex/workspace/repos/genie (branch dev, clea
#  — skipped (cap 2 per session) score 43 · ~/prod/brain · In /home/namastex/prod/brain (READ-ONLY — never edit), verif
# mine-explore-tasks: wrote 6 task file(s) to …/tasks
```

6 task files, 60 required facts (14, 10, 11, 12, 5, 8) drawn from **106** in-root
`path:line` citations, 0 cross-tree claims — every scored fact is reachable from
the single `--dir` the rlmx arm gets. 40 further citations were checked and
**excluded**, each listed in its task file with the reason.

### What a fact now has to survive

Every fact is a `path:line` claim the native answer made about the task's own
root, and it is emitted only when a **term the claim itself supplies** — an
identifier it names or a fragment it quotes — is still in that file *and* is
specific enough to point at a line (a term occurring on more than 8 lines, or
more than 5% of the file, anchors nothing and is rejected). The term is printed
next to the evidence, so the link between the claim and the quoted line is
auditable rather than asserted:

```
- [ ] **F3** (re-anchored) `scripts/build-binary.sh:161`
  - claim: - **Yes, it uses `-C "${STAGE}" .`** — archiving `.` from inside the staging dir, …
  - anchored on: quoted `-C "${STAGE}" .` — 1 line in this file
  - verified: `tar czf "${TARBALL}" -C "${STAGE}" .`
  - drift: native cited :73; `-C "${STAGE}" .` is at :161 today
```

Kinds across the suite: **43 `exact`, 17 `re-anchored`, 0 of anything weaker.**
Spot-check of five facts against the live trees (`sed -n '<line>p' <file>`), all
matching the quoted evidence exactly:

| Fact | Anchor | File says |
|------|--------|-----------|
| 1.md F7 | `brain/src/lib/cache.ts:69` | `inputPerToken: 0.0000015, // gpt-4o-mini: $0.15/1M` |
| 3.md F2 | `brain/src/lib/server.ts:244` | `const port = opts.port ?? 3847;` |
| 5.md F1 | `genie/.github/workflows/build-tarballs.yml:34` | `workflow_call:` |
| 5.md F3 | `genie/scripts/build-binary.sh:161` | `tar czf "${TARBALL}" -C "${STAGE}" .` |
| 2.md F2 | `genie/src/genie-commands/install.ts:353` | `const codexFailed = results.some((result) => result.runtime === 'codex' && !result.ok);` |

### What this round changed in the harness, and what it removes

- **No `line` facts.** A claim that names no identifier and quotes no fragment
  used to be emitted as kind `line`, verified by `line.replace(/[^\w]/g,'').length >= 4`
  — i.e. "the cited line is not blank", a fact about whitespace. Those claims
  are now dropped with that reason recorded. This is what removed
  `install.ts:156 → deliveryComplete: true,` and
  `uninstall.ts:3521 → console.log(` from the checklist: the first anchored a
  claim that quotes `const codexFailed = …` (which lives at `:353`, where the
  same claim is now anchored), the second a claim about a `confirm({…})` call
  that is `askConfirm` today.
- **Terms come from the claim, not from a window around it.** The old
  `symbolsNear()` harvested identifiers from up to 600 characters past the
  citation, so a sentence about a `tar` invocation could be "verified" by
  `STAGE` picked out of the code block below it. Terms are now read from the
  claim text as written into the task file.
- **A term must be selective.** `STAGE` occurs on 24 of `build-binary.sh`'s 231
  lines; matching it near a citation says only "somewhere in this file". The
  claim about `tar … -C "${STAGE}" .` is now anchored on the quoted command
  itself, at `:161` — the real `tar` line — instead of on `:150`, an unrelated
  `release-payload-version.ts --verify` call.
- **Whole-token matching for quoted fragments too**, not just identifiers: a
  quoted `genie install` no longer matches inside "genie installation".
- **Drift is recorded only when there was drift.** A sentence citing `:34` and
  `:139-144` in one breath is anchored at whichever of *its own* lines carries
  the term, labelled `exact`, with a note saying so. Two fabricated drift
  records (`workflow_call`, the `admit` job) are gone.
- **Claims are clipped on a word boundary** with an ellipsis, at 260 chars.
  26 of the previous 72 claims ended mid-token ("…assembled at `sc"), which
  criterion 1 — "the answer makes the same claim" — cannot be scored against.
- **Redaction no longer corrupts evidence.** The `API_KEY|SECRET|TOKEN|…` rule
  fired on ordinary code (`const apiKey = process.env.GEMINI_API_KEY;` →
  `[REDACTED]`), so three quoted lines did not match their files. The value is
  now tested for being an opaque literal before the pair is redacted; the
  shaped-secret rules (`sk-…`, `ghp_…`, JWT, AWS, Google, Bearer) are unchanged
  and unconditional. The suite contains **zero** `[REDACTED]` markers now, and
  no key appears in any file.
- **Suite diversity is capped**, at most 2 tasks per session and 3 per
  repository, with the window widening when the *diversified* suite is short.
  The previous suite drew 3 of 6 tasks from one 35-second stretch of one
  session; this one draws from 4 sessions, and `mining-run.json` records the
  one candidate that a cap displaced. Two repositories is what this corpus
  offers — the honest limit of "real tasks only", not a choice.

Everything the earlier rounds already fixed still holds and is verified by the
same run: review commissions rejected (a verdict is not a citation, WISH.md:66),
bare paths existence-checked but never scored, the task root chosen as the tree
the answer is *about*, and the native arm's own criteria 2 and 3 checked rather
than assumed (a task is not written if a citation into its root fails to
resolve).

Criterion 1 rounding is disclosed per task: ⌈0.9 × N⌉ is the wish's ≥90% bar,
and for N < 10 it rounds to every fact. Tasks 1–4 (14, 10, 11, 12 facts) allow
one miss; tasks 5–6 (5, 8) allow none, and each says so in its own rubric.

`tasks/mining-run.json` records both window attempts — 24h (42 transcripts, 3
candidates, 2 selectable) then 168h (613 transcripts, 8 candidates, 6
selectable) — and why the widening happened, so a reader can audit that it was
earned rather than chosen. The suite is mined from a live corpus: re-running on
a later day scans a different set of transcripts and can surface a different
task, so the committed files, not the script, are the frozen artefact Group 4
scores.

## AC3 — smoke question answered with resolvable citations

Group validation command, both arms live (`KHAL_API_KEY` exported in the shell
only):

```
$ npm run build && test "$(ls .genie/wishes/rlmx-explore-offload/tasks/*.md | wc -l)" -ge 5 \
    && node scripts/smoke-explore.mjs
# smoke-explore: ── arm station: station/Brain-35B ─────────────────
rlmx mcp: 1 microagent discovered (explore)
# smoke-explore: ✓ rlmx_explore discovered from <checkout>/.rlmx/agents/ via --dir
# smoke-explore: ✓ answered in 87.0s
# smoke-explore:   rlmx · agent=explore · station/Brain-35B · 10 iterations · 9,228 in / 1,401 out · $0.00 · 87.0s · session sess_948295e23bfdc77a
# smoke-explore:   ✓ src/mcp/agents.ts:57 → const override = process.env.RLMX_AGENTS_DIR?.trim();
# smoke-explore:   ✓ src/mcp/agents.ts:17 → * `RLMX_AGENTS_DIR` (colon-separated) replaces the defaults entirely.
# smoke-explore: ✓ 2/2 citations resolve to real lines
# smoke-explore: ✓ 2 grounded citations (cited line shares an identifier with the answer) in 10 iterations
# smoke-explore: ✓ 2 of those cite something the agent's own prompt never mentions (src/mcp/agents.ts:57, src/mcp/agents.ts:17)
# smoke-explore:   correctness (evidence, not gated): HIT — named RLMX_AGENTS_DIR and cited src/mcp/agents.ts
# smoke-explore: ── arm khal: khal/deepseek-v4-flash (reported, not gated) ─────────────────
# smoke-explore: ✓ answered in 58.9s
# smoke-explore:   rlmx · agent=explore · khal/deepseek-v4-flash · 10 iterations · 18,484 in / 1,388 out · $0.0031 · 58.8s · session sess_700573321b23a585
# smoke-explore:   ✓ src/mcp/agents.ts:57 → const override = process.env.RLMX_AGENTS_DIR?.trim();
# smoke-explore: ✓ 1/1 citations resolve to real lines
# smoke-explore: ✓ 1 grounded citation (cited line shares an identifier with the answer) in 10 iterations
# smoke-explore: ✓ 1 of those cites something the agent's own prompt never mentions (src/mcp/agents.ts:57)
# smoke-explore:   correctness (evidence, not gated): HIT — named RLMX_AGENTS_DIR and cited src/mcp/agents.ts

SMOKE PASS: station=station/Brain-35B (10 it, 2 citations resolved, 87.0s, correct=true);
            khal=khal/deepseek-v4-flash (10 it, 1 citation resolved, 58.9s, correct=true)
EXIT=0
```

### The check that actually catches recitation

The previous round sold `iterations >= 2` as the anti-recitation guard. It is
not one for the gating arm: a model that never emits `FINAL` runs to
`budget.max_iterations` and leaves through the forced final-answer path, so its
count saturates — `station/Brain-35B` reported exactly 10 in the run above —
and an assertion it cannot fail protects nothing. The floor is kept for what it
does do (it fails an answer written before any REPL output came back), and the
gate now rests on **prompt-independence**: at least one citation must resolve,
be grounded, *and* carry an anchor and a grounding identifier that appear
nowhere in `SYSTEM.md`, `agent.yaml`, or the question.

That one bites, and here it is biting. The historical leak — the answer to the
smoke question sitting in the agent's own prompt — was re-introduced for one
run and removed again:

```
$ printf '\nLEAK-TEST (temporary…): `RLMX_AGENTS_DIR` is read at src/mcp/agents.ts:57.\n' \
    >> examples/agents/explore/SYSTEM.md
$ node scripts/smoke-explore.mjs --no-khal
# smoke-explore:   rlmx · agent=explore · station/Brain-35B · 3 iterations · 5,480 in / 735 out · $0.00 · 44.3s
# smoke-explore:   ✓ src/mcp/agents.ts:57 → const override = process.env.RLMX_AGENTS_DIR?.trim();
# smoke-explore: ✓ 1/1 citations resolve to real lines
# smoke-explore: ✓ 1 grounded citation (cited line shares an identifier with the answer) in 3 iterations

SMOKE FAIL: no citation carries anything the prompt did not already contain —
src/mcp/agents.ts:57 are all traceable to SYSTEM.md, agent.yaml or the question,
so this answer is consistent with reciting the prompt
```

Resolution passed, grounding passed, the iteration floor passed at 3 — and the
run still failed, on the gating arm. The leak line was removed immediately
(`git diff` on `examples/agents/explore/SYSTEM.md` shows only the `FINAL_VAR`
wording change described below).

### The installed agent is no longer clobbered

`smoke-explore.mjs` writes `<checkout>/.rlmx/agents/explore/` and pins its
`model:` line. Previously, if that directory already existed, cleanup skipped it
and left the smoke copy in place — silently replacing a checkout's own explore
agent, with no backup. It is now copied aside and restored. Proven by planting a
sentinel (a different model, a shorter budget, and an extra `NOTES.md` the
recipe does not have) and running the gate over it:

```
$ md5sum .rlmx/agents/explore/* > /tmp/sentinel.md5
$ node scripts/smoke-explore.mjs --no-khal
# smoke-explore: • /home/namastex/prod/rlmx/.rlmx/agents/explore already exists — copied aside and restored on exit
…
$ md5sum -c /tmp/sentinel.md5
.rlmx/agents/explore/NOTES.md: OK
.rlmx/agents/explore/SYSTEM.md: OK
.rlmx/agents/explore/agent.yaml: OK
```

(That run also failed its own gate — the station model returned a prose
`FINAL(answer)`, which submits the literal word "answer". The recipe now says
so explicitly: outside a repl block only `FINAL_VAR(name)` reads a variable.
That is the one change to `SYSTEM.md` in this round.)

### Which arm gates

The station arm gates; the khal arm is run in full and reported. Whether *this*
model clears the bar on *one* question is a model result, and the parity suite
measures exactly that across six mined tasks with a tuning and escalation ladder
behind it (Group 4). A gate a cheap model fails intermittently stops being a
gate, so the khal arm prints `FAILED-NOT-GATED` and the script's exit code
follows the station arm.

## Full gate

```
$ npm run check   # tsc --noEmit — clean
$ npm run build   # clean
$ npm test        # tests 489 · suites 112 · pass 489 · fail 0
```
