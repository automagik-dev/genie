# DRAFT: dream-replatform (Domain C/D — umbrella G9)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Raw

## KNOWN (evidence)
- dream today: overnight batch-exec of SHIP-ready wishes (layers→PR→merge→QA→report), blocked in v5 on background execution — which native CC now provides (schedule/cron cloud agents, CronCreate, /loop).
- Hermes warning (accepted): native cron solves the trigger, NOT leases, one-run-at-a-time, dedupe, missed-run recovery, cancellation, pause/resume, ownership, audit, "why did this run", exactly-once-ish, backpressure, human-approval boundaries. "Cron is trigger, never authority."
- pm autopilot folds into this successor (Felipe-approved absorb, with policy/approval gates).
- Omni approval queue exists (global genie.db + `genie omni serve` NATS runner) — natural human-gate channel for overnight runs.

## DECIDED (umbrella D7/G9)
- dream = thin scheduler ADAPTER + policy/LEDGER: schedule definitions in repo/genie config (not only cloud UI); every scheduled run opens a run row in genie.db; idempotency key (wish_slug+schedule_id+intended_at+git_ref); lease before dispatch; wish-state + human-gate checks; records native schedule/run ids + artifact/PR/trace links; terminal-state reconciliation; stale-lease expiry with explicit status; cancellation flows genie→native.
- Validation bar: duplicate triggers execute exactly once; run row reconciles; cancellation honored.

## GAPS
- [ ] Substrate choice: local CronCreate/loop (this machine must be on) vs scheduled CLOUD agents (needs repo access + secrets in cloud) vs hybrid. Your overnight reality decides.
- [ ] Human gates: route approvals through the omni WhatsApp approval queue (approve/deny from phone at night)? Ties to omni-approval-ux + omni-runner-port wishes.
- [ ] Budget ceiling per dream run (max $ / max Fable calls) — enforced from the routing-matrix budgets?
- [ ] What does DREAM-REPORT become — omni message, gh summary, or .genie doc (current)?
- [ ] Merge policy overnight: auto-merge on SHIP or always queue PRs for morning review?
