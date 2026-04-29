# Wish: Single canonical genie↔omni wiring — one wizard, deprecate the 5+ command route

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `canonical-genie-omni-wiring` |
| **Date** | 2026-04-29 |
| **Author** | genie-configure |
| **Appetite** | medium |
| **Branch** | `wish/canonical-genie-omni-wiring` |
| **Repos touched** | `automagik-dev/genie`, `automagik-dev/omni`, `namastexlabs/genie-configure` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Today, wiring a genie agent to an omni channel takes 5+ manual commands (or 2 if operators know `omni connect`), is symlink-spoofable, and a stale next-step hint points to a non-existent `genie omni start` command. This wish ships a single canonical `/genie:omni` wizard skill that drives both `genie agent register` and `omni connect` end-to-end, fixes three correctness defects (symlink validation, `dir edit` chicken-and-egg, stale hint), prints deprecation nudges on the legacy multi-command path, and ingests the cross-repo wiring map into genie-configure's brain so future agents don't repeat today's investigation. Per-host fingerprint trust (Bearer→ed25519) is explicitly deferred to a follow-up wish.

## Scope

### IN

- New `/genie:omni` skill in `automagik/genie` plugin: single conversational wizard from "no agent" to "agent answering on a chat", calling existing `genie agent register` + `omni connect` + `genie doctor` underneath.
- D1 fix in genie: `agent-directory.ts` `add()` and `edit()` reject AGENTS.md that is a symlink (`lstatSync().isFile()`); accept only with explicit `--allow-symlink` flag.
- D2 fix in genie: `genie agent register --skip-omni` prints a clear stderr WARNING that the omni side will be unwired and the exact command to wire it later.
- D4 fix in genie: `genie dir edit --dir <new>` validates the NEW path's AGENTS.md, not the old path's agent.yaml. Removes the chicken-and-egg that blocks operators from fixing a wrong `--dir`.
- D3 fix in omni: `omni connect`'s final next-step output stops referencing `genie omni start` (does not exist); points to `genie serve status` and the headless start command.
- Deprecation nudges in omni: `omni providers create --schema nats-genie`, `omni agents create`, `omni instances update --agent ...`, and `omni routes create` for nats-genie routes emit a stderr hint pointing operators to `omni connect <inst> <name>` (or `/genie:omni` from a Claude session). Legacy commands keep working unchanged.
- Brain ingestion in genie-configure: three new files under `./brain/` capturing the canonical wiring map, the operator runbook, and the architectural decision record.

### OUT

- Per-host ed25519 fingerprint trust between genie and omni (defect D5) — needs its own wish with a security review.
- Replacing the shared `omni_sk_…` Bearer model with scoped per-host tokens — same wish as D5.
- Migrating simone's brain (`/home/genie/workspace/agents/simone/brain/`) — different agent, scope creep. We document the pattern in genie-configure's brain so any agent (including simone) can ingest it.
- Auto-discovering and auto-binding multiple omni instances in one wizard run — wizard handles one instance per invocation; multi-instance is a follow-up.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Build `/genie:omni` as a skill (markdown), not a new genie subcommand | Skills compose existing CLI surface (`genie agent register`, `omni connect`); a new subcommand would duplicate logic that already lives in `omni connect`. The "Next Step" hint in `omni connect` will be updated to point at `/genie:omni` for first-time operators. |
| 2 | Reject symlinked AGENTS.md by default; allow with explicit `--allow-symlink` | Yesterday's misregistration (`--dir /home/genie/workspace`) silently passed because `existsSync` follows symlinks. `lstatSync().isFile()` closes the loophole while keeping power-user escape via the flag. |
| 3 | Keep all legacy `omni providers/agents/instances/routes` commands working | Deprecation by stderr nudge, not by removal. Power-users and CI scripts continue to work; new operators get steered to the canonical command. |
| 4 | `genie dir edit --dir <new>` validates the NEW dir, not old | The whole point of changing `--dir` is the old one is wrong. Reading `agent.yaml` at the old path before applying the update is broken-by-design. |
| 5 | Defer fingerprint/ed25519 trust (D5) | Larger surface (new endpoint, key storage, revocation flow, optional enforcement mode) needs its own wish + security review. This wish stays focused on UX + correctness. |
| 6 | Brain artifacts go in `genie-configure/brain/`, not the genie source repo | Brain content is operator/host-specific configuration knowledge, not framework code. Each host's brain captures its own canonical chain. |

