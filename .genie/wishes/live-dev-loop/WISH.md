# Wish: live-dev-loop — "i say change, you change"

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `live-dev-loop` |
| **Date** | 2026-07-21 |
| **Author** | Felipe (4 explicit picks) + Fable orchestrator (2 review-hardened derivations) |
| **Appetite** | medium |
| **Branch** | `wish/live-dev-loop` (docs in genie). Fork code: the live-loop target branch is the FORK's `main` — at plan time server-side `khal-os/genie-desktop` main was `981a530` ("Merge genie-dash into main"; the merge base all groups diffed against — post-execution, main advanced to `5a17077`, the merge of this wish's branch), containing the full genie surface incl. `src/renderer/components/genie/*` and the 19th `GenieApi` domain. **Remote topology is a trap and is named explicitly:** in the Linux working copy the fork remote is `khal` (local `main` tracks UPSTREAM `origin`=syv-ai/dash — never use it); groups run `git fetch khal && git switch -c khal-main-work khal/main` (or equivalent khal/main-tracking branch) and push with `git push khal <branch>:...` semantics allowed by the hook (plain branch pushes). On a Mac clone of the fork, `origin` IS the fork, so the poller there runs `git pull --ff-only origin main`; the rehearsal's scratch clone clones the FORK, making its `origin` the fork too. |
| **Repos touched** | dash fork (khal-os/genie-desktop): dev:web, mock module, dev:live watcher, toast, ITERATE.md; genie repo: wish docs + memory pointer only |
| **Design** | [DESIGN.md](../../brainstorms/live-dev-loop/DESIGN.md) |

## Summary

**Problem:** iterating on genie desktop requires full wish cycles; Felipe wants ask→visible-change in seconds, with rigor deferred to explicit consolidation.

