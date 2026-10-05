# scan-runs — the run records behind the corrected Group 3 numbers

These four files are the raw output of the two scanner runs that produced the
**correction** in `evidence-group-3.md` §10 and
`.rlmx/agents/git-historian.proposed/EVIDENCE.md` §7. They exist because the
original Group 3 numbers had no committed run record, so nobody could check
them without re-running a scanner over a window that no longer exists.

## What was run

One pair, captured back-to-back at **2026-07-27T22:42:4{2,3}Z**, over the same
transcripts:

```bash
# pre-fix classifier — the scanner as Group 3 originally shipped it
node <pre-fix scan-transcripts.mjs> --explain git-history --examples 8
node <pre-fix scan-transcripts.mjs> --hours 24 --json

# post-fix classifier — the scanner at this revision
node plugins/claude-code/skills/microagent-create/scan-transcripts.mjs --explain git-history --examples 8
node plugins/claude-code/skills/microagent-create/scan-transcripts.mjs --hours 24 --json
```

The pre-fix copy differs from the shipped file in **two** places, only one of
which can move a number:

1. **The redirect arm of `SIDE_EFFECTING`** — the character class before `>`:
   `(^|[^0-9&\s])>>?\s*[^&\s|]` (pre-fix) versus `(^|[^0-9&<>=-])>>?\s*[^&\s|]`
   (post-fix). **This is the only difference that touches classification**, and
   so the only one that can change any count, character total, share or family
   assignment. Every number in the delta table is attributable to it alone.

2. **The `--explain` by-action histogram** — the `evidence-group-3.md` §10.4
   fix, which added a remainder row and a total to a block that was silently
   truncated at 15 rows. The pre-fix copy predates it. It is visible in the two
   `--explain` files here: `…prefix-explain-git-history.txt` ends its by-action
   block at `1  git tag` and goes straight to `by project:`, while
   `…postfix-explain-git-history.txt` closes that block with
   `1  (1 further actions below the top 15)` and
   `496  total — equals the family's 496 calls`. **This difference affects
   `--explain` output only.** It is a print-time change with no effect on
   classification, so it moves nothing in the delta table and nothing in either
   `report.json`.

*An earlier revision of this README said the two copies "differ in exactly one
character class". That was wrong twice over: it missed difference 2, and by
asserting a single difference it invited reading the two `--explain` files as
comparable line-for-line, which their by-action blocks are not.*

| file | what |
|---|---|
| `2026-07-27T22-42-42Z-prefix-report.json` | whole-window family table, pre-fix classifier |
| `2026-07-27T22-42-43Z-postfix-report.json` | same window, post-fix classifier |
| `2026-07-27T22-42-42Z-prefix-explain-git-history.txt` | `--explain git-history`, pre-fix |
| `2026-07-27T22-42-43Z-postfix-explain-git-history.txt` | `--explain git-history`, post-fix |

## Why this pair is a clean A/B and not two samples

The two JSON reports agree exactly on everything the classifier does not touch:

```
files 138 · lines 43613 · window since 2026-07-26T22:42Z
tool-result chars 17,958,615 (~4,489,654 tok)
assistant turns 17,687 · output 8,537,792 · cache-create 125,996,910 · cache-read 2,819,821,340
```

Identical in both files. The window is rolling over live transcripts, so those
totals are *not* reproducible tomorrow — but the two runs read the same bytes
0.5 s apart, so every difference between them is the character class and
nothing else.

## What is redacted, and what is not

`samples` (up to six verbatim command lines per family) is retained for
**`git-history`** — the family these records are about, whose commands are all
against this repository — and emptied for the other seven families, whose
samples quote unrelated private projects. Every count, character total, token
estimate and share is unmodified. The `--explain` files are byte-for-byte the
scanner's own stdout, unedited; they are scoped to `git-history` by
construction.

No secret appears in any of these files (checked for `sk-…`, `ghp_`,
`github_pat`, `BWS_ACCESS_TOKEN`, bearer tokens, AWS keys and PEM headers).

## What these records do **not** cover

The two feasibility-probe runs in `EVIDENCE.md` §4 (run 1 fabricated, run 2
clean) have **no** run record here or anywhere. They were executed in a scratch
`RLMX_AGENTS_DIR` that no longer exists, and their token/cost/latency figures
are **self-reported from the session that ran them, not re-derivable**. §4 says
so at the point of use.
