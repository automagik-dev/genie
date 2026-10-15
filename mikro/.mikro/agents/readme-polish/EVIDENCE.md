# EVIDENCE — why `readme-polish` was proposed

Written on **2026-08-16**, during the first dogfood of **mikro v0.260817.1**
(fresh install: old `~/.mikro` + `~/.local/bin/mikro` v0.260730.1 removed,
`scripts/install.sh` re-run from `main` at v0.260817.1). This file exists so
the proposal can be **checked** rather than believed.

Read the last section — *What is not claimed* — before you rename the
directory.

---

## 1. Origin — user directive, not scanner selection

Be clear about this up front, because it is the difference between this draft
and `git-historian.proposed` next door: **the transcript scanner did not pick
this candidate. The user did**, verbatim, as the dogfood test for the new
release:

> "as a test, we will create mikro micro agent, specialized in polishing
> README.md which we desperately need."

The scanner's taxonomy is tool-shaped (repo-exploration, git-history,
web-research, …). It has no "documentation review" family and cannot surface
one: README work is spread invisibly across `repo-exploration` (the reads and
greps) and `edits` (the fixes). So the scan below is **context, not a
ranking** — it establishes the window this host was measured in, not that
this family tops it.

## 2. The scan — context for the window

```bash
node plugins/claude-code/skills/microagent-create/scan-transcripts.mjs --hours 72
```

Captured **2026-08-17T00:17Z** (window since 2026-08-14T00:16:46Z, rolling
over live transcripts — a later run returns different totals). Scope: **112
transcripts, 21,789 lines** under `~/.claude/projects`.

MEASURED (assistant `usage` blocks — the API's own counts):

| Quantity | Value |
|---|---|
| assistant turns | 7,316 |
| output tokens | 4,433,975 |
| cache-creation input tokens | 37,793,774 |
| cache-read input tokens | 845,465,972 |

~ESTIMATED context returned by tool results, all families: **7,178,795 chars
~ 1,794,699 tok** (chars exact, ÷4 a convention — always written with `~`).

Top offloadable families in the window: `repo-exploration` 4,181,247 chars
~1,045,312 tok (58.2%, `explore-r`'s class, already covered), `web-research`
~232,461 tok (13%), `git-history` ~200,240 tok (11.2%, `git-historian.proposed`'s
class). `edits` — where README fixes land — is ~12,271 tok across 236 calls.

## 3. The candidate against the five rules

Scored honestly, including the one it does not clear by measurement:

1. **Offloadable — yes, by construction.** The agent's entire product is a
   written report. The *editing* half of "polishing" stays with the host;
   `SYSTEM.md` forbids every write, including redirects. What is offloaded is
   the expensive half: reading a ~1,000-line document (`README.md` in this
   repo is **1,018 lines / 45.3 KB**, `wc -l README.md`, 2026-08-17T00:17Z)
   plus the source files needed to check its claims.
2. **Not already covered — yes.** `explore-r` answers questions about the
   tree; no existing agent in `.mikro/agents/`, `examples/agents/` or
   `~/.mikro/agents/` audits a document against the tree, carries a severity
   taxonomy, or returns suggested rewrites.
3. **Repeatable — NOT established by measurement.** README polish is episodic
   per repository, and the scanner cannot isolate the family (§1). The
   repeatability claim is an expectation (every repo this host touches has a
   README; releases make them stale), not a measured recurrence. This is the
   weakest leg of the proposal and is stated as such rather than dressed up.
4. **Self-contained — yes.** "Audit this README against this repo" is one
   prompt, no mid-run follow-up needed.
5. **Bulk in, summary out — yes, structurally.** The document plus the
   cross-checked source files enter the agent's context; what returns to the
   session is a findings list. On this repo the bulk-in side alone is 45.3 KB
   (~11k tok by the ÷4 convention) before a single verification read.

## 4. Design provenance

- Rules 1–5, the no-worked-example stance, the verification block, and the
  `FINAL("""` contract are inherited from `git-historian.proposed/SYSTEM.md`,
  whose EVIDENCE records the failure they prevent: its probe run 1 answered
  on turn one and fabricated three paths and a SHA (that file, §4). This
  draft assumes the same failure mode applies to an unread README and guards
  it the same way.
- `shape: loop`, `model: khal/deepseek-v4-flash`, `max_cost: 0.50` are the
  skill defaults (`plugins/claude-code/skills/microagent-create/SKILL.md`),
  which descend from `examples/agents/explore-r/agent.yaml`'s measured sizing.
  `station/<model>` is the $0 offline alternative on hosts that have it.
- `max_iterations: 12` deviates from the default 10; the sizing rationale is
  in `agent.yaml`'s own comments (two extra turns for slicing a long document
  before claim-checking).

## 5. What is **not** claimed

- **No quality evidence at all.** This draft has **never been run** — not
  even a feasibility probe. There are zero data points on whether it finds
  real defects, how many findings survive its own verification block, or what
  a run costs. (`git-historian.proposed` §4 shows what its two probes
  looked like; this draft has none.)
- **No saving is claimed.** The scan numbers in §2 describe the window, not
  this agent. No token figure here predicts what delegating README review
  would save.
- **No repeatability measurement** — see §3 rule 3. If the user wants the
  measured version of this story, the scanner would need a docs-review
  family; today it cannot provide one.
- **The ~ numbers are estimates.** Characters are exact; ÷4 is a convention.
  The MEASURED table is the only exact token figure here.
- **`explore-r`'s parity numbers are not inherited**, cited, or implied. They
  belong to a different agent on a frozen suite (`docs/parity-explore.md`).

## 6. Activating it — your move, not the agent's

This directory ends in `.proposed`, which `discoverAgents` skips
(`src/mcp/agents.ts`, `isProposedDir`). It is neither listed nor callable;
calling it by name answers `Unknown tool: mikro_readme-polish_proposed`.
`tests/mcp-agents.test.ts` pins that.

To activate:

```bash
mv .mikro/agents/readme-polish.proposed .mikro/agents/readme-polish
```

The tool appears as `mikro_readme-polish` on the next request — live refresh,
no restart, no reconnect. To withdraw it, rename it back.

`.proposed` is a **reserved suffix**, matched case-insensitively. An agent you
genuinely wanted to call `something.proposed` would be permanently invisible,
and the skip is silent by design.