Build the live iteration environment for genie desktop: Felipe asks for a change in chat and sees it in seconds — an ultra-fast **browser channel** (network-bound Vite on the Linux box serving the agent's working copy against a watermarked mock `electronAPI`) plus a near-real-time **desktop channel** (`pnpm dev:live` on his Mac: pull poller + HMR/restart + commit-message toasts) — governed by a durable **ITERATE/CONSOLIDATE process contract** (`ITERATE.md`) whose whole point is that plans shrink to the size of Felipe's last sentence without decisions ever getting bundled past him again.

**Bootstrapping boundary (explicit):** THIS wish executes in normal mode — groups, reviewers, validations as usual. Iterate mode exists only AFTER this ships, and only inside the private no-gates fork; the genie repo itself never runs iterate mode.

## Scope

### IN

- **G1 — Mock module + injection seam:** a total no-op stub base **satisfying the full `ElectronAPI` interface** (19 domains / ~226 methods; no `as unknown as` casts — the compile-time drift guard must be real), rich fixtures for the surfaces UI iteration touches (projects, tasks, genie board), an `import.meta.env`-guarded injection seam (dev-only module or `main.web.tsx` entry) assigning `window.electronAPI` **before React renders**, and a visible watermark ("dev preview — mock data") on every screen while mocked.
- **G2 — `pnpm dev:web`:** Vite dev server wrapper serving the working copy; **loopback by default, network bind behind an explicit flag** (Tailscale/LAN posture); dev-only index.html / `transformIndexHtml` widening the CSP `connect-src` (currently `'self' ws://localhost:*`) so remote HMR websockets work — never touching the packaged app's CSP.
- **G3 — `pnpm dev:live` + the contract:** Mac-side watcher wrapping `pnpm dev` with a 2–5s `git fetch && git pull --ff-only` poller (skip + warn on dirty tree); renderer diffs apply via HMR silently; `src/main/**` diffs recompile + restart Electron with a loud pre-restart warning; toast-only signal (one in-app toast per pulled commit, text = commit message). `ITERATE.md` at the fork root: canonical trigger phrases (enter "/iterate" / "loop on"; exit "lock it in"; paraphrases confirmed before acting), husky-only inline gate, ALL stop-and-plan triggers (fork drizzle schema `src/main/db/schema.ts` AND the `.genie/genie.db` bridge contract; ui-bridge protocol; security surface/read-only wall; destructive changes; any contradiction of a Felipe-stated decision — surfaced solo, never bundled), and the counter/offer cadence (loop commits since last consolidation, reset on CONSOLIDATE; one offer at each ~25 boundary). Genie-side memory pointer written by the orchestrator at close.

### OUT

- Tier-2 real-data browser (IPC-over-websocket to a headless Electron) — its own future decision.
- Any change to the shipped product's delivery or the packaged app's CSP — the browser channel is a watermarked dev tool; the browser-vs-desktop product decision stays closed.
- Iterate mode against the genie repo itself.
- Auth/encryption for the dev web server beyond loopback-default + explicit opt-in bind.
- Rewriting dash's dev scripts beyond the two additive wrappers and the toast hook.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | All six design decisions inherited verbatim from the SHIP-stamped [DESIGN.md](../../brainstorms/live-dev-loop/DESIGN.md) (digest `84cb10c4…e928fe`): dual channel; full-interface stub mock + seam + watermark; straight-to-main; toast-only; word + recurring ~25-boundary offer; durable contract with canonical phrases + both schema fences. | Four are Felipe's explicit picker choices; two are orchestrator derivations he saw flagged and the design review hardened (F1–F6 applied, re-review SHIP). Not re-litigated here. |
| 2 | G1 before G2 (mock before web server); G3 fully parallel to G1 — with disjointness MANDATED, not assumed: G1 mounts the watermark inside its own `main.web.tsx`/mock entry (wrapping `<App/>` there), never editing `App.tsx`/`main.tsx`; G3 delivers the toast as a standalone imperative `sonner` module registered from a store (mirroring `taskToasts.tsx` ← `projectsStore.ts`), never a new `App.tsx` effect. `package.json` is shared G2/G3 but they sit in different waves. If either group must touch `App.tsx`/`main.tsx` after all, it reports blocked rather than colliding. | A plain browser renders nothing meaningful without the mock; the single desktop entry (`main.tsx` → `App.tsx`) is the only collision surface and both groups are fenced off it. |
| 3 | The loop-rehearsal proof (design criterion 6) lives in G3's validation as a scripted, headless-tolerant check — three ask→commit→push cycles applied by the watcher, full suite green afterwards. | Proves the loop end-to-end without requiring Felipe's Mac in CI. |
| 4 | Test placement/naming convention (binding for all groups): every test lives under `src/**` as `.ts`/`.tsx` (the vitest include is `src/**/*.{test,spec}.{ts,tsx}` — `scripts/**` is never collected) and each group's test filenames contain the literal filter substring — `mock`, `devweb`, `devlive` (non-hyphenated). The watcher's pure logic (diff classification, dirty-skip, commit-subject extraction) is extracted into an importable `src/**` module tested there; `scripts/dev-live.mjs` stays a thin shell. | The plan reviewer empirically reproduced that the validation filters otherwise match zero files and exit 1 — correct work would fail its own gate. |

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] Browser channel: with `pnpm dev:web` bound to the network on the Linux box, an agent file-save in the renderer is visible in a remote browser in under 2 s, watermark rendered; without the network flag the server binds loopback only. _(Machine proof = loopback/bind assertions + headless ws-handshake + observed HMR event; the <2 s visual bound is Felipe-live QA.)_
- [x] Mock: type-checks against the real preload `ElectronAPI` types with zero casts; app boots in a plain browser (no `window.electronAPI` crash at mount); fixtures render projects/tasks/genie board plausibly. _(G1 review: drift guard proven by injection.)_
- [ ] Desktop channel: an agent push is pulled by `dev:live` (poller tracks `origin main`); a renderer-only change applies via HMR without restart; exactly one toast shows the commit message; a `src/main/**` change triggers recompile + Electron restart preceded by a visible warning; dirty tree → skip + warning, no crash. _(Machine proof = driven-tick rehearsal decisions + commit-subject unit tests; live toast timing and pull latency are Felipe-live QA.)_
- [x] `ITERATE.md` exists at the fork root with the exact canonical entry/exit phrases, husky-only inline gate, all stop-and-plan triggers (both schema fences, bridge protocol, security surface, destructive changes, never-bundle rule), and the counter/offer cadence. _(G3 review: element-by-element PASS, unsoftened.)_
- [x] Loop rehearsal: three consecutive scripted ask→commit→push cycles are applied by the watcher; the full test suite is green when run afterwards (batched, out of loop). _(19/19 driven-tick assertions; suite green.)_
- [x] Fork suite stays green: baseline 111 files / 1034 pass / 1 skip + new tests; `pnpm run type-check` and eslint clean. _(Final: 118 files / 1085 pass / 1 skip.)_
- [x] (orchestrator, at close) genie memory carries the ITERATE.md pointer — orchestrator-owned close-out; subagents never write global memory. _(Done 2026-07-22: `iterate-mode-contract.md` written + indexed in MEMORY.md by the orchestrator.)_

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — large typed surface (+1 multi-module), stateful boot-order seam (+2) | engineer-standard / high | Mock module: full-interface stub base + fixtures + injection seam + watermark |
| 3 | engineer | 3 — watcher lifecycle/restart orchestration (+2), subjective toast/warning UX acceptance (+1) | engineer-standard / high | dev:live watcher + toast + ITERATE.md |

