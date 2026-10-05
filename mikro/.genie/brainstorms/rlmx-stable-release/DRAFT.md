# DRAFT — rlmx stable release

Started 2026-07-25. Owner: genie@namastex.io. Seeded from `~/prod/rlmx/HANDOFF.md`.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

**This file is the PROGRAM RECORD** (and satisfies the handoff §5 ask for a
`.genie/` roadmap doc). Per D6 the program decomposes into three wishes; only
wish 1 is crystallized here — see
`.genie/brainstorms/rlmx-release-hygiene/DESIGN.md`. Wishes 2 and 3 get their
own brainstorms when their inputs exist.

## Problem

rlmx has shipped ~14 wishes of surface — RLM core with Python-REPL prompt
externalization, observable child-process recursion (`RecurseEvent` stream),
`rlmx acp` (ACP stdio agent), pi-ai 0.80.10 Models runtime, CAG caching,
Gemini 3 opt-ins, the `sdk.*` surface, and the local `station` provider — but
the artifact the world can actually see is **npm `0.260528.2`, published
2026-05-28**, fronted by a **722-line dev-notebook README**. Everything that
makes rlmx distinctive landed after that publish and is invisible to a
first-time reader. There is no stable line, no release narrative, and no
first-contact doc.

## Corrected state (verified 2026-07-25, after `git fetch`)

The handoff's §2 "stranded ACP branch" is **stale and closed**:

| Claim in HANDOFF §2 | Verified reality |
|---|---|
| `wish/rlmx-acp-adapter` local-only, no upstream | **PR #112 merged 2026-07-21** (23 files, +5313/−6) |
| 10 commits ahead of `origin/main` | HEAD `66fe01c` **is a strict ancestor** of `origin/main` `d7f1878`; `git diff HEAD origin/main` empty |
| work at risk of disk loss | on `origin/main`, nothing to push |

Cause: the local `origin/main` ref predated the merge; the handoff read
`@{u}` without fetching. No work was lost.

Other verified facts:
- `origin/main` = `d7f1878` (Merge PR #112). Open PRs: **none**.
- Open issues: **#29** (multi `--context` roles), **#13** (shallow tool usage,
  flash-lite), **#6** (v0.3 explicit TTL cache control), **#2** (team-lead
  orchestration executed directly).
- npm dist-tags: `latest = 0.260528.2`, `next = 0.260528.1`.
- `CHANGELOG.md` has an unreleased block (RTK battery, `rlmx doctor` RTK
  status, `rtk.enabled`, RTK-aware scaffolds) — but **nothing about ACP,
  recursion events, pi-ai 0.80, or station**. Changelog is behind the code.
- `docs/` already holds 9 reference docs incl. `events.md`,
  `sdk-overview.md`, `release-contract.md` — a real "below the fold" home.
- `package.json` `files` = `dist/src, src/templates, python/*.py, examples`.
- **Gate on `main` @ `d7f1878`: GREEN.** `npm ci` + `tsc` build clean;
  `npm test` = **420 pass / 0 fail / 0 skipped**, 95 suites, exit 0. The ACP
  work's "all groups SHIP" claim is now independently corroborated.
- **`npm audit --omit=dev` = 2 advisories in the PRODUCTION tree**, both with
  fixes available:
  - `js-yaml` 4.0.0–4.2.0 — **high**, quadratic-complexity DoS via merge-key
    alias chains (GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m). Directly in
    rlmx's threat model: rlmx parses `agent.yaml` / `rlmx.yaml`.
  - `protobufjs` <=7.6.4 — **moderate**, prototype-shadowing + infinite loop
    in `.proto` option parsing.
  (`fast-uri` high is dev-only.)
- `HANDOFF.md` sits untracked in the repo root — decide ignore vs move.

## Scope

IN — (pending owner decisions)
OUT — (pending owner decisions)

## Decisions

### D1 — Versioning: KEEP CALENDAR ✅ (owner, 2026-07-25)

Calendar versioning (`0.2YYMMDD.N`) was a **deliberate migration**, not drift.
It stays. Semver is explicitly NOT adopted.

Consequence — **repo-wide stale-context fix is IN SCOPE**: every place that
states or implies semver must be corrected to describe the calendar scheme.
Known hits to sweep (not yet exhaustively enumerated):
- `CHANGELOG.md` — "this project adheres to [Semantic Versioning]".
- `docs/release-contract.md` — needs verification.
- README, scaffold templates, any `docs/` mention of version bumps.
Sweep must be a real grep, not a guess.

