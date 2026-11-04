# Design: Genie v7 board — the real Herdr Tasks board, read-only

| Field | Value |
|-------|-------|
| **Slug** | `genie-v7-board` |
| **Date** | 2026-11-04 |
| **WRS** | 100/100 (the design author's estimate: every load-bearing choice is Settled B1-1..B1-6, a carried R1 id, or an orchestrator call the owner may override; review r1's findings are folded in) |
| **Size** | M · one wish, three groups: (1) `genie-rs list --json` gains its timestamps, worktree and project and opens `genie.db` read-only, and forge-sync's first pass is bounded and resumable (three crates, about 400–700 inserted lines with tests), (2) the mod `plugins/genie-herdr`, about 1,200–1,800 inserted lines, (3) its install/update channel (Assumed by the design author; the owner has not set a size) |

<!-- Source: B1-n, a carried R1-n, a backticked path (origin/dev: for crates/), or the DRAFT's orchestrator calls O2..O5. "Assumed" marks a choice the DRAFT does not make. -->

## Problem

The owner-approved Tasks mock (`~/.config/herdr-app/mods/tasks-mock`, branch `tasks-plain-time-cost`) draws a static `board.json`, while the real tasks now live in each repository's `genie.db` (genie-v7-tasks: #3201, #3205, #3206, #3209) and nothing in Herdr shows them. The footer's `genie.tasks.waiting` badge has no live source (R1-16).

## Scope