## Success Criteria

- [ ] Running `genie agent register foo --dir <dir-with-symlinked-AGENTS.md>` FAILS with a clear error; same command with `--allow-symlink` succeeds.
- [ ] Running `genie dir edit foo --dir /new/path` succeeds when `/new/path/AGENTS.md` exists, regardless of the old dir's state.
- [ ] Running `genie agent register foo --dir <path> --skip-omni` prints a stderr WARNING with the exact `omni connect` command to wire later.
- [ ] Running `omni connect <inst> <name>` prints "If genie serve isn't running, start it with `genie serve start --headless`" — the literal string `genie omni start` no longer appears anywhere in `connect.ts`.
- [ ] `/genie:omni` skill exists at `plugins/genie/skills/omni/SKILL.md` and walks an operator from "no agent yet" to "agent answering a chat", invoking `omni auth status`, `genie agent register`, `omni instances list`, `omni connect`, and `genie doctor`.
- [ ] Running `omni providers create --schema nats-genie ...` prints a stderr nudge pointing to `omni connect` / `/genie:omni`; the command still creates the provider.
- [ ] genie-configure's `./brain/` contains the three new files: `Configuration & Routing/genie-omni-wiring.md`, `Runbooks/wire-new-omni-agent.md`, `_decisions/2026-04-29-canonical-wiring.md`.
- [ ] All existing tests in `automagik-dev/genie` and `automagik-dev/omni` continue to pass; new tests cover the symlink rejection, the `--skip-omni` warning emission, and the `dir edit` new-path validation.

## Execution Strategy

### Wave 1 (parallel — three independent groups)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Genie-side defect fixes: D1 (symlink validation in `add`+`edit`), D2 (`--skip-omni` warning), D4 (`dir edit` validates new path). One PR against `automagik-dev/genie`. |
| 2 | engineer | Omni-side stale-hint fix: D3 — drop `genie omni start` from `connect.ts`, point to `genie serve`. One trivial PR against `automagik-dev/omni`. |
| 3 | docs | Brain ingestion in genie-configure: three new markdown files under `./brain/`. No code, no upstream PR — local commit only. |

### Wave 2 (depends on Wave 1 Group 1 landing)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | New `/genie:omni` skill markdown in `automagik/genie` plugin under `plugins/genie/skills/omni/SKILL.md`. Skill text only — orchestrates existing CLI commands via Bash. PR against `automagik-dev/genie`. Depends on Group 1 so the skill can rely on the symlink-safe register path being live. |

### Wave 3 (depends on Wave 2 Group 4)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Omni deprecation nudges: stderr hints when operators run `omni providers create --schema nats-genie`, `omni agents create`, `omni instances update --agent ...`, or `omni routes create` for a nats-genie route. Hint text references `omni connect <inst> <name>` and `/genie:omni`. PR against `automagik-dev/omni`. |

## Execution Groups

### Group 1: Genie-side defect fixes (D1, D2, D4)

**Goal:** Close three defects in `automagik-dev/genie`'s agent-directory + register code so future operators (and the new wizard skill) can't repeat yesterday's misregistration.