### D2 — Stability labeling: ACP EXPERIMENTAL, REST STABLE ✅ (owner, 2026-07-25)

`rlmx acp` ships labeled **experimental**. Everything else (RLM core + REPL,
recursion + event stream, SDK, providers, CAG, Gemini 3, station) is stable.

⚠️ **Unresolved tension this creates** (raised to owner, not yet decided):
the `rlmx-live-tui` wish dropped the custom TUI and moved *all* viewing to
"rlmx-acp + pi native TUI". So marking ACP experimental makes the **primary
way to watch a recursion an experimental surface** — which collides with the
README brief's "lead with the watch-the-recursion moment". Resolution needed
before the positioning decision (D3) can be made honestly.

### D3 — Positioning: BLEND OF THREE, EACH BACKED BY A NUMBER (owner, 2026-07-25)

Not one sentence picked from a menu — three claims, none of which ship
unbacked. Owner framing: "everything you pointed at is an ingredient."

**Claim 1 — Cost.** Same task, less money. Must be measured against an
**existing market benchmark**, not a home-made set, or the number is worthless.

**Claim 2 — Capability unlock (the real superpower).** Proper recursion lets
**cheap or even local** models complete higher-complexity tasks that otherwise
demand a frontier model. This is the differentiated claim; nobody else is
making it with evidence.

**Claim 3 — Context effectiveness.** RTK routing cuts tool-output tokens
60–90%. Needs an **rlmx-scoped** number, plus deepened reciprocity with
`github.com/rtk-ai/rtk` (already linked at `README.md:359`).

**Use-case framing.** rlmx is used many ways; survey the popular ones, lead
with **coding agent**. Owner's own killer use: **microagents** — specialized
rlmx agents that absorb repeatable work from Claude Code, as the alternative to
a skill-only setup that pays frontier prices on every invocation. This deserves
first-class README real estate and its own cost comparison.

### D4 — Release wish scope: OPEN (pending decomposition, below)

## Benchmark reality — what exists vs what the claims need

**`rlmx benchmark` already exists** (`src/benchmark.ts`, `rlmx benchmark cost|oolong`),
and measures the right things: tokens in/out, cost, latency, iterations, and
savings % — RLM vs Direct, per task + totals, persisted to
`~/.rlmx/benchmarks/`.

| Claim needs | Verified state | Gap |
|---|---|---|
| Cost per task, published | Harness exists | **`~/.rlmx/benchmarks/` is EMPTY — no run has ever been saved. Zero numbers exist today.** |
| A *market* benchmark | `oolong` mode = real HF Oolong Synth (long-context accuracy) ✅; `cost` mode = **6 hand-written tasks, 1–4.5 KB contexts** | The `cost` set is not credible for a viral claim. Need a recognized **coding-agent** benchmark. |
| Cheap/local model beats frontier-direct | **Not measurable.** `runCostBenchmark` calls `llmComplete(..., config.model)` for BOTH arms — Direct and RLM run on the *same* model | **Needs a code change: a model matrix** (direct-model ≠ rlm-model). Highest-value engineering item in the release — it's what makes Claim 2 provable. |
| RTK savings, rlmx-scoped | `scripts/dogfood-rtk.mjs` (real code path, "no mocks") + `rtk gain` deltas | Global `rtk gain` today = **65.7% saved, 26.8M tokens, 13,265 cmds** — but that's Claude-Code-wide, not rlmx-scoped. Need scoped measurement. |
| Microagent story | Nothing | No README section, no recipe, no cost comparison vs a skill-only setup. |

**Local rig is live and strong.** Lemonade responds on `:13305` serving
`Brain-35B` (Qwen3.6-35B-A3B-MTP, Q4_K_XL, **262 144 ctx**, `tool-calling`
label, 21.3 GB), reachable as `station/<model>` via `src/station-provider.ts`.
Claim 2 is demonstrable **today** on owner hardware at $0 marginal cost.
Also registered: `qwen3.5-2b-FLM` on the **NPU** via FastFlowLM.

### Market-benchmark candidates (D5 — OPEN, load-bearing)

