# Wish duration and size study (genie repo, all branches, 2025-08 → 2026-09-16)

Companion data: `wishes.csv` (342 wishes, one row per slug), `sessions.csv` (20 Claude Code sessions).
Scripts: `wishes.py` (git pass + status detection + size metrics), `effort.py` (commit-derived effort),
`pr.py` (PR-branch span), `sessions.py`, `analyze.py`. All under the same scratchpad `v6/` directory.

## 1. Methodology

**Wish discovery.** `git log --all --name-only --format= -- '*wish*' '*WISH*' | sort -u` returns 156,373 paths,
155,051 of them under `.genie/backups/` (ignored). Primary wish documents were taken from `.genie/wishes/**`,
`genie/wishes/**` and `.claude/worktrees/*/.genie/wishes/**` (prefix stripped): basename `WISH.md`/`wish.md`
(slug = parent dir, container dirs `archive/`, `_archive/`, `genie-wishes-backup/` skipped), flat
`.genie/wishes/<slug>.md`, and `*-wish.md`. Slugs dedupe across branches, layouts and archive copies: 342 wishes.

**One git pass, not per-file calls.** `git log --all --raw --abbrev=40 --no-renames --format='%x00%H%x09%ad'
--date=iso-strict -- <paths>` gives every (commit, blob, path) touch; 782 distinct blobs were read in one
`git cat-file --batch` call. Per wish: `created` = earliest commit touching a primary doc; `shipped` = the
earliest commit whose blob has a status line (`| **Status** | X`, `**Status:** X`, `Status: X`, YAML `status: x`)
in the first 60 lines matching SHIPPED/DONE/COMPLETE(D)/EXECUTED (EXECUTED added because v4/v5 headers used it
before being reconciled to DONE); else `shipped_or_last` = last commit and the row is flagged `unshipped`.
Size metrics come from the blob at ship (or last): bytes, lines, `Group` headings (`## … Group`, `**Group X`),
task bullets (`- [ ]`/`- [x]`), distinct backticked paths containing `/`.

**Three duration measures** (all wall clock):
- `hours`: created → shipped (calendar). Dominated by idle time and bulk header reconciliations (see caveats).
- `active_hours`: sum of gaps ≤2h between commits that touch the wish dir or mention the slug, plus 0.5h per
  burst. A floor: code commits that neither touch `.genie/wishes/<slug>/` nor name the slug are invisible.
- `pr_branch_hours`: for wishes whose slug appears in a `Merge pull request` subject, the span from the first
  commit on the PR's second-parent chain to the merge (up to 5 PRs per wish, max span). This is the closest
  proxy for "one wish → one green PR" delivery time. 55 shipped wishes have it (50 in v4+v5).

**Eras** by created date: v1 <2025-10-03, v2 <2026-03-08, v3 <2026-03-23, v4 <2026-07-03, v5 after.

## 2. Counts per era

| era | wishes | shipped | unshipped | shipped with PR branch |
|---|---|---|---|---|
| v1 | 5 | 0 | 5 | 0 |
| v2 | 51 | 27 | 24 | 4 |
| v3 | 18 | 4 | 14 | 0 |
| v4 | 221 | 88 | 133 | 23 |
| v5 | 47 | 32 | 15 | 27 |
| all | 342 | 151 | 191 | 55 |

Final status words seen: DRAFT 114, SHIPPED 92, DONE 26, APPROVED 25, COMPLETE 23, IN_PROGRESS 8, EXECUTED 8.

## 3. Duration distributions

### 3a. Calendar hours, created → shipped (shipped wishes only)

| era | n | median | p75 | p90 | max | median (days) | p90 (days) | n with 0h |
|---|---|---|---|---|---|---|---|---|
| v2 | 27 | 0.0 | 19.6 | 98.1 | 238.7 | 0.00 | 4.1 | 14 |
| v3 | 4 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00 | 0.0 | 4 |
| v4 | 88 | 0.0 | 3.3 | 195.7 | 196.3 | 0.00 | 8.2 | 61 |
| v5 | 32 | 17.7 | 326.2 | 424.7 | 674.0 | 0.74 | 17.7 | 3 |
| all | 151 | 0.0 | 30.5 | 195.7 | 674.0 | 0.00 | 8.2 | 82 |

