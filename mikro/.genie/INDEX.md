# Mikro historical artifacts

The imported planning journal, historical benchmark tools, recipe variants,
mailbox and recorded runs are archived together at immutable Genie commit
`1b58ca73a1b9e322597a41000cc4ebd897e86bdc`. They remain in Git history, not the final code-review diff.

- [Full historical Mikro artifact tree](https://github.com/automagik-dev/genie/tree/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/mikro/.genie)
- [Original Mikro index](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/mikro/.genie/INDEX.md)
- [Full historical package](https://github.com/automagik-dev/genie/tree/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/mikro)
- [Source-only cleanup evidence](../../.genie/wishes/mikro-engine-split/evidence/INDEX.md)

## Retained inputs

Production source, tests, npm/build/CI contracts and generated `dist/` stay intact.
These historical files remain **byte-for-byte** because current scripts read them:

- `evidence/prime-runtime-benchmark/model-benchmark-sdk-v2-selection-lock.json`
  — `scripts/benchmark-runtimes-v2.mjs` reads/hashes this selection input.
- `wishes/rlmx-explore-offload/parity/round2/train-tasks/{3,4,5,6,7}.md`
  — `scripts/eval-routing.mjs` checks the exact pre-registered question hashes.
- `wishes/rlmx-explore-offload/parity/round2/optimizer/gens/gen-4/rep-2/runs/task-5.json`
  — that same script verifies the real recorded failed answer, not a synthetic copy.

The complete numeric gate/training task suites, authored specification, selection
policy and their explanatory README are retained together as fixture definitions.
Their original historical reproduction commands require the archived tool suite.

## Historical reproduction

The reporting tools and all their recorded inputs were archived coherently. Do
not run old commands against an incomplete cleaned tree or silently treat missing
records as zero/success. Inspect an isolated full historical snapshot instead:

```sh
archive_dir="$(mktemp -d)"
git archive 1b58ca73a1b9e322597a41000cc4ebd897e86bdc mikro/ | tar -x -C "$archive_dir"
```

Original documented dependencies, external checkouts and operator prerequisites
still apply; their availability is not certified here. No benchmark rerun,
rescore or provider call is part of cleanup. All historical failures and scores
remain unchanged.

For any old `.genie/<path>` reference in a selection lock, source comment or report,
use `https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/mikro/.genie/<path>`.
This lookup does not promise a file absent from the original import exists; older
specifications may require earlier source history. No source ancestry is rewritten.
