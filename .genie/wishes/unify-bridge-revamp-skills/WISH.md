# Wish: Unify omni-bridge into serve, fix status IPC, revamp skills, make turn fallback configurable

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `unify-bridge-revamp-skills` |
| **Date** | 2026-04-09 |
| **Design** | N/A — direct from debug session |

## Summary
The omni-bridge is now conceptually part of `genie serve`, but the codebase still treats it as a standalone module with a per-process singleton — `genie omni status` and `genie doctor` lie about its state because they run in a separate Node process that never touches serve's memory. This wish deletes the duality: bridge becomes an unconditional serve subsystem, status/doctor query it via a real IPC channel (pidfile + NATS ping), the `genie omni bridge` top-level command surface is removed (no backwards compat), the built-in skills are audited against the current CLI surface, and Omni's hardcoded turn-monitor fallback message is made configurable per instance so "⏱ Still processing your request..." stops leaking to WhatsApp on stalled turns.

## Scope
### IN
- **genie**: make omni-bridge a mandatory, non-optional subsystem of `genie serve` with deterministic lifecycle hooks (start before `ready`, stop on shutdown).
- **genie**: replace the module-scoped `bridgeInstance` singleton with a process-external state source (pidfile at `~/.genie/state/omni-bridge.json` + NATS `omni.bridge.ping` request/reply with timeout).
- **genie**: fold bridge health reporting into `genie doctor` as the single source of truth. Remove `genie omni status` entirely.
- **genie**: delete legacy `genie omni bridge start|stop|status` AND `genie omni status` standalone commands and the `GENIE_EXECUTOR_TYPE=tmux` env-var workaround. Bridge is only ever started by serve; bridge state is only ever read via `genie doctor`.
- **genie**: audit `plugins/genie/skills/*` (brainstorm, wish, work, review, fix, refine, trace, docs, report, council, learn, genie, pm, dream, wizard, genie-hacks) against the current CLI surface. Remove stale command references, fix broken examples, align skill outputs with v4 task-lifecycle integration.
- **omni**: add `agentFallbackEnabled` (default `true`), `agentFallbackMessage` (default preserves current string), and `agentFallbackTimeoutMs` (default 600000) to the instance schema + Drizzle migration.
- **omni**: `turn-monitor.ts` reads those fields per instance; when disabled, skip the fallback send entirely; when enabled, use the custom message.
- **omni**: CLI surface via `omni instances update --agent-fallback-enabled false` (or equivalent flag).
- Migration notes + CHANGELOG entry describing the breaking CLI removal.

### OUT
- Root-cause debugging of *why* agents stall for 10+ minutes (tracked separately — this wish only stops the symptom from reaching users).
- Moving the bridge out-of-process into its own daemon/systemd unit (explicitly rejected; it stays in-serve).
- Any rewrite of the NATS subject scheme (`omni.message.>` stays as-is).
- Skills *content* redesign — only correctness/stale-reference fixes, not conceptual rewrites of how each skill works.
- Backwards compatibility shims for the removed `genie omni bridge` / `genie omni status` commands.
- Reply-filter tuning for the felipe-whatsapp instance (operator task, not code).
- Localization of the turn-monitor fallback message — English only for this wish; per-language variants are tracked for a follow-up wish.
- Moving from pidfile + NATS ping to a fuller control-plane protocol (e.g., subject-based command/event bus) — current scope is the minimum IPC needed for status.

## Decisions
| Decision | Rationale |
|----------|-----------|
| Pidfile + NATS ping over HTTP health endpoint | Consistent with the rest of the stack (everything else is NATS); proves responsiveness, not just liveness. |
| No backwards compat for removed commands | User explicitly asked for root fix without compat; keeping dead commands invites confusion about which code path is canonical. |
| Bridge is unconditional in serve | There is no legitimate reason to run serve without the bridge anymore; making it optional is what caused the `GENIE_EXECUTOR_TYPE=tmux` env-var hack. |
| Turn-monitor fallback kept opt-in by default | Most Omni users rely on it; opt-out respects existing behavior while giving power users an escape hatch. |
| Config lives on the instance, not the provider | Per-instance is where other reply/trigger/debounce settings already live. |
| Skills audit is mechanical, not creative | Scope control — prevents this wish from ballooning into a framework rewrite. |