Excluding 0h rows (wish first committed already marked shipped): all n=69 median 48h, p75 196h, p90 356h;
v5 n=29 median 123h (5.1 days), p75 348h (14.5 days), p90 427h (17.8 days).
82 of 151 shipped wishes have 0h because the wish doc landed in the same squash/merge as its code. Ship dates
cluster on bulk reconciliation commits: 2026-03-28 (30 wishes), 2026-04-10 (23), 2026-04-05 (14). The v4 p90 of
195.7h is one such commit. Unshipped v4 rows mostly end at the 2026-07-02 archive move (93 rows).
**Calendar hours therefore measure queue and bookkeeping, not effort.**

### 3b. Commit-derived active hours (shipped wishes)

| era | n | median | p75 | p90 | max | work bursts (median) | commits (median) |
|---|---|---|---|---|---|---|---|
| v4 | 88 | 2.0 | 2.5 | 3.1 | 4.9 | 4 | 6 |
| v5 | 32 | 3.7 | 5.2 | 10.6 | 27.9 | 4 | 10.5 |
| all | 151 | 2.5 | 3.0 | 4.9 | 27.9 | 4 | 6 |

### 3c. PR-branch hours, first branch commit → merge (shipped wishes with a slug-named PR)

| era | n | median | p75 | p90 | max | branch commits (median / p90) | PR insertions (median / p90) | PR files (median / p90) |
|---|---|---|---|---|---|---|---|---|
| v4 | 23 | 0.9 | 2.8 | 5.5 | 26.8 | 4 / 12 | 497 / 3,455 | 11 / 33 |
| v5 | 27 | 2.3 | 11.1 | 30.3 | 224.4 | 7 / 36 | 2,300 / 7,584 | 22 / 76 |
| all | 55 | 1.6 | 6.2 | 19.1 | 224.4 | 5 / 27 | 1,445 / 6,862 | 17 / 50 |

v5 share of PR branches merged within 8h: 19/27 (70%); within 24h: 24/27 (89%). The three beyond 24h are
`routing-delivery-fix` (45h, 2 commits, idle), `mcp-write-tools` (53h), `codex-plugin-update-handoff` (224h,
1,158-line wish, 11,421 insertions).

## 4. Size distributions (size at ship or last; shipped + unshipped)

| era | n | lines med / p75 / p90 / max | groups med / p90 / max | tasks med / p90 / max | files med / p90 / max | bytes med / p90 |
|---|---|---|---|---|---|---|
| v1 | 5 | 128 / 164 / 234 / 280 | 3 / 5 / 5 | 0 / 4 / 6 | 9 / 28 / 30 | 5.5k / 13.8k |
| v2 | 51 | 254 / 452 / 689 / 1428 | 4 / 6 / 16 | 21 / 37 / 71 | 9 / 26 / 60 | 8.7k / 26.7k |
| v3 | 18 | 224 / 289 / 362 / 547 | 4 / 7 / 10 | 12 / 21 / 32 | 6 / 21 / 27 | 10.3k / 17.9k |
| v4 | 221 | 223 / 349 / 478 / 1931 | 4 / 8 / 14 | 25 / 61 / 168 | 9 / 32 / 78 | 11.7k / 35.5k |
| v5 | 47 | 271 / 392 / 480 / 1158 | 4 / 8 / 23 | 22 / 42 / 71 | 18 / 48 / 280 | 25.2k / 59.0k |
| all | 342 | 235 / 360 / 497 / 1931 | 4 / 8 / 23 | 23 / 56 / 168 | 10 / 32 / 280 | 12.8k / 35.6k |

The typical wish has been ~230 lines, 4 groups, ~23 task bullets, ~10 named files for every era; v5 wishes name
more files (18) and are twice the bytes (25k) because they carry evidence ledgers and review history in the doc.

