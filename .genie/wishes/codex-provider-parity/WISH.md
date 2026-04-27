# Wish: Codex Provider Parity

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `codex-provider-parity` |
| **Date** | 2026-04-27 |
| **Design** | _No brainstorm — direct wish (seeded from `/tmp/genie-recover/codex-parity-findings-2026-04-27.md` and live `/trace`)_ |
| **Target Release** | `4.260427.7` (micropr) |

## Summary

Make codex a first-class provider across genie's orchestration surfaces. Today, codex spawns work and produce real output (sec-install-guard-codex shipped a complete wish 2026-04-27 17:09–17:12), but the observability/control layers that make claude workers orchestratable are claude-only stubs for codex: state detection always returns `'working'`, `genie log` returns 0 events, `genie sessions` is blind to `~/.codex/history.jsonl`, the native inbox bridge can't resolve codex members, readiness probes time out at 30s, and `genie doctor` doesn't verify codex PATH. This wish closes those gaps in a single micropr targeted at `4.260427.7`.

The spawned codex genie (`genie-8b0e@genie`) discovered most of these empirically while orchestrating. Their findings + today's `/trace` give us file:line evidence for every gap.

## Scope

### IN
- Codex provider state detection wired to the same pane-capture flow claude uses, with a shared `detectCodexState` extracted from the OTel relay script (single source of truth).
- Native inbox bridge: codex spawn calls `nativeTeams.registerNativeMember` so `genie send` resolves codex recipients without falling back to PG-only.
- `runtime_events` emission for codex: bridge OTel relay receivers OR `~/.codex/log/codex-tui.log` tail into the same audit/event substrate claude uses.
- `genie sessions` ingest of `~/.codex/history.jsonl` into the `sessions` PG table.
- Codex readiness probe uses provider-specific signal (OTel first-event OR history row count) instead of pane patterns.
- `genie doctor` adds a non-interactive PATH check for `codex` (and verifies `bun`/`node`/`npm` resolve in the spawn-script shell, not just interactive tmux shells).
- `genie update` install-detection follows symlinks before pattern-matching (kills the `'source'` mis-classification on `~/.local/bin/genie` symlinks).
- `genie spawn --fork <session-id>` first-class flag for codex (replaces the `--extra-args` workaround).
- Auto-`genie brief` injection on codex spawn so workers receive inbox/team/wish context the same way claude does via system-prompt + hooks.

