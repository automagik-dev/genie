# Brainstorm: live-dev-loop — "i say change, you change"

**Started:** 2026-07-21 · **WRS:** 100/100 (Problem ✅ Scope ✅ Decisions ✅ Risks ✅ Criteria ✅) — crystallized to [DESIGN.md](DESIGN.md)

**Felipe's round-2 answers (2026-07-21, picker):** dual-channel sync — "i see from web browser remotely, additionally, so that we are in ultra speed, and i can still test from desktop with a little delay" (browser = ultra-fast primary view, desktop = near-real-time test bed); iterate commits go **straight to main**; in-loop signal = **toast only**; consolidation = **his word + offered once past ~25 commits**. Orchestrator design consequence (flagged for his cheap veto at design review): the browser channel serves the agent's LINUX WORKING COPY directly via `vite --host` (latency = file-save → HMR, sub-second, no git in the hot path) with a mocked `electronAPI` (fixtures) — UI-only by design in v1; a real-IPC-over-websocket bridge to a headless Electron is explicitly OUT (tier 2, own decision later). Desktop channel = git watcher + pull + toast, unchanged.

## Problem

Iterating on genie desktop today means full wish cycles — plans, groups, reviewers — which Felipe experiences as "long ass plans that deceive me in the end with something i didn't ask for." He wants a live loop: the app running on his Mac, him asking for a change in chat, the change visible in seconds — with the heavyweight rigor deferred to an explicit consolidation moment, not abolished.

## The two halves

1. **Tooling** — a sync + reload channel from the agent's working copy (Linux box, `~/prod/genie-ui-ab/dash-fork`, remote `khal`) to the running app on Felipe's Mac.
2. **Process contract** — ITERATE MODE vs CONSOLIDATE MODE, durably written so every future instance obeys it without relearning. This is the heart; the trust history demands it be explicit.

## Ground facts (verified)

- `pnpm dev` = concurrently(`dev:main`: one-shot tsc + electron; `dev:renderer`: vite). **Renderer changes = free HMR, no restart. Main-process changes = need recompile + Electron restart, which kills live PTY terminals** — a real cost the loop must surface, not hide.
- khal-os/genie-desktop is private with NO gates (Felipe's standing decision) — direct pushes to main are legal.
- husky pre-commit (prettier + eslint + type-check) is fast and stays as the only inline gate.
- Felipe's Mac runs the app; the agent stays on the Linux box.

## Loop mechanics (candidates)

- **(a) git-native watcher (bias):** `pnpm dev:live` on the Mac = `pnpm dev` + a 2–5s `git fetch && git pull --ff-only` poller. Agent commits tiny + pushes immediately. Renderer diffs → HMR applies silently; `src/main/**` diffs → watcher recompiles + restarts Electron (with a visible warning since terminals drop). Each incoming commit message printed by the watcher and/or shown as an in-app toast — "changed: hire button color" — so Felipe sees the loop breathing. Zero new infra; the commit trail IS the changelog.
- **(b) mutagen/ssh-mounted worktree:** no commits during iteration; lower latency; new infra, loses the commit-per-ask audit trail, dirtier failure modes. Not recommended.
- **(c) agent runs on the Mac:** moves the whole agent environment; loses this box's setup. Not recommended.

## Process contract (to ratify)

**ITERATE MODE** (entered when Felipe says so, e.g. "/iterate" or "loop on"):
- One ask → ONE bounded change → commit (conventional, tiny, message = the ask) → push → next. No wish groups, no per-change reviewer, no planning docs, no subagent fan-out.
- husky is the only inline gate. Full test suite runs batched/async — never blocks the loop.
- Allowed without stopping: renderer/UI, copy, styles, small main-process behavior.
- **Stop-and-plan triggers (sacred even mid-loop):** genie.db schema, ui-bridge protocol, security surface (the read-only wall), deleting user data, anything that contradicts a decision Felipe stated in his own words — surfaced as its own question, never bundled (standing rule applies at loop speed).
- Main-process changes announce "app will restart — terminals drop" BEFORE pushing, wait for his "go" only when terminals are likely live.

**CONSOLIDATE MODE** (entered on Felipe's word — "lock it in" — or offered, never forced, past a size threshold):
- One pass: full suite, one review over the accumulated diff, ledger/wish evidence entry, polish triage. The iterate commits stay as-is (history = the session's story).

Durability: contract written to the fork (e.g. `ITERATE.md`) + genie memory, so any future instance enters the mode correctly.

## Open decisions (Felipe)

1. Sync mechanics: (a) git-native watcher vs (b)/(c).
2. Iterate commits: straight to `main` vs `iterate/<date>` branch fast-merged at consolidation.
3. In-loop signal: watcher console, in-app toast, or both.
4. Consolidation trigger: his word only, or word + offered-at-threshold (e.g. every ~25 commits).

## Risks

- Main-process restart kills live agent terminals — must be loud, never silent.
- Loop speed erodes discipline → the stop-and-plan triggers + durable contract are the countermeasure; consolidation review catches drift.
- Mac watcher pulling mid-HMR edge cases (partial pushes) → agent pushes atomic single commits only; `--ff-only` keeps the Mac clean.
- Iterate commits are un-reviewed by design — acceptable ONLY inside the private no-gates fork; the genie repo itself never runs iterate mode.
