# Wish: Genie Command Telemetry Boundary

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-command-telemetry-boundary` |
| **Date** | 2026-05-01 |
| **Author** | felipe + Codex |
| **Appetite** | large |
| **Branch** | `wish/genie-command-telemetry-boundary` |
| **Repos touched** | `genie` |
| **Design** | Direct wish from live DB investigation |

## Summary

Make Genie faster and easier to operate by wrapping CLI commands with consistent telemetry and separating "agent world" from "harness world". Agents need to know what happened, what is slow, what failed, and whether the problem belongs to an agent session or to Genie infrastructure itself. This wish creates the command instrumentation and taxonomy that turns Genie into an inspectable harness instead of a pile of unrelated event streams.

**depends-on:** agent-observability-snapshot, genie-serve-structured-observability, hookify-perf-foundation

**blocks:** none

## Scope

### IN

- Command wrapper telemetry for every public `genie` CLI command.
- Standard fields: command, args shape, actor, cwd, duration, exit code, failure class, world, subsystem, trace id, and DB/query counts where available.
- Taxonomy separating `world = agent` from `world = harness`.
- Slow/failing command summaries in `genie doctor --perf`, `genie status`, and events queries.
- Regression tests preventing new commands from bypassing the wrapper.
- Documentation for when work is "improving agents" vs "improving Genie itself".

### OUT

- Rewriting every command implementation.
- External APM integration.
- Full security/RBAC event substrate.
- UI dashboard redesign.
- Hook daemon implementation already owned by `hookify-perf-foundation`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Command telemetry is a wrapper concern | Every command gets baseline observability without hand-instrumenting each handler. |
| 2 | Agent world and harness world are first-class fields | The operator question is usually "is the agent stuck, or is Genie broken?" |
| 3 | Args are shape-summarized, not raw captured | Prevents leaking secrets or long prompts while keeping command behavior diagnosable. |
| 4 | Slow/fail reporting is CLI-first | Agents and humans both operate from terminal surfaces today. |

## Success Criteria

- [ ] Every public `genie` command emits a bounded command telemetry record.
- [ ] New commands fail CI if they bypass the wrapper.
- [ ] `genie status --perf` or equivalent shows slowest and failing command families.
- [ ] `genie doctor --perf` distinguishes harness failures from agent/session failures.
- [ ] `genie observe agents` can exclude harness rows by default and include them explicitly.
- [ ] Command telemetry has no raw secret-shaped arguments.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Define taxonomy and command telemetry envelope |
| 2 | engineer | Wrap public CLI command execution |
| 3 | engineer | Add slow/failure query surfaces |
| 4 | qa | Validate coverage and performance overhead |

## Execution Groups

### Group 1: Taxonomy and Envelope

**Goal:** Define the minimum durable vocabulary for command and world classification.

**Deliverables:**
1. `world` enum: `agent`, `harness`, `bridge`, `system`.
2. `subsystem` enum aligned with existing command namespaces.
3. Command telemetry schema with redacted argument shape.
4. Mapping table for existing commands to world/subsystem.
5. Documentation at `docs/observability/agent-vs-harness.md`.

**Acceptance Criteria:**
- [ ] Every public command maps to a world and subsystem.
- [ ] Ambiguous commands document their classification rule.
- [ ] Redaction tests cover flags, env-shaped strings, and paths.

**Validation:**
```bash
bun test src/lib/command-telemetry.test.ts
test -s docs/observability/agent-vs-harness.md
```

**depends-on:** none

---

### Group 2: CLI Wrapper Instrumentation

**Goal:** Emit command telemetry consistently without changing command behavior.

**Deliverables:**
1. Central wrapper around Commander command action execution.
2. Duration, exit status, thrown error class, cwd, actor, and trace context.
3. DB query count and elapsed DB time where pgserve client exposes it.
4. CI lint that detects public commands without telemetry registration.
5. Low-overhead benchmark.

**Acceptance Criteria:**
- [ ] All current public commands are covered.
- [ ] Command telemetry overhead is below 5 ms p99 for no-op commands.
- [ ] Failed commands emit failure class without raw stack traces by default.

**Validation:**
```bash
bun test src/term-commands src/lib/command-telemetry.test.ts
bun run check
```

**depends-on:** Group 1

---

### Group 3: Slow and Failing Command Surfaces

**Goal:** Make command telemetry useful to humans and agents.

**Deliverables:**
1. `genie events commands --slow --since <dur>`.
2. `genie events commands --failures --since <dur>`.
3. `genie doctor --perf` section for command latency, hook latency, and DB query latency.
4. `genie status --perf` concise summary.
5. Query fixtures using the richer remote data scale.

**Acceptance Criteria:**
- [ ] Slowest command families are visible without raw SQL.
- [ ] Failure summaries include world/subsystem.
- [ ] Agent-caused failures and harness-caused failures are separated.

**Validation:**
```bash
genie --no-tui events commands --slow --since 24h
genie --no-tui events commands --failures --since 24h
genie --no-tui doctor --perf
```

**depends-on:** Group 2

---

### Group 4: Coverage and Overhead QA

**Goal:** Prove the wrapper is complete, cheap, and safe.

**Deliverables:**
1. Coverage report listing all commands and telemetry status.
2. Overhead benchmark report.
3. Secret probe report for redacted args.
4. Remote `ssh felipe` smoke run.

**Acceptance Criteria:**
- [ ] Coverage is 100 percent for public commands.
- [ ] No secret probe appears in stored telemetry.
- [ ] Remote smoke run produces readable slow/failure output.

**Validation:**
```bash
bun run scripts/check-command-telemetry-coverage.ts
ssh felipe 'export PATH=/home/genie/.bun/bin:/home/genie/.local/share/fnm/node-versions/v24.14.1/installation/bin:$PATH; cd /home/genie/workspace/repos/genie && genie --no-tui doctor --perf'
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] A human can answer "agent stuck or Genie slow?" from CLI output.
- [ ] An agent can consume JSON telemetry without shelling into Postgres directly.
- [ ] New command additions require explicit telemetry classification.
- [ ] Command telemetry does not leak raw prompts, tokens, or secrets.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Command wrapper changes can subtly alter exit behavior | High | Snapshot tests for exit codes and thrown errors before/after wrapping. |
| DB timing may not be available everywhere | Medium | Make DB timing optional and record `unknown` instead of failing. |
| Taxonomy may need iteration | Low | Keep enum small and document ambiguous cases. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```text
src/cli.ts
src/term-commands/events.ts
src/term-commands/doctor.ts
src/term-commands/status.ts
src/lib/command-telemetry.ts
src/lib/events/registry.ts
docs/observability/agent-vs-harness.md
scripts/check-command-telemetry-coverage.ts
```