### Wave 2 (after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 2 — config/serve wiring (+1 no deterministic remote-HMR test in CI), CSP dev-only override (+1) | engineer-standard / medium | dev:web wrapper: loopback-default bind flag + dev-only CSP widening |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: Mock module + injection seam + watermark

**Goal:** The renderer boots and renders meaningfully in a plain browser, against a fully-typed mock, watermarked so it can never impersonate the product.

**Deliverables:**
1. `src/renderer/dev/electronApiMock.ts` (or equivalent): no-op stub base generated/written to satisfy the complete `ElectronAPI` interface — compile-time checked, zero casts; rich fixtures for projects, tasks, and genie board/wish state layered on top.
2. Injection seam: `import.meta.env`-guarded dev-only module (or `main.web.tsx` entry) assigning `window.electronAPI` before `createRoot` (App.tsx dereferences at mount — boot must not crash).
3. Watermark component rendered on all screens when the mock is active ("dev preview — mock data").
4. Tests (per Decision 4: filenames contain literal `mock`, under `src/**`): type-level drift guard (mock satisfies `ElectronAPI`, node env); browser-mode boot smoke in a jsdom environment — add `jsdom` + `@testing-library/react` as devDeps (additive; not a dev-script rewrite) and mark the smoke file `// @vitest-environment jsdom` while the global vitest env stays `node` — asserting no electronAPI crash at mount, watermark present, fixtures render.
5. Watermark mounts inside the G1-owned `main.web.tsx`/mock entry (wrapping `<App/>`) — `App.tsx`/`main.tsx` are NOT touched (Decision 2 fence).

