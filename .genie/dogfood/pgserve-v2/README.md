# pgserve v2 — Dogfood Canary (`automagik-dev/genie`)

This directory is the canary loop for the [pgserve v2 wish](https://github.com/automagik-dev/genie/) — proof that `automagik-dev/genie` (the largest pgserve consumer) can run end-to-end against pgserve v2 work-in-progress builds throughout the wish's execution.

## Role

The canary is **this repo, on branch `dogfood/pgserve-v2-canary`** (cut from `dev`). It is consumed exclusively by the `dogfooder-pgserve-v2` agent under `genie-pgserve`'s direction. As pgserve v2 waves land in [`namastexlabs/pgserve#wish/pgserve-v2`](https://github.com/namastexlabs/pgserve/tree/wish/pgserve-v2), the canary:

1. Pulls the matching pgserve build via `npm pack` of the feature branch.
2. Re-runs the scenario suite under `.genie/dogfood/pgserve-v2/scenarios/`.
3. Reports PASS/FAIL back to `genie-pgserve` via `genie send`.

The canary is **not** a production deployment. It runs ephemeral pgserve test instances; it does not touch the long-running daemon at PID 160588 (Felipe's email brain) and does not drop any `brain_*` databases.

## Why a separate canary?

Most pgserve consumers (brain, omni, rlmx, hapvida-eugenia, email) will pin `pgserve@^1.x` until v2 ships. We need *one* consumer to run against the v2 branch continuously so that breaking changes are caught the moment they land — not at release time. `automagik-dev/genie` is the right canary because:

- It's the largest, most feature-complete pgserve consumer.
- The genie team owns both repos, so feedback latency is minimal.
- The wish's Group 7 will migrate the genie consumer anyway, so the canary's scenarios double as the migration acceptance harness.

## When to run each scenario

| Scenario | Run after... | Promotes to PASS when... |
|----------|--------------|--------------------------|
| S1 connect | Wish Group 4 ships | A clean genie boot creates an `app_<sanitized>_<12hex>` DB and CRUDs a row. |
| S2 fingerprint mismatch denied | Wish Group 4 ships | A genie booted from `/tmp/fake-project` cannot reach this repo's DB. |
| S3 persist honored | Wish Group 5 ships | `pgserve.persist: true` survives a 25h fast-forward. |
| S4 TTL reaped | Wish Group 5 ships | No-persist DB is gone after a 25h fast-forward. |
| S5 `--listen` TCP fallback | Wish Group 6 ships | `host=localhost port=5432` connects when daemon was started with `--listen :5432`. |
| S6 kill-switch bypass | Wish Group 4 ships | `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` lets a foreign fingerprint reach an existing DB and emits the deprecation warning. |

Until the matching wave ships, each script is a stub that exits non-zero with `WIP — awaiting wave N` on stderr. That is expected.

## Consuming pgserve v2 from `npm pack`

The pgserve v2 work happens on the `wish/pgserve-v2` branch of `namastexlabs/pgserve`, which is **not** published to npm until v2.0.0. To consume a WIP build:

```bash
# In a checkout of namastexlabs/pgserve on branch wish/pgserve-v2
cd /home/genie/workspace/repos/pgserve
git checkout wish/pgserve-v2
npm pack                          # produces pgserve-2.0.0-<sha>.tgz

# In this repo (the canary)
cd /home/genie/.genie/worktrees/genie/dogfood-pgserve-v2
bun add /home/genie/workspace/repos/pgserve/pgserve-2.0.0-*.tgz
bun .genie/dogfood/pgserve-v2/scenarios/s1.ts
```

The canary should never depend on a published v2 version until 2.0.0 ships — the whole point of the loop is to validate **this branch's HEAD**, not a release.

## Running the suite

```bash
# One scenario
bun .genie/dogfood/pgserve-v2/scenarios/s1.ts

# All scenarios (manual sweep)
for s in .genie/dogfood/pgserve-v2/scenarios/s*.ts; do
  echo "=== $s ==="
  bun "$s"
  echo "exit=$?"
done
```

Exit codes:
- `0` — PASS
- `2` — WIP (stub, expected before matching wave ships)
- `3` — FAIL (real failure with diagnostic on stderr)

## Daily summary

When at least one scenario is READY, the dogfooder agent posts a one-liner:

```bash
genie send "dogfood D=$(date +%Y%m%d): S1✅ S2✅ S3⚠ S4✅ S5✅ S6✅" --to genie-pgserve
```

Use ✅ for PASS, ❌ for FAIL, ⚠ for WIP.

## Felipe's standing constraints (carried from the wish brief)

- DO NOT restart the running pgserve daemon at PID 160588.
- DO NOT drop any `brain_*` databases.
- DO NOT spawn pgserve daemons for testing — use ephemeral test instances.
- The canary IS this repo (`automagik-dev/genie`). Verify with `git remote -v` before any consumer-side work.