### OUT
- No claude-side regressions or behavior changes — claude paths are reference, not target.
- No new schema columns. Existing `sessions`, `executors`, `runtime_events`, `audit_events`, `agents` tables are sufficient.
- No reimagining of the OTel pipeline — wire the existing relay into existing tables, don't redesign.
- No codex resume/fork beyond the `--fork` flag passthrough (codex's session-fork mechanic is upstream-owned).
- No TUI redesign for codex pane rendering.
- No `genie hook dispatch` rewrite — codex doesn't have a CC-style hook system; the bridge runs server-side via OTel/log tail.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Extract `detectCodexState` into `src/lib/orchestrator/codex-state.ts` | Today the codex state patterns live inline in the OTel relay script (`agents.ts:164-183`). Two callers (relay + provider) need the same detection — one source of truth prevents drift. |
| Bridge OTel relay → `runtime_events`, not `~/.codex/log/codex-tui.log` tail | OTel is structured (OTLP HTTP/JSON), already running, already wired to PG via `otel-receiver.ts`. Log tail is fragile + unstructured. Add an executor-state-update path inside `otel-receiver.ts`. |
| Use `~/.codex/history.jsonl` for sessions ingest, not OTel | History.jsonl is the canonical user-facing record; OTel is operational telemetry. Sessions search must surface what the user sees in codex, not what the runtime logged. |
| `genie sessions` ingest is best-effort + lazy | Don't block CLI on jsonl parse. Best-effort import on `genie sessions list/search` invocation; if codex jsonl parse fails, skip with debug log. |
| Native inbox bridge becomes provider-agnostic | Move `nativeTeams.registerNativeMember` call out of the claude-only spawn path and into the shared flow. Codex needs the same registration. |
| Doctor PATH check runs in non-interactive subshell | The bug Felipe hit (`ENOENT: posix_spawn 'git'` on update) is a non-interactive-PATH bug. Doctor must spawn `sh -c 'which git codex bun node npm'` to catch it. |
| `--fork` flag accepts a UUID; provider passes through | Generic on the genie-spawn side; codex provider translates `--fork <uuid>` to its native `codex --fork <uuid>` invocation. Other providers (claude) ignore. |

## Success Criteria

- [ ] `genie ls --json | jq '.[] | select(.name=="<codex-agent>") | .status'` returns `idle` / `working` / `permission` based on actual codex state, not always `working`.
- [ ] `genie log <codex-agent> --last 10 --json` returns ≥1 row for an actively-working codex agent (was 0 before).
- [ ] `genie sessions search <query> --json` returns codex-originated sessions matching the query.
- [ ] `genie send --to <codex-agent>` does NOT emit `Native inbox bridge: could not find native team member for "<name>"` warning.
- [ ] `genie spawn ... --provider codex` exits with `Agent ready` within ≤10s for a typical-CPU host (vs the 30s timeout-with-warning seen today).
- [ ] `genie doctor` reports a PATH-OK row for `codex` (and warns if non-interactive shell can't resolve `git`/`bun`/`node`/`npm`).
- [ ] `genie update --next` correctly classifies a `bun add -g`-installed binary as `'bun'`, not `'source'`.
- [ ] `genie spawn --provider codex --fork <session-id>` works and forks the named codex session (no `--extra-args` needed).
- [ ] Fresh codex spawns receive a `genie brief` injection on startup (visible in their first prompt).

## Execution Strategy

### Wave 1 — P0 (blocks codex orchestration on `genie ls`/`status`/`log`)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Extract `detectCodexState` + wire to provider |
| 2 | engineer | Bridge OTel relay → executor state + runtime_events |
| 3 | engineer | Native inbox bridge for codex (registerNativeMember) |
| review | reviewer | Review Groups 1+2+3 |

### Wave 2 — P1 (UX gaps blocking smooth orchestration)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | `genie sessions` ingests `~/.codex/history.jsonl` |
| 5 | engineer | Codex readiness probe (OTel first-event signal) |
| 6 | engineer | `genie doctor` non-interactive PATH check |
| 7 | engineer | `genie update` symlink-resolve install-detection |
| review | reviewer | Review Groups 4+5+6+7 |

### Wave 3 — P2 (orchestration ergonomics + dispatch-flow)
| Group | Agent | Description |
|-------|-------|-------------|
| 8 | engineer | `genie spawn --fork <session-id>` flag |
| 9 | engineer | Auto-brief injection on codex spawn |
| 10 | engineer | `genie work` provider-aware dispatch + reuse-agent |
| 11 | engineer | Codex spawn `--prompt` flag honored |
| 12 | engineer | `genie wish set-group-state` direct verb |
| qa | qa | End-to-end smoke: spawn codex, dispatch via `genie work --reuse-agent`, verify all surfaces |

---

## Execution Groups

### Group 1: Codex state detection + shared detector

**Goal:** `CodexProvider.detectState` returns real state (idle/working/permission/terminated), not the hardcoded `'working'`.

**Deliverables:**
1. Create `src/lib/orchestrator/codex-state.ts` with `detectCodexState(content: string): CodexStateResult`. Lift the patterns from `src/term-commands/agents.ts:164-183` (relay's inline detector) verbatim. Add unit tests for each pattern (idle prompt `›`, spinner glyphs, `Press enter to confirm`, `esc to interrupt`).
2. Rewrite `src/lib/providers/codex.ts:55-58 detectState`:
   ```typescript
   async detectState(executor: Executor): Promise<ExecutorState> {
     if (executor.state === 'terminated' || executor.endedAt) return 'terminated';
     const paneId = executor.tmuxPaneId;
     if (!paneId) return 'working';
     const { capturePaneContent } = await import('../tmux.js');
     const content = await capturePaneContent(paneId, 50).catch(() => null);
     if (!content) return 'working';
     const { detectCodexState } = await import('../orchestrator/codex-state.ts');
     return mapToExecutorState(detectCodexState(content));
   }
   ```
3. Refactor `agents.ts:164-183` to import + call `detectCodexState` (single source of truth).

**Acceptance Criteria:**
- [ ] Unit: 4+ test cases per state (idle/working/permission), all pass.
- [ ] Unit: `CodexProvider.detectState` returns each state correctly when fed a stubbed `capturePaneContent`.
- [ ] Integration: spawn a codex agent, observe state transitions in `genie ls --json` over time.

**Validation:**
```bash
bun test src/lib/orchestrator/codex-state.test.ts
bun test src/lib/providers/codex.test.ts
```

**depends-on:** none

---

### Group 2: OTel relay → executor state + runtime_events bridge

**Goal:** Codex worker activity surfaces in `genie log`, `genie events`, and updates `executor.state` automatically — no more 0-event blackout.

**Deliverables:**
1. Extend `src/lib/otel-receiver.ts` to recognize codex-originated OTLP events. Map operationally: codex emits `op.dispatch.user_input_*` and tool spans (visible in `~/.codex/log/codex-tui.log` example: `submission_dispatch{otel.name="op.dispatch.user_input_with_*"}`).
2. On each recognized event, emit a `runtime_events` row with the codex agent_id + executor_id (`agent_id` resolved by `executor_id → agents.id` join).
3. On state-implying events (e.g. `op.dispatch.*` start = working, completion = idle), call `executorRegistry.updateExecutorState` to keep PG truth aligned.
4. Add `src/lib/otel-receiver.test.ts` cases for codex payloads.

**Acceptance Criteria:**
- [ ] `genie log <codex-agent> --last 10 --json` returns ≥1 row within 5s of codex tool use.
- [ ] `genie events list --since 1m | grep <codex-agent>` shows entries.
- [ ] PG: `SELECT state FROM executors WHERE id = '<codex-exec-id>'` reflects current state, not stale 'running'.
- [ ] No regression: claude executors continue receiving events via their existing `genie hook dispatch` path.

**Validation:**
```bash
bun test src/lib/otel-receiver.test.ts
# Manual: spawn codex, verify genie log/events surface activity
```

**depends-on:** Group 1 (state types)

---

### Group 3: Native inbox bridge for codex

**Goal:** `genie send --to <codex-agent>` resolves natively without the `could not find native team member` warning + PG-only fallback.

**Deliverables:**
1. In `src/lib/protocol-router-spawn.ts`, ensure `registerNativeTeamMember` is called for codex spawns (today it's gated by claude-specific code paths).
2. Verify `nativeTeams.registerNativeMember` accepts `agentType: 'codex'` (or generic) without rejection.
3. Test: `genie send --to <codex-agent> 'hello'` should succeed without printing the bridge warning.

**Acceptance Criteria:**
- [ ] No `[genie send] Native inbox bridge: could not find native team member` warning when sending to a fresh codex spawn.
- [ ] Codex agent appears in `~/.claude/teams/<team>/inboxes/<agent>.json` after spawn.
- [ ] PG mailbox path still works as fallback if native bridge fails.

**Validation:**
```bash
bun test src/lib/protocol-router-spawn.test.ts
bun test src/lib/claude-native-teams.test.ts  # ensure no regression
# Manual: spawn codex, send message, observe no warning
```

**depends-on:** none

---

### Group 4: `genie sessions` ingests `~/.codex/history.jsonl`

**Goal:** `genie sessions list` and `genie sessions search` return codex-originated sessions, not just claude.

**Deliverables:**
1. New `src/lib/codex-sessions-ingest.ts` — lazy parser for `~/.codex/history.jsonl`. Each line is one session; map fields to the `sessions` table schema (id, role='codex', project_path, file_size, file_mtime, ...).
2. Hook the ingest into `term-commands/sessions.ts`:
   - On `sessions list` / `sessions search`, run `ingestCodexSessions()` once (cached in-process), then query the unified `sessions` table.
3. Best-effort: parse failures log debug + skip the row, don't error the command.

**Acceptance Criteria:**
- [ ] `genie sessions search <query>` returns codex sessions when content matches.
- [ ] `genie sessions list --limit 20` includes codex sessions interleaved with claude.
- [ ] No degradation in latency for claude-only users (ingest is incremental — only re-reads modified file).

**Validation:**
```bash
bun test src/lib/codex-sessions-ingest.test.ts
# Manual: search for known codex content, verify hit
```

**depends-on:** none

---

### Group 5: Codex readiness probe (OTel first-event)

**Goal:** Spawn output shows `Agent ready (Xs)` for codex within ~5–10s instead of `Agent readiness timeout (30s)`.

**Deliverables:**
1. Provider-method `getReadinessSignal(executor: Executor)`: claude returns pane-pattern signal (existing); codex returns "OTel first-event seen for executor_id" signal.
2. Modify `src/lib/spawn-command.ts:waitForAgentReady` (or a sibling fn) to dispatch on provider — call the appropriate readiness probe.
3. Codex's OTel-based probe: poll `runtime_events` (or `audit_events`) for `executor_id = <id>` rows; first row = ready. (Depends on Group 2 wiring OTel → events.)

**Acceptance Criteria:**
- [ ] `genie spawn ... --provider codex` reports `Agent ready (≤10s)` on a typical-CPU host.
- [ ] Claude readiness unchanged (still ~2–5s pane-pattern based).

**Validation:**
```bash
bun test src/lib/spawn-command.test.ts
# Manual: time multiple codex spawns
```

**depends-on:** Group 2 (OTel → events bridge)

---

### Group 6: `genie doctor` non-interactive PATH check

**Goal:** `genie doctor` warns when `codex`, `git`, `bun`, `node`, `npm` aren't resolvable in a non-interactive subshell (the actual environment spawn-scripts run in).

**Deliverables:**
1. In `src/genie-commands/doctor.ts`, add a check that runs `sh -c 'command -v <bin>'` for each required binary. Distinguishes "interactive only" from "always available".
2. Add `codex` to the required-binary list (alongside the existing `bun`, `claude` checks).
3. Suggest fix: PATH export in `~/.profile` or `~/.bashrc.d/`.

**Acceptance Criteria:**
- [ ] `genie doctor` shows codex with version + ok/missing/path-only-interactive status.
- [ ] If `codex` is in `~/.bashrc` PATH but missing from `~/.profile`, doctor flags as warning.

**Validation:**
```bash
bun test src/genie-commands/doctor.test.ts
# Manual: temporarily remove codex from non-interactive PATH, observe warning
```

**depends-on:** none

---

### Group 7: `genie update` install-detection symlink resolve

**Goal:** `genie update --next` correctly identifies `bun add -g`-installed binaries as `'bun'`, not `'source'`. Eliminates today's `ENOENT: posix_spawn 'git'` failure mode.

**Deliverables:**
1. Modify `src/genie-commands/update.ts:138-142 detectFromBinaryPath`:
   ```typescript
   function detectFromBinaryPath(path: string): InstallationType | null {
     let resolved = path;
     try { resolved = require('node:fs').realpathSync(path); } catch { /* keep original */ }
     if (resolved.includes('node_modules')) return 'npm'; // or 'bun' below
     if (resolved.includes('/.bun/install/global/')) return 'bun';
     if (path === join(LOCAL_BIN, 'genie') && !resolved.includes('node_modules')) return 'source';
     if (resolved.startsWith(GENIE_BIN)) return 'source';
     return null;
   }
   ```
2. Test: simulate `which genie` returning the LOCAL_BIN symlink, with realpath pointing into `~/.bun/install/global/...`. Assert returns `'bun'`.

**Acceptance Criteria:**
- [ ] `genie update --next` on a `bun add -g @automagik/genie@next` install reports `Channel: next, Detected installation: bun`, then runs `bun add -g --force --no-cache @automagik/genie@next` and succeeds.
- [ ] Source installs (where `~/.genie/src/.git` exists) still detect as `'source'`.

**Validation:**
```bash
bun test src/genie-commands/update.test.ts
# Manual: bun-installed user runs `genie update --next`, succeeds without git ENOENT
```

**depends-on:** none

---

### Group 8: `genie spawn --fork <session-id>` first-class flag

**Goal:** Codex session-fork is a top-level CLI option, not hidden behind `--extra-args`.

**Deliverables:**
1. Add `--fork <session-id>` to `genie spawn` option parser (`src/term-commands/agents.ts spawnCommand`).
2. CodexProvider's `buildSpawnCommand` translates `ctx.forkSessionId` to `codex --fork <id>` invocation.
3. Other providers ignore the flag with a debug log.
4. Document in CLI help: "Provider-specific: codex resumes the named session."

**Acceptance Criteria:**
- [ ] `genie spawn --provider codex --fork <uuid> --team <name>` produces a spawn-script with `codex --fork <uuid>` (verify in `~/.genie/spawn-scripts/...`).
- [ ] `--fork` on claude spawns logs a debug warning + ignores.

**Validation:**
```bash
bun test src/term-commands/agents.test.ts
# Manual: spawn codex with known session-id, verify continuation
```

**depends-on:** none

---

### Group 9: Auto-`genie brief` injection on codex spawn

**Goal:** Codex workers receive inbox/team/wish context on startup, the way claude does via system-prompt + hooks.

**Deliverables:**
1. In `src/lib/protocol-router-spawn.ts`, after codex spawn registers, run `genie brief --team <team> --agent <agent> --json` and inject its content as the codex worker's first user-message (via `genie send` or pre-loading the inbox file).
2. Configurable via env: `GENIE_CODEX_AUTO_BRIEF=0` opts out.

**Acceptance Criteria:**
- [ ] Fresh codex spawn shows the brief content visible in `genie history <agent> --last 5 --json` first turn.
- [ ] Opt-out env disables the injection.

**Validation:**
```bash
bun test src/lib/protocol-router-spawn.test.ts
# Manual: spawn codex, verify first prompt contains team/wish summary
```

**depends-on:** Group 3 (native inbox bridge — for the `genie send` path to land natively)

---

### Group 10: `genie work` provider-aware dispatch + existing-agent reuse

**Goal:** `genie work` can dispatch to an existing codex worker (or spawn a new codex worker), instead of always cold-spawning claude. Eliminates the "must spawn cold claude over loaded codex" problem genie-8b0e@genie hit at 17:18 (forced workaround: marked tasks via `genie task block` instead of using `genie work` because the latter would spawn a redundant claude alongside the active codex worker).

**Reproducer:**
- Active codex agent `sec-install-guard-codex` already loaded with security context.
- `genie work security-install-download-guard --group 1` would spawn a fresh claude worker, ignoring the live codex.
- Operator forced manual workaround (PG message + task state mutation) instead of using the canonical work-dispatch flow.

**Deliverables:**
1. Add `--provider <claude|codex>` flag to `genie work` to override spawn provider.
2. Add `--reuse-agent <agent-name>` flag to dispatch into an existing live worker rather than cold-spawning. Validate the target agent is alive (`isPaneAlive` + executor.state in {idle, working}) before dispatching.
3. `genie work` auto-detects: if the wish team has an active worker matching the group's role, reuse it (with a confirmation prompt unless `--no-interactive`).
4. Tests: dispatch into existing codex; dispatch with explicit `--provider codex`; dispatch with no live worker falls back to fresh spawn.

**Acceptance Criteria:**
- [ ] `genie work <slug> --group N --provider codex` spawns a codex worker for the group.
- [ ] `genie work <slug> --group N --reuse-agent <name>` dispatches the group prompt into the named live worker via `genie send`.
- [ ] Auto-detection: with one live codex worker matching the group's role, `genie work` confirms reuse before cold-spawning.

**Validation:**
```bash
bun test src/term-commands/work.test.ts
# Manual: spawn codex, then `genie work <slug> --group 1 --reuse-agent <codex-name>`, observe dispatch into the live pane
```

**depends-on:** Group 3 (native inbox bridge for the dispatch send to land natively)

---

### Group 11: Codex spawn `--prompt` flag honored

**Goal:** `genie spawn ... --provider codex --prompt '<text>'` injects the prompt as the codex worker's first user-message, mirroring claude's `--prompt` behavior.

**Reproducer:**
- Today, codex spawn ignores `--prompt` (the auto-generated `Genie worker. Team: <name>. Role: <role>.` is hardcoded into the buildCodexCommand at `src/lib/provider-adapters.ts`).
- Operators must either edit `--extra-args` manually OR send a follow-up message via `genie send` after spawn (which today fails the native bridge — Group 3).

**Deliverables:**
1. `buildCodexCommand` in `src/lib/provider-adapters.ts` reads `params.initialPrompt` (or equivalent) and uses it as the codex CLI's positional prompt arg, falling back to the auto-generated string when absent.
2. `genie spawn` already accepts `--prompt`; ensure the flag value is plumbed through `SpawnContext.initialPrompt → SpawnParams.initialPrompt → buildCodexCommand`.
3. Tests: spawn-script generation contains the user-supplied prompt verbatim.

**Acceptance Criteria:**
- [ ] `genie spawn <name> --provider codex --prompt 'do X' --team <t>` produces a spawn-script ending in `codex --yolo --no-alt-screen 'do X'` (not the auto-string).
- [ ] No regression on claude `--prompt` handling.

**Validation:**
```bash
bun test src/lib/provider-adapters.test.ts
# Manual: spawn codex with --prompt, inspect ~/.genie/spawn-scripts/<file>.sh for the prompt text
```

**depends-on:** none

---

### Group 12: `genie wish status` provider-agnostic group state

**Goal:** Mark a wish-group `in_progress` / `done` / `blocked` from the orchestrator side without forcing a claude worker spawn. Today the wish-state mutation flow is tied to claude's `genie work` dispatch path, so codex orchestrators must touch `wishState` indirectly via `genie task` (which orchestrates correctly but doesn't update the wish-side group state).

**Reproducer:**
- genie-8b0e@genie noted at 17:18: _"Wish state still shows Group 1 as ready because native genie work is Claude-only right now; I avoided using it so we do not spawn a cold Claude worker over the loaded Codex worker."_
- The operator wanted to mark Group 1 `in_progress` for `security-install-download-guard` but `genie wish` doesn't expose a direct group-state mutation verb; `genie work` does it as a side effect of spawning a worker.

**Deliverables:**
1. Add `genie wish set-group-state <slug> <group-num> <state>` (or `genie wish update-group <slug> <group-num> --state <s> --assignee <name>`) — a direct CLI verb for mutating wish-group state without spawning.
2. The verb writes to the wish state machinery the same way `genie work` does (via `wishState.setGroupState` or equivalent).
3. Document in `genie wish --help` and the wish skill so this is the canonical "marking work in progress" path.

**Acceptance Criteria:**
- [ ] `genie wish set-group-state codex-provider-parity 1 in_progress --assignee <agent>` mutates the wish-state without spawning anything.
- [ ] Subsequent `genie wish status codex-provider-parity` shows Group 1 as `in_progress` with the named assignee.

**Validation:**
```bash
bun test src/term-commands/wish.test.ts
# Manual: mutate state, observe in `genie wish status`
```

**depends-on:** none

---

## QA Criteria

_To run after merge to dev (smoke test on npm `@next` build)._

- [ ] **Smoke spawn**: `genie spawn genie --provider codex --team test-codex` spawns within ≤10s, no readiness-timeout warning.
- [ ] **State surface**: `genie ls --json | jq '.[] | select(.team=="test-codex")'` shows status transitions over a 30s observation window (idle → working → idle).
- [ ] **Log surface**: `genie log <agent> --last 10 --json` returns rows during active codex work.
- [ ] **Send native**: `genie send --to <codex-agent> 'hello'` exits clean, no `Native inbox bridge` warning.
- [ ] **Sessions search**: `genie sessions search <known-codex-keyword>` returns ≥1 result.
- [ ] **Doctor**: `genie doctor` includes a `codex` row with status + PATH-resolution diagnostic.
- [ ] **Update**: `bun add -g @automagik/genie@next && genie update --next` exits 0 (no `ENOENT git` for bun-installed users).
- [ ] **Fork flag**: `genie spawn ... --provider codex --fork <id>` produces a working continuation.
- [ ] **Auto-brief**: First codex `genie history` row contains team/wish context.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| OTel receiver may not have an executor_id on every codex event | Medium | Fall back to looking up agent by tmux_pane_id from the resource attributes; degrade gracefully (log debug, skip event). |
| Codex `~/.codex/history.jsonl` schema changes upstream | Low | Schema-defensive parser: required fields + skip-on-error. Document the codex CLI version we tested against. |
| Native inbox bridge for non-claude providers may collide with existing claude-specific assumptions in `claude-native-teams.ts` | Medium | Add a `provider` field to the native member registration; default to 'claude' for backward compat. |
| Auto-brief on every spawn could spam codex with redundant context | Low | Opt-out env (`GENIE_CODEX_AUTO_BRIEF=0`). Brief is only ~50 lines, well within codex context budget. |
| Sessions ingest of large `history.jsonl` (10k+ entries) may slow `genie sessions` first-call | Low | Incremental ingest based on file_mtime + last_offset checkpointing. |
| `genie update` symlink resolve could fail on broken symlinks | Low | Already wrapped in try/catch; falls back to original path. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
NEW:
  src/lib/orchestrator/codex-state.ts           # Group 1
  src/lib/orchestrator/codex-state.test.ts      # Group 1
  src/lib/codex-sessions-ingest.ts              # Group 4
  src/lib/codex-sessions-ingest.test.ts         # Group 4

MODIFY:
  src/lib/providers/codex.ts                    # Group 1 (detectState rewrite)
  src/term-commands/agents.ts                   # Group 1 (relay refactor) + Group 8 (--fork flag)
  src/lib/otel-receiver.ts                      # Group 2 (codex event recognition)
  src/lib/otel-receiver.test.ts                 # Group 2
  src/lib/protocol-router-spawn.ts              # Group 3 (registerNativeTeamMember) + Group 9 (auto-brief)
  src/lib/protocol-router-spawn.test.ts         # Group 3 + Group 9
  src/term-commands/sessions.ts                 # Group 4 (ingest hook)
  src/lib/spawn-command.ts                      # Group 5 (provider-aware readiness)
  src/lib/spawn-command.test.ts                 # Group 5
  src/genie-commands/doctor.ts                  # Group 6 (codex + non-interactive PATH check)
  src/genie-commands/doctor.test.ts             # Group 6
  src/genie-commands/update.ts                  # Group 7 (realpath in detectFromBinaryPath)
  src/genie-commands/update.test.ts             # Group 7
  src/lib/provider-adapters.ts                  # Group 8 (forkSessionId) + Group 11 (initialPrompt)
  src/term-commands/work.ts                     # Group 10 (--provider, --reuse-agent flags)
  src/term-commands/work.test.ts                # Group 10
  src/term-commands/wish.ts                     # Group 12 (set-group-state verb)
  src/term-commands/wish.test.ts                # Group 12
```

---

## Provenance

- **Findings memo**: `/tmp/genie-recover/codex-parity-findings-2026-04-27.md` (captured from genie-8b0e@genie OTel-relay snapshots).
- **Trace evidence**: `/trace` performed inline 2026-04-27 17:13 by genie@felipe; file:line citations in each Group's Deliverables.
- **Sub-codex success proof**: `sec-install-guard-codex` (codex provider) shipped `.genie/wishes/security-install-download-guard/WISH.md` lint-clean — codex orchestration WORKS, the observability layer was the gap.
- **Sibling micropr context**: `4.260427.6` shipped Group 22 (master-aware-spawn shadow dedup, PR #1416). This wish targets `4.260427.7` as the next focused micropr, scoped tightly to codex parity.