## 5. Size × duration

**Calendar hours (shipped, hours>0, n=69):** no relationship. Spearman rho with lines 0.02, tasks 0.04, groups
-0.06, files -0.13. By lines quartile the median calendar hours were 86h (≤161 lines), 134h (162–236), 17h
(237–350), 22h (>350): big wishes shipped by multi-agent orchestration in one sitting, small ones sat in a queue.

**PR-branch hours (v4+v5 shipped with PR, n=50):** strong relationship. Spearman rho with lines 0.67, tasks 0.55,
groups 0.51, files 0.47, PR insertions 0.70. Branch commits correlate similarly (lines 0.64, insertions 0.72).

| wish lines | n | branch hours med / p75 / p90 / max | merged ≤8h | merged ≤24h | PR insertions (med) |
|---|---|---|---|---|---|
| ≤150 | 9 | 0.4 / 0.7 / 2.0 / 2.3 | 100% | 100% | 140 |
| 151–250 | 19 | 0.8 / 2.0 / 5.1 / 20.3 | 95% | 100% | 1,181 |
| 251–400 | 12 | 2.8 / 10.8 / 25.6 / 53.3 | 67% | 83% | 2,349 |
| >400 | 10 | 10.3 / 16.6 / 63.2 / 224.4 | 30% | 80% | 3,760 |

| wish groups | n | branch hours med / p90 | ≤8h | ≤24h | | wish tasks | n | branch hours med / p90 | ≤8h | ≤24h |
|---|---|---|---|---|---|---|---|---|---|---|
| ≤2 | 9 | 0.4 / 3.0 | 100% | 100% | | ≤15 | 12 | 0.4 / 2.3 | 100% | 100% |
| 3 | 10 | 1.2 / 5.8 | 90% | 100% | | 16–25 | 16 | 0.9 / 17.4 | 75% | 94% |
| 4 | 13 | 0.5 / 13.4 | 77% | 92% | | 26–40 | 13 | 3.0 / 23.4 | 69% | 85% |
| 5–6 | 7 | 2.6 / 21.8 | 86% | 86% | | >40 | 9 | 3.3 / 58.8 | 56% | 89% |
| >6 | 11 | 8.1 / 53.3 | 36% | 82% | | | | | | |

Named files: ≤10 → median 0.5h, p90 4.1h, 100% within 24h; 11–20 → median 3.0h, p90 45h, 73% within 24h.

Active hours (commit-gap floor, v4+v5 shipped, n=120) tell the same story more weakly: ≤150 lines median 2.3h,
>400 lines median 3.1h / p90 8.6h; ≤2 groups p90 2.9h, >6 groups p90 8.3h.

## 6. Claude Code sessions (`~/.claude/projects/-Users-feliperosa-workspace-repos-genie`, main transcripts only)

Only one project dir matches (`-Users-feliperosa-workspace-repos-genie`); worktree sessions live in it. 20 sessions,
226 MB, 2026-07-28 → 2026-09-16. Subagent transcripts were not summed (they are in per-session subdirs).

| metric | median | p75 | p90 | max |
|---|---|---|---|---|
| wall minutes (first → last record) | 200 | 581 | 1,393 | 4,654 |
| assistant turns (deduped by message.id) | 53 | 114 | 207 | 433 |
| tool calls | 55 | 127 | 208 | 625 |
| tokens (input+output+cache read+cache write) | 6.9M | 25.2M | 48.9M | 167.7M |

Three sessions name a wish or issue in their first user message (`wish/group` twice, `#2735` once). The largest
session (167.7M tokens, 433 turns, 22h wall) is the one that produced the v6 study itself. The backfill report
(`~/workspace/repos/claude-observability/reports/2026-09-16-backfill-report.md`, lines 11–18) covers 105 sessions
across all projects Jul–Sep 2026: tokens per session mean 41M, median 3.9M, max 496M; output mean 113k, median
37k; 98% of input is cache read; median context per request 218k, p90 536k; total 4.56B tokens, $4,338 at list
prices (line 45).