### IN

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | **`genie-rs list --json` gains six fields per task (group 1).** <br>`created_at` and `worktree` come from the LATEST `created` row (a restart is a new lifecycle; usagemeter's `started_at` uses the same row); `opened_at`, `merged_at`, `closed_at` from the first row of each kind; `project` is the realpath `project_root` already computes. Null when absent or `''`, so a forge-first task has `created_at: null`. Additive only: text output unchanged, and `status --json` gains the same fields through `task_json`. One aggregate in `store.tasks()`, no schema change (Assumed). <br>**Read-only in effect:** `list` and `status` open with normal read-write flags but run no write statement (no `SCHEMA_SQL`, no `journal_mode = WAL` or `synchronous`), so the main file stays byte-identical and a WAL file without sidecars still reads (`SQLITE_OPEN_READONLY` would refuse it). `tasks()` tolerates `no such table` as `read_events` does, so a v5-only database lists `[]`, exit 0. Refusals stay exit 2: a missing file, `user_version = 0`, and `NewerSchema` (a newer `v7_schema` version), refused before any read. | `crates/genie-rs/src/lib.rs`, `crates/genie-tasks/src/store.rs`, `crates/genie-rs/tests/exit_codes.rs` | B1-2, R1-32, `origin/dev:crates/genie-rs/src/lib.rs`, `origin/dev:crates/genie-tasks/src/store.rs`, `origin/dev:crates/genie-tasks/src/schema.sql`, `.genie/brainstorms/genie-v7-board/DRAFT.md` (O4) |
| 1b | **forge-sync's first pass is bounded and resumable (group 1).** Today a cursorless pass pages the whole history, a call per merged PR, saving only at the end. <br>**Horizon:** a cursorless pass stops at now − 30 days (the feed's `d30`); older PRs are never recorded. <br>**Per page:** each page's events commit, then the cursor's `seen` map saves; `since` stays null until the pass completes. A cut pass re-lists from the newest page (one call per 100 PRs) and skips seen PRs, so no count call repeats. <br>**Completion:** a completed pass writes `since` = the newest `updated_at` it listed (page 1's top), or the horizon when it listed nothing, so `since: null` means exactly "no completed pass" (H3). <br>**Order:** `tasks.jsonl` appends per page, newest first, not oldest-first; R1-19 readers dedupe on `dedupe_key`. <br>**Accepted edge:** a locally `created` task whose PR merged before the horizon stays Working on a never-synced project. Remedy: `genie task forge-sync --project <p> --full`; `--full` (hand-run only; A21) lists the whole history once, ignoring horizon and `since`. Exit codes and `--json` are otherwise unchanged. | `crates/genie-forge/src/sync.rs`, `crates/genie-forge/src/client.rs`, `crates/genie-forge/tests/sync.rs` | `origin/dev:crates/genie-forge/src/sync.rs:255`, `origin/dev:crates/genie-forge/src/sync.rs:207`, `origin/dev:crates/genie-forge/src/sync.rs:276-283`, `origin/dev:crates/genie-forge/src/sync.rs:310-312`, `origin/dev:crates/genie-forge/src/client.rs:154-183`, R1-19, `.genie/brainstorms/genie-v7-board/DRAFT.md` (H2, H3) |
| 2 | **The mod and its footer entry (group 2).** As the mock: `mod.json` has `place: "none"`, a 1×1 popup that toggles a `Tasks` tab (`toggleTasks`), and one footer entry, `{id: "tasks", label: "Tasks", icon: "mods/genie-herdr/tasks.svg", command: "mod.open", args: {name: "genie-herdr"}, badge: "genie.tasks.waiting"}`. Plain JS (A13): pure rules in `data.js` (no `herdr` or `gpui-kit` import), the view in `main.js`. | `plugins/genie-herdr/mod.json` (new), `plugins/genie-herdr/main.js` (new), `plugins/genie-herdr/data.js` (new), `plugins/genie-herdr/tasks.svg` (new), `plugins/genie-herdr/terminal.svg` (new), `plugins/genie-herdr/clock.svg` (new) | R1-12, R1-16 |
| 3 | **Project discovery.** Every Herdr space folder holding `.genie/genie.db`, with no setup. One `exec('sh', ['-c', loop, 'sh', ...folders])` prints each such folder's `pwd -P` realpath; realpaths are deduped. Worktree spaces hold no `genie.db`, so only main checkouts get a board. Local spaces only, re-probed when `spaces()` changes (A2, A3). | `plugins/genie-herdr/main.js`, `plugins/genie-herdr/data.js` | B1-4 |
| 4 | **Finding `genie-rs`.** As the TS front door's `resolveGenieRsBin`: `GENIE_RS_BIN`, then `<GENIE_HOME>/plugins/genie-rs/bin/genie-rs` (`GENIE_HOME` defaults to `~/.genie`). Resolved through `exec('sh', ['-c', …])`, which has the user's real environment (A4). | `plugins/genie-herdr/main.js` | `src/term-commands/v5-task.ts`, `.genie/brainstorms/genie-v7-board/DRAFT.md` |
| 5 | **Refresh: `list` for all, forge-sync on a budget.** On mount, and then on `cx.timer.every(60000, …)` while the Tasks tab is mounted. The handler returns synchronously, so `main.js` holds one in-flight boolean (via `skipWhileBusy` in `data.js`): a tick firing while one runs is skipped, never queued. <br>**`list`:** every project runs `genie-rs list --json --project <p>` (local, no forge call). <br>**forge-sync:** a global budget of 10 `genie-rs forge-sync --project <p>` calls per tick. The focused space's project, if it is one, goes first (at most once a minute). The other projects take the remaining slots round-robin, so with 128 synced projects each is reached within ceil(127/9) = 15 minutes (owner: "15 minutes is fine, keep the cap"). <br>**Bounding API calls:** at most one never-synced project takes a slot per tick. **Never-synced** (H3): the cursor file `<GENIE_HOME>/cache/forge/<sha256(project)>.cursor.json` is missing, or it holds `"since":null`. The row 3 loop tests `grep -q '"since":[0-9]' "$f"`, naming `$f` from `printf %s "$d" \| shasum -a 256` (forge-sync writes compact JSON). A cut first pass stays in that lane until a pass completes. <br>**Backoff:** any failed forge-sync backs off 1, 2, 4… minutes, cap 1 h, reset on success; failure is a non-zero exit or an `exec` rejection (the 30 s limit too: `ExecResult` has no timeout marker). <br>**Seam:** pure `planTick(state, {now, projects, focused, neverSynced, results})` in `data.js` returns what to sync and list and the next state: the round-robin pointer (last synced realpath) and the backoff map, both kept across a re-probe (a vanished pointer resumes at the next path in sort order). `main.js` runs the plan under the in-flight guard. <br>**Assumed:** at most 8 spawns in flight at once. | `plugins/genie-herdr/main.js`, `plugins/genie-herdr/data.js` | B1-6, B1-2, `.genie/brainstorms/genie-v7-board/DRAFT.md` (H2, H3) |
| 6 | **Lanes and the read-only card.** Working, Review, Merged and Closed (the `lane` field). <br>**Card:** id (`task`, or "untracked" with the url), title, lead, lane, cost, time, and the ETA on open cards; no buttons; a click toggles the drawer. Order, cap and selection: A6. <br>**Terminal icon:** the only way into a worker, shown while a live terminal belongs to the card: `agent.focus` when a pane shows it, else `terminal.peek`, on the row-9 join's terminal, `task.lead` first. | `plugins/genie-herdr/main.js`, `plugins/genie-herdr/data.js` | B1-1, R1-18, R1-5, R1-17 |
| 7 | **The drawer.** The id, a lane chip, the terminal icon and the title; the PR/MR url (opens) and branch (copy); `usd`, `work_min`, elapsed or `lead_min`, the ETA with its merge count, and one row per `bots[]` entry; the row-1 event times and worktree. No action buttons. | `plugins/genie-herdr/main.js` | B1-1, R1-18, R1-6 |
| 8 | **Cost, time and ETA from usagemeter.** Each refresh runs `exec('automagik-herdr', ['doc', 'get', 'herdr-meter'])` once. <br>**Pinned path:** `doc.space.projects[<project>].tasks`, keyed by the realpath `project` from row 1, read only when that field is present as an array (usagemeter#8). <br>**Today's doc** (`meter_version` 0.3.0, `schema_version` 2) has no `space`: `projects[]` is keyed by `repo` with `tasks` a count, `tasks[]` by (`repo`, `branch`). The board reads neither, so every number is "–" by rule. <br>**Feed row:** `{key, task, url, branch, usd, work_min, lead_min, started_at, state, bots: [{bot, usd, work_min}]}`. <br>**Join:** the key is `(project, task)`, or the `url` when `task` is null. <br>**Time:** merged cards show `lead_min` (null until merge); Working cards show now − `started_at`, live. <br>**ETA:** the median of the project's past `lead_min` values above the elapsed time, minus it; past the slowest, "over" (the mock's `estimateOf`). <br>**Display:** null shows "–", never 0; minutes render in the mock's hour format; a measured 0 shows `$0.00`/`0m` (Assumed). | `plugins/genie-herdr/data.js`, `plugins/genie-herdr/main.js` | B1-3, R1-6, R1-13, R1-19, R1-32, `.genie/brainstorms/genie-v7-board/DRAFT.md` (O2, O3) |
| 9 | **The `genie.tasks.waiting` badge.** Distinct cards across projects: every Review card (a PR ready to merge) plus every Working card with a blocked worker. <br>**Blocked join, labels first:** `terminals()` with `status === 'blocked'` whose labels carry `task` and `task.project` → that task's card in the project with the label's realpath. Each new `task.project` value is realpathed at join time (one `sh -c` `pwd -P` loop per refresh), since a label need not be a space folder (A22). <br>**Fallback, unlabelled workers only:** the latest `workers.jsonl` `start` row with `kind: "worker"` for that `terminal` → its realpathed `project` → the card matching its `task`, else its `task` or `branch` as a branch (recent rows carry branch names as `task`), else its `worktree`. An unmatched blocked terminal is not counted (A9). <br>**Writes:** null at 0, `setShared` only on change. The fallback file read and the overlay refresh are A10 and A11. | `plugins/genie-herdr/data.js`, `plugins/genie-herdr/main.js` | R1-16, R1-5, R1-17, `.genie/brainstorms/genie-v7-board/DRAFT.md` (O5) |
| 10 | **Graceful degradation.** <br>**`genie-rs` missing** (no file, or `exec` rejects): one line replaces the lanes, `genie-rs not found: run 'genie update'` plus the path (A12). <br>**`doc get` failing** (Decision 15): every cost, time and ETA shows "–"; the lanes still render. <br>**Forge offline** (any failed forge-sync, a non-zero exit or an `exec` rejection): a "forge not synced" note, `list` still runs, and the project backs off (row 5). <br>**`list` failing** (exit 1, a timeout, unparseable output): the last good list stays, with its age. <br>**No project database:** hidden, as is any project whose `list` exits 2 (`user_version = 0`, or `NewerSchema`: A23). <br>**Who writes:** `list` is read-only: a v5-only `genie.db` shows `[]` and stays byte-unchanged. The board's forge-sync turn is what opens it read-write, creates the `v7_` tables and appends to `tasks.jsonl`, within 15 minutes of discovery; forge-sync stays the one creator. <br>**Older `genie-rs`:** fields missing from row 1 read as null. | `plugins/genie-herdr/main.js`, `plugins/genie-herdr/data.js` | B1-3, B1-4, `origin/dev:crates/genie-rs/src/lib.rs`, `origin/dev:crates/genie-tasks/src/store.rs`, `src/term-commands/v5-task.ts` |
| 11 | **Packaging and tests.** `cp -R plugins` already stages the mod inside the frozen `plugins` member; the one build edit adds `plugins/genie-herdr/mod.json` to the `required` list, pinned by `scripts/release-docs.test.ts`. `prune_release_tests` strips `data.test.ts`; Biome lints `plugins/**`; a `.gitignore` covers Herdr's generated files (A14). | `plugins/genie-herdr/data.test.ts` (new), `plugins/genie-herdr/.gitignore` (new), `scripts/build-binary.sh`, `scripts/release-docs.test.ts` | R1-12, `scripts/build-binary.sh`, `src/lib/install-promotion.ts`, `biome.json` |
| 12 | **The Herdr mod channel (group 3).** `genie install` and `genie update` copy `<GENIE_HOME>/plugins/genie-herdr` to `~/.config/herdr-app/mods/genie-herdr`. Same shape as the workflows channel. <br>**Consent gate (orchestrator call N1):** runs only when the selection is not `'none'` and an install record exists, like workflows; B1-5 is read as "under genie's normal channel consent". <br>**Hooks:** `install` beside `runWorkflowsChannelConvergence`; `update` inside the NEW binary's `update --post-delivery-converge` (beside `runUpdateWorkflowsChannel`). <br>**Record and backup:** a sha256 record of delivered files; a file matching neither the record nor the delivered bytes is copied to `<GENIE_HOME>/state-backups/herdr-mod-collision-<ISO>/` before replacement; equal bytes are left alone, so a rerun backs up nothing. `gpui-kit.d.ts`, `jsconfig.json` and every undelivered file are never touched. Record field, `$HERDR_APP_HOME`, no-Herdr skip and stale-file removal: A17–A19. | `src/lib/herdr-mod-installer.ts` (new), `src/lib/herdr-mod-installer.test.ts` (new), `src/genie-commands/install.ts`, `src/genie-commands/update.ts` | B1-5, `src/lib/workflows-installer.ts:115-127`, `src/genie-commands/update.ts:2706`, `.genie/brainstorms/genie-v7-board/DRAFT.md` (N1) |

### OUT

- **Actions** (merge, start, kill): they wait for lockdown (Source: R1-7, B1-1).
- **The DSH hand-off to Herdr:** a separate wish (Source: R1-31).
- **Pocket** (Source: B1-1, the brief's boundary; not in the DRAFT).
- **A To-do lane from open forge issues:** deferred here by genie-v7-tasks; `list` has none. Trigger: the owner asks after v1 (Source: R1-1, `.genie/brainstorms/genie-v7-board/DRAFT.md`).
- **The mock's pets, filters and `.herdr/bots.json` looks:** not in B1-1's card. Trigger: owner feedback on v1 (Source: B1-1; Assumed).
- **Spaces on other machines.** Trigger: a project on a linked machine (Source: B1-4; Assumed).
- **Mod removal on `genie uninstall`, and a `genie doctor` check:** B1-5 names install and update only (Source: B1-5; Assumed).
- **Genie computing cost or lead time:** usagemeter does it (Source: B1-3, R1-19).
- **A resident poller or daemon:** zero-daemon; the open tab owns the cadence (Source: `.genie/brainstorms/genie-v7-board/DRAFT.md`).

## Approach

**One reader, one owner per number.** The board spawns `genie-rs` (B1-2) and never opens `genie.db`; it reads usagemeter's deduped doc (B1-3, R1-32), deriving only live elapsed time and the ETA.

**Kept from the mock:** tab toggle, badge, lanes, cards, drawer-only click, terminal icon (R1-18).

**Delivery.** The payload's `plugins` member carries the mod; `genie install`/`update` copy it into Herdr's mods folder, backup-first and recorded like the workflows channel (B1-5), so one release carries the mod and its `genie-rs`.

**Alternatives that lost:**
- **`genie task v7-list --json`:** breaks B1-2's letter and adds a bun start per call.
- **Reading `genie.db`, or `status` per task:** a second reader (B1-2), or N spawns a minute.
- **A symlink, `am-mods`, or a manual copy:** the owner chose the recorded copy (B1-5).

## Simplicity Case

- **Simplest complete design:** one plain-JS mod (per minute: a `list` per project, at most 10 forge-syncs, one `doc get`; state: the last good replies, the round-robin pointer, the backoff map and one in-flight boolean; writes: the badge and its forge-sync turns) and one installer on an existing channel shape.
- **Added machinery:**
  - **The `genie-rs list` fields:** they remove per-task spawns and give the exact usagemeter key (DRAFT dependency "Genie (ours)", O4).
  - **Running forge-sync from the board, on a budget, with backoff and a bounded first pass:** usagemeter needs a live `tasks.jsonl`, zero-daemon leaves nobody else to run it, and the gh quota is shared (B1-6, H2).
  - **The `workers.jsonl` fallback:** for unlabelled workers (DRAFT scout facts).
  - **The install record and backups:** the mod folder sits in another app's home, which a person may edit (B1-5).
- **Deferred until measured:**
  - **A resident badge refresher.** Trigger: the owner sees a stale badge while the Tasks tab is closed.
  - **A `--since` or lane filter on `list`.** Trigger: a project's output nears `exec`'s 8 MiB cap.
- **Complexity removed:** no To-do lane, no actions, no pictures on disk, no project config, no second database reader and no cost arithmetic in Genie.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | v1 is read-only: lanes, cost and time per card, the drawer, the terminal icon and the badge | Actions wait for lockdown. Read-only means no owner action. `list` writes nothing; the board's forge-sync turn records only what the forge already did, creating the `v7_` tables and appending to `tasks.jsonl` | B1-1, R1-7 |
| 2 | Tasks come only from spawning `genie-rs list --json --project <p>` | Rust is the only code that knows the database layout | B1-2 |
| 3 | Cost and time come only from usagemeter's `herdr-meter` doc; null shows "–", never 0 | "We are one": one cost authority, already deduped | B1-3, R1-19, R1-32 |
| 4 | A project is any local Herdr space folder holding `.genie/genie.db` | No setup | B1-4 |
| 5 | While its tab is open, the board runs `list` for every project each minute, and forge-sync at most 10 a minute (focused first, round-robin, one never-synced per minute until a pass completes, backoff to 1 h on any failure, no overlapping ticks); first passes look back 30 days and resume per page | `tasks.jsonl` stays live with no daemon, and API calls stay bounded. The H2/H3 parts are orchestrator calls (owner may override) | B1-6, `.genie/brainstorms/genie-v7-board/DRAFT.md` (H2, H3) |
| 6 | `list --json` gains `created_at`, `opened_at`, `merged_at`, `closed_at`, `worktree` and `project`, additively | One spawn per project instead of one per task; the usagemeter join uses Genie's own realpath. `created_at` is the latest `created` row; `list`/`status` open read-only | Orchestrator call O4 (owner may override); R1-32; review r1 | `.genie/brainstorms/genie-v7-board/DRAFT.md` (O4), R1-32, `origin/dev:crates/genie-tasks/src/store.rs` |
| 7 | A card click only toggles the drawer; only the terminal icon opens a worker | The owner-approved mock's behaviour | R1-18 |
| 8 | The badge = Review cards + Working cards with a blocked worker, counted once, null at 0 | The footer contract | R1-16 |
| 9 | The mod lives at `plugins/genie-herdr` and ships inside the existing `plugins` payload member | The 8 top-level members are frozen; `cp -R plugins` already stages it | R1-12, `src/lib/install-promotion.ts`, `scripts/build-binary.sh` |
| 10 | `genie install` and `genie update` copy the mod to `~/.config/herdr-app/mods/genie-herdr` with a record of genie's files, backup-first, leaving Herdr's generated files alone | The mod always matches the `genie-rs` it ships beside; same channel shape and consent gate as workflows (selection not `'none'`, an install record exists): orchestrator call N1 (owner may override) | B1-5, `src/lib/workflows-installer.ts`, `src/genie-commands/update.ts`, `.genie/brainstorms/genie-v7-board/DRAFT.md` (N1) |
| 11 | `genie-rs` is resolved from `GENIE_RS_BIN`, then the payload's `plugins/genie-rs/bin/genie-rs` | Same order as the TS front door | `src/term-commands/v5-task.ts` |
| 12 | ETA = the conditional median of past `lead_min` values above the elapsed time, minus it | Orchestrator call O2 (owner may override); derived from usagemeter's numbers, so B1-3 holds | R1-13, B1-3, `.genie/brainstorms/genie-v7-board/DRAFT.md` (O2) |
| 13 | A merged card shows `lead_min`, which stays null until merge. A Working card shows now − `started_at`, live. usagemeter adds `started_at` and `state` to each task | Orchestrator call O3 (owner may override), on usagemeter's answer: `lead_min` is the finished lead time | R1-6, `.genie/brainstorms/genie-v7-board/DRAFT.md` (O3) |
| 14 | Blocked workers and the icon's terminal join by the terminal labels `task`, `task.project` and `task.lead` first, with `workers.jsonl` only as the fallback | Orchestrator call O5 (owner may override); labels are exact and live in `terminals()`; both sides realpath-normalized | R1-17, `.genie/brainstorms/genie-v7-board/DRAFT.md` (O5) |
| 15 | `doc get` succeeds only on exit 0 with one line of JSON; any non-zero exit (3 no such doc, 1 another failure, 2 usage), a launch failure, unparseable output or a missing pinned path shows "–" | The Herdr contract, automagik#283 (merged, pack 3.69.5) | B1-3, `.genie/brainstorms/genie-v7-board/DRAFT.md` |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | `workers.jsonl` is 300 KB and growing; `readTextFile` stops at 1 MiB | Low | Only the fallback (Decision 14), read by its tail (Assumed); an older worker is just not joined |
| 2 | forge-sync burns the shared gh quota (5,000/h per token) | High | Bounded in API calls: a synced pass costs one list call per 100 PRs since its cursor plus one count call per new merge, about 10–20 calls a minute at the cap (≈600–1,200/h). A project with no completed pass (`since` null) costs at most ceil(PRs in 30 d / 100) plus its 30-day merges, one such per minute even when cut, so a backlog ramps over hours. Passes resume, failures back off, ticks never overlap (rows 1b, 5; T1c, T7) |
| 3 | The installer writes into another app's home | Medium | Backup-first, recorded files only, Herdr's own files untouched (T10) |
| 4 | The badge goes stale while the Tasks tab is closed | Low | The overlay copy refreshes it on each open; a resident refresher is deferred |
| 5 | The `herdr-meter` shape changes before usagemeter#8 ships | Medium | One pinned path, read only when present. Anything else degrades to "–" (IN row 10) |
| 6 | `list --json` returns every task ever recorded, while `exec` caps output at 8 MiB | Low | The board caps what it draws. A `--since` or lane filter is deferred until measured |
| 7 | A local `created` task whose PR merged before the horizon stays Working on a never-synced project | Low | Accepted; remedy `genie task forge-sync --project <p> --full` (row 1b) |

**Assumed (by the design author; no DRAFT decision):** A1 the new list fields come from an aggregate over `v7_task_events`, with no schema change; `status --json` gains them too; A2 local spaces only; A3 re-probe, in one `sh -c` loop, when `spaces()` changes; A4 `GENIE_RS_BIN` and `GENIE_HOME` are resolved through `exec('sh', …)`, with no `target/release` fallback; A5 at most 8 spawns in flight; A6 `updated_at` order, a cap of 12, and the selection kept in `localStorage`; A7 for an unlabelled worker, the icon's lead is matched on `botId` equal to `lead`; A8 a measured 0 shows `$0.00`/`0m`; A9 the fallback join order is task → branch → worktree, and unmatched blocked terminals are not counted; A10 `workers.jsonl` is read at `<appHome>/automagik-herdr/workers.jsonl` through `tail -n 2000`; A11 the overlay copy runs `list` alone for the badge; A12 the wording of the missing-binary line and of the "forge not synced" note; A13 plain JS, with no build step; A14 a `.gitignore` covers Herdr's generated mod files; A15 Size M in three groups, the group-1 and group-2 line estimates, and WRS 100; A16 the mock's pets and filters are OUT; A17 the install record is one optional field on `skills-install.json`; A18 the installer honours `$HERDR_APP_HOME`, and skips with one line when there is no Herdr app home; A19 an unmodified recorded file the payload no longer ships is removed; uninstall and doctor are OUT; A20 a Working card with a null `started_at` shows "–" for its time and ETA; A21 the never-synced test is the row-5 `grep` on the cursor file, and the forge-sync `--full` flag is the edge-case remedy; A22 `task.project` realpaths are cached per string for the tab's life; A23 a project whose `list` exits 2 for `NewerSchema` is hidden.

## Dependencies

- **usagemeter#8 (t2wv, confirmed 2026-11-03; amended 2026-11-04):** the pinned `space.projects[<project path>].tasks[]` (absent from the live 0.3.0 doc), with `started_at` and `state`. ETA about 1 working day after their 2 open PRs; until then every number is "–". **Needs from Genie:** a written `tasks.jsonl` (the board's forge-sync, row 5) and workers started with `--task` (R1-5).
- **Herdr `automagik-herdr doc get`:** met (automagik#283, pack 3.69.5, installed); contract in Decision 15.
- **A dev release with `genie-rs` (1c, #3206):** payload-only, so `genie update --dev` once it ships, and again after this wish (which installs the mod).
- **Herdr v0.5.0** (footer, R1-16) and **v0.6.0** (worker labels, R1-17).

## Success Criteria

- [ ] **T1 list fields (group 1):** a task that went created → opened → merged lists `opened_at` and `merged_at` from its events, `closed_at: null`, and `project` equal to the realpath of the main checkout. A task restarted with a second `created` row lists that row's `at` as `created_at` and its worktree. A forge-first task lists `created_at: null` and `worktree: null`. Old keys and the text output are unchanged. **Proof:** `crates/genie-rs/tests/exit_codes.rs`.
- [ ] **T1b read-only (group 1):** on a v5-only `genie.db`, `list --json` prints `[]`, exits 0, and leaves the main file byte-identical (sha256 before and after) with no `v7_` table created; a WAL database copied without its sidecars still lists; `status` likewise creates nothing; a database whose `v7_schema` is newer exits 2 and is unchanged. **Proof:** `crates/genie-rs/tests/exit_codes.rs`.
- [ ] **T1c first pass (group 1):** a fake `gh` serves PRs updated over 90 days.
  - **Horizon:** a cursorless pass requests no page past the 30-day horizon (the fake's call log) and records no PR older than 30 days.
  - **Resume:** when the fake fails on page 2, page 1's events and `seen` map persist, and the cursor's `since` stays null. The rerun finishes with no repeated `pushed_after_open` call.
  - **Completion:** `since` then equals page 1's newest `updated_at`. A first pass that lists nothing writes the horizon. `--full` records a merge older than the horizon.
  - **Proof:** `crates/genie-forge/tests/sync.rs`.
- [ ] **T2 discovery (group 2):** from injected `spaces()` and the probe loop's output, a local folder holding `.genie/genie.db` is one project even when two spaces reach it through a symlink; a worktree, a folder without the file, a remote space and a project whose `list` exits 2 are not shown. **Proof:** `plugins/genie-herdr/data.test.ts`.
- [ ] **T3 lanes and card (group 2):** a canned `list --json` lands in Working, Review, Merged and Closed by `lane`; a null `task` renders "untracked" with its url; the card model carries title, id, lead, lane, cost, time and ETA and no action. **Proof:** `plugins/genie-herdr/data.test.ts`.
- [ ] **T4 cost, time and ETA (group 2):** a canned doc with the pinned path joins by `(project, task)`, or by `url` for a null `task`.
  - **Formatting and time:** null renders "–" and 0 renders `$0.00`. A merged card shows `lead_min`. A Working card whose `started_at` is an injected 90 minutes ago shows 1.5h, and a null `started_at` shows "–".
  - **ETA:** past `lead_min` values of 60, 120 and 240 with 90 elapsed give `~1.5h` left; 300 elapsed shows "over".
  - **Missing feed:** the live 0.3.0 shape, a missing task, `doc get` exiting 1, 2 or 3, a launch failure or invalid JSON leaves every number "–" and the lanes intact.
  - **Proof:** `plugins/genie-herdr/data.test.ts`.
- [ ] **T5 badge (group 2):** 2 Review cards plus 1 Working card with a `blocked` worker gives 3.
  - **Matching:** a labelled blocked terminal matches through `task`/`task.project` without reading `workers.jsonl`, also when its `task.project` is a symlink to the project's realpath. For unlabelled terminals, the branch-as-`task` and worktree fallbacks each match.
  - **Counting:** a card is never counted twice, and a blocked terminal with no matching card adds nothing.
  - **Writes:** no waiting card gives `null`, and an unchanged count makes no `setShared` call.
  - **Proof:** `plugins/genie-herdr/data.test.ts`.
- [ ] **T6 degradation (group 2):** no binary gives one line naming `genie update` and the path; any failed forge-sync (a non-zero exit or an `exec` rejection) still runs `list` and shows the note; a failed `list` keeps the last list with its age; an older `list` without the row-1 fields yields nulls. **Proof:** `plugins/genie-herdr/data.test.ts`.
- [ ] **T7 forge budget (group 2):** `planTick` and `skipWhileBusy`, over simulated minutes with 128 fake projects, one focused:
  - **Cap:** no minute plans more than 10 forge-syncs, and the focused project is first every minute.
  - **Rotation:** with every project already synced once, each is synced within ceil(127/9) = 15 minutes; each tick lists all 128.
  - **Never-synced:** with 20 never-synced projects, no minute plans more than one of them, and all 20 are reached within 20 minutes.
  - **Backoff:** a project whose forge-sync fails three times in a row, by any non-zero exit or rejection, is skipped 1, 2 and 4 minutes, then never more than 60; a success resets it.
  - **Cut first pass:** a cursor holding `"since":null` keeps the project never-synced until `since` is a number.
  - **No overlap:** `skipWhileBusy` skips (never queues) a tick fired while the last tick's promise is pending, and runs again once it settles.
  - **Re-probe:** dropping and adding projects mid-rotation keeps the pointer, so no project waits past the bound.
  - **Proof:** `plugins/genie-herdr/data.test.ts`.
- [ ] **T8 the mod loads (group 2; local, not CI: needs the desktop app):** `herdr-app check plugins/genie-herdr` exits 0. **Proof:** `herdr-app check plugins/genie-herdr`.
- [ ] **T9 payload (group 2):** `scripts/build-binary.sh`'s `required` list names `plugins/genie-herdr/mod.json`, so a tarball without it fails the build; the release-docs test pins that entry. **Proof:** `scripts/release-docs.test.ts`.
- [ ] **T10 mod channel (group 3):** against a temp `GENIE_HOME` and Herdr app home:
  - **Runs:** the first run copies every payload file and records its sha256; a second run changes nothing and creates no backup root.
  - **Backups:** a hand-edited genie file is copied to `state-backups/herdr-mod-collision-*` before replacement.
  - **Hands off:** a file genie never delivered, `gpui-kit.d.ts` and `jsconfig.json` stay byte-identical, and a host with no Herdr app home is skipped with one line.
  - **Hooks:** `genie install` runs the channel, and so does `update --post-delivery-converge`, never the old binary's update path.
  - **Consent:** a `'none'` selection or a missing install record skips the channel and writes nothing.
  - **Proof:** `src/lib/herdr-mod-installer.test.ts`.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `ddb667d42dce118ce0944ae7fe9a18f4fc279b3dcf7ac05db42cceaba5e625e1`
- **Reviewer:** claude-fable-5-1
- **Reviewed at:** 2026-11-04T12:37:37.000Z
<!-- genie-design-review:end -->
