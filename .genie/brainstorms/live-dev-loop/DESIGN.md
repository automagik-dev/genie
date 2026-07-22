# Design: live-dev-loop — "i say change, you change"

| Field | Value |
|-------|-------|
| **Slug** | `live-dev-loop` |
| **Date** | 2026-07-21 |
| **WRS** | 100/100 |

## Problem

Iterating on genie desktop today requires full wish cycles — plans, groups, reviewers — which Felipe experiences as "long ass plans that deceive me in the end with something i didn't ask for." He wants a live loop: he asks for a change in chat and sees it within seconds, with heavyweight rigor deferred to an explicit consolidation moment rather than abolished. This is both tooling (a sync/reload channel) and a durable process contract future agent instances must obey without relearning.

## Scope

### IN

- **Browser channel (ultra-fast, primary view):** `pnpm dev:web` on the Linux box — Vite dev server bound to the network (`--host`, Tailscale/LAN reach, same opt-in posture as the ui-bridge HOST story) serving the agent's **working copy** directly. Latency = file save → HMR (sub-second); git is not in the hot path. The renderer runs against a **mocked `electronAPI`** (typed fixture module: sample projects/tasks/genie board state) — UI-only by design; every mocked surface is visibly watermarked in-app ("dev preview — mock data") so it can never masquerade as the real product.
- **Desktop channel (near-real-time, real behavior):** `pnpm dev:live` on Felipe's Mac — existing `pnpm dev` plus a 2–5s `git fetch && git pull --ff-only` poller. Renderer diffs apply via HMR silently; `src/main/**` diffs recompile + restart Electron with a loud pre-restart warning (restart kills live PTY terminals — never silent). Toast-only in-loop signal: each pulled commit surfaces one in-app toast with its message ("changed: hire button → green").
- **Loop cadence (agent side):** one ask → ONE bounded change → conventional tiny commit whose message is the ask → push to `main` immediately (Felipe's no-gates decision; commit trail = the session changelog and the Mac channel's feed).
- **Process contract, durably written** as `ITERATE.md` at the fork root + genie memory: ITERATE MODE (entered on Felipe's word): no wish groups, no per-change reviewers, no planning docs, no subagent fan-out; husky pre-commit (prettier+eslint+type-check) is the only inline gate; full tests run batched/async, never blocking. **Stop-and-plan triggers, sacred mid-loop:** ANY database schema or migration — the fork's own drizzle schema (`src/main/db/schema.ts`) AND the consumed `.genie/genie.db` contract over the ui-bridge; the ui-bridge protocol; the security surface (the read-only wall); destructive/data-loss changes; and anything contradicting a decision Felipe stated in his own words — each surfaced as its own question, never bundled. **Mode triggers are canonical:** ITERATE entered on Felipe saying "/iterate" or "loop on"; CONSOLIDATE on "lock it in" (paraphrases confirmed before acting). CONSOLIDATE MODE: one pass of full suite + one review over the accumulated diff + ledger evidence + polish triage; iterate commits are never rewritten. The offer counter is loop commits **since the last consolidation** (reset to 0 on CONSOLIDATE); the agent offers once each time the count crosses a ~25 boundary (25, 50, …) — never every commit, never only once ever.

### OUT

- **Tier-2 real-data browser:** an IPC-over-websocket bridge to a headless Electron on the Linux box (real DB/terminals in the browser). Explicitly deferred — its own decision later; v1 browser is UI-only with mocks.
- Any change to the shipped product's delivery (desktop remains the product; the browser channel is a dev tool, watermarked as such — this does not reopen the browser-vs-desktop product decision).
- Running iterate mode against the genie repo itself — the contract applies ONLY to the private no-gates fork.
- Auth/encryption for the dev web server beyond loopback-default + explicit opt-in bind (same posture as ui-bridge HOST; private Tailscale/LAN is the threat model Felipe accepted for dev tooling).
- Rewriting dash's dev scripts beyond the two additive wrappers (`dev:web`, `dev:live`) and the toast hook.

## Approach

Two channels, one loop. The agent edits the Linux working copy; Vite (bound to the network) makes those edits visible in Felipe's browser at HMR speed with mocked data — this is where "i say change, you change" lives. Each accepted ask is also committed and pushed to `main`, which the Mac's `dev:live` watcher pulls within seconds, giving Felipe the real app (real DB, real terminals, real bridge) "with a little delay" — his own framing. The process contract is the governing artifact: iterate mode strips ceremony to husky-only, consolidate mode restores full rigor over the whole accumulated diff at a moment Felipe chooses.

Alternatives considered and why they lost:
- **Git-only loop (no browser channel):** simplest, but hot-path latency = push + poll + HMR and every look requires the Mac; Felipe explicitly asked for remote browser view at ultra speed. Superseded by his round-2 answer.
- **mutagen/SSH-mounted worktree:** low latency but new infra, dirty failure modes, and no commit-per-ask audit trail. Rejected.
- **Agent running on the Mac:** tightest loop but relocates the agent's entire environment (genie state, memory, hooks live on the Linux box). Rejected.
- **Real-IPC browser bridge now (tier 2):** highest fidelity remote view but resurrects a browser-serving surface with real PTY access — deserves its own deliberation; deferred to OUT.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Dual channel: network-bound Vite serving the agent's working copy (browser, mock data, sub-second) + git watcher on the Mac (real app, seconds). | Felipe's explicit round-2 choice: "web browser remotely … ultra speed, and i can still test from desktop with a little delay." Serving the working copy is the only way to get git out of the hot path. |
| 2 | Browser channel is UI-only with a typed mocked `electronAPI`, visibly watermarked. Mock strategy: a **total no-op stub base that satisfies the full `ElectronAPI` interface** (19 domains / ~226 methods — the compile-time drift guard stays real, no `as unknown as` cast) plus rich fixtures only for the surfaces UI iteration actually touches (projects/tasks/genie board). Injection seam: a dev-only, `import.meta.env`-guarded module (or `main.web.tsx` entry) assigns `window.electronAPI` **before React renders** (App.tsx dereferences it at mount) — additive, no dev-script rewrite. Mock construction is its own execution group in the wish. | Ultra-speed iteration is a UI activity; the stub-base keeps the drift guard honest while bounding fixture effort; the watermark keeps the dev tool from impersonating the product. Tier-2 real-data bridge is OUT, its own later decision. |
| 3 | Iterate commits go straight to `main`. | Felipe's explicit pick; consistent with his standing no-gates decision for this private fork. History is the session story. |
| 4 | In-loop signal = toast only (commit message as toast text on the Mac channel). | Felipe's explicit pick. |
| 5 | Consolidation = Felipe's word ("lock it in"), plus a non-blocking OFFER each time the loop-commit counter (commits since last consolidation, reset on CONSOLIDATE) crosses a ~25 boundary (25, 50, …) — never every commit, never only once ever. | Felipe's explicit pick, sharpened so drift is actually bounded: without the recurring boundary offer, one declined offer at 25 would make drift unbounded. |
| 6 | Process contract is a durable artifact (`ITERATE.md` in the fork + genie memory) recording: both modes with their **canonical trigger phrases** (enter: "/iterate" / "loop on"; exit: "lock it in"), the husky-only inline gate, ALL stop-and-plan triggers — any DB schema/migration (fork drizzle `src/main/db/schema.ts` AND the `.genie/genie.db` bridge contract), ui-bridge protocol, security surface, destructive changes, and any contradiction of a Felipe-stated decision (surfaced solo, never bundled) — plus the counter/offer cadence. | The wish exists because ceremony hid decisions from Felipe once; fixed trigger phrases and an explicitly-scoped schema fence are what make the contract obeyable by a future instance without interpretation drift. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Dev web server exposes the working copy UI on the network | Low | Loopback by default; network bind is an explicit flag; private Tailscale/LAN threat model Felipe already accepted for dev tooling; mock data only, no PTY/DB surface |
| 2 | Mock drift — browser preview diverges from real app behavior | Medium | Mock module is typed against the same `electronAPI` types; watermark labels it; the Mac channel is the truth check "with a little delay"; consolidation review compares |
| 3 | Main-process restarts kill live terminals mid-loop | Medium | Watcher warns loudly pre-restart; agent announces main-process pushes before sending when terminals are likely live |
| 4 | Unreviewed loop commits accumulate defects | Medium | husky inline; batched async tests; consolidation offer at ~25 commits; stop-and-plan triggers keep dangerous classes out of the loop entirely |
| 5 | Mid-pull races on the Mac (partial state) | Low | Agent pushes atomic single commits; `--ff-only`; watcher skips a tick on dirty tree and toasts a warning |
| 5b | Renderer CSP may block remote HMR websocket — `src/renderer/index.html` ships `connect-src 'self' ws://localhost:*`, scoped for localhost HMR; a remote browser's HMR socket to the bound host may be refused | Medium | `dev:web` serves a dev-only index.html (or vite `transformIndexHtml`) widening `connect-src` to the bound host / `ws:` — dev-web-only, never the packaged app; verified by Success Criterion 1 |
| 6 | Loop-speed pressure erodes the standing decision rule | High (trust) | Encoded as a stop-and-plan trigger in `ITERATE.md` + memory; consolidation review explicitly audits for bundled decisions |

## Success Criteria

- [ ] Browser channel: with `pnpm dev:web` running on the Linux box, an agent file-save in the renderer is visible in a remote browser (Tailscale IP) in under 2 s, with the mock watermark rendered; server binds loopback unless the network flag is passed.
- [ ] Desktop channel: with `pnpm dev:live` running on a clone, an agent push lands, is pulled within 5 s, a renderer-only change applies via HMR without app restart, and exactly one toast shows the commit message.
- [ ] Main-process change path: a pushed `src/main/**` change triggers recompile + Electron restart with a visible pre-restart warning; the app returns healthy.
- [ ] `ITERATE.md` exists at the fork root stating both modes **with their exact canonical entry/exit trigger phrases** ("/iterate" / "loop on" → ITERATE; "lock it in" → CONSOLIDATE), the husky-only inline gate, all stop-and-plan triggers (both schema fences, bridge protocol, security surface, destructive changes, the never-bundle rule), and the counter/offer cadence (reset on consolidation; offer at each ~25 boundary); genie memory carries the pointer.
- [ ] Mock `electronAPI` module type-checks against the real preload types (compile-time drift guard).
- [ ] Loop rehearsal (scripted, headless-tolerant): three consecutive ask→commit→push cycles complete with the Mac-side watcher applying all three and the full test suite still green when run afterward (batched, out of loop).

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `84cb10c493b0015a98b715e4ac436ee7e14f8410aa39d2465e42d4f1a3e928fe`
- **Reviewer:** genie:reviewer a8c4f457a42b80e59
- **Reviewed at:** 2026-07-22T01:39:38.000Z
<!-- genie-design-review:end -->
