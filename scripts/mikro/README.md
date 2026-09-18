# mikro microagents for genie

Cheap, fast, read-only workers on DeepSeek 4.1 Flash (`deepseek-api/deepseek-flash`, custom-typed
in `.mikro/mikro.yaml` because the engine's registry only knows `deepseek-v4-flash`) that gather
the mechanical facts a stage needs BEFORE an expensive agent reads anything. Three agents live in
`.mikro/agents/<name>/` (`agent.yaml` + `SYSTEM.md` on the upstream five-rules contract — starter
block first, no `FINAL` before the fourth REPL block, every citation printed by its own REPL, git
and gh read-only, one fenced JSON answer):

| agent | prompt | returns | used by |
|---|---|---|---|
| `issue-triage` | `Triage issue #<n>` | type, area, summary, repro, candidate files with `path:line`, related PRs/wishes, lane, one question | the canonical wish's intake; `gh` issue triage in parallel |
| `wish-context` | `Intent: <sentence>` | facts with evidence, related work, candidate file set, pinning tests, validation command, gotchas, estimate, open questions | `wish.js` admit:scout runs it first |
| `review-prep` | `Prepare the review of PR #<n>` or `… of commit <sha> against <base>` | per changed file: pinning tests, gotchas, boundary flag, wish; claims with how-to-verify; risk flags | `wish.js` review:diff runs it first |

## Run one

```sh
source ~/.mikro/gate-env.sh                                   # DEEPSEEK_API_KEY from Bitwarden (bws)
bun scripts/mikro/call.ts issue-triage --prompt "Triage issue #2941" --dir .
bun scripts/mikro/call.ts review-prep --dir <worktree> --prompt "Prepare the review of commit <sha> against origin/dev"
```

`call.ts` is the only runtime: it speaks MCP over stdio to `mikro mcp --dir <repo>` (agents are
found through `MIKRO_AGENTS_DIR`, defaulting to this checkout's `.mikro/agents`, so a `--dir` cut
from `origin/dev` still works), then treats the answer as data that has to earn trust — the cost
footer must parse, the JSON must validate against `schemas.ts`, every `path:line` must exist at that
line (an unambiguous bare file name is resolved to its tracked path and rewritten; an ambiguous one
gets a did-you-mean hint), and a failure is retried once with the errors appended. Every attempt is
appended to `.mikro/runs/<agent>.jsonl` (gitignored) and posted as an AGENT span to Phoenix project
`cc-mikro`, beside the Opus turns it replaces. Exit 0 = the JSON on stdout is trustworthy.

## Measure one

```sh
bun scripts/mikro/bench.ts issue-triage --reps 2 --concurrency 4 --tag round=3 --write-evidence
```

Fixtures (`fixtures/<agent>.json`) carry ground truth from merged PRs; `score.ts` computes recall and
precision over file sets, type accuracy, and the citation verdict; the bars are yield ≥ 0.9,
fabrications 0, files recall ≥ 0.6, median cost ≤ $0.05, p90 ≤ 240 s. `--write-evidence` appends
the table to `.mikro/agents/<agent>/EVIDENCE.md` — every number there is a real run.

## Refine one

Edit `SYSTEM.md`, re-bench with a new `--tag round=N`, keep the change only if the bars still pass
and the evidence table improved. Deterministic before generative: anything a script can compute
(file lists, tests that name a file, gotcha lines) is fetched by the starter-block helpers, and the
model only reads, cites and summarizes. Never add a write verb to a helper.