## Success Criteria
- [ ] `genie serve` always starts the bridge; if bridge fails to start, serve fails fast with a non-zero exit.
- [ ] `~/.genie/state/omni-bridge.json` is written on bridge start (pid, subjects, startedAt) and removed on clean shutdown.
- [ ] `genie doctor` from a fresh process returns accurate bridge state by reading the pidfile and issuing an `omni.bridge.ping` NATS request with a 2s timeout.
- [ ] `genie omni status`, `genie omni bridge start`, and `genie omni bridge stop` no longer exist as commands (all exit with commander's unknown-command error).
- [ ] All skill files under `plugins/genie/skills/` reference only commands that exist in the current `genie --help` output. A linter script (`bun run skills:lint`) confirms this.
- [ ] Every skill example block that invokes a CLI command is runnable against the current binary (`--help` for each referenced subcommand succeeds in CI).
- [ ] Omni instance GET returns `agentFallbackEnabled`, `agentFallbackMessage`, `agentFallbackTimeoutMs`.
- [ ] When `agentFallbackEnabled=false`, a stalled turn at `fallbackTimeoutMs` never calls `sendFallback`; verified with a unit test that stubs `sendFallback` and asserts zero calls.
- [ ] When `agentFallbackMessage` is set, the message sent to WhatsApp matches exactly (integration test using a mock channel plugin).
- [ ] `bun run check` green in both repos.
- [ ] No references to `getBridge()` remain outside `src/services/omni-bridge.ts` and `src/genie-commands/serve.ts`.

## Execution Strategy

### Wave 1 (parallel — independent repos / concerns)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Bridge IPC: pidfile + NATS ping + serve lifecycle refactor |
| 2 | engineer | Turn-monitor fallback config: schema, migration, code path, CLI flag |
| 3 | engineer | Skills audit: lint script + stale-reference fixes |

### Wave 2 (sequential — depends on Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Delete legacy `genie omni bridge` commands; rewrite status + doctor to use IPC |
| 5 | reviewer | Review all groups against success criteria; run validations |

## Execution Groups

### Group 1: Bridge IPC via pidfile + NATS ping
**Goal:** Give the serve-owned bridge an out-of-process-queryable health surface.

**Deliverables:**
1. `src/services/omni-bridge.ts` — on `start()`, write `~/.genie/state/omni-bridge.json` with `{pid, startedAt, subjects, natsUrl}`; on `stop()`, delete it. Subscribe to `omni.bridge.ping` and reply with `{ok:true, uptimeMs, subjects, pid}`.
2. `src/lib/bridge-status.ts` (new) — pure helper: reads pidfile, issues NATS request with 2s timeout, returns `{state: 'running'|'stopped'|'stale', detail}`. Used by both status and doctor.
3. `src/genie-commands/serve.ts` — bridge is mandatory; remove all conditional `if (bridgeEnabled)` paths and env-var gates; any bridge start failure is fatal.
4. Unit tests for `bridge-status.ts` covering: no pidfile → stopped; pidfile + no pong → stale; pidfile + pong → running.

**Acceptance Criteria:**
- [ ] Pidfile created with `O_EXCL` (`fs.open(path, 'wx')`) so two concurrent serves cannot both claim it; the losing serve fails fast with a clear "pidfile locked" error.
- [ ] Unit test spawns two bridge starts in parallel and asserts exactly one succeeds.
- [ ] Pidfile removed deterministically on clean `stop()`, SIGTERM, and SIGINT.
- [ ] `omni.bridge.ping` replies within 2s under normal load.
- [ ] Pre-implementation check: `grep -r "omni\.bridge\." repos/omni/` returns zero matches, confirming the subject does not collide with any existing Omni subscriber. Evidence captured in the PR description.
- [ ] `bun test src/lib/bridge-status.test.ts` passes.
- [ ] Integration test: start `genie serve`, confirm pidfile exists, send `omni.bridge.ping`, confirm pong; SIGTERM serve, confirm pidfile deleted within 500ms.
- [ ] Serve exits non-zero if bridge fails to connect to NATS at startup.

**Validation:**
```bash
cd repos/genie && bun run check \
  && bun test src/lib/bridge-status.test.ts \
  && bun run test:integration:bridge-lifecycle
```

**depends-on:** none

---

### Group 2: Omni turn-monitor fallback configurable
**Goal:** Stop leaking "⏱ Still processing your request..." to WhatsApp by default-safely, but let operators opt out.

**Deliverables:**
1. `packages/db/src/schema.ts` — add `agentFallbackEnabled boolean not null default true`, `agentFallbackMessage text`, `agentFallbackTimeoutMs integer not null default 600000` to `instances`.
2. `packages/db/drizzle/NNNN_instance_fallback_config.sql` — generated migration.
3. `packages/api/src/services/turn-monitor.ts` — replace hardcoded 600s + literal string with per-instance config lookup; when `agentFallbackEnabled=false`, never call `sendFallback`.
4. `packages/api/src/routes/v2/instances.ts` — accept the new fields on PATCH; include in GET response; Zod schema update.
5. `packages/cli/src/commands/instances/update.ts` — add `--agent-fallback-enabled`, `--agent-fallback-message`, `--agent-fallback-timeout-ms` flags.
6. Unit test: stalled turn with `agentFallbackEnabled=false` → `sendFallback` never called.
7. Unit test: stalled turn with custom message → `sendFallback` receives exact message.
8. **Instance config loading strategy (documented in turn-monitor.ts doc comment):** turn-monitor re-reads instance config at the start of every fallback evaluation tick (not cached). A CLI change to `agentFallbackEnabled` takes effect on the next tick without requiring a serve restart. If this proves too expensive, a short-TTL cache (≤5s) is acceptable, but the behavior must be documented in the same comment.

**Acceptance Criteria:**
- [ ] Migration applies cleanly on a fresh DB and on the current dev DB. Running it twice in sequence is idempotent (no error on the second run).
- [ ] Instance GET/PATCH round-trips all three new fields.
- [ ] CLI flags work and are reflected in `omni instances get <id>`.
- [ ] Both unit tests pass.
- [ ] Live config change test: with serve running, call `omni instances update --agent-fallback-enabled false`; the next stalled turn honors the new value without restart. Covered by an integration test.
- [ ] The literal string "Still processing" appears exactly once in the omni repo, as the default value of `agentFallbackMessage` in `turn-monitor.ts` (or its schema default). Verified by `grep -rn "Still processing" repos/omni/packages/ | wc -l` returning 1.
- [ ] Out-of-scope note present in the wish: localization of the fallback message is not addressed here (English only). Tracked for a follow-up wish if needed.

**Validation:**
```bash
cd repos/omni && bun run check \
  && bun test packages/api/src/services/turn-monitor \
  && bunx drizzle-kit migrate && bunx drizzle-kit migrate   # idempotency
```

**depends-on:** none

---

### Group 3: Skills audit + lint
**Goal:** Bring every bundled skill back in sync with the current CLI surface.

**Deliverables:**
1. `scripts/skills-lint.ts` (new) — parses every `plugins/genie/skills/*/SKILL.md` (and any nested prompt files), extracts code fences tagged ```bash` or ```sh`, grep-matches `genie <subcommand>` / `omni <subcommand>` invocations, validates each against `genie --help` / `omni --help` output. Emits a JSON report `{skill, missingCommands[]}` and exits non-zero if any entry is non-empty. Supports a `<!-- skills-lint:ignore -->` bailout marker for legitimately complex examples.
2. `scripts/skills-audit.ts` (new) — computes edit-distance per skill file between the pre-wish and post-wish state; fails if any skill has >30% of lines changed, enforcing the "mechanical reference fix only" scope fence.
3. `bun run skills:lint` and `bun run skills:audit` scripts in `package.json`.
4. Fixes for every skill file that references removed/renamed commands. Track edits in a single commit per skill for review clarity.
5. Remove any skill example that references `genie omni bridge start|stop|status` OR `genie omni status` (replaced by `genie doctor` narrative).
6. Update skills that reference v3 task flow to the v4 `genie task` lifecycle already present in the skill template.

**Acceptance Criteria:**
- [ ] `bun run skills:lint` exits 0 and its JSON report shows zero missing commands across all skills.
- [ ] `bun run skills:audit` exits 0 (no skill changed by >30% of its lines); files needing larger changes are moved to a follow-up wish rather than smuggled in.
- [ ] No skill file references a non-existent command (enforced by the linter, not human review).
- [ ] Skills that mention the bridge describe it as "managed by `genie serve`, status via `genie doctor`", not as a standalone command.

**Validation:**
```bash
cd repos/genie && bun run skills:lint && bun run skills:audit && bun run check
```

**depends-on:** none

---

### Group 4: Delete legacy commands + fold bridge health into doctor
**Goal:** Remove the dead command surface and make `genie doctor` the sole bridge health report.

**Deliverables:**
1. `src/term-commands/omni.ts` — delete the `bridge` subcommand AND the `status` subcommand in the omni namespace.
2. `src/genie-commands/serve.ts` (or wherever `genie doctor` lives) — bridge section calls `bridge-status.ts`; replaces the old `getBridge()` call with the IPC-backed helper. Output includes pid, uptime, subjects, and last ping latency.
3. `src/services/omni-bridge.ts` — remove the exported `getBridge()` and `bridgeInstance` singleton. All consumers go through `bridge-status.ts`.
4. Commander usage tests updated; stale `genie omni status` tests deleted.
5. CHANGELOG entry: `BREAKING: removed 'genie omni bridge' and 'genie omni status' subcommands. Bridge is managed exclusively by 'genie serve'; health is reported via 'genie doctor'.`

**Acceptance Criteria:**
- [ ] `genie omni bridge` and `genie omni status` both exit with commander's unknown-command error.
- [ ] `genie doctor` returns accurate bridge state against a live `genie serve` bridge, including running / stopped / stale transitions.
- [ ] `grep -rE "getBridge|bridgeInstance" repos/genie/src repos/genie/**/*.test.ts` returns zero results after the commit (covers both src and tests; any old singleton-based mocks are refactored to use the IPC helper or deleted).
- [ ] `grep -r "GENIE_EXECUTOR_TYPE" src/` returns zero results (workaround no longer needed).

**Validation:**
```bash
cd repos/genie && bun run check && bun test
```

**depends-on:** Group 1, Group 3

---

### Group 5: Cross-repo review + ship
**Goal:** Prove the whole thing works end-to-end before landing.

**Test fixture:** a dedicated throwaway instance named `felipe-whatsapp-test` connected via the existing `felipe-whatsapp` session, OR a mock channel plugin `mock-channel` registered only for tests. The E2E test MUST specify which is used and clean up any artifacts (messages, turns, events) at the end.

**Deliverables:**
1. Reviewer runs each group's validation command and captures output.
2. End-to-end check #1 — fallback disabled: start `genie serve`, set `agentFallbackEnabled=false` on the test instance, send one message, stall the agent for 610s, assert **zero** outbound messages were sent to the channel in that window (queried via `omni events --type message.sent --since 11m` or the mock's captured send log).
3. End-to-end check #2 — fallback custom message: set `agentFallbackMessage="__test_marker__"`, stall for 610s, assert exactly **one** outbound message with body `__test_marker__`.
4. End-to-end check #3 — doctor transitions: `genie doctor` reports bridge running, then SIGTERM serve, then `genie doctor` reports stopped within 2s.
5. Review output (commands + outputs + pass/fail per check) stored in `## Review Results`.

**Acceptance Criteria:**
- [ ] All Wave 1 + Group 4 validations pass.
- [ ] E2E check #1 passes (zero fallback messages sent when disabled).
- [ ] E2E check #2 passes (exact custom message sent when enabled).
- [ ] E2E check #3 passes (doctor transitions in ≤2s).
- [ ] No regressions in `bun test` across both repos.
- [ ] Test fixture cleaned up (no stale turns, no leftover messages in the test instance).

**Validation:**
```bash
cd repos/genie && bun run check && bun test
cd repos/omni && bun run check && bun test
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## QA Criteria

- [ ] Starting `genie serve` on a clean host brings the bridge up automatically with no env-var tweaking.
- [ ] `genie doctor` accurately reflects bridge state from a separate shell and no longer reports `omni-bridge: stopped` when it's actually running.
- [ ] `omni instances update --agent-fallback-enabled false` prevents "⏱ Still processing..." from being sent to WhatsApp, verified by watching a stalled turn for 15 minutes.
- [ ] `omni instances update --agent-fallback-message "custom"` sends exactly "custom" instead.
- [ ] All skills render and execute examples correctly when invoked via `/brainstorm`, `/wish`, `/review`, `/work`, `/fix`.
- [ ] No pre-existing test broken; total test count is unchanged or higher.

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| NATS ping subject collides with existing omni subjects | Low | Use `omni.bridge.ping` — not under `omni.message.>`; verified via `grep` on subject literals in omni repo before implementing. |
| Pidfile becomes stale after a crash and confuses status | Medium | Status checks `kill -0 pid` before trusting the file; stale → report "stale", not "running". |
| Removing `genie omni bridge` commands breaks automation scripts in user environments | Medium | Breaking change is explicitly in scope per user directive; CHANGELOG entry + release notes mitigate surprise. |
| Turn-monitor migration touches a hot table and causes downtime | Low | Drizzle adds columns with defaults — no rewrite, no lock beyond metadata. |
| Skills lint script's CLI grep is fragile against multi-line commands | Medium | Start with strict "first token on a bash line" matching; add bailout escape hatch `<!-- skills-lint:ignore -->` for known-complex examples. |
| Skills audit scope creep into rewrites | High | Reviewer rejects any skill diff that isn't a reference fix; `bun run skills:audit` enforces a <30% line-churn limit per file; conceptual changes get their own follow-up wish. |
| Turn-monitor caches instance config and ignores live CLI updates | Medium | Group 2 deliverable #8 mandates no-cache (or ≤5s TTL) reads on each tick; live-update integration test in Group 2 acceptance criteria. |
| `getBridge()`/`bridgeInstance` references linger in test mocks | Medium | Group 4 grep covers both `src/` and `*.test.ts`; CI fails on any match. |
| Pidfile race between two `genie serve` starts | Medium | O_EXCL mandated in Group 1; concurrent-start unit test enforces single winner. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
repos/genie/src/services/omni-bridge.ts              (modify — pidfile write, ping handler, remove singleton export)
repos/genie/src/lib/bridge-status.ts                 (create — IPC status helper)
repos/genie/src/lib/bridge-status.test.ts            (create — unit tests)
repos/genie/src/genie-commands/serve.ts              (modify — mandatory bridge, use bridge-status for doctor)
repos/genie/src/term-commands/omni.ts                (modify — delete bridge subcommand, rewrite status)
repos/genie/scripts/skills-lint.ts                   (create — skills command linter)
repos/genie/package.json                             (modify — add skills:lint script)
repos/genie/plugins/genie/skills/**/SKILL.md         (modify — stale reference fixes)
repos/genie/CHANGELOG.md                             (modify — breaking change entry)

repos/omni/packages/db/src/schema.ts                 (modify — instance fallback fields)
repos/omni/packages/db/drizzle/NNNN_*.sql            (create — migration)
repos/omni/packages/api/src/services/turn-monitor.ts (modify — per-instance fallback)
repos/omni/packages/api/src/services/turn-monitor.test.ts (modify — new coverage)
repos/omni/packages/api/src/routes/v2/instances.ts   (modify — expose new fields)
repos/omni/packages/cli/src/commands/instances/update.ts (modify — new flags)
```