**Deliverables:**
1. Patch `src/lib/agent-directory.ts` `add()` (line ~170) and `edit()` (line ~510): replace `existsSync(agentsPath)` with a check that uses `lstatSync(agentsPath).isFile()` (rejects symlinks). Accept symlinks only when an explicit `allowSymlink` option is passed. Surface the option via a new `--allow-symlink` CLI flag on `genie agent register` and `genie dir edit`.
2. Patch `src/term-commands/agent/register.ts`: when `--skip-omni` is passed, write a clear stderr WARNING block after registration completes — naming the agent, listing the omni-side state that is now stale, and giving the exact `omni connect <instance> <name>` command to run later.
3. Patch `src/lib/agent-directory.ts` `edit()`: stop reading `agent.yaml` from the OLD `entry.dir` when only `--dir` is being updated. Read `AGENTS.md` from the NEW dir and apply the update if validation passes. Existing behavior for other field edits unchanged.
4. Add colocated tests: symlink rejection in `agent-directory.test.ts`, `--skip-omni` warning emission in `register.test.ts`, `dir edit --dir` new-path-only validation in `agent-directory.test.ts`.

**Acceptance Criteria:**
- [ ] Symlinked-AGENTS.md `--dir` path is rejected with a clear error message; same path with `--allow-symlink` is accepted.
- [ ] `--skip-omni` registration emits the exact stderr warning block described in deliverable 2.
- [ ] `genie dir edit foo --dir /new/path` succeeds when only the NEW path has a real `AGENTS.md`.
- [ ] All new + existing tests in `automagik-dev/genie` pass; biome+typecheck clean.

**Validation:**
```bash
cd <genie-clone>
bun run typecheck && bunx biome check src/lib/agent-directory.ts src/term-commands/agent/register.ts && \
  bun test src/lib/agent-directory.test.ts src/term-commands/agent/register.test.ts
```

**depends-on:** none

---

### Group 2: Omni stale-hint fix (D3)

**Goal:** Remove the stale `genie omni start` next-step instruction from `omni connect`'s output and replace it with the correct `genie serve` guidance.

**Deliverables:**
1. Patch `src/commands/connect.ts` in `automagik-dev/omni`: replace the final `info("Start the genie bridge: genie omni start")` (and any related stale text) with `info("If genie serve isn't running, start it with: genie serve start --headless")` plus a `keyValue("Verify", "genie serve status")` line.
2. Update any test fixture or snapshot that asserts the old text.

**Acceptance Criteria:**
- [ ] Running `omni connect <inst> <name>` no longer prints the literal `genie omni start`.
- [ ] Output includes the new `genie serve start --headless` guidance.
- [ ] All omni tests pass.

**Validation:**
```bash
cd <omni-clone>
bun run typecheck && bun test src/commands/connect.test.ts && \
  ! (bun run build && grep -r "genie omni start" dist/)
```

**depends-on:** none

---

### Group 3: Brain ingestion in genie-configure

**Goal:** Persist the canonical genie↔omni wiring knowledge into `genie-configure/brain/` so the next agent inheriting this host (or any sibling agent) doesn't repeat the investigation.

**Deliverables:**
1. `./brain/Configuration & Routing/genie-omni-wiring.md` — full ASCII flowchart of inbound message → claude reply, the canonical 2-command chain (`genie agent register` + `omni connect`), each subsystem's role, and the NATS subjects.
2. `./brain/Runbooks/wire-new-omni-agent.md` — operator runbook: pre-reqs, the `/genie:omni` happy path, the manual fallback (two commands), the verification commands, and recovery actions when the wire breaks.
3. `./brain/_decisions/2026-04-29-canonical-wiring.md` — architectural decision record: why we picked `omni connect` + `/genie:omni` skill over a parallel `genie agent bind` command, why we deferred fingerprint trust, what defects the canonical command closes.

**Acceptance Criteria:**
- [ ] All three files exist at the listed paths.
- [ ] Each file references the canonical commands (no stale `genie omni start`).
- [ ] Decision record links the deferred D5 (fingerprint trust) work as a follow-up wish.

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure
test -f "./brain/Configuration & Routing/genie-omni-wiring.md" && \
  test -f "./brain/Runbooks/wire-new-omni-agent.md" && \
  test -f "./brain/_decisions/2026-04-29-canonical-wiring.md" && \
  ! grep -l "genie omni start" "./brain/" -r
