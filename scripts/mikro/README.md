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

## Per-machine prerequisites (checklist)

- `mikro` ≥ 1.260909.1 on PATH (`mikro --version`), run by a working node — on this host Homebrew's node 25
  cannot load `libllhttp`, so the `mikro` MCP wrapper registered with `claude mcp` pins
  `~/.nvm/versions/node/v24.13.1/bin` first in PATH.
- `~/.mikro/settings.json` mirroring the `providers:` block of `.mikro/mikro.yaml` (api-key-env only, no
  literal key), so a `--dir` outside this checkout still resolves `deepseek-api/deepseek-flash`.
- `~/.mikro/gate-env.sh` exporting `DEEPSEEK_API_KEY` by resolving it from Bitwarden (`bws secret get …`)
  at source time. It is never backed up with a literal value; `call.ts` sources it only when the caller's
  environment lacks the key and hands the key to the MCP server's environment alone.

## What "read-only" means here

Prompt discipline, not a sandbox. Each agent's starter block routes `git` and `gh` through allowlisted
helpers, but the REPL is Python with `subprocess` available; an instruction smuggled into an issue body,
PR body or commit message that the model obeys could run anything the MCP server's environment allows.
Mitigations in place: the server gets an allowlisted environment (PATH, HOME, locale, `MIKRO_*`, the
provider key — never the caller's tokens or SSH agent); a `--dir` whose `.mikro/` config differs from the
invoking checkout's is refused, so a PR cannot swap the provider or inject `TOOLS.md`; untracked files are
never verified citations; every attempt is ledgered and traced. Not yet in place: an adversarial fixture
per agent scoring `injection_attempts` with a bar of zero executed side effects — required before an
agent is pointed at issues or PRs authored outside the team.

## Prices

USD figures come from the per-million prices declared for the provider (`cost:` in `.mikro/mikro.yaml`);
token counts, iterations and wall clock are measured. Since 2026-09-18 those are DeepSeek's published
list prices, read from <https://api-docs.deepseek.com/quick_start/pricing> (USD per million tokens):

| model | input, cache miss | input, cache hit | output |
|---|---|---|---|
| `deepseek-flash` (4.1 Flash; legacy `deepseek-v4-flash` bills at Flash rates) | 0.30 peak / 0.15 off-peak | 0.006 / 0.003 | 1.20 / 0.60 |
| `deepseek-v4-pro` | 1.32 / 0.66 | 0.044 / 0.022 | 3.96 / 1.98 |

The config declares the **peak cache-miss** column, deliberately: off-peak is exactly half, and mikro's
cost footer reports one input figure without separating cached prompt tokens, so a reported cost is an
upper bound on the bill — never below it. DeepSeek documents 1M context for both models; the declared
`context-window: 128000` is left as a conservative cap (nothing in `scripts/mikro/` reads it, and a low
cap can only refuse a run). The per-machine `~/.mikro/settings.json` mirrors the `providers:` block of
`.mikro/mikro.yaml` by hand and is not in the repo, so reprice it there too.

Each ledger row and Phoenix span carries `mikro_version` and `price_basis`, which is now
`deepseek-list-2026-09-18-peak` (`PRICE_BASIS` in `call.ts` — the one constant both the ledger and the
span read), so a later reprice stays mechanical: rows are filtered by basis, never rewritten. Rounds
dated before 2026-09-18T05:00Z in `.mikro/agents/*/EVIDENCE.md` were billed at the placeholder basis
(0.14 in / 0.28 out per million) and their USD is therefore understated — roughly 4.3x on output and
2.1x on input against the peak list price. Those numbers are left alone: every row is a real run at the
basis of its time, and the basis on each row is what makes it re-priceable.
