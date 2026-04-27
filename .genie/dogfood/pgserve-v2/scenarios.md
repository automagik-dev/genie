# pgserve v2 — Canary Scenarios

Scenario harness for the `automagik-dev/genie` dogfooder twin (this repo, branch `dogfood/pgserve-v2-canary`). Each scenario validates one invariant from the pgserve v2 wish. Status flips from `WIP` → `READY` → `PASS`/`FAIL` as matching wish waves ship.

| ID | Wave | Status | Description |
|----|------|--------|-------------|
| S1 | 4 (Group 4) | WIP | **connect** — genie boots, requests a DB, gets one named `app_<sanitized>_<12hex>` with the genie fingerprint, CRUD a row, disconnect. |
| S2 | 4 (Group 4) | WIP | **fingerprint mismatch denied** — genie booting from `/tmp/fake-project` (different package.json) must NOT reach the real genie DB; gets a fresh fingerprint instead. |
| S3 | 5 (Group 5) | WIP | **persist honored** — `pgserve.persist: true` in package.json; kill genie, fast-forward 25h, restart → original DB still present. |
| S4 | 5 (Group 5) | WIP | **TTL reaped** — no persist flag; kill genie, fast-forward 25h, restart with same fingerprint → DB was reaped, fresh empty one provisioned. |
| S5 | 5 (Group 6) | WIP | **`--listen` TCP fallback** — pgserve started with `--listen :5432`; genie configured with `host=localhost port=5432` connects. |
| S6 | 4 (Group 4) | WIP | **kill-switch bypass** — `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`; two genies from different fingerprints — second reaches first's DB; deprecation warning logged. |

## Status legend

- `WIP` — script is a stub; the wave needed to validate this scenario hasn't shipped yet.
- `READY` — the wave shipped; script wired and runnable but not yet promoted to PASS in CI.
- `PASS` — last run on a `npm pack` build of `pgserve@2.0.0-*` returned exit 0.
- `FAIL` — last run failed; see the daily `genie send` summary or `genie events timeline` for the diagnostic.

## Run

```bash
bun .genie/dogfood/pgserve-v2/scenarios/s1.ts
bun .genie/dogfood/pgserve-v2/scenarios/s2.ts
# ... s3 .. s6
```

Each script exits 0 on PASS, non-zero on FAIL with a diagnostic on stderr. WIP stubs always exit non-zero so a green run is meaningful.

## Daily summary

When at least one script flips to READY, post:

```bash
genie send "dogfood D=$(date +%Y%m%d): S1✅ S2✅ S3⚠ S4✅ S5✅ S6✅" --to genie-pgserve
```

Use ✅ for PASS, ❌ for FAIL, ⚠ for WIP/blocked.

## Re-promotion rules

A scenario only flips to PASS when:
1. The matching wish wave has shipped on `wish/pgserve-v2`.
2. The canary consumed pgserve via `npm pack` of that branch (not a published release).
3. The script ran end-to-end with no manual intervention.
4. The diagnostic on stderr was empty.

If any of those four are false, the result is FAIL. No "soft pass" mode.
