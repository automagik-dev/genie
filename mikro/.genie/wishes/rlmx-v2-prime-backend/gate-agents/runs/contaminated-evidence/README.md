# contaminated-evidence — provenance

Contaminated records preserved as evidence (D8). None of these are scored;
the final scored records live under `runs/gate-v2-legacy/` and
`runs/gate-v2-prime/` and are what `summarize.mjs runs` reads.

- `task-1.json` / `task-3.json` / `task-4.json` — legacy second-pass records
  that ran with the scaffolded brain-mirror `.rlmx/` config (the explore agent
  ran `rlmx init` in its own cwd during the first pass; D8). Moved here from
  `runs/gate-v2-legacy/` when the final re-runs replaced those files (commit
  `25dd21d`); the content is byte-identical to the legacy records committed at
  `e9fca38` under `runs/gate-v2-legacy/task-{1,3,4}.json`.
- `prime-task-1.json` / `prime-task-3.json` / `prime-task-4.json` — prime
  contaminated failure records: the scaffolded config made every brain task
  fail at ~0.9s on `assertSupportedConfig` (custom REPL tools; D8). Restored
  from git history commit `e9fca38` (where they lived under
  `runs/gate-v2-prime/task-{1,3,4}.json` and, identically, under this
  directory as `task-{1,3,4}.json`) after the final re-runs replaced the
  originals under `runs/gate-v2-prime/` in commit `25dd21d`. Byte-identical
  to the `e9fca38` blobs.