| Benchmark | Serves | Cost/risk |
|---|---|---|
| **Aider polyglot** (225 Exercism, 6 langs) | Claims 1 **and** 2 — its public leaderboard lists **% solved *and* $ per run**, so "cheap+rlmx vs frontier-direct" is apples-to-apples | Moderate; runnable locally |
| **SWE-bench Verified** (500 real issues) | Max prestige / virality | Heavy Docker infra, expensive, slow; needs a full agentic scaffold — **release-blocker risk** |
| **Terminal-Bench** | Agentic terminal tasks | Newer, smaller audience |
| **Oolong** (already wired ✅) | The RLM-paper root claim: token-efficient over huge context | Not a *coding* benchmark — doesn't serve the "coding agent" lead |

## Scope-size finding — this must decompose

The ask now spans parts that ship and staff independently:

- **A. Release hygiene** — version stale-context sweep, `js-yaml`/`protobufjs`
  audit fix, CHANGELOG backfill, stale `next` dist-tag, issue triage.
  *Independent; publishable immediately.*
- **B. Proof engineering** — benchmark model-matrix capability + market
  benchmark integration. *Real feature work in `src/benchmark.ts`.*
- **C. Proof execution** — run the sweeps (frontier vs cheap vs local
  `station`), RTK-scoped savings. *Depends on B.*
- **D. Launch** — README from scratch around the proven numbers, microagent
  recipes, demo recording, rtk reciprocity. *Depends on C — you cannot write
  the viral README before the numbers exist.*

Proposed split: **`rlmx-release-hygiene`** (A, ships now) →
**`rlmx-proof`** (B+C, the heart) → **`rlmx-launch`** (D).

### D6 — Sequencing: THREE WISHES, HYGIENE SHIPS NOW ✅ (owner, 2026-07-25)

`rlmx-release-hygiene` → `rlmx-proof` → `rlmx-launch`, as above.

### D7 — Zero-spend benchmarking ✅ (owner, 2026-07-25)

Owner constraint: **"we will test only with chosen local llms so it's free."**
Selected arms: **cheap cloud + rlmx** (headline) and
**local `station/Brain-35B` + rlmx** (showstopper).

⚠️ **No baseline arm was selected** — but Claims 1 and 2 are comparative
("cheaper than what?", "beats what?"). A frontier-direct arm is exactly the
expensive thing being ruled out. Resolution — a methodology that costs nothing
and is *more* rigorous than cross-vendor racing:

1. **Control = same model, ±rlmx.** Run each model direct and through rlmx.
   This isolates recursion as the single variable. **The harness already does
   exactly this** (`runCostBenchmark` runs both arms on `config.model` — the
   "limitation" found earlier is precisely the right control). Free locally.
2. **Report tokens as the primary unit**, then derive dollars from
   **published per-token rate cards**. Gives cost-per-task figures with zero
   billed spend. Must be labeled *computed from list pricing, not billed*.