## 7. Roadmap cards (`.genie/roadmap.json` at HEAD)

78 cards on one board (Idea 6, Brainstorm 0, Wish 19, Work 15, Review 3, Done 35); 16 distinct wish slugs carry
cards. Card durations are not usable: every Done card was moved by a `(none)→Done` bulk adoption event, so
created → Done spans are 191h–1,357h in lockstep blocks (skills-everywhere-* 365–388h, genie-ui 1,357h). The
board records placement, not lifecycle timing. Per-wish card counts: 1–8 cards, median 3.

## 8. Sizing recommendation

Basis: v4+v5 shipped wishes with a slug-named PR (n=50), PR-branch hours as the delivery-time proxy.

**Wishes whose PR merged within 1 working day (≤8h, n=38):** median 211 lines (p75 255, p90 364), 4 groups
(p90 6), 22 tasks (p90 44), 10 named files (p90 35); PR median 1,183 insertions across 14 files (p90 3,650 / 41).
**Within 1 hour (n=21):** median 178 lines (p90 253), 3 groups (p90 4), 16 tasks (p90 26), 9 named files (p90 19);
PR median 311 insertions across 7 files (p90 1,445 / 22).
**Beyond 24h (n=4):** median 369 lines, 7 groups, 35 tasks, 4,174 insertions.

**Thresholds where p90 branch time exceeds one day (24h):** >250 wish lines (p90 25.6h), >4 groups (5–6 groups
p90 21.8h, >6 groups p90 53h), >25 tasks (p90 23.4h), >10 named files (p90 45h), PR >~2,500 insertions.

**Proposed V6 single-workflow wish size (target: one green PR in one session):**

| | ideal | maximum |
|---|---|---|
| wish document | ≤150 lines, ≤8 KB | 250 lines, 15 KB |
| groups (independent work units) | 1–2 | 3 |
| task bullets (acceptance items) | ≤12 | 20 |
| files named in the wish | ≤8 | 12 |
| expected PR | ≤800 insertions, ≤10 files | 2,000 insertions, 25 files |
| expected delivery | ≤1h branch time, ≤2 work bursts | 8h branch time |
| session budget (from sessions table) | ≤50 turns, ≤7M tokens | 120 turns, 25M tokens |

Rationale: at ≤150 lines / ≤2 groups / ≤15 tasks / ≤10 files every observed PR merged within 3h and 100% within
8h; the 151–250-line band still merged 95% within 8h; above that the p90 crosses a day and the share merged in
8h drops to 67% then 30%. Anything that would need >3 groups or >25 tasks should be split into sibling wishes
(as `skills-everywhere` a/b/c already was: 442–774 lines, 7–23 groups, 8h branches each but 19–23h calendar).

## 9. Caveats

- Calendar time ≠ effort. 82/151 shipped wishes have 0h (doc landed already shipped); 67 ship dates fall on three
  bulk header reconciliations; unshipped v4 rows end at a single archive move. Use §3c/§5 PR-branch numbers.
- PR-branch hours undercount when a branch was squashed or rebased before the PR (commit timestamps rewritten;
  several v5 branches read 0.0–0.5h with 1–3 commits) and overcount when a branch idled (routing-delivery-fix).
- Active hours are a floor: only commits touching the wish dir or naming the slug are seen.
- Slug matching in merge subjects is substring-based (slugs ≥6 chars); a slug that is a prefix of another may
  gain a merge. Multi-branch duplicates are counted once by slug; a wish that moved between layouts is one row.
- Status detection reads the first 60 lines; a wish whose status lives only in INDEX.md is `unshipped` here.
- Sessions: 20 main transcripts only, one project dir; subagent transcripts (forked agents) are excluded, so
  per-session tokens are lower than Phoenix's subagent-inclusive rollups.
- Roadmap card timestamps reflect a bulk adoption, not lifecycle.