**Acceptance Criteria:**
- [ ] Type-check fails if a new method is added to any electron-api domain without a mock stub (drift guard proven by test or compile assertion).
- [ ] Plain-browser boot renders projects/tasks/genie board fixtures with the watermark; no crash at App mount.
- [ ] Zero `as unknown as` (or equivalent) casts in the mock path (grep gate).

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && pnpm run type-check && pnpm test -- mock && ! grep -rn 'as unknown as' src/renderer/dev/
```

**depends-on:** none

---

### Group 2: `pnpm dev:web` — network-bound Vite with dev-only CSP

**Goal:** One command serves the agent's working copy to a remote browser at HMR speed, loopback-safe by default.

**Deliverables:**
1. `dev:web` script: Vite serve with loopback default; explicit flag/env (e.g. `DEV_WEB_HOST=0.0.0.0`) for network bind; wires the G1 mock entry.
2. Dev-only CSP handling: `transformIndexHtml` (or dev index variant) widening `connect-src` to the bound host / `ws:` — packaged app CSP untouched (assert in test/grep).
3. Evidence: remote-browser HMR proof from this box (curl + ws handshake check headless; the <2s visual bound recorded as the criterion for Felipe's live use).

**Acceptance Criteria:**
- [ ] No network flag → server listens on loopback only (`ss` assertion); with flag → bound host serves the app and the HMR websocket connects (headless ws client proof).
- [ ] Packaged/production index.html CSP byte-unchanged (test or grep gate).
- [ ] A file edit on this box reflects in a connected client without full reload (HMR event observed).

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && pnpm test -- devweb && pnpm run type-check
```

**depends-on:** Group 1

---

### Group 3: `pnpm dev:live` watcher + toast + ITERATE.md

**Goal:** The Mac-side channel: pulls land as toasts within seconds, main-process changes restart loudly, and the process contract exists durably.