3. **Frontier = cited, not run.** Verified 2026-07-25: the Aider polyglot
   leaderboard (<https://aider.chat/docs/leaderboards/>) publishes
   **Model · Percent correct · Cost · Command · Correct edit format · Edit
   format** over **225 Exercism exercises in C++/Go/Java/JS/Python/Rust**.
   Cite those rows for context.

**Honesty guardrail (non-negotiable):** our run and a leaderboard row are
**not** apples-to-apples — different scaffold (aider's edit harness vs rlmx's
agent), different dates, different model revisions. Every cited number must
carry that caveat. The only strictly-controlled comparison we own is our own
±rlmx arms. Publish `latency_ms` too: recursion trades wall-clock for cost,
and showing the loss makes every win credible.

⚠️ **Unresolved contradiction:** "only local llms so it's free" vs. the
selected **cheap cloud + rlmx** arm (Haiku/Flash class costs a few dollars).
Needs the owner to confirm: strictly zero-spend local-only, or is a small
cloud spend acceptable to buy universal reproducibility?

### D5 — Benchmark: FULL AIDER POLYGLOT, NO SUBSET ✅ (owner, 2026-07-25)

All **225** Exercism exercises (C++, Go, Java, JS, Python, Rust) per arm — no
sampling, so there is no subset caveat for critics to pull on. `oolong` stays
wired and gets run as supporting long-context evidence (already built, free);
it is not the headline. **SWE-bench Verified deferred** post-release.

### D8 — Four arms ✅ (owner, 2026-07-25)

| Arm | Cost | Role |
|---|---|---|
| local `station/Brain-35B` **direct** | $0 | control for the local pair |
| local `station/Brain-35B` **+ rlmx** | $0 | showstopper |
| cheap cloud **direct** | ~$ | control for the cloud pair |
| cheap cloud **+ rlmx** | ~$ | **headline — reproducible by anyone** |

Owner accepted a few dollars of cloud spend (over strict zero-spend) to buy
universal reproducibility. Frontier arms are **cited from the Aider
leaderboard, never run**.

⚠️ **Scale risk (feeds wish 2's design):** 225 exercises × 4 arms = **900
benchmark runs**, and the two rlmx arms multiply that by the recursion factor
(each task is many LLM calls). On a local 35B this is a **multi-day** campaign.
`saveBenchmarkResults` currently persists **only at the end of a run**
(`src/benchmark.ts`), so a single crash loses days — the exact failure mode
that already cost this project once. **Wish 2 must add incremental
checkpoint/resume to the benchmark harness before the campaign starts.**

## Release-contract findings (verified 2026-07-25) — reshapes wish 1

`docs/release-contract.md` is authoritative and **contradicts the handoff's
release checklist**. Verified reality:

- **npm is SDK-only.** The contract states "npm is not the canonical end-user
  CLI release channel" and "the npm manifest does not expose a `bin`".
  Confirmed: `package.json` has **no `bin` field**. Therefore the handoff §4
  item *"confirm `npx rlmx` works post-install"* rests on a false premise —
  `npx rlmx` cannot work by design. Replace with an `install.sh` /
  `rlmx update` smoke.
- **The release boundary is a git merge to `main`**, consumed by
  `scripts/install.sh` and `rlmx update` — not `npm publish`.

Stale context in that same contract (all verified):

| Contract says | Reality |
|---|---|
| release boundary is `dev` → `main` | **no `dev` branch exists on origin**; `wish/*` and `fix/*` merge straight to `main` (PRs #107–#112) |
| use short-lived `drogo/<topic>` branches | actual convention is `wish/*` / `fix/*` |
| "do not keep a long-lived `drogo/prod-rlmx` branch" | **`refs/heads/drogo/prod-rlmx` exists on origin** |
| production checkout `/home/genie/prod/rlmx` | actually `/home/namastex/prod/rlmx` |

Also: **`scripts/version.mjs` documents `YYMMDD` as UTC** (line 6–8) but
computes it with local-time `getFullYear()/getMonth()/getDate()` (lines 45–47).
A release cut near midnight disagrees with its own contract. Small, real, fix
it in wish 1.

Good news on D1's sweep: a real repo-wide grep (excluding `node_modules`/`dist`)
found the **only** live stale semver claim in tracked source is
**`CHANGELOG.md:6`** — "this project adheres to [Semantic Versioning]". The
version-scheme sweep is one line; the *release-contract* staleness above is the
bigger prize.

## Roadmap — the three wishes

### Wish 1 — `rlmx-release-hygiene` (crystallized, unblocked, ships first)
Security fix, stale-context correction, CHANGELOG backfill, ACP experimental
labeling, dist-tag hygiene, calendar version bump + release.
→ `.genie/brainstorms/rlmx-release-hygiene/DESIGN.md`

### Wish 2 — `rlmx-proof` (the heart; blocked on nothing but sequencing)
- Add checkpoint/resume to the benchmark harness (**prerequisite**).
- Add a **model matrix** so direct-arm and rlm-arm models can differ.
- Integrate full Aider polyglot (225).
- Run the 4 arms + Oolong; measure tokens, derive dollars from published rate
  cards; publish `latency_ms` honestly.
- Measure **rlmx-scoped** RTK savings via `scripts/dogfood-rtk.mjs` + `rtk gain`
  deltas (global today: 65.7%, 26.8M tokens, 13 265 cmds — not rlmx-scoped).
- Output: `docs/benchmarks.md`, reproducible.

### D9 — ACP positioning + README constraints ✅ (owner, 2026-07-25)

**The ACP integration exists to drive rlmx from Claude Code, Codex, Hermes, and
the CLI. Nothing else.** Owner does not use Tidewave or Newio; those sections
were pre-existing README content, not a product direction.

Researched (2026-07-25) — this is an architectural constraint, not a
preference:

- ACP defines **Client = the editor/IDE**, **Agent = the AI coding tool**
  (<https://agentclientprotocol.com/get-started/introduction>).
- `rlmx acp` is therefore an **Agent**.
- **Claude Code and Codex are also Agents, not Clients** — Zed had to build a
  bridge to wrap Claude Code as an agent. Two agents cannot speak ACP to each
  other, so nothing in Claude Code natively consumes `rlmx acp`.
- The path that actually works is **`acpx`** (<https://github.com/openclaw/acpx>),
  a headless ACP client, verified in-repo at 0.12.0. Any harness that can run a
  shell command drives rlmx through it. This was buried as a "dev loop"
  footnote beneath three unused hosts; it is the **primary** integration.
- **Zed stays** — Zed Industries authored ACP and is the reference client, so
  it is the honest example of "a real ACP client spawning rlmx directly". It is
  demoted below the `acpx` path, not deleted.
- **Hermes is owner-controlled**, so making Hermes a true ACP *client* is the
  one route to first-class editor-style integration without a bridge. Worth
  considering in wish 3 or later.

**README verdict (owner, blunt):** the current 722-line README is *"too verbose,
AI slop, trash that needs cleaning."* Binding constraints for the wish-3
rewrite:

1. **Terse.** Assume the reader bails in 30 seconds. Reference material moves
   to `docs/`.
2. **No AI-slop register** — no throat-clearing, no padded transitions, no
   feature-marketing adjectives.
3. **Only claim integrations that are real and used.** Every host named must be
   one a reader can actually use, with a verified command.
4. Every number comes from wish 2; nothing unbacked.

### Wish 3 — `rlmx-launch` (blocked on wish 2's numbers)
README from scratch around the three proven claims; **microagent** recipes as
first-class content (owner's killer use: specialized rlmx agents absorbing
repeatable Claude Code work, vs. a skill-only setup paying frontier prices every
invocation); demo recording of visible recursion; deepen `rtk-ai/rtk`
reciprocity (already linked at `README.md:359`).

## Criteria

Program-level definition of done:
1. Wish 1 published: 0 production-tree advisories, release contract matches
   reality, CHANGELOG covers the ACP/recursion/pi-ai/station era.
2. Wish 2: `docs/benchmarks.md` exists with all 4 arms over 225 exercises, every
   number reproducible from a documented command, latency reported alongside
   cost.
3. Wish 3: README leads with a claim that a stranger can verify in an afternoon.

Per-wish testable criteria live in each wish's DESIGN.md.

## Risks / constraints

- **Overclaim risk.** The README brief says "go viral"; the same brief says
  "don't overclaim; every feature link resolves". Any feature named above the
  fold must have a working copy-paste path on a clean machine.
- **npm publish is irreversible.** A wrong `latest` tag can't be recalled,
  only deprecated. Publish from a verified clean CI-green tree.
- **`1.0.0` is a promise.** It implies the `sdk.*` surface and `agent.yaml`
  schema are stable under semver. If either is still moving, 1.0.0 buys a
  viral moment and sells breaking-change freedom.
- **ACP v1 is single-session serialized** — honest labeling needed if it
  fronts the release.
- **Demo recording needs a live provider.** The "watch the recursion happen"
  hook depends on a real recursive run being filmable and legible; the local
  `station`/Lemonade path makes this credential-free but slower.
- **pi-ai 0.80 provider breadth is untested** across the full matrix; the
  README should claim only providers actually exercised.
- **Stale `next` dist-tag** (`0.260528.1`) is older than `latest` — it will
  mislead anyone who installs `@next` unless retagged or removed.
- **Verification is unfinished** — the "all groups SHIP" claim on the ACP work
  has not been independently re-run this session (gate in flight).
- `~/prod` is the `ryzen-ai` estate monorepo with unrelated uncommitted work on
  `wish/brain-chat-proxy`; the rlmx repo is a separate git repo inside it.
  Don't cross-contaminate.

## Criteria

(pending scope)

## Notes / open threads

- Four open issues: fold any into the release, or leave for post-1.0?
- CHANGELOG `[Unreleased]` must be backfilled for ACP/recursion/pi-ai/station
  regardless of version scheme.