```

**depends-on:** none

---

### Group 4: `/genie:omni` skill — single canonical wizard

**Goal:** Ship the skill markdown that wraps the full wire as one conversational flow, so operators never need to remember the two-command chain.

**Deliverables:**
1. New file `plugins/genie/skills/omni/SKILL.md` in `automagik-dev/genie`. Skill includes:
   - frontmatter with `name`, `description`, `allowed-tools` (Bash for `omni *`, `genie *`).
   - Flow: check `omni auth status` → if not authenticated, run `omni install` first; else continue. Pick or scaffold genie agent dir (validate AGENTS.md is real). Run `genie agent register <name> --dir <path>`. List omni instances, pick one. Run `omni connect <instance-id> <name>`. Verify with `genie serve status` + `omni doctor` + a synthetic message round-trip. Print the final topology + a test command.
2. Add the skill to the genie plugin's manifest (skills list) so `/genie:omni` is discoverable.
3. README/docs entry pointing operators to `/genie:omni` as the canonical entry point.

**Acceptance Criteria:**
- [ ] `/genie:omni` listed in genie plugin's available skills.
- [ ] Running `/genie:omni` end-to-end on a clean host produces a wired agent answering one chat without manual omni or genie subcommands.
- [ ] Skill markdown calls only existing CLI commands — no new genie subcommand introduced.

**Validation:**
```bash
cd <genie-clone>
test -f plugins/genie/skills/omni/SKILL.md && \
  grep -q "omni connect" plugins/genie/skills/omni/SKILL.md && \
  grep -q "genie agent register" plugins/genie/skills/omni/SKILL.md
```

**depends-on:** Group 1

---

### Group 5: Omni deprecation nudges on legacy chain

**Goal:** Steer operators away from the multi-command legacy chain toward `omni connect` / `/genie:omni`, without breaking the legacy path.

**Deliverables:**
1. Patch `src/commands/providers.ts` in `automagik-dev/omni`: when `--schema nats-genie` is passed to `providers create`, emit a stderr nudge after creation: `💡 For genie-backed agents, prefer 'omni connect <instance> <agent>' (or '/genie:omni' from a Claude session). This command stays for power users.`
2. Patch `src/commands/agents.ts`: same nudge when `agents create` is used with a provider whose schema is `nats-genie`.
3. Patch `src/commands/instances.ts`: same nudge when `instances update --agent ...` is used and the resolved agent is bound to a `nats-genie` provider.
4. Patch `src/commands/routes.ts`: same nudge when a route is created for a `nats-genie` agent.
5. Add tests asserting the nudge string appears on stderr (not stdout) for each path.

**Acceptance Criteria:**
- [ ] Running each of the four legacy commands prints the deprecation nudge to stderr.
- [ ] Nudge does NOT block; the underlying create/update still succeeds.
- [ ] Tests verify stderr emission for all four paths.

**Validation:**
```bash
cd <omni-clone>
bun run typecheck && bun test src/commands/providers.test.ts src/commands/agents.test.ts \
  src/commands/instances.test.ts src/commands/routes.test.ts
