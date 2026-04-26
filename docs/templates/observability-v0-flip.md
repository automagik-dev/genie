# PR Template — Flip `GENIE_WIDE_EMIT` default to ON

> **Do not merge this PR** until every box below is checked and every
> artifact is linked. This is the v0 release gate for the observability
> substrate. Flipping the default without 14 consecutive days of green
> watcher metrics is the exact incident the wish's pen-test and
> back-pressure work were designed to prevent.

Wish: [genie-serve-structured-observability](../../.genie/wishes/genie-serve-structured-observability/WISH.md)
Rollout phase: **Phase 4 — Flip default** (per
[docs/observability-rollout.md](../observability-rollout.md)).

---

## 1. Summary

One paragraph describing what is flipping and why now:

- Flipping `GENIE_WIDE_EMIT` default from `0` to `1` in `src/lib/observability-flag.ts`.
- All previous phases (0-3) are green for **≥ 14 consecutive days**.
- Pen-test suite, perf gate, and rollback procedure have been re-verified
  within the last 7 days against the current tip of `main`.
- Rollback plan: [see §7 below].

---

## 2. Watcher-of-watcher metrics — 14-day green checklist

Attach a screenshot (or Grafana / `genie events list` query result) showing
14 consecutive days of non-null, within-SLO values for **each** of:

- [ ] `emitter.rejected` — no sustained spike above baseline
- [ ] `emitter.queue.depth` — p99 depth < 5 % of QUEUE_CAP (500 / 10_000)
- [ ] `emitter.latency_p99` — rolling p99 emit-site latency < 1 ms
- [ ] `notify.delivery.lag` — roundtrip lag p99 < 200 ms
- [ ] `stream.gap.detected` — zero unresolved gaps in the window
- [ ] `correlation.orphan.rate` — orphan rate < 1 %

Query used to produce evidence (paste exact SQL or CLI):

```bash
# Example — adjust window to 14d
genie events list --enriched --kind 'emitter.*,notify.*,stream.*,correlation.*' \
  --since 14d --format json | jq ...
```

Link to dashboard screenshots:

- 14d view — emitter metrics: `<paste screenshot link>`
- 14d view — correlation / stream metrics: `<paste screenshot link>`

---

## 3. Pen-test suite — all 4 scenarios passing

Re-run the pen-test suite against the current branch within the last 7 days.
CI log link required:

- [ ] `test/pentest/observability/forge-event.ts` — green → `<CI log link>`
- [ ] `test/pentest/observability/exfil-env-var.ts` — green → `<CI log link>`
- [ ] `test/pentest/observability/schema-bomb.ts` — green → `<CI log link>`
- [ ] `test/pentest/observability/listen-bomb.ts` — green → `<CI log link>`

```bash
bun test test/pentest/observability/
```

---

## 4. Perf regression gate — all gates green

Run on a representative host (not a shared CI micro-VM) at the full 60s
target duration:

- [ ] `emit p99 < 1 ms` — observed `<X.XX> ms` → `<CI log link>`
- [ ] `e2e  p99 < 50 ms` — observed `<X.X> ms` → `<CI log link>`
- [ ] `pg backend count < 150` — observed `<N>` → `<CI log link>`
- [ ] `partition rotation < 500 ms` on pre-seeded 5M-row table — observed
      `<X.X> ms` → `<CI log link>`

```bash
bun run test/perf/observability/gate.ts --duration=60000
```

---

## 5. Soak test evidence

- [ ] 24-hour dogfood on internal workspace with `GENIE_WIDE_EMIT=1`:
      main-table signal density ≥ 90 %. Query + result:

```sql
-- Fraction of non-command_success events in main table over last 24h
SELECT
  count(*) FILTER (WHERE subject <> 'command_success')::float / GREATEST(count(*), 1)
AS signal_density
FROM genie_runtime_events
WHERE created_at > now() - interval '24 hours';
```

Result: `<X.XX>`

- [ ] `correlation.orphan.rate < 1 %` sustained across the 24-hour window.
- [ ] Spill journal empty at end of window
      (`ls ~/.genie/data/emit-spill.jsonl` → missing / zero bytes).
- [ ] Watchdog reports no `stale` or `backpressure_critical` events in the
      window.

---

## 6. Audit + RBAC verification

- [ ] Subscriber token test: a `events:subscriber`-role token is **rejected**
      when attempting to LISTEN on `genie_events.audit`. Attach test output.
- [ ] Audit HMAC chain: `genie events export-audit --verify-only < recent.json`
      returns 0 rows with `chain_break: true`.
- [ ] Admin un-hash + audit export both emitted `audit:true` rows during
      the soak window (sentinel H6).

---

## 7. Rollback plan (REQUIRED — reviewer may not approve without this)

This PR includes a **pre-prepared revert commit** at the tip of the same
branch. The revert restores `GENIE_WIDE_EMIT` default to `0` in a single
file change.

Emergency rollback procedure:

1. `git revert <flip-commit-sha>` (the revert commit is already prepared).
2. `npm publish` the previous tag (no new version bump needed if revert is
   rolled forward immediately).
3. Roll out to affected installs: `npm i -g @automagik/genie@<prev-tag>`.
4. Watchdog and audit tier **continue unchanged** — the revert only flips
   the flag; substrate remains present.
5. Post-incident: confirm spill journal drains; open a follow-up issue for
   the trigger signal.

Revert commit sha (once prepared): `<paste sha>`

---

## 8. Reviewer checklist

- [ ] All boxes in §2 – §7 checked with evidence linked.
- [ ] Revert commit exists on branch tip and is verified by a second reviewer.
- [ ] `docs/observability-rollout.md` `Change log` updated with a Phase 4 entry.
- [ ] At least one security-minded reviewer has re-read
      `docs/observability-contract.md` for any unstated guarantee that this
      flip would violate.

---

## 9. Post-merge monitoring

For the first 72 hours after flip:

- Oncall watches the 6 watcher metrics live.
- `watchdog --probe-once` runs every 10 min (not 60s) via extra systemd timer.
- If **any** of the following fires, revert immediately:
  - `backpressure_critical` raised
  - `correlation.orphan.rate > 2 %` sustained 5 min
  - audit chain break detected
  - spill journal non-empty for > 10 min

Incident post-mortem template: [template to be filled during 72h window].