**Deliverables:**
1. `dev:live` script/wrapper: `pnpm dev` + 2–5s poller running `git fetch && git pull --ff-only origin main` — correct on the Mac clone and the scratch rehearsal clone because both clone the FORK (their `origin` = khal-os/genie-desktop; see the header's remote-topology note — never valid in the Linux working copy where `origin` is upstream); dirty-tree → skip tick + warning; classify pulled diff — renderer-only → let HMR apply; `src/main/**` touched → recompile (`tsc -p tsconfig.main.json`) + Electron restart with a loud pre-restart warning. The watcher's pure logic (diff classification, dirty-skip, commit-subject extraction) lives in an importable `src/**` module; `scripts/dev-live.mjs` is a thin shell (Decision 4).
2. Toast: a standalone imperative `sonner` module registered from a store (mirroring `taskToasts.tsx` ← `projectsStore.ts`) — one toast per pulled commit, text = commit subject. `App.tsx`/`main.tsx` NOT touched (Decision 2 fence).
3. `ITERATE.md` at the fork root with every element from the design (canonical phrases, husky-only gate, both schema fences + all stop-and-plan triggers incl. never-bundle, counter/offer cadence, CONSOLIDATE contents).
4. Loop rehearsal (headless-deterministic): three scripted commit cycles against a scratch clone with the poll tick DRIVEN synchronously (no wall-clock sleeps); assertions on the watcher's decisions — diff-classification result, captured pre-restart warning string, and a spied/stubbed restart call (no real Electron relaunch headless). Full suite green afterwards (batched).
5. Tests for the watcher's pure parts under `src/**` with `devlive` in the filename (Decision 4).

**Acceptance Criteria:**
- [ ] Rehearsal: 3/3 driven-tick cycles applied on the scratch clone; renderer-only cycle classified no-restart; main-touching cycle triggers the spied restart with the warning line captured. (Wall-clock pull latency = Felipe-live QA.)
- [ ] `ITERATE.md` contains the exact entry/exit phrases and every trigger/cadence element (checklist-diffed against the design's criterion 4).
- [ ] Full suite green after rehearsal (batched validation, out of loop).

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && pnpm test -- devlive && pnpm test && test -f ITERATE.md
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional (Felipe, live): browser on his machine shows a change within ~2 s of the agent saving; his Mac `dev:live` shows the toast and applies the same change within ~5 s of push; after a main-process restart the app returns healthy (design SC3's health clause — inherently live).
- [ ] Contract: a future session entering "/iterate" behaves per ITERATE.md (tiny commits, no ceremony) and STOPS on a schema-touching ask.
- [ ] Regression: `pnpm dev` (stock) unchanged for anyone not using the new scripts; packaged app CSP untouched.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Remote HMR websocket blocked by CSP | Medium | Dev-only `connect-src` widening (design Risk 5b); G2 asserts packaged CSP untouched |
| Mock drift vs real app behavior | Medium | Full-interface no-cast stub = compile-time guard; Mac channel is the truth check; consolidation review compares |
| Main restart kills live PTYs mid-loop | Medium | Loud pre-restart warning in watcher; ITERATE.md instructs the agent to announce main-process pushes when terminals are likely live |
| Unreviewed loop commits accumulate defects | Medium | husky inline; batched tests; recurring ~25-boundary consolidation offer; stop-and-plan fences |
| Loop-speed pressure erodes the never-bundle rule | High (trust) | Encoded verbatim in ITERATE.md + genie memory; consolidation review audits for bundled decisions |
| Watcher races / partial pulls on the Mac | Low | Atomic single commits; `--ff-only`; dirty-tree skip+warn |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan Review — 2026-07-22T01:49:04Z
- Reviewer: genie:reviewer (independent, read-only)
- Verdict: FIX-FIRST (9 findings: F1 filters match zero files/exit 1 — empirically reproduced; F2 G1‖G3 disjointness unsecured on App.tsx; F3 jsdom/RTL absent; F4 branch/poller-ref ambiguity; F5 wall-clock rehearsal flake; F6 memory-pointer SC dropped; F7 machine-vs-live annotation; F8 app-returns-healthy dropped; F9 no one-line problem)
- Fork-reality PASSes: CSP quote exact; 19 domains confirmed; schema fence, husky, sonner toast patterns real; 111 baseline test files; filter-collision worry with existing electronApiMock helper CLEARED (outside test include).

### Plan Re-Review (fix loop 1) — 2026-07-22T01:54:48Z
- Verdict: FIX-FIRST (8/9 resolved; F4-branch reopened — "main contains all prior work" contested + poller `origin main` wrong on the Linux box where origin=upstream)

### Plan Re-Review (fix loop 2, final) — 2026-07-22T01:57:53Z
- Reviewer: genie:reviewer (independent, read-only)
- Verdict: SHIP (all 9 findings RESOLVED; 0 open)
- Pre-flight: design digest 84cb10c4…e928fe verified SHIP (verify exit 0).
- F4-branch RESOLVED against fresh refs (post git fetch khal): khal/main = 981a530 "Merge genie-dash into main"; khal/main...genie-dash = 0 ahead / 1 behind; khal/main carries the full genie surface (GenieBoardModal/HirePanel/SidebarEntry + the 19th GenieApi domain) → G1 premise + genie-board fixtures AC buildable. Remote-topology trap documented: local `main` tracks upstream origin=syv-ai/dash (git config confirmed); groups branch from khal/main after `git fetch khal`; Mac + scratch clones clone the FORK so `origin main` is valid THERE only.
- Prior fixes re-confirmed: F1 (named src/** tests with literal filter substrings), F2 (disjointness mandated + report-blocked escape), F3 (jsdom+RTL, @vitest-environment jsdom), F5 (driven-tick/spied-restart), F6 (orchestrator memory SC), F7 (machine-vs-live annotations), F8 (app-returns-healthy QA), F9 (one-line problem).
- Design→wish fidelity: all 6 design SCs + all IN/OUT bullets covered; bootstrapping boundary explicit; no scope smuggled. Ready for `work`.

_Orchestrator disposition (2026-07-22): SHIP persisted after two fix loops (within the ≤2 contract); all edits were wish-text corrections, no design change (digest untouched, re-verified exit 0). Status set to APPROVED._

### Execution Review (G1) — 2026-07-22T04:45:16Z
- Reviewer: independent read-only (genie:review execution pipeline)
- Target: wish/live-dev-loop @ 7a14343 (689e7e5 mock+fixtures · 75b1b08 seam+watermark · 7a14343 tests) vs 981a530; pushed khal
- Verdict: SHIP (1 cosmetic NIT)
- AC1 drift guard PROVEN BY INJECTION: fake `rtkDriftProbeMethod` added to RtkApi → tsc failed TS2741 at electronApiMock.ts:51 ("220 more" confirming ~226 surface) → reverted, tree verified clean. Annotation sits on the real installed object (noopBase → spread → window.electronAPI); no index signatures/Record/any/satisfies-widening on the interfaces; fixtureOverrides is Partial<ElectronAPI>; expectTypeOf adds a second compile-time layer catching extra methods too.
- AC2 seam import-order verified (no module-scope electronAPI deref anywhere in src/renderer; smoke reproduces worst case via dynamic App import); watermark pointer-events-none, max z-index, mounted ONLY in the dev seam (product can never render it); smoke asserts no-crash + watermark + fixtures (incl. board cards). Canvas warning benign, no package added to silence it.
- AC3 cast gate clean (only `as const` on fixtures, off the contract path).
- Fixtures: type-correct, agentId/agentProfile per schema, durable statuses, NO capability lies (hire returns bridge-unavailable; PTY guarded failures).
- Scope: exactly 7 G1 files + 2 devDeps; App.tsx/main.tsx untouched; zero existing tests modified; fork-wide eslint exit 1 = pre-existing scripts/*.mjs debt, zero in G1 files.
- NIT (polish): DEV_BOARD.counts says done:2/total:5 vs 3 listed tasks with zero done — cosmetic in a watermarked preview.

_Orchestrator disposition (2026-07-22): SHIP + orchestrator-run validation (type-check clean; pnpm test -- mock 2 files/5 pass; cast grep clean; full suite 113/1039/1). Task t_mrvf2p7za43e792d marked done. NIT added to the polish backlog._

### Execution Review (G3) — 2026-07-22T05:14:04Z
- Reviewer: independent read-only (genie:review execution pipeline)
- Target: wish/live-dev-loop @ 0243948 (c46fec4 core+tests · 5960127 shell+rehearsal · 4fdc7fd toasts · 0243948 ITERATE.md) vs 7a14343
- Verdict: FIX-FIRST → fixed → verified
- H1 (HIGH): toast ws server bound all interfaces (hostless listen → `::`, empirically proven) — violates loopback posture. FIXED in `874f02f`: `TOAST_BIND_HOST='127.0.0.1'` + error handler degrading to no-toasts without killing the loop + real bind-host test (address() === 127.0.0.1). Re-validated: devlive 29/29, rehearsal 19/0, full suite 1068/1.
- M1 (MEDIUM, orchestrator-dispositioned ACCEPTED): toast wired via dev-guarded useEffect in shared Toast.tsx instead of the mandated store registration. Grounds: production inertness PROVEN (vite build + bundle grep — all dev symbols absent via DCE/tree-shake); the App.tsx/main.tsx hard fence held; mandate's purpose (parallel-writer disjointness) was mooted by sequencing; placement mirrors the two existing effect-based subscription toasts in the same component; the store pattern is event-triggered and has no natural socket-lifecycle event. This reworks the orchestrator's own derivation, not any Felipe-stated decision. NIT carried: no ToastContainer parity test with guard off.
- L1 fixed with H1 (port-busy degrade). L2: new scripts inherit the pre-existing scripts/*.mjs eslint gap (out of gate, identical to existing scripts) — not a regression.
- Concern 3 (tsconfig) PASS both halves: necessity confirmed (type-aware ESLint parse), no production leak (noEmit; vite entry graph excludes src/dev; bundle grep clean; main tsconfig unchanged).
- ITERATE.md faithfulness: element-by-element PASS, never-bundle rule EMPHASIZED not softened; husky-only claim verified against real lint-staged config.
- Purity/determinism/topology all verified (zero-import core; no wall-clock in rehearsal path; origin-main topology headers present). Scope exact, zero existing tests modified.

_Orchestrator disposition (2026-07-22): SHIP after 1 fix loop + orchestrator re-validation (devlive 29/29; rehearsal 19/0; full 1068 pass/1 skip). Task t_mrvf2pd39e9349c2 marked done. M1 acceptance recorded above; ToastContainer parity-test NIT + G1 fixture-count NIT sit in the polish backlog._

### Execution Review (G2 — final group) — 2026-07-22T05:37:35Z
- Reviewer: independent read-only (genie:review execution pipeline)
- Target: wish/live-dev-loop @ 3907347 vs 874f02f; pushed khal (ref verified)
- Verdict: SHIP (2 LOW non-blocking)
- All 3 ACs PROVEN: socket-level loopback-default (address()===127.0.0.1, network URLs empty) + DEV_WEB_HOST=0.0.0.0 bind + real vite-hmr ws handshake `connected`; product index.html CSP byte-unchanged after build:renderer (zero dev tokens); HMR observed as genuine `update` (not full-reload) via standalone repro — hermetic, deadline-polled, sleep-free.
- Mode gate AIRTIGHT: isDevWeb = command==='serve' && mode==='web'; the nasty escape `vite build --mode web` empirically produces a byte-identical production bundle. DEV_WEB_HOST inert outside dev:web. resolveDevWebHost: blank/unset→loopback; garbage→fail-closed vite bind error, never silent exposure.
- Scope exact (5 files; package.json +1 line); zero existing tests modified; polling appears only in the test harness (committed config uses inotify); host sysctl untouched (65536).
- LOWs: HMR integration assertion also tolerates full-reload (tighten to === 'update' at polish); dev:web CSP widens connect-src to ws:/wss: (scheme-only, mock-only watermarked page, product untouched — accepted).

_Orchestrator disposition (2026-07-22): SHIP + orchestrator-run validation (devweb 17/17; type-check clean; full suite 118 files/1085 pass/1 skip; product CSP verified original in dist/renderer/index.html). Task t_mrvf2pam274f1741 marked done. **All three groups complete** — branch merged to fork main via API (hook-safe); wish remains IN_PROGRESS pending Felipe-live QA (<2s browser visual, Mac toast+pull latency, post-restart health, ITERATE-mode behavioral check). Known host prerequisite for the browser channel on the Linux box: `fs.inotify.max_user_watches` is 65536 and vite exhausts it — Felipe one-liner: `sudo sysctl fs.inotify.max_user_watches=524288` (+ persist in /etc/sysctl.d) or run dev:web with CHOKIDAR_USEPOLLING=1. Polish backlog: 2 G2 LOWs + G3 parity-test NIT + G1 fixture-count NIT._

---

## Files to Create/Modify

```
# dash fork (khal-os/genie-desktop, main)
src/renderer/dev/electronApiMock.ts                # G1 — full-interface stub + fixtures
src/renderer/dev/mock.test.ts (+ jsdom smoke)      # G1 — drift guard + boot smoke ("mock" in filename)
src/renderer/dev/watermark.tsx                     # G1 — mock watermark (mounted in main.web.tsx only)
src/renderer/main.web.tsx                          # G1 — injection seam + watermark wrap (App.tsx untouched)
package.json (scripts + jsdom/@testing-library)    # G1 devDeps · G2/G3 scripts — additive only
vite.config.ts (transformIndexHtml dev-only CSP)   # G2
src/renderer/dev/devweb.test.ts                    # G2 — bind/CSP/HMR proofs ("devweb" in filename)
src/dev/devliveCore.ts (+ devlive.test.ts)         # G3 — watcher pure logic under src/** ("devlive" in filename)
scripts/dev-live.mjs                               # G3 — thin shell over devliveCore
src/renderer/... genieDevToasts module             # G3 — imperative sonner toast from store (App.tsx untouched)
ITERATE.md                                         # G3 — the process contract
scripts/loop-rehearsal.mjs                         # G3 — driven-tick rehearsal shell

# genie repo (this repo)
.genie/wishes/live-dev-loop/WISH.md                # this document
# (memory pointer written by the orchestrator at close — not a repo file)
```