```

**depends-on:** Group 4

---

## Dependencies

| Wave / Group | Depends on | Notes |
|---|---|---|
| Wave 1 / Group 1 | none | Genie-side fixes — independent. |
| Wave 1 / Group 2 | none | Omni stale-hint fix — independent. |
| Wave 1 / Group 3 | none | Brain ingestion — local-only docs. |
| Wave 2 / Group 4 | 1 | Skill relies on the symlink-safe register path being live. |
| Wave 3 / Group 5 | 4 | Deprecation nudge text references `/genie:omni`, which must exist first. |

This wish has no cross-wish dependencies. The deferred D5 fingerprint-trust work (`blocks: none`, `blocked-by: this`) is its own wish to be filed separately once this lands.

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional**: a fresh operator running `/genie:omni` on a clean host (no agent registered, no provider, no route) ends with a working WhatsApp/Telegram bridge answering one chat — no manual omni-side commands.
- [ ] **Functional**: `genie agent register` rejects symlinked AGENTS.md by default; `--allow-symlink` accepts.
- [ ] **Functional**: `genie dir edit foo --dir /new/path` succeeds when only the new path has AGENTS.md.
- [ ] **Integration**: end-to-end — register agent → connect to omni instance → send WhatsApp message → claude responds, all triggered from within `/genie:omni`.
- [ ] **Integration**: legacy multi-command path (`omni providers create` + `omni agents create` + `omni instances update --agent` + `omni routes create`) still produces a working bridge AND emits deprecation nudges on stderr at each step.
- [ ] **Regression**: existing genie test suite (incl. agent-directory + register tests) passes; existing omni test suite (incl. connect tests) passes; no new biome/typecheck regressions in either repo.
- [ ] **Regression**: `genie agent register --skip-omni` still creates the genie-side dir entry as before (just with the new stderr warning).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `automagik-dev/omni` source repo is not cloned on this host — Groups B and E require cloning it before patching. | Low | Engineer clones the repo as the first step of Group 2/E. The bundle on disk is read-only reference. |
| The `/genie:omni` skill calls `omni install` if auth is missing, which is itself an interactive wizard — nested interactivity may confuse the Claude TUI. | Medium | Skill detects `omni auth status` first and tells the operator to run `omni install` in a separate terminal, then come back. Don't nest two interactive flows. |
| Deprecation nudges in Group 5 may break CI scripts that grep stdout for specific lines. | Low | All nudges go to stderr (not stdout); existing stdout output is unchanged. |
| Symlink rejection (Group 1) may break existing setups that intentionally symlink AGENTS.md across agent dirs. | Medium | The `--allow-symlink` escape hatch covers the legitimate use case. Migration note in the PR description: existing operators relying on symlinks must add the flag. |
| D5 (fingerprint trust) being deferred leaves the bearer-token model in place — single key compromise = full omni access. | Low (for this wish) | Documented in the decision record; tracked as a follow-up wish. Not blocking for this wish's correctness/UX deliverables. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
automagik-dev/genie  (Groups 1 + 4)
  src/lib/agent-directory.ts                                     [modify — D1, D4]
  src/lib/agent-directory.test.ts                                [modify — new tests for D1, D4]
  src/term-commands/agent/register.ts                            [modify — D2 warning, --allow-symlink flag]
  src/term-commands/agent/register.test.ts                       [modify — test for D2 warning]
  plugins/genie/skills/omni/SKILL.md                             [create — Group 4]
  plugins/genie/manifest.json (or skills index)                  [modify — register new skill]

automagik-dev/omni  (Groups 2 + 5)
  src/commands/connect.ts                                        [modify — drop "genie omni start"]
  src/commands/connect.test.ts                                   [modify — assert new hint text]
  src/commands/providers.ts                                      [modify — Group 5 nudge]
  src/commands/providers.test.ts                                 [modify — assert stderr nudge]
  src/commands/agents.ts                                         [modify — Group 5 nudge]
  src/commands/agents.test.ts                                    [modify — assert stderr nudge]
  src/commands/instances.ts                                      [modify — Group 5 nudge]
  src/commands/instances.test.ts                                 [modify — assert stderr nudge]
  src/commands/routes.ts                                         [modify — Group 5 nudge]
  src/commands/routes.test.ts                                    [modify — assert stderr nudge]

namastexlabs/genie-configure (genie-configure brain — local commit)
  brain/Configuration & Routing/genie-omni-wiring.md             [create — Group 3]
  brain/Runbooks/wire-new-omni-agent.md                          [create — Group 3]
  brain/_decisions/2026-04-29-canonical-wiring.md                [create — Group 3]
```
