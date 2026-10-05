# Evidence — Group 4: parity loop + report

Verbatim outputs behind [docs/parity-explore.md](../../../docs/parity-explore.md).
Every number in the report can be recomputed from the artifacts referenced here
without re-running a model, **with one stated exception**: 7 runs were re-run
after scoring and their answers overwritten before anyone read them back, so
claims that depended on that text have been withdrawn rather than restated. What
was wrong in the first publication of this file, and what could and could not be
repaired, is in [§11](#11-audit-pass--what-the-first-publication-got-wrong).

`KHAL_API_KEY` was exported in the shell only. It appears in no file, no
command recorded here, and no diff.

---

## 1. Ground truth re-verified before any run

The task files' checklists were mined by Group 3 and are **not modified by this
group**. Before scoring anything, every one of the 60 required-fact anchors was
reopened against its tree and checked to still carry its recorded line text —
the tripwire for ground truth drifting under the gate.

```text
$ node .genie/wishes/rlmx-explore-offload/parity/verify-native.mjs
task 1: 14/14 fact anchors still resolve with their recorded text
task 2: 10/10 fact anchors still resolve with their recorded text
task 3: 11/11 fact anchors still resolve with their recorded text
task 4: 12/12 fact anchors still resolve with their recorded text
task 5: 5/5 fact anchors still resolve with their recorded text
task 6: 8/8 fact anchors still resolve with their recorded text

NATIVE GROUND TRUTH VERIFIED
```

## 2. Native arm, criteria 2 and 3, by the same scorer

Criterion 1 is 100% by construction (decision 6 / P3). Criteria 2 and 3 were
re-derived mechanically from the recorded traces using the identical scorer:

```text
$ for n in 1 2 3 4 5 6; do node .genie/wishes/rlmx-explore-offload/parity/score-task.mjs --native $n; done
native task 1: chars=4029 cites=52 c2=PASS c3=PASS
native task 2: chars=4029 cites=12 c2=PASS c3=PASS
native task 3: chars=4029 cites=20 c2=FAIL bench/api.ts:900 (missing-file) c3=FAIL
native task 4: chars=4029 cites=27 c2=PASS c3=PASS
native task 5: chars=4029 cites=17 c2=PASS c3=PASS
native task 6: chars=4029 cites=14 c2=PASS c3=PASS
```

**The first publication of these numbers was wrong, in native's favour.** It
recorded `cites=2` for tasks 2, 3 and 4 because the extractor matched the native
trace with a non-greedy `` ```text\n([\s\S]*?)\n``` `` that stops at the first
*nested* code fence. Those three traces embed their own fenced snippets, so the
scorer saw 1,027 / 693 / 776 characters of them — 3.0k, 3.3k and 3.3k characters
per task never reached it. Meanwhile the rlmx arm was scored on 26–129 citations
across its full text. Fewer citations scored can only help an arm on criteria 2
and 3, so this was an undisclosed asymmetry running *toward* native, in a report
that claimed every disclosed asymmetry ran against rlmx. The extractor is now
bound to both delimiters of the block and the arm is re-scored above.

Two further things this exposes, both stated rather than corrected:

- **Every native trace is capped at 4,000 characters at mining time** (each ends
  `[… truncated at 4000 chars]`). The native arm is scored on the first 4,029
  characters of a much longer answer. For criterion 1 this is harmless — the
  checklist was lifted from the full answer — but for criteria 2 and 3 it means
  native's unscored citations cannot fail, which favours native.
- **With its whole visible trace scored, native fails criteria 2 and 3 on task
  3.** The citation is `bench/api.ts:900` (and `:919`). It is not a fabrication:
  `src/bench/api.ts` exists with 942 lines and both lines are real. It is a
  partial-path shorthand, and the scorer resolves bare basenames but not path
  suffixes — so writing *more* of the true path is penalised where writing less
  is forgiven. The convention was not rewritten to rescue it. Every run on both
  arms was additionally scored with suffix resolution
  (`SUFFIX_SHORTHAND=1`, `.score.suffix.json`); across all 97 recorded task-runs
  it flips exactly one rlmx run (`r3-flash-tune2` t1, which names 0 of 14 anchor
  files) and this native task. No task verdict moves on either arm.

**Scoring convention found here, not invented for convenience.** On the first
pass the native arm *failed* criterion 2 on tasks 1 and 6, on citations like
`embedding.ts:28` and `agent-sync.ts:6892` — bare basenames that the same answer
had already introduced in full (`src/lib/embedding.ts`, `src/lib/agent-sync.ts`).
Those are shorthand back-references, not claims that the file sits at the repo
root. The scorer now resolves a bare basename against the directory of every
directory-qualified path the answer itself supplies, then against a tree-wide
basename index. The rule was added because the ground-truth arm exposed it, and
it applies identically to the rlmx arm.

## 3. The whole gate, run by run

16 rounds × 6 tasks + 1 post-gate re-check = **97 recorded task-runs**.
`c2`/`c3` are the mechanical rubric; "anchors named" counts the task's anchor
files the answer mentions by **full path**, "basename bound" counts them by
basename as well (the citation convention accepts both, so both are printed);
"terms" counts facts whose anchoring identifier also appears.

**Every row is regenerated from the matched pair of files on disk.** In the
first publication seven rows took `iters`/`wall`/`cost` from one run and
`c2`/`c3`/anchors from another, because a re-run had overwritten the run JSON
after the score JSON was written. Every run JSON has since been re-scored and
the matrix regenerated; the affected rows (`r6-mimo-tune1` tasks 1/2/3/5/6 and
`r8-mimo-tune3` tasks 2/5) now describe the run that is actually on disk, which
is in most cases a worse one. `r6-partial-300s-cap` is included — it was
previously hidden by a filter in `matrix.mjs`. See §11.

| round | model | task | iters | wall | khal cost | c2 | c3 | anchors named | basename bound | terms |
|---|---|---|---|---|---|---|---|---|---|---|
| r1-flash-baseline | khal/deepseek-v4-flash | 1 | 10 | 101.5s | $0.0098 | PASS | PASS | 3/14 | 4/14 | 1 |
| r1-flash-baseline | khal/deepseek-v4-flash | 2 | 10 | 141.8s | $0.02 | PASS | PASS | 8/10 | 9/10 | 6 |
| r1-flash-baseline | khal/deepseek-v4-flash | 3 | 10 | 200.2s | $0.00 | PASS | PASS | 8/11 | 9/11 | 3 |
| r1-flash-baseline | khal/deepseek-v4-flash | 4 | 1 | 77.5s | $0.0007 | FAIL (8) | FAIL (8) | 2/12 | 2/12 | 1 |
| r1-flash-baseline | khal/deepseek-v4-flash | 5 | 1 | 156.5s | $0.0014 | PASS | PASS | 0/5 | 0/5 | 0 |
| r1-flash-baseline | khal/deepseek-v4-flash | 6 | 1 | 208.9s | $0.00 | PASS | PASS | 0/8 | 0/8 | 0 |
| r2-flash-tune1 | khal/deepseek-v4-flash | 1 | 16 | 282.7s | $0.02 | FAIL (1) | FAIL (1) | 5/14 | 5/14 | 3 |
| r2-flash-tune1 | khal/deepseek-v4-flash | 2 | 16 | 121.9s | $0.0086 | PASS | PASS | 8/10 | 9/10 | 6 |
| r2-flash-tune1 | khal/deepseek-v4-flash | 3 | 1 | 134.6s | $0.0009 | FAIL (13) | FAIL (8) | 4/11 | 4/11 | 0 |
| r2-flash-tune1 | khal/deepseek-v4-flash | 4 | 14 | 249.4s | $0.02 | PASS | PASS | 0/12 | 0/12 | 0 |
| r2-flash-tune1 | khal/deepseek-v4-flash | 5 | 7 | 300.2s | $0.0086 | PASS | PASS | 0/5 | 0/5 | 0 |
| r2-flash-tune1 | khal/deepseek-v4-flash | 6 | 1 | 303.4s | $0.00 | PASS | PASS | 0/8 | 0/8 | 0 |
| r3-flash-tune2 | khal/deepseek-v4-flash | 1 | 16 | 188.7s | $0.01 | FAIL (1) | FAIL (1) | 0/14 | 3/14 | 2 |
| r3-flash-tune2 | khal/deepseek-v4-flash | 2 | 16 | 180.8s | $0.01 | PASS | PASS | 8/10 | 9/10 | 5 |
| r3-flash-tune2 | khal/deepseek-v4-flash | 3 | 1 | 116.1s | $0.0010 | FAIL (1) | PASS | 4/11 | 4/11 | 0 |
| r3-flash-tune2 | khal/deepseek-v4-flash | 4 | 1 | 306s | $0.00 | PASS | PASS | 0/12 | 0/12 | 0 |
| r3-flash-tune2 | khal/deepseek-v4-flash | 5 | 16 | 67.8s | $0.0074 | PASS | PASS | 2/5 | 2/5 | 0 |
| r3-flash-tune2 | khal/deepseek-v4-flash | 6 | 1 | 303.1s | $0.00 | PASS | PASS | 0/8 | 0/8 | 0 |
| r4-flash-tune3 | khal/deepseek-v4-flash | 1 | 10 | 128.9s | $0.02 | PASS | PASS | 0/14 | 0/14 | 0 |
| r4-flash-tune3 | khal/deepseek-v4-flash | 2 | 16 | 89.7s | $0.0067 | PASS | PASS | 1/10 | 3/10 | 1 |
| r4-flash-tune3 | khal/deepseek-v4-flash | 3 | 16 | 75.9s | $0.01 | PASS | PASS | 4/11 | 5/11 | 3 |
| r4-flash-tune3 | khal/deepseek-v4-flash | 4 | 6 | 174.8s | $0.02 | PASS | PASS | 0/12 | 0/12 | 0 |
| r4-flash-tune3 | khal/deepseek-v4-flash | 5 | 5 | 253s | $0.01 | FAIL (5) | FAIL (5) | 4/5 | 4/5 | 2 |
| r4-flash-tune3 | khal/deepseek-v4-flash | 6 | 16 | 144.5s | $0.0100 | PASS | PASS | 5/8 | 5/8 | 3 |
| r5-mimo-t0 | khal/mimo-v2.5 | 1 | 16 | 159.6s | $0.09 | PASS | PASS | 7/14 | 7/14 | 0 |
| r5-mimo-t0 | khal/mimo-v2.5 | 2 | 16 | 283.5s | $0.06 | PASS | PASS | 7/10 | 7/10 | 6 |
| r5-mimo-t0 | khal/mimo-v2.5 | 3 | 16 | 300.3s | $0.03 | PASS | PASS | 6/11 | 7/11 | 3 |
| r5-mimo-t0 | khal/mimo-v2.5 | 4 | 16 | 108s | $0.05 | PASS | PASS | 0/12 | 0/12 | 0 |
| r5-mimo-t0 | khal/mimo-v2.5 | 5 | 16 | 89.8s | $0.03 | PASS | PASS | 4/5 | 4/5 | 0 |
| r5-mimo-t0 | khal/mimo-v2.5 | 6 | 16 | 287.1s | $0.09 | PASS | PASS | 6/8 | 6/8 | 0 |
| r6-mimo-tune1 | khal/mimo-v2.5 | 1 | 2 | 900.8s | $0.03 | PASS | PASS | 0/14 | 0/14 | 0 |
| r6-mimo-tune1 | khal/mimo-v2.5 | 2 | 5 | 900.3s | $0.05 | PASS | PASS | 0/10 | 0/10 | 0 |
| r6-mimo-tune1 | khal/mimo-v2.5 | 3 | 6 | 900.5s | $0.08 | PASS | PASS | 0/11 | 0/11 | 0 |
| r6-mimo-tune1 | khal/mimo-v2.5 | 4 | 24 | 273.3s | $0.07 | PASS | PASS | 4/12 | 4/12 | 5 |
| r6-mimo-tune1 | khal/mimo-v2.5 | 5 | 16 | 900.2s | $0.16 | PASS | PASS | 0/5 | 0/5 | 0 |
| r6-mimo-tune1 | khal/mimo-v2.5 | 6 | 24 | 354.7s | $0.13 | PASS | PASS | 5/8 | 5/8 | 3 |
| r6-partial-300s-cap | khal/mimo-v2.5 | 1 | 22 | 300.4s | $0.10 | PASS | PASS | 0/14 | 0/14 | 0 |
| r6-partial-300s-cap | khal/mimo-v2.5 | 2 | 20 | 300.3s | $0.04 | PASS | PASS | 0/10 | 0/10 | 0 |
| r6-partial-300s-cap | khal/mimo-v2.5 | 3 | 21 | 300.4s | $0.12 | PASS | PASS | 0/11 | 0/11 | 0 |
| r6-partial-300s-cap | khal/mimo-v2.5 | 4 | 24 | 182s | $0.09 | PASS | PASS | 6/12 | 6/12 | 7 |
| r6-partial-300s-cap | khal/mimo-v2.5 | 5 | 2 | 300.3s | $0.03 | PASS | PASS | 0/5 | 0/5 | 0 |
| r6-partial-300s-cap | khal/mimo-v2.5 | 6 | 24 | 165.5s | $0.05 | PASS | PASS | 6/8 | 6/8 | 3 |
| r7-mimo-tune2 | khal/mimo-v2.5 | 1 | 24 | 467.4s | $0.16 | PASS | PASS | 7/14 | 7/14 | 3 |
| r7-mimo-tune2 | khal/mimo-v2.5 | 2 | 24 | 701.2s | $0.14 | PASS | PASS | 0/10 | 0/10 | 0 |
| r7-mimo-tune2 | khal/mimo-v2.5 | 3 | 23 | 438.5s | $0.12 | PASS | PASS | 0/11 | 0/11 | 0 |
| r7-mimo-tune2 | khal/mimo-v2.5 | 4 | 7 | 252.4s | $0.07 | PASS | PASS | 0/12 | 0/12 | 0 |
| r7-mimo-tune2 | khal/mimo-v2.5 | 5 | 24 | 147.5s | $0.08 | PASS | PASS | 4/5 | 4/5 | 2 |
| r7-mimo-tune2 | khal/mimo-v2.5 | 6 | 21 | 211.5s | $0.11 | PASS | PASS | 6/8 | 6/8 | 3 |
| r8-mimo-tune3 | khal/mimo-v2.5 | 1 | 24 | 157.8s | $0.10 | FAIL (1) | FAIL (1) | 10/14 | 10/14 | 7 |
| r8-mimo-tune3 | khal/mimo-v2.5 | 2 | 23 | 900.4s | $0.20 | PASS | PASS | 0/10 | 0/10 | 0 |
| r8-mimo-tune3 | khal/mimo-v2.5 | 3 | 19 | 208.4s | $0.11 | PASS | PASS | 8/11 | 8/11 | 4 |
| r8-mimo-tune3 | khal/mimo-v2.5 | 4 | 24 | 168.7s | $0.08 | PASS | PASS | 3/12 | 3/12 | 5 |
| r8-mimo-tune3 | khal/mimo-v2.5 | 5 | 24 | 588.3s | $0.11 | PASS | PASS | 0/5 | 0/5 | 0 |
| r8-mimo-tune3 | khal/mimo-v2.5 | 6 | 24 | 326.8s | $0.07 | PASS | PASS | 6/8 | 6/8 | 4 |
| r9-kimi-t0 | khal/kimi-code | 1 | 24 | 215.2s | $0.09 | PASS | PASS | 0/14 | 0/14 | 0 |
| r9-kimi-t0 | khal/kimi-code | 2 | 24 | 210.2s | $0.08 | PASS | PASS | 7/10 | 8/10 | 0 |
| r9-kimi-t0 | khal/kimi-code | 3 | 24 | 227.8s | $0.15 | PASS | PASS | 4/11 | 6/11 | 0 |
| r9-kimi-t0 | khal/kimi-code | 4 | 24 | 178.9s | $0.20 | PASS | PASS | 5/12 | 5/12 | 5 |
| r9-kimi-t0 | khal/kimi-code | 5 | 24 | 111.5s | $0.09 | PASS | PASS | 3/5 | 3/5 | 1 |
| r9-kimi-t0 | khal/kimi-code | 6 | 24 | 133.7s | $0.09 | PASS | PASS | 1/8 | 1/8 | 0 |
| r10-kimi-tune1 | khal/kimi-code | 1 | 24 | 124.8s | $0.16 | PASS | PASS | 2/14 | 3/14 | 1 |
| r10-kimi-tune1 | khal/kimi-code | 2 | 24 | 187s | $0.18 | PASS | PASS | 7/10 | 8/10 | 3 |
| r10-kimi-tune1 | khal/kimi-code | 3 | 24 | 113.4s | $0.09 | PASS | PASS | 0/11 | 0/11 | 0 |
| r10-kimi-tune1 | khal/kimi-code | 4 | 24 | 91.4s | $0.20 | PASS | PASS | 1/12 | 1/12 | 4 |
| r10-kimi-tune1 | khal/kimi-code | 5 | 24 | 83.8s | $0.07 | PASS | PASS | 0/5 | 0/5 | 1 |
| r10-kimi-tune1 | khal/kimi-code | 6 | 24 | 97s | $0.15 | PASS | PASS | 6/8 | 6/8 | 2 |
| r11-haiku-t0 | khal/claude-haiku | 1 | 3 | 180.2s | $0.19 | FAIL (24) | FAIL (24) | 0/14 | 0/14 | 1 |
| r11-haiku-t0 | khal/claude-haiku | 2 | 1 | 82.8s | $0.07 | FAIL (18) | FAIL (18) | 0/10 | 0/10 | 0 |
| r11-haiku-t0 | khal/claude-haiku | 3 | 7 | 135.7s | $0.31 | PASS | PASS | 5/11 | 5/11 | 2 |
| r11-haiku-t0 | khal/claude-haiku | 4 | 5 | 72.4s | $0.12 | PASS | PASS | 0/12 | 0/12 | 0 |
| r11-haiku-t0 | khal/claude-haiku | 5 | 5 | 213.5s | $0.34 | PASS | PASS | 2/5 | 4/5 | 2 |
| r11-haiku-t0 | khal/claude-haiku | 6 | 6 | 223.5s | $0.33 | PASS | PASS | 2/8 | 3/8 | 1 |
| r12-haiku-tune1 | khal/claude-haiku | 1 | 3 | 128.4s | $0.14 | PASS | PASS | 0/14 | 0/14 | 0 |
| r12-haiku-tune1 | khal/claude-haiku | 2 | 1 | 62.9s | $0.05 | FAIL (11) | FAIL (11) | 0/10 | 7/10 | 0 |
| r12-haiku-tune1 | khal/claude-haiku | 3 | 14 | 285s | $0.64 | PASS | PASS | 0/11 | 0/11 | 0 |
| r12-haiku-tune1 | khal/claude-haiku | 4 | 1 | 43.6s | $0.04 | FAIL (5) | FAIL (5) | 1/12 | 1/12 | 2 |
| r12-haiku-tune1 | khal/claude-haiku | 5 | 4 | 208.8s | $0.24 | PASS | PASS | 0/5 | 0/5 | 0 |
| r12-haiku-tune1 | khal/claude-haiku | 6 | 13 | 336.5s | $0.71 | PASS | PASS | 0/8 | 0/8 | 0 |
| r13-haiku-tune2 | khal/claude-haiku | 1 | 2 | 126.8s | $0.13 | FAIL (3) | FAIL (3) | 0/14 | 0/14 | 2 |
| r13-haiku-tune2 | khal/claude-haiku | 2 | 2 | 112.6s | $0.13 | FAIL (5) | FAIL (5) | 2/10 | 8/10 | 0 |
| r13-haiku-tune2 | khal/claude-haiku | 3 | 1 | 67.1s | $0.05 | FAIL (1) | FAIL (1) | 0/11 | 0/11 | 0 |
| r13-haiku-tune2 | khal/claude-haiku | 4 | 1 | 26.8s | $0.02 | FAIL (4) | FAIL (4) | 2/12 | 2/12 | 2 |
| r13-haiku-tune2 | khal/claude-haiku | 5 | 2 | 103.4s | $0.10 | FAIL (4) | FAIL (4) | 0/5 | 0/5 | 1 |
| r13-haiku-tune2 | khal/claude-haiku | 6 | 8 | 226.4s | $0.42 | PASS | PASS | 0/8 | 0/8 | 0 |
| r14-haiku-tune3 | khal/claude-haiku | 1 | 24 | 453.2s | $1.53 | FAIL (34) | FAIL (34) | 0/14 | 0/14 | 0 |
| r14-haiku-tune3 | khal/claude-haiku | 2 | 5 | 186.4s | $0.31 | PASS | PASS | 6/10 | 9/10 | 5 |
| r14-haiku-tune3 | khal/claude-haiku | 3 | 1 | 58.8s | $0.05 | FAIL (3) | FAIL (2) | 1/11 | 2/11 | 1 |
| r14-haiku-tune3 | khal/claude-haiku | 4 | 5 | 59.6s | $0.14 | PASS | PASS | 2/12 | 2/12 | 5 |
| r14-haiku-tune3 | khal/claude-haiku | 5 | 9 | 352.3s | $0.71 | PASS | PASS | 2/5 | 5/5 | 2 |
| r14-haiku-tune3 | khal/claude-haiku | 6 | 2 | 108.7s | $0.12 | FAIL (2) | FAIL (2) | 2/8 | 3/8 | 1 |
| r15-flash-control | khal/deepseek-v4-flash | 1 | 24 | 117.3s | $0.02 | PASS | PASS | 5/14 | 5/14 | 1 |
| r15-flash-control | khal/deepseek-v4-flash | 2 | 24 | 161.1s | $0.02 | PASS | PASS | 8/10 | 9/10 | 6 |
| r15-flash-control | khal/deepseek-v4-flash | 3 | 24 | 148.6s | $0.02 | PASS | PASS | 5/11 | 5/11 | 3 |
| r15-flash-control | khal/deepseek-v4-flash | 4 | 24 | 138.7s | $0.02 | PASS | PASS | 2/12 | 2/12 | 4 |
| r15-flash-control | khal/deepseek-v4-flash | 5 | 22 | 205s | $0.04 | PASS | PASS | 4/5 | 5/5 | 2 |
| r15-flash-control | khal/deepseek-v4-flash | 6 | 24 | 280.4s | $0.02 | PASS | PASS | 5/8 | 5/8 | 2 |
| r16-mimo-t2-recheck | khal/mimo-v2.5 | 2 | 24 | 294.8s | $0.07 | PASS | PASS | 8/10 | 9/10 | 2 |

### Reading the matrix

- **`c3` FAIL is fatal on its own** — one fabricated path fails the task
  whatever else it did (rubric criterion 3).
- **A tiny `chars` value with 0 citations** is the `FINAL(answer)` failure: the
  literal word `answer` submitted as the whole result. Fixed for good in
  `r8-mimo-tune3` by writing the answer inline as `FINAL("""…""")`.
- **`0 in / 0 out` after ~300s** in `r2`/`r3` is the gateway-congestion
  artefact, not a model result; see *Environment corrections* in the report.

## 4. Criterion 1, judged fact by fact

The anchor-file count is used to **screen**, not to score. It is printed two
ways (full path, and basename — the citation convention accepts both), and every
run reaching its task's threshold on *either* column is judged fact by fact
below. Under the full-path column **no run in the gate reaches its threshold**;
under the basename column eight do.

```text
                              best c2/c3-clean run   full  basename  need
task 1   r7-mimo-tune2                                 7      7       13
task 2   r15-flash-control                             8      9        9   ← judged
task 3   r1-flash-baseline                             8      9       10
task 4   r6-partial-300s-cap                           6      6       11
task 5   r15-flash-control                             4      5        5   ← judged
task 6   r8-mimo-tune3                                 6      6        8
```

Tasks 1, 3, 4 and 6 are screened out on both columns. Corrected margins
(final-review audit; the original "4 to 5 facts" claim was wrong for tasks
1, 3 and 6): task 1 = 6, task 3 = 2 strict / 1 basename, task 4 = 5,
task 6 = 2. Task 3's closest run (`r1-flash-baseline`) was judged at audit:
7 strict / 9 generous against threshold 10 — still FAIL (see
docs/parity-explore.md, screening section). For the remaining screened rows
the bound argument holds in its strong form: an answer that
never mentions the file a fact is about cannot state that fact. Tasks 2 and 5
reach their thresholds on the basename column, so they are judged — as are the
four other task-2 runs that do the same, and the post-gate re-check.

> **Withdrawn.** The first publication judged task 2 on `r8-mimo-tune3` and
> reported 7 of 10. That run was re-run after scoring and its 18,841-character
> answer overwritten; a 1-character answer sits in its place. The judgement
> cannot be re-derived from anything on disk, so it is withdrawn rather than
> restated, and task 2 is re-judged below on `r15-flash-control`, whose text is
> intact. See §11.

### Task 2 — the five clean runs that reach the basename bound

Threshold 9 of 10. `F3` (`syncOneSkill`) is stated by **no run in any round**,
so 9 is the ceiling before judging begins; `F6` (`stampWorkflowTemplate`) is
stated by no run either, which caps four of the five at 8.

| Run | chars | Strict | Generous | Facts never stated |
|-----|-------|--------|----------|--------------------|
| `r15-flash-control` (flash) | 12,435 | **6** | **8** | F3, F6 |
| `r1-flash-baseline` (flash) | 6,564 | 6 | 8 | F1, F3 |
| `r3-flash-tune2` (flash) | 9,333 | 6 | 8 | F3, F6 |
| `r2-flash-tune1` (flash) | 8,735 | 5 | 7 | F1, F3, F6 |
| `r14-haiku-tune3` (haiku) | 4,229 | 4 | 7 | F3, F4, F6 |
| `r16-mimo-t2-recheck` (mimo, post-gate) | 37,987 | 1 | 5 | F1, F3, F4, F6, F7 |

**None reaches 9.** The high-water mark of the entire gate is `r15-flash-control`
at 8 generous, one short, and 6 strict, three short.

`r15-flash-control`, fact by fact:

| Fact | Anchor | Stated? |
|------|--------|---------|
| F1 | `runtime-integrations.ts:2171` — childCwd fed by `const cwd = options.cwd ?? process.cwd()` | **generous only** — says "forbidden roots from the calling process's `childCwd` (typically `process.cwd()`)"; never names `runtime-integrations.ts` or `options.cwd` |
| F2 | `install.ts:353` — `codexFailed` gates agent-sync | YES — quotes the assignment and the `if (!codexFailed)` skip branch |
| F3 | `agent-sync.ts:3521` — `syncOneSkill` | **NO** — `syncOneSkill` 0 occurrences, no per-skill sync described |
| F4 | `doctor.ts:984` — `sourceDigest === managedDigest && computeDirDigest(dir) === managedDigest` | YES — quoted verbatim and all three digests explained |
| F5 | `council.js:23` — template ships unstamped, `__GENIE_LENS_ROOT__` | YES |
| F6 | `agent-sync.ts:5078` — stamping lives in `stampWorkflowTemplate` | **NO** — discusses LENS_ROOT staleness and doctor's regex but never locates the stamping function |
| F7 | `doctor.ts:1001` — `councilStampState` | YES |
| F8 | `interactivity.ts:22` — `isInteractive` | YES |
| F9 | `uninstall.ts:3468` — `uninstallCommand` never consults `isInteractive` | **generous only** — asserts the substance but hedges it ("I did not find the uninstall prompt itself within the iteration budget") and never names `uninstallCommand` |
| F10 | `install.ts:353` — agent-sync scope gated on a codex-only flag under `auto` | YES |

**6 strict, 8 generous. Threshold 9. FAIL under both.**

`r1-flash-baseline` is the only other run worth spelling out, because it misses
just one *term*: it states F2, F5, F7, F8, F9 and F10 outright, reaches F4 and
F6 generously (it names `stampWorkflow` at `agent-sync.ts:4977` — a real
function, the exported caller of `stampWorkflowTemplate` — not the fact's
subject), and fails F1 outright by attributing the cwd to
`classifyCodexInstallDefault` at a line that holds `addGitMarkerRoots(...)`.
**6 strict, 8 generous. FAIL.**

The post-gate `r16-mimo-t2-recheck` is the largest answer in the gate at 37,987
characters and one of the weakest: it names 8 of 10 anchor files while its text
is mostly unfinished planning ("We need to find where the uninstall command
prompts the user"), so it states almost nothing. It is a fresh data point, **not
a reproduction of r8** — r8's prompt was never snapshotted and no longer exists.

### Task 5 — the two clean runs that reach the basename bound

Threshold 5 of 5: every fact, no miss allowed.

- **`r15-flash-control`** (14,568 chars): states **F1** (build-tarballs.yml
  triggered by `workflow_call` from release.yml) and **F3** (quotes
  `tar czf "${TARBALL}" -C "${STAGE}" .` at `build-binary.sh:161` with the `./`
  root-entry consequence). Misses **F2** — never gives the tarball naming
  (`TARBALL="${DIST_DIR}/genie-${VERSION}-${PLATFORM}.tar.gz"`, `:65`); **F4**
  generously only (says "Dev CI success → dev release" but never the `:69` gate,
  `conclusion == 'success'`, or the `[auto-version]` exclusion); and **F5**
  outright — it places the `admit` job in `release-publish.yml`, not
  `sign-attest.yml`, and "Bind caller workflow and control commit" appears
  nowhere. **2 strict, 3 generous. FAIL.**
- **`r14-haiku-tune3`** (5,594 chars): states **F1**, **F2**
  (`build-binary.sh:65` with `dist/genie-${VERSION}-${PLATFORM}.tar.gz`) and
  **F3**. Misses **F4** on the same grounds, and **F5** outright — `sign-attest`
  appears only as a link in a call chain, `admit` 0 occurrences. **3 strict, 4
  generous. FAIL.**

**F5 is stated by neither**, which alone settles a 5-of-5 task.

### Task 6 — settled by the bound, and by one fact no run ever states

Threshold 8 of 8. The best clean runs (`r8-mimo-tune3`, `r7-mimo-tune2`,
`r6-partial-300s-cap`, `r4-flash-tune3`) all reach 6 of 8 anchor files. A probe
of every task-6 run for each fact's anchoring term — **an upper bound on the
judgement, not the judgement**, since a term can be present in a sentence that
makes a different claim:

```text
run                     F1 F2 F3 F4 F5 F6 F7 F8   terms present
r8-mimo-tune3            Y  Y  Y  Y  Y  -  Y  -      6/8
r7-mimo-tune2            Y  Y  -  Y  Y  Y  Y  -      6/8
r6-partial-300s-cap      Y  Y  -  Y  Y  Y  Y  -      6/8
r4-flash-tune3           Y  Y  -  Y  Y  Y  Y  -      6/8
r6-mimo-tune1            Y  Y  -  Y  Y  -  -  -      4/8
r15-flash-control        Y  Y  -  Y  Y  -  -  -      4/8
r10-kimi-tune1           -  Y  -  Y  -  -  Y  -      3/8
r5-mimo-t0               -  -  -  -  -  -  Y  -      1/8
```

**`F8` — the Claude Code plugin hooks (`plugins/genie/hooks/hooks.json`,
`SessionStart` → `session-context.cjs`) never trigger agent-sync — has its term
absent from every task-6 run in every round** (`SessionStart`, `hooks.json` and
`session-context` all score zero occurrences everywhere), and an 8-of-8 task
cannot survive one miss. **FAIL, in every round**, before any judgement call.

`r10-kimi-tune1`, the run the audit asked to see judged (3,169 characters):
misses F1 (Hermes/`$GENIE_HOME/skills` never discussed), F3 (`installCommand`),
F5 (`CLAUDE_EXCLUDED_SKILLS`), F6 (`MANIFEST_NAME` / managed-mirror removal) and
F8. **At most 3 of 8. FAIL.**

### Task 4 — relabelled

- **Task 4, `r6-partial-300s-cap`** (10,095 characters, 6 of 12 anchor files —
  the best task-4 answer in the gate): stated F1, F2, F5, F7, F8, F9, F10 =
  **7**. Missed F3 (`lazy-init.ts`), F4 (`server.ts:261`), F6 (the RUNBOOK
  line), F11 (`applyBrainGrants`, absent), F12 — and F12 is the interesting one:
  the native answer records "per-brain DB with dedicated owner" as a *future
  design goal* in `.genie/brainstorms/brain-lxc/DRAFT.md`, while this answer
  asserts it as current behaviour and answers the question "TRUE" outright.
  Threshold 11.

  > **Correction.** The first publication attributed this judgement to
  > `r6-mimo-tune1`. It does not fit that run: `r6-mimo-tune1/task-4.json` is
  > 5,436 characters, names 4 of 12 anchor files (F1 and F9 among the ones it
  > does *not* name), and does contain `applyBrainGrants`. It fits
  > `r6-partial-300s-cap/task-4.json` exactly — the round that was excluded from
  > the matrix and never mentioned. The judgement is sound; the label was wrong.
  > The round-log sentence "task 4 produced a 10k-character cited report through
  > exactly that path" had the same defect and is corrected in the report.

### Tasks judged for the record (verdict already settled by the bound)

- **Task 3, `r8-mimo-tune3`** (8 of 11 named): stated F1 (`Bun.serve` at
  `server.ts:395-400`), F2 (port 3847), F3 (`handleRequest`), F4
  (`POST /api/search` at `search.ts:10`), F6 (`extractPrincipal`, never
  denies), F7 (`BRAIN_ENDPOINT` at `active-brain.ts:72`), F8 (DSN-direct via
  `getDb()`), F10 (stdio MCP + Postgres-direct) = **8**. Missed F5 (the
  `/api/brains/:id/ask` route — the answer lists a different `/api/ask`), F9
  (`BRAIN_ADMIN_DATABASE_URL` absent; generous reading rescues this one → 9),
  F11 (`compiled-entry.ts` / `discoverHookBaseUrl`, absent). Threshold 10.
- **Task 6, `r4-flash-tune3`** (5 of 8 named): stated F3, F4, F5, F6 = **4**.
  Missed F1 (contradicts it — says `syncHermes` "continues syncing bare-name
  skills" rather than stating that Hermes never reads `~/.claude/skills` and is
  pointed at `$GENIE_HOME/skills` via `skills.external_dirs`), F2 (the
  `~/.genie/.last-agent-sync` marker — absent; only `runAgentSyncSafe` appears),
  F7 (`genie setup` not mentioned; `acquireLifecycleLease` attributed to
  `install.ts:19`), and F8 (no mention of the plugin hooks at all). Threshold 8.

  > **Corrected.** The first publication credited this run with F8 and scored it
  > 5. `SessionStart`, `hooks.json` and `session-context` have zero occurrences
  > in its answer, so F8 cannot have been stated. The verdict was FAIL either
  > way; the count was one too high.

## 5. Verbatim runs — the final round of the strongest tier

`r15-flash-control` (`khal/deepseek-v4-flash`, final prompt, corrected
environment — the best round of the gate, and the one task 2's and task 5's
judgements now rest on) and `r8-mimo-tune3` (`khal/mimo-v2.5`, the strongest
mimo round, **two of whose six records were overwritten** — tasks 2 and 5 below
are the surviving 1-character and 576-character runs, not the answers the first
publication scored). Answers are truncated at 2,200 characters with the elision
marked; the full text of every run is in
`.genie/wishes/rlmx-explore-offload/parity/runs/<round>/task-<n>.json`.

### Round `r15-flash-control`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/deepseek-v4-flash r15-flash-control
rlmx · agent=explore · khal/deepseek-v4-flash · 24 iterations · 59,901 in / 8,788 out · $0.02 · 116.9s · session sess_8fec0fd6c5ce1516
```

Returned answer (14406 chars):

```text
# Structured Report on /home/namastex/prod/brain

## 1. Cloud Model / Provider Dependencies

### Gemini Embeddings
The sole embedding provider is Google Gemini. The default model is `gemini-embedding-2-preview` with 768 dimensions (Matryoshka L2-normalized). The file `src/lib/embedding.ts` implements the embedding client:

- **Model**: `DEFAULT_MODEL = "gemini-embedding-2-preview"` (src/lib/embedding.ts:28). Configurable via `brain.json` field `embedModel` (default `"gemini-embedding-2-preview"` at src/lib/brain-config.ts:91).
- **Dimensions**: `DEFAULT_DIMS = 768` (src/lib/embedding.ts:29). Configurable via `dims` parameter; schema defaults in migrations: `vector(768)` in `src/db/migrations/005-brain-embeddings.sql:21` and `src/db/migrations/021-brain-pgvector-retry.sql:53`.
- **Task types**: 8 enumerated types in `EmbeddingTaskType` (src/lib/embedding.ts:18-26): `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, `SEMANTIC_SIMILARITY`, `CLASSIFICATION`, `CLUSTERING`, `QUESTION_ANSWERING`, `FACT_VERIFICATION`, `CODE_RETRIEVAL_QUERY`. Task type is prefixed into the text for v2 models (applyV2TaskPrefix at src/lib/embedding.ts:51-72) or passed as `taskType` field for v1 models (embedText at src/lib/embedding.ts:137,153). Default task type is `RETRIEVAL_DOCUMENT` (line 137).
- **API call**: POST to `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}` (line 142). Batch endpoint `:batchEmbedContents` (line 215).
- **Fallback**: If embedding API fails or is disabled, returns `null` and falls back to BM25-only search (lines 166-171, 241-246). No local embedding fallback in `src/` code.

### rlmx Usage
The repository uses an `rlmx` agent bridge. The file `src/agent/rlmx-bridge.ts` manages the decision to use the rlmx SDK. Configuration flags:
- `rlmx_mode` in agent YAML manifests (rlmx-bridge.test.ts:41-43)
- Environment variable `BRAIN_USE_RLMX_SDK` (rlmx-bridge.test.ts:54-77)
- Precedence: YAML explicit `false` wins; env `0` is kill-switch over YAML `true`.

Default models for rlmx agents are specified in `runbooks/custom-rlmx-agents.md` where examples use `gemini-3.1-flash-lite-preview` (lines 118,191,236,281). The Gemini model pricing 
[… 12206 more chars]
```

Mechanical rubric — citations extracted: 75; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/deepseek-v4-flash r15-flash-control
rlmx · agent=explore · khal/deepseek-v4-flash · 24 iterations · 68,454 in / 11,585 out · $0.02 · 160.8s · session sess_68c8989645d1c653
```

Returned answer (12435 chars):

```text
**Structured Summary: Three defects in `genie` (branch `dev`)**

---

### Defect A — "Refusing repository-local codex CLI executable: ~/.local/bin/codex" – *and* consequent agent-sync skip

**Observation**: A fresh `genie install --integrations auto` can reject a `codex` found at `~/.local/bin/codex` as "repository-local", even when the binary is in the user's own home directory. This causes codex integration to fail, which in turn suppresses ALL agent-sync (Claude, Hermes) under the `--integrations auto` path.

**Root cause** (two parts):

**A1 — Executable rejection logic** (`src/lib/trusted-executable.ts:136-148`):

The function `validateTrustedExecutablePath` builds a set of *forbidden roots* from the calling process's `childCwd` (typically `process.cwd()`) and every enclosing git trust root walked upward from it (`resolveEnclosingGitTrustRoots`, lines 96-118). These are filtered to exclude roots that are *within* the user's home (`canonicalHome`). If the `childCwd` or a parent git root is **not under home** (e.g., a repo cloned under `/tmp` or a symlinked workspace), and the candidate executable path falls anywhere inside that root tree, the binary is rejected with `"Refusing repository-local … executable"`.

The user's suspicion is close but one detail off: it is not *any* path under `cwd()` that gets refused — only paths under a *git trust root* (the cwd or any enclosing `.git`-marked parent) that is **outside home**. The scenario that hits this: running genie from a repo outside `~` while `Bun.which('codex')` finds a binary under that repo tree, or more commonly, when the `.git` of a dotfiles repo at `/home/user/.git` is the cwd's enclosing git root but the `canonicalHome` resolution fails to filter it (e.g., `safeCanonical` error fallback or symlink mismatch).

**A2 — Agent-sync suppressed by codex failure** (`src/genie-commands/install.ts:353-369`):

After integration results are collected, the code at line 353 sets `codexFailed = results.some(r => r.runtime === 'codex' && !r.ok)`. At lines 361-368, if `codexFailed` is true AND selection is `'auto'`, agent-sync is **entirely skipped** — including Claude and Hermes — with the message:
```
  ! Skipped ag
[… 10235 more chars]
```

Mechanical rubric — citations extracted: 30; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/deepseek-v4-flash r15-flash-control
rlmx · agent=explore · khal/deepseek-v4-flash · 24 iterations · 75,290 in / 5,163 out · $0.02 · 148.2s · session sess_5df21a4f56f17e49
```

Returned answer (7690 chars):

```text
I have only partial information — I was able to read the server entry point and route table but did not get to examine the MCP binary, the CLI commands' DB acquisition, or the full port-resolution logic. Here is what I *did* verify, with citations, and what remains unknown.

---

## 1. What `brain serve` starts and what it binds

`brain serve` starts a `Bun.serve` HTTP server:

```typescript
// src/lib/server.ts:395-400
state.httpServer = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: handleRequest,
    idleTimeout: 255,
});
```

**The default port is "auto-assigned"** per `src/lib/help-templates.ts:130`:
```
--port <n>     HTTP server port (default: auto-assigned)
```
I did *not* get to read the `port` variable resolution to see whether "auto-assigned" means a random free port, or whether there is a fallback number. The test file `src/lib/active-brain.test.ts:21,27,59,65` hardcodes `3847` as the expected port, and the k8s deploy likewise uses `3847`, so the *de facto* default is **3847** when it isn't auto-assigned.

**The hostname is hardcoded `"0.0.0.0"`** (line 397). There is no env var I found in the 2-iteration budget to override this. The `BrainServerOptions` interface (line 54-80) has a `port` field but no `hostname` field. **No env var like `BRAIN_HOST` or `BIND_ADDRESS` exists in the code I searched** — I grepped `BRAIN_SERVER|BRAIN_HOST|BRAIN_PORT|SERVER_URL` and found nothing binding-address related. **The bind host is not configurable by env var; it is hardcoded to 0.0.0.0.**

## 2. HTTP routes exposed

From `src/lib/server.ts:940-1019` (`handleRequest`), the routes are:

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/healthz` | `handleHealthz` | K8s probe |
| GET | `/readyz` | `handleReadyz` | K8s probe |
| GET | `/api/sync/status` | `handleSyncStatus` | Sync status |
| GET | `/api/review/feed` | `handleReviewFeed` | Review API |
| POST | `/api/review/classification/:id` | `handleReviewVote` | Review API |
| GET | `/api/brains/:id/schema` | `handleBrainSchema` | Brain schema |
| POST | `/khortex/session/event` | `handleKhortexSessionEvent` | Gated on `--khortex-memory` |
| POST | `/khortex/session/query
[… 5490 more chars]
```

Mechanical rubric — citations extracted: 26; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/deepseek-v4-flash r15-flash-control
rlmx · agent=explore · khal/deepseek-v4-flash · 24 iterations · 106,394 in / 5,959 out · $0.02 · 138.5s · session sess_26c3e69d68f646a4
```

Returned answer (4897 chars):

```text
## Ground Truth: brain's database topology

**Answer: TRUE** — the codebase's existing model is per-brain database `brain_<slug>` with a dedicated per-brain role.

### What the code does

1. **Database name derivation** (`src/lib/pgserve.ts:89-108`):
   `deriveDatabaseName(slug)` sanitizes the slug and returns `brain_<slug>` (capped at 63 characters). This is used everywhere the per-brain DB is referenced.

2. **Per-brain database creation** (`src/lib/db.ts:376-467`):
   `ensureBrainDatabase(database)` runs `CREATE DATABASE "${database}"` (line 412 in DSN mode, line 458 with `OWNER "${runtimeRole}"` in autopg mode). It is idempotent — checks `pg_database` first. This is called during `startBrainServer` (`src/lib/server.ts:301`) and `rebuildBrain` (`src/lib/execute.ts:3407`).

3. **Single-tenant per process** (`src/lib/db.ts:276-282`):
   The comment says *"Brain is single-tenant: one brain per process. This single binding is sufficient."* `setActiveDatabase()` (line 291) closes the old connection pool and sets a new active database name; `getDb()` (line 602) uses that name to open a pool against the target database. A `brain serve` process talks to **one** per-brain database at a time, determined by the slug from its `brain.json`.

4. **Per-brain role** (`src/lib/db.ts:969-972`):
   `upsertBrain()` calls `ensureBrainRole(config.shortName)` (imported from `./rls.js`) to create a dedicated Postgres role per brain for row-level security. So each brain has its own credentials/role in addition to its own database.

5. **The `brains` table** (`src/db/migrations/001-brain-foundation.sql:9-29`):
   Every per-brain database contains a `brains` table. The brain's own row lives in its own per-brain DB. There is also a shared default database named `brain` that acts as a registry hub — when scanning for a brain across all databases, the code enumerates `datname LIKE 'brain_%' OR datname = 'brain'` (`src/lib/db.ts:1034`), and the comment at line 1011 says *"In practice hits the shared `brain` registry on the first scan because every hub registers there."* So **multiple brains are rows inside one registry DB**, but the primary data model is per-brain-database.

6. **DSN resol
[… 2697 more chars]
```

Mechanical rubric — citations extracted: 29; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/deepseek-v4-flash r15-flash-control
rlmx · agent=explore · khal/deepseek-v4-flash · 22 iterations · 197,337 in / 7,899 out · $0.04 · 204.7s · session sess_8388151bba24b130
```

Returned answer (14568 chars):

```text

## Genie Install / Release Delivery Path — Structured Report

---

### 1. `install.sh` at repo root

#### (a) Channel selection & manifest URL resolution

- **Channel is selected via the `GENIE_CHANNEL` environment variable**, defaulting to `stable`:
  - `install.sh:358`: `local channel="${GENIE_CHANNEL:-stable}"`
  - The `resolve_channel()` function at `install.sh:357-378` validates allowed values: `stable`, `homolog`, `dev`. Deprecated `next` and retired `beta`/`canary` map to `dev` with a warning.
- **Manifest URL resolution** (`resolve_manifest_url`, `install.sh:386-389`): stable → `latest.json`, everything else → `<channel>.json` (e.g. `dev.json`, `homolog.json`).
  - `install.sh:388`: `if [ "$channel" = "stable" ]; then file="latest.json"; else file="${channel}.json"; fi`
  - Base URL is `MANIFEST_BASE` defined at `install.sh:28`: `"https://raw.githubusercontent.com/${REPO}/main/.well-known"`
- **`install.sh` is fetched** via the documented one-liner at `README.md:23`:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
  ```

#### (b) Staging creation + `tar -xzf` extraction block (extract_and_link, `install.sh:632-663`)

- **Staging directory created**: `install.sh:634`: `STAGING_DIR="${TMP_DIR}/release-payload"`
- **Extraction**: `install.sh:641`: `tar -xzf "$tarball" -C "$STAGING_DIR" ||`
- **chmod after extraction**: **There IS a chmod after extraction**, but it relocks the staging **root** (not individual files), and it is explicitly noted as the only chmod:
  - `install.sh:649`: `chmod 700 "$STAGING_DIR" ||`
  - Comment at `install.sh:627-628`: `"Its only chmod relocks the private staging root it created to 0700 after extraction (tar clobbers that mode via the archived root entry); it never chmods a live path."`
  - The rationale at `install.sh:643-648` explains tar restores the archived `"./"` root entry's mode (0755 from the published tarball) onto the extraction directory, overwriting the 0700 they created.

**Conclusion**: There **is** a `chmod 700 "$STAGING_DIR"` after extraction, but it operates only on the staging root directory itself — not on individual files, and never on live production pat
[… 12368 more chars]
```

Mechanical rubric — citations extracted: 93; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/deepseek-v4-flash r15-flash-control
rlmx · agent=explore · khal/deepseek-v4-flash · 24 iterations · 70,243 in / 10,753 out · $0.02 · 280.1s · session sess_ce6d2f6f4a6cfd88
```

Returned answer (4292 chars):

```text
The hotfix is already implemented in this repository. Here is the structured report:

## Trigger Inventory — All Agent Sync Callers

**Primary callers** (both call `runAgentSyncSafe` → `runAgentSync` → `syncClaude`):

1. **`genie update` command** — `src/genie-commands/update.ts:1759` — the `sync` seam parameter defaults to `runAgentSyncSafe`. Called from the update command handler after codex lifecycle lease acquisition. Selection narrowing at lines 1736-1779 passes `'auto'`/`'all'`/`'claude'` through to agent-sync; returns `null` (skip) for `'codex'`/`'none'`.

2. **`genie install` command** — `src/genie-commands/install.ts:362` — `runSync(agentSyncSelection)` where `runSync` is bound to `runAgentSyncSafe` at line 330. Gated by `narrowAgentSyncSelection(selection)` at line 359; only fires when selection is non-null.

3. **`genie doctor`** — `src/genie-commands/doctor.ts` — imports `CLAUDE_EXCLUDED_SKILLS` from agent-sync.ts (line 90 of agent-sync.ts) for freshness validation. Does **not** call `runAgentSync` — it reads `.genie-sync.json` manifests to check state.

4. **`genie uninstall`** — `src/genie-commands/uninstall.ts:61` — imports `acquireAgentSyncLock` and `allocateExclusiveBackupRoot`. Acquires lock (lines 1586-1597) to protect removal of managed assets. Does not call `runAgentSync`.

5. **Hooks** (`src/hooks/`), **src/genie.ts** — no agent-sync references found.

6. **Core engine** — `src/lib/agent-sync.ts:6927-6962` (`runAgentSync`). At line 6952: `selection === 'auto' | 'all' | 'claude'` → `syncClaude(ctx, report)`. At line 6955: `selection === 'auto' | 'all'` → `syncHermes(ctx, opts, report)`. No `'codex'` arm (retired per comment at lines 5687-5696).

## The Hotfix — Already in Place

**`src/lib/agent-sync.ts:5645-5669`** — `syncClaude` function:
- Line 5649: Checks plugin status via `claudeGeniePluginEnabled(join(claudeDir, 'settings.json'))`.
- Lines 5656-5658: If plugin enabled, exclude ALL source skills (`new Set(enumerateSourceSkills(ctx.pluginRoot).map(s => s.name))`) — `syncSkillDirsInto` sees empty source set and prunes existing managed mirrors while preserving user-edited/unmanaged dirs.
- Lines 5661-5665: Reports `{kind: 'skills-mirror',
[… 2092 more chars]
```

Mechanical rubric — citations extracted: 7; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.


### Round `r8-mimo-tune3`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/mimo-v2.5 r8-mimo-tune3
rlmx · agent=explore · khal/mimo-v2.5 · 24 iterations · 50,836 in / 9,341 out · $0.10 · 157.4s · session sess_2ae99f8a3084612c
```

Returned answer (19640 chars):

```text
<think>I need to provide the final answer now based on all the data I've gathered. Let me compile a comprehensive report.```repl
FINAL("""
# Brain Codebase Exploration Report — /home/namastex/prod/brain

## 1. Cloud Model/Provider Dependencies

### Gemini Embeddings
- **Primary embedding client:** `src/lib/embedding.ts`
  - Default model: `gemini-embedding-2-preview` (line 28)
  - Default dims: `768` (line 29, Matryoshka-wrapped to pgvector compat)
  - API endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent` (line 142)
  - 8 task types defined (lines 18-26): RETRIEVAL_DOCUMENT, RETRIEVAL_QUERY, SEMANTIC_SIMILARITY, CLASSIFICATION, CLUSTERING, QUESTION_ANSWERING, FACT_VERIFICATION, CODE_RETRIEVAL_QUERY
  - API key: `process.env.GEMINI_API_KEY` or `process.env.GOOGLE_API_KEY` (line 94, 133)
  - Also tries `~/.rlmx/settings.json` for key (lines 120-131)
  - `embedText()` (line 109) and `embedBatch()` (line 199) — both use Gemini REST API directly
  - v2 models (`gemini-embedding-2*`) use text-prefix task encoding instead of `task_type` field (lines 36-38, 51-72)

- **Brain config embedModel/dims defaults:** `src/lib/brain-config.ts`
  - Default embedModel: `gemini-embedding-2-preview` (line 91, 105)
  - Default dims: `768` (line 93-97, 106)
  - Config schema: `EmbeddingsConfigSchema` (lines 80-99)
  - `embeddings.enabled: true` by default; `false` skips all embedding and falls back to BM25+trigram (lines 71-78)
  - Legacy flat `embedModel`/`embedDims` keys are lifted and stripped (lines 362-438)

- **Migrations (pgvector):**
  - `src/db/migrations/005-brain-embeddings.sql` — adds `embed_model TEXT DEFAULT 'gemini-embedding-2-preview'` to brain_documents (line 36) and brain_chunks (line 52)
  - `src/db/migrations/003-brain-identity.sql` — adds `embed_model` to brains table (line 36)
  - `src/db/migrations/021-brain-pgvector-retry.sql` — adds `embedding vector(768)` columns (lines 53, 61, 69) and HNSW indexes

- **DB-level vector column:** `src/db/migrations/010-brain-closed-loop.sql`
  - `brain_domain_embeddings` table with `embedding vector(768)` (line 21, 27)

### rlmx (Automagik rlmx SDK)
- **Package:** `package.json` line 45 —
[… 17440 more chars]
```

Mechanical rubric — citations extracted: 129; criterion 2 (citations resolve): **FAIL — helm/values-hml.yaml:54 (missing-file)**; criterion 3 (no fabrication): **FAIL — helm/values-hml.yaml:54 (missing-file)**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/mimo-v2.5 r8-mimo-tune3
rlmx · agent=explore · khal/mimo-v2.5 · 23 iterations · 54,687 in / 49,418 out · $0.20 · 900.0s · session sess_81d12614803bbf0e
```

Returned answer (1 chars):

```text


```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**;
criterion 3 (no fabrication): **PASS**.

> **This is the run the first publication called decisive, and it is empty.**
> The earlier text here printed the same 1-character body and then claimed
> "citations extracted: 44; criterion 2: PASS; criterion 3: PASS" — numbers that
> came from a *different* run of the same task (18,841 characters, 24 iterations,
> $0.23, 768.7s, `sess_bdd21c1bd9ad5b0e`) that had been scored and then
> overwritten by this one. The judged text is unrecoverable; its score JSON
> survives as `runs/r8-mimo-tune3/task-2.score.orphaned.json`. Task 2's ceiling
> is re-derived below from `r15-flash-control` instead. See §11.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/mimo-v2.5 r8-mimo-tune3
rlmx · agent=explore · khal/mimo-v2.5 · 19 iterations · 61,731 in / 13,802 out · $0.11 · 208.0s · session sess_cadc271694be7922
```

Returned answer (10735 chars):

```text
# Brain Serve HTTP Surface vs. CLI Transport — Feasibility Map

## 1. What `brain serve` Actually Starts

`brain serve` launches a **Bun.serve** HTTP server. The hostname is **hardcoded to `0.0.0.0`** — there is no `--host` flag, no `BRAIN_HOST` env var, no configurable binding host. The default port is **3847** (overridable with `--port`).

- `src/lib/server.ts:397` — `hostname: "0.0.0.0",` (hardcoded)
- `src/lib/server.ts:396` — `port,` (default 3847 from `src/lib/server.ts:180`)
- `src/lib/execute.ts:2010` — only `--port` is parsed; no `--host`

**⚠ LOUDLY:** The bind host is `0.0.0.0` with **no env var or flag to change it**. On a bridge network (10.10.10.0/24), any container can reach this port.

## 2. HTTP Routes Exposed

### Direct routes in `handleRequest` (src/lib/server.ts:940-1020):

| Method | Path | Feature-gated? |
|--------|------|----------------|
| POST | `/khortex/session/event` | `--khortex-memory` / `BRAIN_KHORTEX_MEMORY=1` |
| POST | `/khortex/session/query` | `--khortex-memory` / `BRAIN_KHORTEX_MEMORY=1` |
| GET | `/khortex/healthz` | `--khortex-memory` / `BRAIN_KHORTEX_MEMORY=1` |
| GET | `/healthz` | No |
| GET | `/readyz` | No |
| GET | `/api/sync/status` | No |
| GET | `/api/review/feed` | No |
| POST | `/api/review/classification/:id` | No |
| GET | `/api/brains/:id/schema` | No |
| OPTIONS | `/*` | No (CORS preflight) |

### Bench router delegation (src/bench/api.ts:661-760):

| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/search` | `src/bench/routes/search.ts:10` |
| POST | `/api/khortex/ask` | `src/bench/routes/khortex-ask.ts:49` |
| POST | `/api/analyze` | `src/bench/routes/analyze.ts` |
| POST | `/api/ask` | `src/bench/routes/ask.ts` |
| GET | `/api/health` | `src/bench/routes/health.ts` |
| + ~25 more (documents, files, graphs, learnings, etc.) | | |

**Specifically:** there is `POST /api/search` and `POST /api/khortex/ask` in the bench routes, and `POST /khortex/session/query` in the direct handler. There are **no** standalone `/search`, `/ask`, `/recall`, `/remember` routes — only `/api/search`, `/api/khortex/ask`, and `/khortex/session/query|event|healthz`.

## 3. AUTHENTICATION

**Auth exists but is lo
[… 8535 more chars]
```

Mechanical rubric — citations extracted: 47; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/mimo-v2.5 r8-mimo-tune3
rlmx · agent=explore · khal/mimo-v2.5 · 24 iterations · 43,977 in / 8,048 out · $0.08 · 168.5s · session sess_328b46148d671fa1
```

Returned answer (6132 chars):

```text
<think>The FINAL() call failed due to a syntax error - the triple quotes were being broken by the backtick code blocks inside the string. Let me provide the answer directly without a FINAL() wrapper since this is the last iteration.

Actually, wait - the instructions say "If a message tells you this is your last iteration, or asks you for your final answer directly, then write the answer itself as plain prose in that reply — no repl block, no FINAL(``), no further searching."

Let me provide the answer directly as plain prose, no REPL block.The inner backtick code blocks inside the FINAL triple-quoted string caused a syntax error. Since this is the final iteration, here is the answer directly as plain prose, no REPL block, no FINAL.

---

## Brain Database Topology: Per-Brain Database Architecture

**Verdict: TRUE** — the claim that "brain uses one Postgres database per brain, named `brain_<slug>`, with a dedicated owner role" is substantively correct.

### Architectural Pattern

Brain uses a **split architecture**:

1. **Shared registry database** (defaulting to `brain`) — stores the `brains` table (the global registry), plus shared tables like `brain_documents`, `brain_chunks`, `brain_mounts` (migration `001-brain-foundation.sql`). This is the "active database" when the process starts.

2. **Per-brain database** (named `brain_<slug>`) — created at brain initialization, containing its own copy of the `brains` row and its own `brain_documents`, `brain_chunks`, etc. tables. Each brain entity gets a fully isolated, independently-migrated database.

### Key Evidence

**1. Database naming — `deriveDatabaseName()` in `src/lib/pgserve.ts:89-108`**

Takes a brain slug, sanitizes it (lowercase, replace non-alphanumeric with underscore), and returns `brain_<sanitized_slug>` (max 63 chars Postgres limit).

**2. Per-brain database creation — `createBrain()` in `src/lib/identity.ts:109-132`**

When a brain is created, the code:
- Writes a registry row to the shared `brain` DB
- Creates a **separate per-brain database** via `ensureBrainDatabase(perBrainDb)` (where `perBrainDb` = `deriveDatabaseName(shortName)`)
- Switches to that database (`setActiveDatabase(perBrainDb)`) an
[… 3932 more chars]
```

Mechanical rubric — citations extracted: 27; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/mimo-v2.5 r8-mimo-tune3
rlmx · agent=explore · khal/mimo-v2.5 · 24 iterations · 87,547 in / 14,340 out · $0.11 · 588.0s · session sess_03f48f875b6a158e
```

Returned answer (576 chars):

```text
```repl
# FINAL VERIFICATION - read all critical lines I plan to cite
CITES = [
    ("install.sh", 28), ("install.sh", 49), ("install.sh", 60),
    ("install.sh", 357, 390), ("install.sh", 386, 390), ("install.sh", 392, 399),
    ("install.sh", 625, 663),
    ("install.sh", 641, 649),  # tar + chmod
    ("install.sh", 875, 883),  # ensure_local_bin preflight
    ("install.sh", 888, 895),
    ("install.sh", 909, 911),  # main entry
]

for p, start, end in CITES:
    print(f"\n{'='*60}")
    print(f"  {p}:{start}-{end}")
    print(f"{'='*60}")
    read(p, start, end)
```

```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**;
criterion 3 (no fabrication): **PASS**. (The earlier "33 citations" here also
came from an overwritten run — 11,786 characters, `sess_a99cbc77aa704f17` — kept
as `task-5.score.orphaned.json`. See §11.)

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/mimo-v2.5 r8-mimo-tune3
rlmx · agent=explore · khal/mimo-v2.5 · 24 iterations · 28,539 in / 10,406 out · $0.07 · 326.5s · session sess_bfd1e71ec397426b
```

Returned answer (8145 chars):

```text
# Structured Report: Agent Sync Trigger Inventory + Install/Propagation Chain

## 1. Trigger Inventory

The core engine is **`runAgentSync`** at `src/lib/agent-sync.ts:6927`. It accepts an `AgentSyncSelection` (type `'auto'|'codex'|'claude'|'all'|'none'`) and dispatches per-agent sync adapters (`syncClaude`, `syncHermes`). It is wrapped by **`runAgentSyncSafe`** at `src/genie-commands/update.ts:2688`, which catches errors and converts them to advisory failures.

### CLI commands that trigger sync:

**A. `genie install`** (src/genie-commands/install.ts)
- Imports `runAgentSyncSafe` at line 53
- Calls it at line 359–362: `narrowAgentSyncSelection(selection)` → `runSync(agentSyncSelection)`
- Only runs if codex delivery succeeded (line 361: `if (!codexFailed)`)
- Called from `src/genie.ts:16` → `installCommand`

**B. `genie update`** (src/genie-commands/update.ts)
- Imports `runAgentSync` at line 30, `runAgentSyncSafe` at line 2688
- Three call paths:
  1. **`runUpdateAgentSync`** (line 1757–1762): wraps `runAgentSyncSafe` with `strict: true`
  2. **`runLegacySyncOnlyConvergence`** (line 1781–1789): legacy `--sync-only` path, calls `runUpdateAgentSync`
  3. **`runManualUpdateConvergence`** (line 2792–2802): standard update convergence, calls `runUpdateAgentSync`
- Called from `src/genie.ts:24` → `updateCommand`

**C. `genie doctor`** (src/genie-commands/doctor.ts)
- Does NOT run sync; only *reads* the managed-dir contract
- Imports `claudeGeniePluginEnabled` at line 36
- Calls it at line 1204: `const pluginEnabled = claudeGeniePluginEnabled(settingsPath)`
- Uses the result to adjust expected source skills (line 1205): `const excluded = pluginEnabled ? new Set([...sourceSkillDigests(pluginRoot).keys()]) : CLAUDE_EXCLUDED_SKILLS`
- Called from `src/genie.ts:14` → `doctorCommand`

**D. `genie uninstall`** (src/genie-commands/uninstall.ts)
- Imports from agent-sync at line 61
- Uses lifecycle lease (`agentSyncLock` at lines 3420–3434) and removal targets (`AgentSyncRemovalTargets` at line 3114)
- Called from `src/genie.ts:23` → `uninstallCommand`

**E. `genie setup`** (src/genie-commands/setup.ts)
- Imports `acquireLifecycleLease` at line 12
- Uses it for lifecycle coo
[… 5945 more chars]
```

Mechanical rubric — citations extracted: 41; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

## 6. Verbatim runs — the characteristic failures

One round per remaining tier, showing the failure each one is remembered for:
`r1-flash-baseline` (the shipped recipe, `FINAL(answer)` and first-turn
fabrication), `r9-kimi-t0` (REPL blocks returning nothing, and an honest refusal
to invent), `r11-haiku-t0` (answering from priors; `budget hit: max-cost`), and
`r14-haiku-tune3` (the top tier's last tuned round). Truncated at 900
characters.

### Round `r1-flash-baseline`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/deepseek-v4-flash r1-flash-baseline
rlmx · agent=explore · khal/deepseek-v4-flash · 10 iterations · 63,373 in / 6,302 out · $0.0098 · 101.2s · session sess_63bab2bf64d8aa60
```

Returned answer (5733 chars):

```text
# Brain Codebase — Structured Report

## 1. Cloud Model/Provider Dependencies

### Gemini Embeddings (the only embedding provider)
- **Embedding file:** `src/lib/embedding.ts` — the sole embedding implementation
- **Model:** `gemini-embedding-2-preview` (default, 768 dims) — `src/lib/embedding.ts:28`
- **Task types** (8 defined for v1/`task_type` field): `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, `SEMANTIC_SIMILARITY`, `CLASSIFICATION`, `CLUSTERING`, `QUESTION_ANSWERING`, `FACT_VERIFICATION`, `CODE_RETRIEVAL_QUERY` — `src/lib/embedding.ts:18-26`
- **v2 models ignore task_type** and prefix text instead — `src/lib/embedding.ts:36-38`, prefix mapping at lines 51-71
- **Env var read:** `process.env.GEMINI_API_KEY` or `process.env.GOOGLE_API_KEY` — `src/lib/embedding.ts:133`
- **Fallback key source:** `~/.rlmx/settings.json` — `src/lib/embedding.ts:118-127`

### LLM Model (rlmx / auto-kb)
- **D
[… 4833 more chars]
```

Mechanical rubric — citations extracted: 41; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/deepseek-v4-flash r1-flash-baseline
rlmx · agent=explore · khal/deepseek-v4-flash · 10 iterations · 122,625 in / 7,032 out · $0.02 · 141.5s · session sess_0e9a74467cf1c078
```

Returned answer (6564 chars):

```text
## Defect A: "Refusing repository-local codex CLI executable"

**Root cause:** `validateTrustedExecutablePath` (src/lib/trusted-executable.ts:129) treats any path under `process.cwd()` or its enclosing Git trust roots as "repository-local" unless that root is the user's home directory. The filter at line 142–144 removes roots that ARE `$HOME`, but it does NOT remove roots that are UNDER `$HOME` — meaning a Git repo at `~` (dotfiles repo) is NOT filtered out. Running `genie install` from `~` (which `classifyCodexInstallDefault` passes as `process.cwd()`, line 112) makes `canonicalCwd = $HOME`. Since `$HOME` IS the home, line 143 filters it out. But the critical failure path is: any non-home CWD (like cloning a repo under `~/projects/`) where `~/.local/bin/codex` is resolved. The codex at `~/.local/bin/codex` is CONTAINED in `$HOME`, so the home filter passes; but if CWD is also under `$HO
[… 5664 more chars]
```

Mechanical rubric — citations extracted: 15; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/deepseek-v4-flash r1-flash-baseline
rlmx · agent=explore · khal/deepseek-v4-flash · 10 iterations · 116,815 in / 6,113 out · $0.00 · 199.9s · session sess_3804397bedab1da9
```

Returned answer (4629 chars):

```text
## Feasibility Verdict: Modest work required — the serve surface partially exists but is not wired as a CLI-facing API

### 1. What `brain serve` actually starts

Bun.serve on `0.0.0.0:3847` (hardcoded default):

- `src/lib/server.ts:395-400`: `Bun.serve({ port, hostname: "0.0.0.0", fetch: handleRequest, idleTimeout: 255 })`
- Default port is `3847` (`src/lib/server.ts:244`: `const port = opts.port ?? 3847`)
- **The bind host is hardcoded `"0.0.0.0"` with no env var or config knob to change it to loopback.** There is no `BIND_HOST` / `HOST` / `LISTEN_ADDR` anywhere.
- Port is configurable via `--port` CLI flag → `opts.port`.

### 2. HTTP routes exposed

**In `handleRequest` (src/lib/server.ts:940-1020)** (first-class, no auth):
- `GET /healthz` → `handleHealthz`
- `GET /readyz` → `handleReadyz`
- `GET /api/sync/status` → `handleSyncStatus`
- `GET /api/review/feed` → `handleReviewFeed`
- 
[… 3729 more chars]
```

Mechanical rubric — citations extracted: 22; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/deepseek-v4-flash r1-flash-baseline
rlmx · agent=explore · khal/deepseek-v4-flash · 1 iteration · 876 in / 3,063 out · $0.0007 · 77.2s · session sess_80783a41f17b7bef
```

Returned answer (2529 chars):

```text
**FALSE** — brain does NOT use per-brain databases. It uses a single shared database per brain *install* (a vault/station), with multiple brains stored as rows in a `brains` table inside that single database.

Here is the evidence, load-bearing code with file paths and line numbers:

### 1. The database DSN is per-install, not per-brain
The database configuration comes from environment variables (`NEON_DATABASE_URL`, `DATABASE_URL`, etc.) read at startup in `src/lib/config.ts:22-33`. A single `db.ts:1-15` module creates one `pg.Client` using that single DSN. The process connects to exactly ONE database — there is no code to switch databases or create new ones for different brains.

### 2. Multiple brains live in one table, one database
The migration `migrations/001-init.sql:1-40` creates the `brains` table (among others) inside a single database. Migration `migrations/003-brains.sql:1-20
[… 1629 more chars]
```

Mechanical rubric — citations extracted: 15; criterion 2 (citations resolve): **FAIL — src/lib/config.ts:22 (missing-file); src/lib/config.ts:33 (missing-file); migrations/001-init.sql:1 (missing-file); migrations/001-init.sql:40 (missing-file); migrations/003-brains.sql:1 (missing-file); migrations/003-brains.sql:20 (missing-file); src/lib/serve.ts:1 (missing-file); src/lib/serve.ts:30 (missing-file)**; criterion 3 (no fabrication): **FAIL — src/lib/config.ts:22 (missing-file); src/lib/config.ts:33 (missing-file); migrations/001-init.sql:1 (missing-file); migrations/001-init.sql:40 (missing-file); migrations/003-brains.sql:1 (missing-file); migrations/003-brains.sql:20 (missing-file); src/lib/serve.ts:1 (missing-file); src/lib/serve.ts:30 (missing-file)**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/deepseek-v4-flash r1-flash-baseline
rlmx · agent=explore · khal/deepseek-v4-flash · 1 iteration · 2,786 in / 5,464 out · $0.0014 · 156.3s · session sess_e8582bccc4ec66e7
```

Returned answer (7 chars):

```text
answer

```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/deepseek-v4-flash r1-flash-baseline
rlmx · agent=explore · khal/deepseek-v4-flash · 1 iteration · 810 in / 9,754 out · $0.00 · 208.6s · session sess_6e18d3889e0da0c2
```

Returned answer (7 chars):

```text
answer

```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.


### Round `r11-haiku-t0`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/claude-haiku r11-haiku-t0
rlmx · agent=explore · khal/claude-haiku · 3 iterations · 49,967 in / 27,670 out · $0.19 · 179.8s · session sess_de34e29d7b3ef605
```

Returned answer (8331 chars):

```text

# BRAIN REPOSITORY - COMPREHENSIVE ANALYSIS

## QUESTION 1: Cloud Models/Provider Dependencies

### Gemini Embeddings Configuration
- **Model ID**: `models/embedding-001` (src/lib/models.ts:2)
- **Embedding Dimensions**: 768 (src/lib/models.ts:3)
- **Task Type Configuration**: RETRIEVAL_DOCUMENT for indexing, RETRIEVAL_QUERY for retrieval queries (src/lib/embedding.ts:5-8)
- **API Client**: Initialized with GEMINI_API_KEY in src/lib/embedding.ts:1-3

### rlmx Integration & Default Models
- **rlmx Usage**: src/agents/main.ts:3 imports and integrates rlmx for agentic execution
- **Default LLM**: `gemini-2.0-flash` set in src/lib/config.ts:2
- **Default Provider**: Google (hardcoded, no Anthropic/OpenAI fallback)
- **Provider Configuration**: src/lib/providers.ts:2-5 configures Google as primary provider

### Environment Variables Required
- **GEMINI_API_KEY** (src/lib/env.ts:1) - Google G
[… 7431 more chars]
```

Mechanical rubric — citations extracted: 30; criterion 2 (citations resolve): **FAIL — src/lib/models.ts:2 (missing-file); src/lib/models.ts:3 (missing-file); src/agents/main.ts:3 (missing-file); src/lib/config.ts:2 (missing-file); src/lib/providers.ts:2 (missing-file); src/lib/providers.ts:5 (missing-file); src/lib/env.ts:1 (missing-file); src/lib/env.ts:2 (missing-file); src/lib/env.ts:3 (missing-file); src/lib/config.ts:4 (missing-file); src/lib/database.ts:2 (missing-file); db/schema.ts:8 (missing-file); db/schema.ts:14 (missing-file); db/schema.ts:20 (missing-file); src/agents/multimodal.ts:3 (missing-file); db/schema.ts:12 (missing-file); db/schema.ts:13 (missing-file); db/schema.ts:1 (missing-file); db/schema.ts:45 (missing-file); src/agents/main.ts:8 (missing-file); src/agents/main.ts:10 (missing-file); src/agents/multimodal.ts:17 (missing-file); src/agents/memory.ts:3 (missing-file); src/agents/memory.ts:32 (missing-file)**; criterion 3 (no fabrication): **FAIL — src/lib/models.ts:2 (missing-file); src/lib/models.ts:3 (missing-file); src/agents/main.ts:3 (missing-file); src/lib/config.ts:2 (missing-file); src/lib/providers.ts:2 (missing-file); src/lib/providers.ts:5 (missing-file); src/lib/env.ts:1 (missing-file); src/lib/env.ts:2 (missing-file); src/lib/env.ts:3 (missing-file); src/lib/config.ts:4 (missing-file); src/lib/database.ts:2 (missing-file); db/schema.ts:8 (missing-file); db/schema.ts:14 (missing-file); db/schema.ts:20 (missing-file); src/agents/multimodal.ts:3 (missing-file); db/schema.ts:12 (missing-file); db/schema.ts:13 (missing-file); db/schema.ts:1 (missing-file); db/schema.ts:45 (missing-file); src/agents/main.ts:8 (missing-file); src/agents/main.ts:10 (missing-file); src/agents/multimodal.ts:17 (missing-file); src/agents/memory.ts:3 (missing-file); src/agents/memory.ts:32 (missing-file)**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/claude-haiku r11-haiku-t0
rlmx · agent=explore · khal/claude-haiku · 1 iteration · 4,800 in / 12,736 out · $0.07 · 82.4s · session sess_e16117091eda8403
```

Returned answer (3189 chars):

```text
## Defect Analysis Summary

### A) "Refusing repository-local codex" + "Skipped agent-sync" on integration failure

**Root Cause**: 
- The codex path check compares against process.cwd() (lib/codex/init.js:1-50) to determine if an executable is "repository-local". When ~/.local/bin/codex exists but is under a path that shares ancestry with the current working directory structure, it may incorrectly classify it.
- Integration failures during `--integrations auto` mode cause ALL subsequent agent-syncs to be skipped unconditionally (lib/integration/init.js and lib/agent/sync.js cross-check integration status, and a failed integration sets a flag that blocks agent-sync entirely).

**File References**:
- lib/codex/init.js:1-50 — where codex executable paths are validated
- lib/integration/init.js:200-300 — where integration failures are recorded  
- lib/agent/sync.js:50-100 — where agent sync
[… 2289 more chars]
```

Mechanical rubric — citations extracted: 18; criterion 2 (citations resolve): **FAIL — lib/codex/init.js:1 (missing-file); lib/codex/init.js:50 (missing-file); lib/integration/init.js:200 (missing-file); lib/integration/init.js:300 (missing-file); lib/agent/sync.js:50 (missing-file); lib/agent/sync.js:100 (missing-file); lib/skill/digest.js:1 (missing-file); lib/skill/digest.js:50 (missing-file); lib/skill/update.js:100 (missing-file); lib/skill/update.js:200 (missing-file); lib/skill/doctor.js:50 (missing-file); lib/skill/doctor.js:100 (missing-file); lib/cli.js:1 (missing-file); lib/cli.js:100 (missing-file); lib/cli/uninstall.js:1 (missing-file); lib/cli/uninstall.js:50 (missing-file); lib/confirm.js:1 (missing-file); lib/confirm.js:40 (missing-file)**; criterion 3 (no fabrication): **FAIL — lib/codex/init.js:1 (missing-file); lib/codex/init.js:50 (missing-file); lib/integration/init.js:200 (missing-file); lib/integration/init.js:300 (missing-file); lib/agent/sync.js:50 (missing-file); lib/agent/sync.js:100 (missing-file); lib/skill/digest.js:1 (missing-file); lib/skill/digest.js:50 (missing-file); lib/skill/update.js:100 (missing-file); lib/skill/update.js:200 (missing-file); lib/skill/doctor.js:50 (missing-file); lib/skill/doctor.js:100 (missing-file); lib/cli.js:1 (missing-file); lib/cli.js:100 (missing-file); lib/cli/uninstall.js:1 (missing-file); lib/cli/uninstall.js:50 (missing-file); lib/confirm.js:1 (missing-file); lib/confirm.js:40 (missing-file)**.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/claude-haiku r11-haiku-t0
rlmx · agent=explore · khal/claude-haiku · 7 iterations · 214,392 in / 19,579 out · $0.31 · 135.5s · budget hit: max-cost · session sess_6e6890efdce4178d
```

Returned answer (3246 chars):

```text
Based on my investigation of the brain repository, here is my feasibility assessment:

## Brain Serve HTTP Surface & CLI-as-Client Feasibility

**CRITICAL FINDING:** The `brain serve` command does **NOT** expose any HTTP routes for search, ask, recall, remember, or khortex. The server.ts file (1930 lines) contains NO Bun.serve() call, NO route handlers, and NO HTTP endpoint definitions. 

### 1. WHAT DOES `brain serve` START?

According to src/lib/server.ts:1-14, `brain serve` starts:
- Resolves autopg v3 socket discovery
- Runs migrations  
- Registers brain from brain.json
- Starts watchdog (in-process file watcher)
- Writes .brain-server.json + .brain-server.pid

**However, there is NO HTTP server.** The server.ts file imports `Bun` at line 126 (`httpServer: ReturnType<typeof Bun.serve> | null;`) but never calls Bun.serve(). The default port is hardcoded at line 180 as 3847, but no HT
[… 2346 more chars]
```

Mechanical rubric — citations extracted: 9; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/claude-haiku r11-haiku-t0
rlmx · agent=explore · khal/claude-haiku · 5 iterations · 60,023 in / 12,720 out · $0.12 · 72.1s · session sess_33129fcd86017bb0
```

Returned answer (7 chars):

```text
answer

```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/claude-haiku r11-haiku-t0
rlmx · agent=explore · khal/claude-haiku · 5 iterations · 198,204 in / 28,674 out · $0.34 · 213.2s · budget hit: max-cost · session sess_d1b4a1d4de1c2729
```

Returned answer (6136 chars):

```text

# GENIE INSTALL/RELEASE DELIVERY PATH - COMPLETE ANALYSIS

## 1. install.sh Channel Selection & Manifest Resolution

**How channel is selected:** The GENIE_CHANNEL environment variable controls which manifest is fetched (install.sh:24-28). The one-liner documented in README.md (install.sh:14) defaults to the "stable" channel, but users can override via `GENIE_CHANNEL=dev curl ... | bash` to receive the dev-channel manifest.

- **Documented one-liner:** `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash` (install.sh:14)
- **Manifest base URL:** `https://raw.githubusercontent.com/${REPO}/main/.well-known` (install.sh:28)
- **Channel manifest files:** Per install.sh:24-26, the script resolves `.well-known/{latest,dev,homolog}.json` at runtime based on GENIE_CHANNEL environment variable. Stable channel uses `latest.json`, dev uses `dev.json`, homolog us
[… 5236 more chars]
```

Mechanical rubric — citations extracted: 18; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/claude-haiku r11-haiku-t0
rlmx · agent=explore · khal/claude-haiku · 6 iterations · 168,848 in / 31,798 out · $0.33 · 223.2s · budget hit: max-cost · session sess_f6eae73970e44d98
```

Returned answer (5543 chars):

```text
Based on my investigation of the genie repository, here is the comprehensive report on agent sync triggers and the install/propagation chain:

## STRUCTURED REPORT: Agent Sync Triggers & Install/Propagation Chain

### PART 1: TRIGGER INVENTORY - All Sync Entrypoint Callers

**CRITICAL TRIGGERS (Cause Claude Code Duplication):**

1. **Marketplace Command + Utility Function**
   - Location: src/lib/util-marketplace.ts (contains activateSyncAndOpenMarketplace definition)
   - Called from: src/genie-commands/marketplace.ts (user runs: `genie marketplace`)
   - Action: Calls syncToAgentSkillsDir() with targets including 'claude'
   - **PROBLEM**: Syncs bare-name skills to ~/.claude/skills/ even when genie@automagik plugin enabled
   - **Duplication impact**: ~2,200 tokens per session from duplicate bare-name skills

2. **Post-Install Hook**
   - Location: src/post-install.ts
   - When: Runs v
[… 4643 more chars]
```

Mechanical rubric — citations extracted: 2; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.


### Round `r14-haiku-tune3`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/claude-haiku r14-haiku-tune3
rlmx · agent=explore · khal/claude-haiku · 24 iterations · 1,183,235 in / 69,713 out · $1.53 · 452.8s · session sess_e5a872bb4f1d00c3
```

Returned answer (3523 chars):

```text
# Brain Repository - Complete Analysis Report

## 1. Cloud Model/Provider Dependencies

**Gemini Embeddings - Model Names & Task Types:**
- src/lib/embedding.ts:8 imports GoogleGenerativeAI from "@google/generative-ai"
- src/lib/embedding.ts:17 model name: "embedding-001"
- src/lib/embedding.ts:18 task type: "RETRIEVAL_DOCUMENT"
- src/lib/embedding.ts:21 embedDims constant: 768

**Default Model Provider & Configuration:**
- src/lib/providers.ts:9 default provider: "google" (Gemini)
- src/lib/providers.ts:13 default model ID: "gemini-pro"
- src/lib/client.ts:1-5 initializes GoogleGenerativeAI client
- src/lib/client.ts:12 reads GOOGLE_API_KEY from environment

**rlmx Usage:**
- NOT FOUND - no rlmx references in codebase

**Environment Variables Required:**
- src/lib/config.ts:7 GOOGLE_API_KEY (required)
- src/lib/config.ts:8 ANTHROPIC_API_KEY (optional)
- src/lib/config.ts:9 OPENAI_API_KE
[… 2623 more chars]
```

Mechanical rubric — citations extracted: 38; criterion 2 (citations resolve): **FAIL — src/lib/providers.ts:9 (missing-file); src/lib/providers.ts:13 (missing-file); src/lib/client.ts:1 (missing-file); src/lib/client.ts:5 (missing-file); src/lib/client.ts:12 (missing-file); src/lib/config.ts:7 (missing-file); src/lib/config.ts:8 (missing-file); src/lib/config.ts:9 (missing-file); src/lib/config.ts:10 (missing-file); src/lib/storage.ts:4 (missing-file); src/lib/config.ts:5 (missing-file); src/lib/config.ts:12 (missing-file); src/db/schema.ts:24 (missing-file); src/db/schema.ts:35 (missing-file); src/lib/ingest.ts:12 (missing-file); src/lib/ingest.ts:15 (missing-file); src/lib/ingest.ts:20 (missing-file); src/lib/ingest.ts:25 (missing-file); src/lib/ingest.ts:30 (missing-file); src/lib/ingest.ts:35 (missing-file); src/lib/ingest.ts:40 (missing-file); src/lib/ingest.ts:45 (missing-file); src/db/schema.ts:9 (missing-file); src/db/schema.ts:18 (missing-file); src/db/schema.ts:28 (missing-file); src/db/schema.ts:42 (missing-file); src/db/schema.ts:50 (missing-file); src/lib/storage.ts:1 (missing-file); src/lib/storage.ts:8 (missing-file); src/lib/memory.ts:15 (missing-file); src/lib/memory.ts:25 (missing-file); src/lib/memory.ts:30 (missing-file); src/lib/memory.ts:35 (missing-file); src/lib/memory.ts:40 (missing-file)**; criterion 3 (no fabrication): **FAIL — src/lib/providers.ts:9 (missing-file); src/lib/providers.ts:13 (missing-file); src/lib/client.ts:1 (missing-file); src/lib/client.ts:5 (missing-file); src/lib/client.ts:12 (missing-file); src/lib/config.ts:7 (missing-file); src/lib/config.ts:8 (missing-file); src/lib/config.ts:9 (missing-file); src/lib/config.ts:10 (missing-file); src/lib/storage.ts:4 (missing-file); src/lib/config.ts:5 (missing-file); src/lib/config.ts:12 (missing-file); src/db/schema.ts:24 (missing-file); src/db/schema.ts:35 (missing-file); src/lib/ingest.ts:12 (missing-file); src/lib/ingest.ts:15 (missing-file); src/lib/ingest.ts:20 (missing-file); src/lib/ingest.ts:25 (missing-file); src/lib/ingest.ts:30 (missing-file); src/lib/ingest.ts:35 (missing-file); src/lib/ingest.ts:40 (missing-file); src/lib/ingest.ts:45 (missing-file); src/db/schema.ts:9 (missing-file); src/db/schema.ts:18 (missing-file); src/db/schema.ts:28 (missing-file); src/db/schema.ts:42 (missing-file); src/db/schema.ts:50 (missing-file); src/lib/storage.ts:1 (missing-file); src/lib/storage.ts:8 (missing-file); src/lib/memory.ts:15 (missing-file); src/lib/memory.ts:25 (missing-file); src/lib/memory.ts:30 (missing-file); src/lib/memory.ts:35 (missing-file); src/lib/memory.ts:40 (missing-file)**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/claude-haiku r14-haiku-tune3
rlmx · agent=explore · khal/claude-haiku · 5 iterations · 172,287 in / 26,561 out · $0.31 · 186.0s · session sess_eff0c432a86ccc07
```

Returned answer (4229 chars):

```text
DEFECT ANALYSIS — GENIE FRESH INSTALL ISSUES

## A) "Refusing repository-local codex CLI executable"

Root cause: The trusted-executable validator refuses executables under repository roots (including git worktrees). It computes forbiddenRoots from process.cwd() and all enclosing git repositories, then filters out roots that are contained in the user's home directory. The actual refusal logic (line 147) checks if the executable candidate is inside any forbidden root. When codex integration fails for any reason, install skips all agent-sync including Claude/hermes (line 367).

Where executable is refused:
- src/lib/trusted-executable.ts:147 — throw Error('Refusing repository-local ${name} executable: ${candidate}')
- src/lib/trusted-executable.ts:142 — forbiddenRoots computation: [...new Set([canonicalCwd, ...resolveEnclosingGitTrustRoots(canonicalCwd)])].filter((root) => !isSameOrContain
[… 3329 more chars]
```

Mechanical rubric — citations extracted: 11; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/claude-haiku r14-haiku-tune3
rlmx · agent=explore · khal/claude-haiku · 1 iteration · 5,647 in / 8,275 out · $0.05 · 58.3s · session sess_89d87c3cb8aaa46f
```

Returned answer (2377 chars):

```text
FEASIBILITY VERDICT: Not feasible today. The HTTP serve surface does not exist in the shape the design assumes.

1. WHAT DOES "brain serve" START?
   - `brain serve` is NOT implemented. There is no HTTP server in the codebase.
   - src/index.ts (src/index.ts:1-30) contains the entry point and does NOT call Bun.serve() or any HTTP listen.
   - src/cli.ts (src/cli.ts:1-50+) exports the CLI directly; no serve command handler exists.
   - No bind host (127.0.0.1 vs 0.0.0.0) configuration exists because there is no serve.

2. HTTP ROUTES EXPOSED:
   - NONE. No routes are defined. search(), ask(), recall(), remember(), inject() are CLI functions only, exported directly from src/khortex/*.ts.
   - No /khortex/* paths exist.
   - No GET/POST handlers for these operations.

3. AUTHENTICATION:
   - Not applicable — no HTTP surface exists.

4. CLI TRANSPORT:
   - Every CLI command (search, ask, rec
[… 1477 more chars]
```

Mechanical rubric — citations extracted: 8; criterion 2 (citations resolve): **FAIL — src/cli.ts:50 (line-out-of-range); src/khortex/search.ts:1 (missing-file); src/khortex/search.ts:20 (missing-file)**; criterion 3 (no fabrication): **FAIL — src/khortex/search.ts:1 (missing-file); src/khortex/search.ts:20 (missing-file)**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/claude-haiku r14-haiku-tune3
rlmx · agent=explore · khal/claude-haiku · 5 iterations · 111,781 in / 6,365 out · $0.14 · 59.2s · session sess_e20c2a3b48d72189
```

Returned answer (4129 chars):

```text
The claim that "the codebase's existing model is per-brain DB `brain_<slug>` with a dedicated owner role" is **TRUE**.

## Per-Brain Database Architecture

Brain uses **ONE Postgres database PER BRAIN**, not a shared database with a `brains` table and per-brain rows. Each brain entity gets a dedicated database named `brain_<slug>`.

**Database Naming & Creation:**
- The `deriveDatabaseName()` function (src/lib/pgserve.ts:89) derives the database name by prefixing the brain's slug with `brain_`, sanitizing to valid Postgres identifiers, and capping at 63 characters (src/lib/pgserve.ts:106)
- `ensureBrainDatabase()` (src/lib/db.ts:376) creates each database with `CREATE DATABASE "${database}" OWNER "${runtimeRole}"` (src/lib/db.ts:458), establishing a per-brain owner role from initialization

**Per-Brain Role (Dedicated Owner):**
- A separate Postgres ROLE is created per brain, following t
[… 3229 more chars]
```

Mechanical rubric — citations extracted: 16; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/claude-haiku r14-haiku-tune3
rlmx · agent=explore · khal/claude-haiku · 9 iterations · 488,222 in / 44,309 out · $0.71 · 352.0s · session sess_ca4ebe1d53ee345c
```

Returned answer (5594 chars):

```text
# Genie Install/Release Delivery Path — Complete Verified Research

## 1. install.sh: Channel Selection, Manifest URLs, and Extraction

**Repository** (install.sh:23): REPO="automagik-dev/genie"
**Manifest Base URL** (install.sh:28): MANIFEST_BASE="https://raw.githubusercontent.com/${REPO}/main/.well-known"
**Channel Selection** (install.sh:25-27): GENIE_CHANNEL env var selects .well-known/{latest,dev,homolog}.json
**One-liner** (README.md:23): curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash — fetches from main, NOT manifest
**Staging** (install.sh:50): TMP_DIR="$(umask 077; mktemp -d -t genie-install-XXXXXX)" creates 0700 directory
**tar Extraction** (build-tarballs.yml:168): tar -xzf "${TARBALL}" -C "${STAGE}"
**After tar chmod**: NONE. Tarball carries correct permissions from build.
**LOCAL_BIN** (install.sh:49): LOCAL_BIN="$HOME/.local/bin"

##
[… 4694 more chars]
```

Mechanical rubric — citations extracted: 52; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/claude-haiku r14-haiku-tune3
rlmx · agent=explore · khal/claude-haiku · 2 iterations · 25,599 in / 19,677 out · $0.12 · 108.4s · session sess_f19620cd0e742aaa
```

Returned answer (3895 chars):

```text

# AGENT SYNC TRIGGER INVENTORY & INSTALLATION PROPAGATION CHAIN

## TRIGGER INVENTORY: All invocations of AgentSync.sync()

### 1. **`genie sync` command** — src/genie-commands/sync.ts:7
   Direct CLI entry point. Creates AgentSync instance and calls `.sync()` immediately.
   Selection type: accepts CLI argument (defaults to 'auto').

### 2. **`genie doctor` command** — src/genie-commands/doctor.ts:33
   Diagnostic command that runs AgentSync.sync() without arguments.
   Runs with default selection (likely 'auto').

### 3. **`genie enable <plugin>` command** — src/genie-commands/enable.ts:12
   When a plugin is enabled, calls agentSync.sync() to refresh skill mirrors.
   Triggers immediately after plugin installation/enable.

### 4. **`genie uninstall` command** — src/genie-commands/uninstall.ts:10
   Cleanup: calls agentSync.sync() to remove stale skill mirrors.
   Runs as final step o
[… 2995 more chars]
```

Mechanical rubric — citations extracted: 7; criterion 2 (citations resolve): **FAIL — src/genie-commands/sync.ts:7 (missing-file); src/genie-commands/enable.ts:12 (missing-file)**; criterion 3 (no fabrication): **FAIL — src/genie-commands/sync.ts:7 (missing-file); src/genie-commands/enable.ts:12 (missing-file)**.


### Round `r9-kimi-t0`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/kimi-code r9-kimi-t0
rlmx · agent=explore · khal/kimi-code · 24 iterations · 37,611 in / 9,407 out · $0.09 · 214.9s · session sess_80ad5a4c9f32fe77
```

Returned answer (618 chars):

```text
I was unable to read `/home/namastex/prod/brain` because every REPL execution in this session returned no output. I attempted `os.walk`, `os.listdir`, and diagnostic `print()` calls, but none produced directory listings, file contents, or search results.

Since I have not verified any file paths or line numbers, I cannot answer the six questions about cloud model dependencies, embedding pipeline, multimodal ingestion, Postgres schema, memory models, or local-model support. Any specific citations I gave would be fabricated.

A properly cited report would require a working REPL that can return filesystem output.

```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/kimi-code r9-kimi-t0
rlmx · agent=explore · khal/kimi-code · 24 iterations · 40,080 in / 6,588 out · $0.08 · 210.0s · session sess_745e0a6f0453c3a3
```

Returned answer (2115 chars):

```text
 I was unable to complete the REPL-based verification for this run: after the initial tree listing, my search/read blocks either returned no tool output or failed to execute, so I never printed the actual source lines for the three defects.

What I can establish from the repo layout (`look()`, `/home/namastex/workspace/repos/genie`, branch `dev`):

- This is a TypeScript/Node project; command implementations live in `src/genie-commands/` (`install.ts`, `update.ts`, `uninstall.ts`, `doctor.ts`), and shared logic in `src/lib/`.
- The A symptoms (codex CLI rejection, agent-sync skipping under `--integrations auto`) likely involve:
  - A codex discovery/executable validator in `src/lib/codex-*.ts` (e.g., `codex-activation.ts`, `codex-host-observation.ts`, `codex-doctor-observation.ts`) for the “repository-local” refusal rule.
  - `src/lib/agent-sync.ts` or `src/genie-commands/update-integrat
[… 1215 more chars]
```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/kimi-code r9-kimi-t0
rlmx · agent=explore · khal/kimi-code · 24 iterations · 105,754 in / 9,515 out · $0.15 · 227.4s · session sess_6ee86dec9685c409
```

Returned answer (1082 chars):

```text
I was unable to complete the REPL investigation before the iteration budget ran out. I can only confirm what the first successful block printed: the repository tree exists under /home/namastex/prod/brain, with src/cli.ts, src/lib/server.ts, src/bench/routes/*, and plugins/brain-khortex/ present; the subsequent search blocks failed to execute or returned no output, so I do not have verified line numbers or quoted snippets.

Without being able to read src/lib/server.ts, src/cli.ts, the MCP files, and route registrations, I cannot give the precise, cited answer your question demands. I did not find evidence that brain serve exists or does not exist; I simply have not read the files yet.

What to do next: read src/lib/server.ts (the likely Bun.serve entry), src/cli.ts command dispatch, src/lib/execute.ts around the "serve" case, plugins/brain-khortex/mcp/*, and src/bench/routes/khortex-ask.t
[… 182 more chars]
```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/kimi-code r9-kimi-t0
rlmx · agent=explore · khal/kimi-code · 24 iterations · 139,444 in / 6,996 out · $0.20 · 178.6s · session sess_d683ab92191db0c1
```

Returned answer (4707 chars):

```text
GROUND TRUTH: Brain uses **one Postgres database per brain entity**, named `brain_<slug>`. It does NOT use a single shared database with per-brain rows. Each per-brain DB does contain its own `brains` table (and related brain_* tables), so there is a row per brain inside that brain's own database.

1. DSN / database name selection
- `deriveDatabaseName(slug)` builds the per-brain database name: `brain_${sanitized_slug}` with a 63-character Postgres identifier cap (src/lib/pgserve.ts:89-109).
- `ensureBrainDatabase(database)` runs `CREATE DATABASE "${database}"` (DSN mode) or `CREATE DATABASE "${database}" OWNER "${runtimeRole}"` (autopg mode) (src/lib/db.ts:376-412).
- The registry database concept exists separately: `resolveRegistryDatabase()` returns the active daemon's own per-brain DB from `~/.brain/config.json` when available, or falls back to the literal `"brain"` for dev/tests (sr
[… 3807 more chars]
```

Mechanical rubric — citations extracted: 27; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/kimi-code r9-kimi-t0
rlmx · agent=explore · khal/kimi-code · 24 iterations · 43,339 in / 6,134 out · $0.09 · 111.2s · session sess_ae40e44fdbab7232
```

Returned answer (3610 chars):

```text
 Based on the limited files I was able to read before the run limit, here is what I can verify with exact `file:line` references. The remaining items were not reached in this session, so they are marked “not read” rather than fabricated.

## 1. `install.sh` (repo root)

### 1(a) Channel selection and documented one-liner

The documented one-liner fetches `install.sh` from the `main` branch:

- `README.md:23`: `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash`
- `install.sh:14`: same one-liner.

Channel → manifest mapping is described in the header:

- `install.sh:24-27`:
  ```
  # Per-channel manifest URL: stable → latest.json, others → <channel>.json.
  # Resolved at runtime in resolve_manifest_url after the channel is known so
  # `GENIE_CHANNEL=dev curl ... | bash` reads .well-known/dev.json. See wish
  # release-channel-dev (2026-05-11) for the 
[… 2710 more chars]
```

Mechanical rubric — citations extracted: 6; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/kimi-code r9-kimi-t0
rlmx · agent=explore · khal/kimi-code · 24 iterations · 36,302 in / 8,780 out · $0.09 · 133.5s · session sess_babf38d4bdebb863
```

Returned answer (1315 chars):

```text
I could not complete the investigation: every REPL execution attempt in this session returned no output except one basic `os.getcwd()` check, so I never produced printed lines from `src/lib/agent-sync.ts`, the CLI commands, doctor, test files, or `/home/namastex/.genie`.

Consequently I cannot produce the requested structured trigger inventory with `file:line` citations or the exact install/propagation chain, because all such claims would be unverified guesses.

To answer this properly, the next run should:
1. Define `look()` / `search()` / `read()` helpers and scan `src/lib/agent-sync.ts` for exported sync entrypoints and the `AgentSyncSelection` type usage.
2. Search the entire `src` tree for those entrypoint names to find CLI commands, postinstall, doctor, plugin hooks, and session hooks.
3. Read `src/genie-commands/doctor.ts`, `src/lib/agent-sync.test.ts`, and `src/lib/runtime-integr
[… 415 more chars]
```

Mechanical rubric — citations extracted: 0; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

## 7. Group 4 validation command

Run verbatim, from the wish (WISH.md:440):

```text
$ cd ~/prod/rlmx && test -f docs/parity-explore.md && grep -qE 'Gate: (PASS|FAIL)' docs/parity-explore.md
$ echo $?
0
```

The command is silent on success (`grep -q`), so the exit status is the result:
`0` — the report exists and states a verdict. For the record, the line it
matched:

```text
$ grep -nE 'Gate: (PASS|FAIL)' docs/parity-explore.md
572:Gate: FAIL
```

## 8. The tree is still green with the tuned recipe

Tuning edited `examples/agents/explore/`, which `scripts/smoke-explore.mjs`
gates. Re-run after the last tuning round:

```text
$ npm test
# tests 489
# pass 489
# fail 0

$ node scripts/smoke-mcp.mjs
SMOKE PASS: handshake + --dir workspace + Agent-tool schema + live refresh (create/delete + list_changed) + sessions (resume, busy, cross-tool) + error isolation all verified.

$ node scripts/smoke-explore.mjs
# smoke-explore:   rlmx · agent=explore · station/Brain-35B · 9 iterations · 9,733 in / 896 out · $0.00 · 70.5s
# smoke-explore:   ✓ src/mcp/agents.ts:57 → const override = process.env.RLMX_AGENTS_DIR?.trim();
# smoke-explore: ✓ 1 of those cites something the agent's own prompt never mentions (src/mcp/agents.ts:57)
# smoke-explore:   correctness (evidence, not gated): HIT — named RLMX_AGENTS_DIR and cited src/mcp/agents.ts
SMOKE PASS: station=station/Brain-35B (9 it, 1 citation resolved, 70.5s, correct=true); khal=khal/deepseek-v4-flash (9 it, 1 citation resolved, 49.1s, correct=true)

$ npm audit --omit=dev
found 0 vulnerabilities
```

Worth recording against the FAIL: the khal arm of smoke-explore is
`correct=true` with the tuned prompt. The tuning did not fail to improve the
recipe — it improved it measurably on a single-part question, and on the
single-part smoke question a cheap model now answers correctly and cites
resolvably. What it could not do is carry a six-part mined question to ≥90%
fact coverage. The gate measures the second thing.

## 9. Artifacts

| Path | What it is |
|------|------------|
| `parity/run-task.mjs` | Drives one task through the real MCP path (`mcp --dir <root>` → `rlmx_explore`) |
| `parity/run-round.sh` | One round = all six tasks, concurrency-capped, 900s run timeout |
| `parity/score-task.mjs` | Mechanical rubric: criteria 2 and 3 decided, criterion 1 signals prepared |
| `parity/score-round.sh` | Scores a whole round |
| `parity/verify-native.mjs` | Re-verifies all 60 ground-truth anchors |
| `parity/tokens.mjs` | Premium-token accounting for a round |
| `parity/matrix.mjs` | The 97-run matrix above (`SUFFIX_SHORTHAND=1` for the alternate reading) |
| `parity/emit-evidence.mjs` | Emits the verbatim sections of this file |
| `parity/runs/<round>/task-<n>.json` | Every run: returned text, footer, progress, timings, char counts, and (from the audit on) prompt/root provenance |
| `parity/runs/<round>/task-<n>.score.json` | Every run's citation-by-citation verdict and per-fact signals, committed convention |
| `parity/runs/<round>/task-<n>.score.suffix.json` | The same under the partial-path shorthand reading |
| `parity/runs/<round>/task-<n>.score.orphaned.json` | The 7 scores whose runs were overwritten — kept as the only surviving record of those invocations |
| `parity/prompts/<sha256>.md` | SYSTEM.md snapshot per prompt digest (final prompt only; r1–r15 were never snapshotted) |

## 10. What was changed, and what was not

**Changed** (tuning, as the wish permits — `SYSTEM.md` and the `agent.yaml`
budget only):

- `examples/agents/explore/SYSTEM.md` — 11 tuning rounds folded in.
- `examples/agents/explore/agent.yaml` — `max_iterations` 10 → 24,
  `max_cost` 0.25 → 2.00 (0.25 was flash's price and truncated every haiku run).

**Not changed:** the six task files and their checklists, the rubric, and the
gate arithmetic. No task was dropped, no threshold moved, no fact reinterpreted
to make a run pass. The verdict is `Gate: FAIL`, and it is recorded as such.

---

## 11. Audit pass — what the first publication got wrong

This section exists because the first version of this report and
`docs/parity-explore.md` contained claims that could not be re-derived from the
artifacts they cited. Nine defects were found and are recorded here whether or
not they changed anything. **None of them moves the verdict** — the gate needed
5 of 6 tasks and got 0 under every reading of every convention tried — but two
of them made published numbers unrecoverable, and that is worth more than the
verdict being stable.

### Defects that destroyed evidence

1. **Seven run records were overwritten after they were scored.** `run-task.mjs`
   wrote `runs/<round>/task-<n>.json` unconditionally, so re-running a task into
   an existing round label replaced the run while its `.score.json` kept
   describing the earlier one. `matrix.mjs` then took `iters`/`wall`/`cost` from
   the run and `c2`/`c3`/anchors from the score, so seven published rows
   described no single actual run — `r6-mimo-tune1` t1 was published as
   "2 iterations, 900.8s, $0.03" *and* "4/14 anchors", figures belonging to two
   different invocations. Affected: `r6-mimo-tune1` tasks 1/2/3/5/6 and
   `r8-mimo-tune3` tasks 2/5.

   *Fixed:* every run JSON re-scored, matrix regenerated from matched pairs,
   and `run-task.mjs` now exits 3 rather than overwrite an existing record
   unless `PARITY_OVERWRITE=1`. *Not recoverable:* the seven overwritten answers.
   Their score JSONs are kept as `task-N.score.orphaned.json`.

2. **The decisive run's text is gone.** `r8-mimo-tune3` task 2 — the only run
   whose bound reached its threshold, and therefore the only one judged fact by
   fact — was one of the seven. Its score JSON describes an 18,841-character
   answer (24 iterations, $0.23, 768.7s, `sess_bdd21c1bd9ad5b0e`); the run JSON
   beside it holds a 1-character answer (23 iterations, $0.20, 900.0s,
   `sess_81d12614803bbf0e`). §5 printed the empty body and then asserted
   "citations extracted: 44; criterion 2: PASS; criterion 3: PASS" for it —
   internally self-contradictory. The "7 of 10 judged" headline and the
   "measured ceiling is 7 of 10 facts on task 2" handoff item both rest on text
   that no longer exists.

   *Fixed:* the claim is **withdrawn**, not restated. Task 2's ceiling is
   re-derived from `r15-flash-control`, whose answer is intact — 8 of 10
   generous, 6 strict. A fresh `khal/mimo-v2.5` run of task 2 under the
   committed prompt (`r16-mimo-t2-recheck`) was made to see whether mimo
   independently reaches the bar: it does not, reaching 8 of 10 anchor files
   and roughly 5 of 10 claims generously. It is a new data point, not a
   reproduction — r8's prompt was never snapshotted.

### Defects that mislabelled or hid real runs

3. **A judgement attributed to the wrong round.** §4's task-4 entry described "a
   10k-character cited report… stated F1, F2, F5, F7, F8, F9, F10 = 7… missed
   … F11 (`applyBrainGrants`)" and labelled it `r6-mimo-tune1`.
   `r6-mimo-tune1/task-4.json` is 5,436 characters, names 4 of 12 anchor files
   (F1 and F9 among those it does *not* name), and **does** contain
   `applyBrainGrants`. `r6-partial-300s-cap/task-4.json` is 10,095 characters,
   names 6 of 12 including F1 and F9, and does not contain `applyBrainGrants`.
   The judgement is sound and belongs to the latter. The round-log sentence
   "task 4 produced a 10k-character cited report through exactly that path"
   carried the same error. *Fixed:* relabelled in both documents.

4. **A whole round was hidden.** `parity/runs/r6-partial-300s-cap/` — 6 runs,
   $0.43, staged into the commit — appeared in neither document, and
   `matrix.mjs` excluded it with a hard-coded
   `.filter(d => d.startsWith("r") && !d.includes("partial"))`. Combined with
   the seven unreported re-runs, the true totals were **≥103 invocations and
   ≥$11.43**, not "15 rounds, 90 task-runs, $11.00", and "Every run is kept.
   90 result JSONs" was false. All six of its runs were scored during the audit:
   none passes (best 6 of 12 and 6 of 8 anchor files), so the verdict is
   unaffected — but two of them are the *best* task-4 and a strong task-6
   answer, so hiding the round also hid the gate's high-water marks.

   *Fixed:* filter removed, round logged with its own entry, totals corrected
   to 16 rounds / 96 recorded runs / $11.43, and 104 invocations / $12.31 all in.

5. **A fact-by-fact count was one too high.** §4 credited `r4-flash-tune3` task 6
   with F8. `SessionStart`, `hooks.json` and `session-context` have zero
   occurrences in that answer. Corrected from 5 to 4; verdict unchanged.

### Defects in the scoring itself

6. **An undisclosed asymmetry favouring the native arm.** The native-trace
   extractor stopped at the first nested code fence, scoring 1,027 / 693 / 776
   characters of tasks 2/3/4 — 3.0k–3.3k characters per task never reached the
   scorer, in a trace already capped at 4,000 characters at mining time. Fewer
   citations scored means fewer that can fail, so "all six native answers pass
   both by the same scorer that scores the rlmx arm" overstated what was
   checked, in a report that claimed every disclosed asymmetry ran against rlmx.

   *Fixed:* extractor made fence-aware; native re-scored; the 4,000-char mining
   cap disclosed in the Method section. *Consequence:* with its whole visible
   trace scored, **native fails criteria 2 and 3 on task 3** on a partial-path
   shorthand (`bench/api.ts:900` for the real `src/bench/api.ts`, 942 lines).
   The convention was not rewritten to rescue it; both readings are published
   and the alternate one changes exactly one rlmx run, which is nowhere near
   its threshold.

7. **"The bound settles it without a judgement call" was too strong.** The
   anchor-file count was presented as an upper bound on criterion 1, but the
   report's own generous readings exceeded it twice (task 3 judged at 9 on a run
   naming 8; task 4 at 7 on a run naming 4), and the count used full-path
   mentions while the citation convention accepts bare basenames. Under the
   basename column 8 runs reach their threshold; only the (phantom) task-2 run
   had been judged.

   *Fixed:* both columns printed in the matrix, the bound demoted to a screening
   device, and all 8 qualifying runs judged fact by fact in §4 — five on task 2,
   two on task 5, one post-gate re-check. **Every one fails under both
   readings.** Task 5's two runs both miss F5 (the `admit` job in
   `sign-attest.yml`); task 6 misses F8 in every run in every round.

### Defects in reproducibility

8. **No prompt provenance.** No round recorded the `SYSTEM.md`/`agent.yaml` it
   ran under, and the intermediate versions were edited in place, so **no round
   from r1 to r15 can be re-run or re-scored against its actual prompt** and
   "what changed in round N" is prose only. *Fixed going forward, not
   retroactively:* `run-task.mjs` now records `promptSha256`, `agentYamlSha256`
   and a `parity/prompts/<sha>.md` snapshot. Only the final prompt has a digest
   (`22334876a626ea3952674bca3d4ec26abffb3491b992354992aaf2fab3bdc77d`); the
   other 14 are unrecoverable.

9. **No task-root provenance.** The task roots are live checkouts that moved
   during the gate window (`/home/namastex/prod/brain/src/lib/server.ts` was
   written at 19:28; rounds span ~20:00–23:55), so early rounds' citations were
   resolved against a tree that may differ from the one the model read.
   `verify-native.mjs` covers ground-truth drift but not citation-resolution
   drift on the rlmx arm. *Fixed going forward:* `provenance.rootGit` records
   each root's HEAD, branch and dirty flag per run; the exposure is disclosed in
   the report's Method section and cannot be bounded for r1–r15.

### What the audit did not do

No task was dropped, no threshold moved, no rubric loosened to make anything
pass, and no failing run was reclassified. Two changes could only have helped
the rlmx arm and were checked for exactly that: the fence-aware native extractor
(which makes the *native* arm's citations harder, not rlmx's) and the
suffix-shorthand reading (which flips one rlmx run that names 0 of 14 anchor
files). Neither moves a task verdict. Where a corrected number is worse for
rlmx it is published as such — `r6-mimo-tune1` lost five of its six rows to
1-character answers, and task 2's judged ceiling fell from a phantom 7 to a real
6 strict / 8 generous.

**`Gate: FAIL` stands, on 97 recorded runs and 104 invocations.**

---

## 12. Round-2 frozen-suite shot — `r2-shot-gen1-flash`

The pre-registered single shot of the round-2 recipe at the frozen gate.
Narrative, gate arithmetic and the campaign summary are in
[docs/parity-explore.md](../../../docs/parity-explore.md) → *Round 2 — the
frozen-suite shot*. This section is the machine-checkable half.

### 12.1 What ran

| | |
|---|---|
| Round label | `r2-shot-gen1-flash` |
| Recipe | `parity/round2/optimizer/gens/gen-1/recipe`, installed verbatim, zero edits |
| `sha256 SYSTEM.md` | `02184f3595d64de903f34b72b1ab9618afaafb947a881b767daa6f32125245c4` (27,840 chars) |
| `sha256 agent.yaml` (installed) | `20f8e0181f6adc08badfe9c5c95a11e25a39f3dec23bbed460d08eec5a9d385d` |
| Prompt snapshot | `parity/prompts/02184f3595d64de903f34b72b1ab9618afaafb947a881b767daa6f32125245c4.md` |
| Agent / tool | `explore-r` / `rlmx_explore-r` |
| Model | `khal/deepseek-v4-flash`, parent and children |
| Child pin | `{"model.provider":"khal","model.model":"deepseek-v4-flash","model.sub-call-model":"deepseek-v4-flash"}` written to each scratch `HOME` |
| Suite (recorded per run) | `frozen-eval`, `tasksDir` = `<wish>/tasks` |
| Concurrency | 1, tasks in order 1..6 |
| Env corrections | `RLMX_REPL_TIMEOUT_MS=600000`, `RLMX_MCP_RUN_TIMEOUT_MS=900000`, `PARITY_CALL_TIMEOUT_MS=600000`, `PARITY_MAX_TOTAL_TIMEOUT_MS=2400000` |
| rlmx HEAD | `6ec4822` (worktree dirty — round-2 harness staged, not committed) |
| Root HEADs | `/home/namastex/prod/brain` `040bb83`; `/home/namastex/workspace/repos/genie` `71dd019` |
| Window | 2026-07-27 13:35:02Z → 14:16:22Z |
| Retries used | **0** — all six runs exited 0 on the first attempt |
| Records | `parity/runs/r2-shot-gen1-flash/task-{1..6}.{json,score.json,score.suffix.json}`, `logs/`, `shot.sh`, `score-shot.sh`, `gate-table.mjs` |

Reproduce:

```bash
export KHAL_API_KEY=…                       # shell only, never in a file
cd ~/prod/rlmx
node .genie/wishes/rlmx-explore-offload/parity/verify-native.mjs
bash .genie/wishes/rlmx-explore-offload/parity/runs/r2-shot-gen1-flash/shot.sh
bash .genie/wishes/rlmx-explore-offload/parity/runs/r2-shot-gen1-flash/score-shot.sh
node .genie/wishes/rlmx-explore-offload/parity/runs/r2-shot-gen1-flash/gate-table.mjs
node .genie/wishes/rlmx-explore-offload/parity/tokens.mjs r2-shot-gen1-flash
```

`shot.sh` is a serial specialization of `run-round.sh` — it exists because
`run-round.sh` hardcodes `run-task.mjs <n> <model> <round>` with no recipe
argument, and the frozen gate's own runner must keep meaning what it meant. It
keeps `timeout 2400`, one log per task and per-exit-code aggregation.
`score-shot.sh` runs the **suffix reading first** and moves it aside before the
default reading, because `score-task.mjs` writes both to `<run>.score.json` —
the clobbering defect §11 found in the native pair.

### 12.2 Ground truth, re-verified immediately before the shot

```
$ node .genie/wishes/rlmx-explore-offload/parity/verify-native.mjs
task 1: 14/14 fact anchors still resolve with their recorded text
task 2: 10/10 fact anchors still resolve with their recorded text
task 3: 11/11 fact anchors still resolve with their recorded text
task 4: 12/12 fact anchors still resolve with their recorded text
task 5: 5/5 fact anchors still resolve with their recorded text
task 6: 8/8 fact anchors still resolve with their recorded text

NATIVE GROUND TRUTH VERIFIED
```

**Zero drift across all 60 anchors**, so raw and drift-adjusted readings are
identical and no fact required adjustment.

### 12.3 Train-set leakage check

gen-1 inherits gen-4's four leaked *training* anchoring terms. Tested against
this suite:

```
frozen-suite anchoring terms checked: 60
terms appearing verbatim in gen-1 SYSTEM.md: 0
```

`MAX_ATTEMPTS`, `findCmd`, `FETCH_BODY_TIMEOUT_MS` and `RECORD_SCHEMA_VERSION`
appear in **no** frozen task file and anchor **no** frozen fact. The shot is
clean of the defect that rejected gen-4.

### 12.4 Mechanical results — both readings

| Task | need | ok | iters | spawns | wall | cost | answer | cites | c2 | c3 | c2 suffix | c3 suffix |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 13/14 | ✓ | 8 | 4 | 514.9s | $0.05 | 11,517 | 62 | PASS | PASS | PASS | PASS |
| 2 | 9/10 | ✓ | 14 | 3 | 480.8s | $0.03 | 8,088 | 28 | PASS | PASS | PASS | PASS |
| 3 | 10/11 | ✓ | 14 | 4 | 340.4s | $0.04 | 4,427 | 19 | PASS | PASS | PASS | PASS |
| 4 | 11/12 | ✓ | 4 | 4 | 390.8s | $0.03 | 5,674 | 32 | PASS | PASS | PASS | PASS |
| 5 | 5/5 | ✓ | 13 | 4 | 441.2s | $0.05 | 9,497 | 47 | PASS | PASS | PASS | PASS |
| 6 | 8/8 | ✓ | 11 | **0** | 310.1s | $0.02 | 8,987 | 27 | PASS | PASS | PASS | PASS |

**215 citations, 0 unresolvable, 0 fabricated, both readings.** The suffix
reading flips nothing — no citation in this shot depends on partial-path
resolution. Seven round-1 rounds were also 6/6 citation-clean, so this
reproduces a solved property rather than establishing a new one.

Task 6 ran with **zero recursive spawns** — the fan-out never fired. That is the
`SEEN`-seeding defect logged for gen-5 at the gen-4 closeout, observed here on
the frozen suite.

### 12.5 Criterion 1 — screening, then judgement

Screening rule (pre-registered by §11 for every future round): judge, do not
screen, every c2/c3-clean run within 2 facts of threshold on **either** column.

| Task | need | strict (full path) | basename | disposition |
|---|---|---|---|---|
| 1 | 13 | 3/14 | 3/14 | screened out — 10 short |
| 2 | 9 | 8/10 | 8/10 | judged |
| 3 | 10 | 6/11 | 8/11 | judged |
| 4 | 11 | 2/12 | 2/12 | screened out — 9 short |
| 5 | 5 | 4/5 | 4/5 | judged |
| 6 | 8 | 6/8 | 6/8 | judged |

Judged results, fact by fact, both readings:

| Task | need | strict | generous | Misses under the generous reading |
|---|---|---|---|---|
| 2 | 9 | **5** | **7** | F1 `runtime-integrations.ts` cwd; F3 `syncOneSkill`; F7 `councilStampState` |
| 3 | 10 | **6** | **9** | F7 `BRAIN_ENDPOINT` — **contradicted**, called "status-only … used only for display" against the claim that it is the one true remote knob; F9 `BRAIN_ADMIN_DATABASE_URL` / `db.ts` never named |
| 5 | 5 | **3** | **3** | F4 the `conclusion == 'success'` gate (answer says CI "completed", not "succeeded"); F5 `sign-attest.yml` never named |
| 6 | 8 | **3** | **7** | F1 the Hermes `skills.external_dirs` → `$GENIE_HOME/skills` mechanism |

Facts counted generous-only, with the reason each is generous rather than
strict:

- task 2 F4 — answer states digest-mismatch→stale, not the
  `sourceDigest === managedDigest && computeDirDigest(dir) === managedDigest`
  conjunction.
- task 2 F6 — answer says `stampWorkflow` at `agent-sync.ts:4977`; the fact
  anchors `stampWorkflowTemplate` at `:5078`. Same substance, different symbol.
- task 3 F1 — `Bun.serve` at `server.ts:395` stated; the symbol `httpServer` is not.
- task 3 F5 — the route `POST /api/brains/:id/ask` at `ask.ts:78` stated; the
  regex is not.
- task 3 F11 — same claim via `discoverBaseUrl` in `common.ts` rather than
  `discoverHookBaseUrl` in `compiled-entry.ts`.
- task 6 F3, F6, F7, F8 — install/uninstall/setup/plugin-hook sync behaviour
  stated in substance without the anchoring identifiers (`installCommand`,
  `MANIFEST_NAME`, `acquireLifecycleLease`, `SessionStart`).

**No task verdict differs between the strict and generous readings, and none
differs between the default and suffix citation readings.**

### 12.6 Gate arithmetic

| Task | c1 strict | c1 generous | need | c2 | c3 | Verdict |
|---|---|---|---|---|---|---|
| 1 | ≤3 | ≤3 | 13 | PASS | PASS | **FAIL** |
| 2 | 5 | 7 | 9 | PASS | PASS | **FAIL** |
| 3 | 6 | 9 | 10 | PASS | PASS | **FAIL** |
| 4 | ≤2 | ≤2 | 11 | PASS | PASS | **FAIL** |
| 5 | 3 | 3 | 5 | PASS | PASS | **FAIL** |
| 6 | 3 | 7 | 8 | PASS | PASS | **FAIL** |

0 of 6 tasks pass; the suite requires 5 of 6.

**`Round-2 gate: FAIL`.** A4b stays unchecked; Wish B does not start.

### 12.7 Against round 1's per-task best

Round 1's column is its best across 16 rounds and four tiers; round 2's is one
run. The comparison flatters round 1 by construction.

| Task | need | Round-1 best (judged) | Round-2 shot (judged) | Δ generous |
|---|---|---|---|---|
| 1 | 13 | ≤7 (`r7-mimo-tune2`) | ≤3 | −4 |
| 2 | 9 | 6 / **8** (`r15-flash-control`) | 5 / **7** | −1 |
| 3 | 10 | 7 / **9** (`r1-flash-baseline`) | 6 / **9** | 0 |
| 4 | 11 | ≤6 (`r6-partial-300s-cap`) | ≤2 | −4 |
| 5 | 5 | 2 / **3** (`r15-flash-control`) | 3 / **3** | 0 |
| 6 | 8 | ≤6 (`r8-mimo-tune3`) | 3 / **7** | +1 |

Recomputed round-1 screening ceilings, for a like-for-like column comparison
(clean runs only, best strict then basename): t1 7/7 `r5-mimo-t0`; t2 8/9
`r1-flash-baseline`; t3 8/9 `r1-flash-baseline`; t4 6/6 `r6-partial-300s-cap`;
t5 4/5 `r15-flash-control`; t6 6/6 `r10-kimi-tune1`.

### 12.8 Premium-token accounting (reported, never gated)

| Task | Native premium | rlmx premium | Ratio | khal in/out | khal cost | Wall |
|---|---|---|---|---|---|---|
| 1 | 2,943,691 | 3,314 | 888× | 298,509 / 42,250 | $0.05 | 514.9s |
| 2 | 3,098,197 | 2,512 | 1,233× | 166,728 / 40,080 | $0.03 | 480.8s |
| 3 | 2,976,188 | 1,622 | 1,835× | 246,914 / 24,437 | $0.04 | 340.4s |
| 4 | 2,186,864 | 1,846 | 1,185× | 198,872 / 29,128 | $0.03 | 390.8s |
| 5 | 1,499,747 | 2,831 | 530× | 282,480 / 39,967 | $0.05 | 441.2s |
| 6 | 3,319,167 | 2,747 | 1,208× | 116,897 / 14,173 | $0.02 | 310.1s |
| **total** | **16,023,854** | **14,872** | **1,077×** | 1,310,400 / 190,035 | **$0.22** | 2,478s |

### 12.9 Verbatim runs

Answers are capped at 1,500 characters each here; the full text of every run is
in `parity/runs/r2-shot-gen1-flash/task-<n>.json` under `answer`.

### Round `r2-shot-gen1-flash`

#### task 1 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 1 khal/deepseek-v4-flash r2-shot-gen1-flash
rlmx · agent=explore-r · khal/deepseek-v4-flash · 8 iterations · 298,509 in / 42,250 out · $0.05 · 514.7s · session sess_8f16529ed07b9d78
```

Returned answer (11517 chars):

```text
# Brain Codebase Report

## 1. Cloud Models / Providers / Environment

### Gemini Embeddings
- **File**: `src/lib/embedding.ts`
- **Model**: `gemini-embedding-2-preview` (constant `DEFAULT_MODEL`, line 28)
- **Dimensions**: 768 (constant `DEFAULT_DIMS`, line 29)
- **Task types**: `EmbeddingTaskType` union defined at lines 18-26: `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, `SEMANTIC_SIMILARITY`, `CLASSIFICATION`, `CLUSTERING`, `QUESTION_ANSWERING`, `FACT_VERIFICATION`, `CODE_RETRIEVAL_QUERY`
- **Default task**: `RETRIEVAL_DOCUMENT` (line 137 fallback)
- **Function**: `export async function embedText()` at line 109
- **No fallback**: only `GEMINI_API_KEY` / `GOOGLE_API_KEY` checked (lines 94, 118, 133, 206); if none set, embedding is unavailable

### rlmx Default Models (all Google/Gemini — no Claude or GPT defaults)
- `src/lib/omni/extractor/agent-wire.ts:73` — `DEFAULT_PRESERVATION_PROVIDER = "google"`
- `src/lib/omni/extractor/agent-wire.ts:74` — `DEFAULT_PRESERVATION_MODEL = "gemini-3.1-flash-lite-preview"`
- `src/lib/omni/extractor/audit-wire.ts:61` — `DEFAULT_AUDIT_PROVIDER = "google"`
- `src/lib/omni/extractor/audit-wire.ts:62` — `DEFAULT_AUDIT_MODEL = "gemini-3.1-flash-lite-preview"`
- rlmx API key injection via `src/lib/ask-pipeline.ts:102-132` (`injectRlmxSettingsApiKeysForBrain`) reads `~/.rlmx/settings.json`

### Environment Variables
  
| Variable | Files reading it |
|----------|-----------------|
| `GEMINI_API_KEY` | `src/auto-kb/gemini.ts:67`, `src/lib/embedding.ts
[… 10017 more chars]
```

Mechanical rubric — citations extracted: 62; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 2 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 2 khal/deepseek-v4-flash r2-shot-gen1-flash
rlmx · agent=explore-r · khal/deepseek-v4-flash · 14 iterations · 166,728 in / 40,080 out · $0.03 · 480.6s · session sess_6518d560a381beec
```

Returned answer (8088 chars):

```text
## Defect A — Repository-local codex CLI executable refused

**Root cause:** `validateTrustedExecutablePath` (src/lib/trusted-executable.ts:129) builds a set of forbidden roots — `canonicalCwd` plus every enclosing `.git` ancestor discovered by `resolveEnclosingGitTrustRoots` (line 96). It then filters out any root that is the home directory itself or an ancestor of it (line 142-143), but **a git root that is a descendant of home (e.g., a dotfiles repo at `~/dotfiles`)** is *not* excluded. The error is thrown at line 147 when the candidate executable falls inside a forbidden root:

```ts
src/lib/trusted-executable.ts:147
throw new Error(`Refusing repository-local ${name} executable: ${candidate}`);
```

When running from `~` that is itself a git root (e.g., a dotfiles repo with `.git` at `~`), the root `~` **is** excluded because `isSameOrContainedPath(root, canonicalHome)` is true. So `~/.local/bin/codex` would *not* be refused in that case. The defect described in the question (running from `~` refuses `~/.local/bin/codex`) must involve a different setup — for instance, `~` is not the git root, but a parent of the git root. More commonly, the bug manifests when the git root is a project *under* home (e.g., `/home/user/project`), whose root is excluded, so the executable would *not* be refused. The reported problem may be due to an outdated version or a different root resolution order. However, the code as written does exactly what the comment says: "Real project roots BELOW
[… 6588 more chars]
```

Mechanical rubric — citations extracted: 28; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 3 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 3 khal/deepseek-v4-flash r2-shot-gen1-flash
rlmx · agent=explore-r · khal/deepseek-v4-flash · 14 iterations · 246,914 in / 24,437 out · $0.04 · 340.1s · session sess_2bb9ce74ae3014a9
```

Returned answer (4427 chars):

```text
After thorough investigation, here is the blunt verdict:

## 1. What does `brain serve` start?  
- **`Bun.serve`** at `src/lib/server.ts:395` with `fetch: handleRequest`.  
- **Default host:** `"0.0.0.0"` (hardcoded, line 397) — binds all interfaces.  
- **Default port:** `opts.port ?? 3847` (line 244).  
- **No configurable env var for host or port** — `BrainServerOptions` has only `port?: number` (line 56), no host field. `BRAIN_HOST` / `BRAIN_PORT` do not exist. The written config endpoint is `127.0.0.1` (line 422), but the actual bind is `0.0.0.0`.  

## 2. HTTP routes exposed  

**Directly in `handleRequest` (`src/lib/server.ts:940-1019`):**  
- `GET /healthz` (line 966), `GET /readyz` (line 967)  
- `GET /api/sync/status` (line 970)  
- `GET /api/review/feed` (line 973), `POST /api/review/classification/:id` (line 976)  
- `GET /api/brains/:id/schema` (line 980)  
- `POST /khortex/session/event` (line 991) — gated on `--khortex-memory`  
- `POST /khortex/session/query` (line 996) — gated; contract stub supports modes `recall|ask|hybrid` (line 1397)  
- `GET /khortex/healthz` (line 1005) — gated  

**Delegated to bench router (`src/bench/api.ts:661-760`):**  
- `POST /api/search` (`search.ts:9`) — `url.pathname !== "/api/search" || req.method !== "POST"`  
- `POST /api/brains/:id/ask` (`ask.ts:78`) — SSE streaming endpoint  
- `POST /api/khortex/ask` (`khortex-ask.ts:48`) — cross-Brain ask concierge  
- 25+ other REST endpoints (brains, files, documents, analyze, config,
[… 2927 more chars]
```

Mechanical rubric — citations extracted: 19; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 4 — `/home/namastex/prod/brain`

```text
$ node run-task.mjs 4 khal/deepseek-v4-flash r2-shot-gen1-flash
rlmx · agent=explore-r · khal/deepseek-v4-flash · 4 iterations · 198,872 in / 29,128 out · $0.03 · 390.5s · session sess_226cb1c7187e2141
```

Returned answer (5674 chars):

```text
## Ground Truth: Brain's Database Topology

**Brain uses ONE Postgres database PER BRAIN entity**, named `brain_<slug>`.

### How it works

1. **Database name derivation** — `deriveDatabaseName(slug)` at `src/lib/pgserve.ts:89-108` produces `` `brain_${sanitized}` `` (line 106). The slug is lowercased, non-alphanumeric characters replaced with underscores, prefixed with `brain_`, and truncated to 63 characters.

2. **Database creation** — `ensureBrainDatabase(database)` at `src/lib/db.ts:376` connects to the Postgres cluster on the admin DSN, checks `pg_database`, and if missing runs `CREATE DATABASE "${database}"` (line 412). A variant `ensureBrainDatabaseIfOwned` at `src/lib/db.ts:455-462` adds `OWNER "${runtimeRole}"` to grant ownership to a provisioned runtime role.

3. **Connection switching** — `setActiveDatabase(database)` at `src/lib/db.ts:291-301` closes the existing `sql` pool (line 295: `await sql.end({ timeout: 2 })`) and sets `activeDatabase = database` (line 301). `getDb()` at `src/lib/db.ts:595-615` builds a DSN targeting the active database via `buildDsnForDatabase` (line 610), which rewrites the URL path to the target database name (line 162: `url.pathname = \`/\${encodeURIComponent(database)}\``).

4. **Default/fallback** — `resolveDatabase()` at `src/lib/db.ts:579-587` returns `activeDatabase` if set, else the database named in `DATABASE_URL`, else the literal `"brain"` (line 586).

### The brains table (registry, NOT per-brain storage)

Migration `001-brai
[… 4174 more chars]
```

Mechanical rubric — citations extracted: 32; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 5 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 5 khal/deepseek-v4-flash r2-shot-gen1-flash
rlmx · agent=explore-r · khal/deepseek-v4-flash · 13 iterations · 282,480 in / 39,967 out · $0.05 · 440.9s · session sess_de6175e7837eaf29
```

Returned answer (9497 chars):

```text
# Install/Release Delivery Path — Genie Repository

## 1. `install.sh` (repo root) — Channel Selection & Fetch

- **Channel**: env var `GENIE_CHANNEL`, default `stable` (install.sh:358 — `local channel="${GENIE_CHANNEL:-stable}"`). No flag.
- **Manifest URL base**: `MANIFEST_BASE` at install.sh:28 — `"https://raw.githubusercontent.com/${REPO}/main/.well-known"`.
- **Per-channel file**: install.sh:388 — `if [ "$channel" = "stable" ]; then file="latest.json"; else file="${channel}.json"; fi`. Stable → `latest.json`, dev → `dev.json`, homolog → `homolog.json`.
- **One-liner fetch**: install.sh:14 — `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash`.

### 1a. Staging + Extraction (lines 632–660)
- **Staging creation**: install.sh:635 — `(umask 077; mkdir "$STAGING_DIR")` (private 0700).
- **Extraction**: install.sh:641 — `tar -xzf "$tarball" -C "$STAGING_DIR"`.
- **chmod after extraction**: Yes, but only on the staging root dir to relock it to 0700 after tar clobbers mode (install.sh:649 — `chmod 700 "$STAGING_DIR"`). This is a relock of the private staging sandbox, not a chmod of any live binary path. The comment at install.sh:626–628 confirms: *"Its only chmod relocks the private staging root it created to 0700 after extraction (tar clobbers that mode via the archived root entry); it never chmods a live path."*

### 1b. Preflight of `~/.local/bin`
- **No preflight before download.** `LOCAL_BIN="$HOME/.local/bin"` (install.sh:49) is defined
[… 7997 more chars]
```

Mechanical rubric — citations extracted: 47; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

#### task 6 — `/home/namastex/workspace/repos/genie`

```text
$ node run-task.mjs 6 khal/deepseek-v4-flash r2-shot-gen1-flash
rlmx · agent=explore-r · khal/deepseek-v4-flash · 11 iterations · 116,897 in / 14,173 out · $0.02 · 309.9s · session sess_c18ec3d02e0a5ccd
```

Returned answer (8987 chars):

```text

## Trigger Inventory — Every Caller of the Agent Sync Entrypoints

The agent-sync engine lives in `src/lib/agent-sync.ts` with one public entrypoint — **`runAgentSync`** (defined at line 6927) — which converges Claude and Hermes surfaces. It is never called directly by hooks or session lifecycles. All triggers flow through `runAgentSync` via one of three callers:

### 1. `genie install` — post-curl|bash finishing step
- **File**: `src/genie-commands/install.ts:362` — `runSync(agentSyncSelection)`
- The selection is narrowed by `narrowAgentSyncSelection` (line 518-520): passes through for `auto`/`all`/`claude`, returns `null` for `none`/`codex`.
- The call is gated on Codex integration not having failed (line 361).

### 2. `genie update` — self-update convergence
- **File**: `src/genie-commands/update.ts:2801` — `runUpdateAgentSync(agentSyncSelection)`, which calls `runAgentSyncSafe` with `strict: true` (line 1761).
- Also reachable via legacy `--sync-only` path at line 1786.
- The `runAgentSyncSafe` wrapper (line 2688-2710) formats a summary, handles Codex role refresh, writes `~/.genie/.last-agent-sync` throttle marker on success.

### 3. `runAgentSyncSafe` directly (used by tests only)
- **Test files**:
  - `src/lib/agent-sync.test.ts:195` — main test harness
  - `src/genie-commands/__tests__/update.test.ts:2257` — update test suite

### What does NOT trigger sync (by design):
- **Hooks subsystem** (`src/hooks/`): zero references to `runAgentSync`, `syncSkill`, or `agent-s
[… 7487 more chars]
```

Mechanical rubric — citations extracted: 27; criterion 2 (citations resolve): **PASS**; criterion 3 (no fabrication): **PASS**.

