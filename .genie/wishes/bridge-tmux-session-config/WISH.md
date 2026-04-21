# Wish: Configurable Bridge Tmux Session

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `bridge-tmux-session-config` |
| **Date** | 2026-04-21 |
| **Design** | _No brainstorm — direct wish_ |

## Summary
Make the Omni bridge's target tmux session configurable. Today `src/services/executors/claude-code.ts:178` hardcodes `tmuxSession = agentName`, which forces hierarchical agents (e.g. `felipe/scout`) into a sanitized standalone session (`felipe-scout`) invisible to the user's attached TUI and blocks enterprise fan-out where one Omni agent serves many inbound numbers that each need isolation. This wish replaces the hardcode with a three-layer resolution chain — env var > agent.yaml default > current behavior — so per-instance overrides from Omni (PR 2) and static per-agent defaults from yaml both light up.

## Scope
### IN
- Add `bridgeTmuxSession?: string` to `AgentConfigSchema` in `src/lib/agent-yaml.ts` with `.strict()` preserved.
- Surface the new field through `DirectoryEntry` (`src/lib/agent-directory.ts`) so `genie dir sync` and `genie agent directory --json` show it.
- Replace `const tmuxSession = agentName` in `src/services/executors/claude-code.ts` (~line 178) with the resolution chain:
  ```ts
  const rawSession = env.GENIE_TMUX_SESSION ?? entry.bridgeTmuxSession ?? agentName;
  const tmuxSession = rawSession.replace(/\//g, '-');
  ```
- Document `GENIE_TMUX_SESSION` as the NATS-env key reserved for the Omni provider (PR 2 will populate it).
- Unit tests for all three resolution paths plus sanitization (`felipe/scout` → `felipe-scout`).
- Full gate passes: `bun run check`.

### OUT
- Omni's plumbing (`instances.bridge_tmux_session` column, CLI flag, `nats-genie-provider.ts` env propagation) — separate wish in `automagik-dev/omni`.
- `ClaudeSdkOmniExecutor` (`src/services/executors/claude-sdk.ts`) — no tmux involvement, not affected.
- TUI aggregation across multiple tmux sessions — architecture change, not required.
- Per-chat session naming heuristics — `sanitizeWindowName` remains as-is.

## Decisions
| Decision | Rationale |
|----------|-----------|
| Three-layer resolution (env > yaml > agentName) | Env wins because Omni knows which instance the message arrived on (runtime data); yaml is the agent's static default; legacy behavior is the floor. |
| Sanitize `/` → `-` at resolution time, not at storage | Keeps yaml human-readable (`felipe/scout`, `felipe`) while guaranteeing tmux compatibility. |
| New field name `bridgeTmuxSession` | Matches existing camelCase fields on `AgentConfigSchema`; “bridge” prefix disambiguates from future TUI-session concepts. |
| `GENIE_TMUX_SESSION` env key | Prefix `GENIE_` reserves namespace for bridge-to-executor wiring; short, stable, grep-friendly. |
| Field optional, defaults preserved | Backward compat: every agent lacking the field retains current behavior. |

## Success Criteria
- [ ] `bridgeTmuxSession` roundtrips through `parseAgentYaml` / `writeAgentYaml` without loss.
- [ ] `genie dir sync` propagates the field into the directory; `genie agent directory <name> --json` surfaces it.
- [ ] `ClaudeCodeOmniExecutor.spawn` uses the resolution chain; `GENIE_TMUX_SESSION` in env overrides; yaml falls back second; `agentName` is last resort.
- [ ] Resolved value is sanitized (`/` → `-`) before passing to `ensureTeamWindow`.
- [ ] Tests cover all three branches plus sanitization; `bun test` green with no new flakes.
- [ ] `bun run check` (typecheck + lint + dead-code + full suite) exits 0.
- [ ] Backward compatibility verified: agent without the field and without env var still lands in `agentName`-based session.
- [ ] PR body cross-references the omni wish, states backward compat explicitly, and notes that per-instance UX only lights up after the omni side ships.

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Schema + directory plumbing (`agent-yaml.ts`, `agent-directory.ts`) + roundtrip tests |
| 2 | engineer | Executor resolver (`claude-code.ts`) + unit tests for the three-branch resolver and sanitization |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | qa | Integration check: run `genie dir sync` with a yaml that sets `bridgeTmuxSession`, verify `genie agent directory --json` output; run full `bun run check` gate. |
| review | reviewer | Review Groups 1+2+3 against success criteria; SHIP / FIX-FIRST verdict. |

## Execution Groups

### Group 1: Schema & Directory Plumbing
**Goal:** Add `bridgeTmuxSession` to the agent.yaml schema and surface it through `DirectoryEntry` + sync.
**Deliverables:**
1. `src/lib/agent-yaml.ts` — add `bridgeTmuxSession: z.string().optional()` inside `AgentConfigSchema`. Keep `.strict()` at the object level.
2. `src/lib/agent-directory.ts` — extend `DirectoryEntry` type with `bridgeTmuxSession?: string`; ensure the sync path copies the value through.
3. `src/lib/agent-yaml.test.ts` — add roundtrip test: write yaml with the field, parse back, assert equality.
4. `src/lib/agent-directory.test.ts` (or existing closest test) — verify sync picks up the field from yaml into the directory entry.

**Acceptance Criteria:**
- [ ] Schema rejects unknown keys (strict mode preserved) while accepting `bridgeTmuxSession`.
- [ ] Roundtrip test green.
- [ ] `genie dir sync` run in a test fixture propagates the field into the directory JSON.
- [ ] No unrelated schema churn.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
bun test src/lib/agent-yaml.test.ts
bun test src/lib/agent-directory.test.ts 2>/dev/null || bun test src/lib/agent-sync.test.ts
```

**depends-on:** none

---

### Group 2: Executor Resolver
**Goal:** Replace the hardcoded `tmuxSession = agentName` with the three-layer resolution chain plus sanitization.
**Deliverables:**
1. `src/services/executors/claude-code.ts` — edit the `spawn` function around line 178 to use the chain:
   ```ts
   const rawSession = env.GENIE_TMUX_SESSION ?? entry.bridgeTmuxSession ?? agentName;
   const tmuxSession = rawSession.replace(/\//g, '-');
   ```
2. Tests — either in `src/services/executors/claude-code.test.ts` (if exists) or new file — covering:
   - env var wins over yaml and agentName
   - yaml wins over agentName when env absent
   - agentName wins when neither present
   - resolved value has `/` replaced with `-`
3. Keep `sanitizeWindowName` unchanged (handled separately by window-level logic).

**Acceptance Criteria:**
- [ ] All three resolver branches tested.
- [ ] Sanitization tested with a slashy input.
- [ ] No change to `ensureTeamWindow` or `sanitizeWindowName` call signatures.
- [ ] No regressions in existing bridge tests.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
bun test src/services/executors/
```

**depends-on:** Group 1 (Group 2 needs `DirectoryEntry.bridgeTmuxSession` to exist in the type)

---

### Group 3: Integration + Gate
**Goal:** Prove the feature works end-to-end against the live bridge code path and pass the full check gate.
**Deliverables:**
1. Manual verification steps documented in PR body:
   - Set `bridgeTmuxSession: felipe` in a throwaway test agent's yaml, run `genie dir sync`, confirm via `genie agent directory <name> --json` the field is present.
   - Trace code path to confirm `env.GENIE_TMUX_SESSION` is read before yaml.
2. Run `bun run check` — full gate must pass.
3. No skipped hooks on push.

**Acceptance Criteria:**
- [ ] `bun run check` exits 0.
- [ ] No `--no-verify` on commits or push.
- [ ] PR body contains explicit backward-compat statement.
- [ ] PR body cross-references the omni wish (`automagik-dev/omni` slug `per-instance-bridge-tmux-session`).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
bun run check
```

**depends-on:** Group 2

---

## Dependencies
| Direction | Target | Notes |
|-----------|--------|-------|
| **blocks** | `automagik-dev/omni:per-instance-bridge-tmux-session` | Omni plumbing reads `env.GENIE_TMUX_SESSION` defined here. Ship genie first. |

## QA Criteria

_Verified on dev after merge. Does not block PR merge, but before dog-fooding with real messages._

- [ ] Regression: existing agents (e.g., `felipe`, `felipe-alpha`) still spawn into tmux sessions named after themselves — no behavior change.
- [ ] Static default: an agent with `bridgeTmuxSession: felipe` in yaml spawns into tmux session `felipe`, not its own name. Verify by calling the executor path (test or dry-run).
- [ ] Env override: when `GENIE_TMUX_SESSION` is present in the spawn env, it wins over yaml. Verify via unit test.
- [ ] Sanitization: a value containing `/` is normalized to `-` before tmux invocation. Verify via unit test.
- [ ] Directory sync shows the field in `genie agent directory --json` output.

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Adding optional field to `AgentConfigSchema.strict()` surfaces as unknown-key error for callers on older schema snapshots | Low | `.strict()` rejects UNKNOWN keys, not new declared ones. Optional field is safe. Roundtrip test guards. |
| `genie dir sync` path does not currently pass through arbitrary optional fields | Low | Group 1 inspects `agent-sync.ts` and adds explicit pass-through if needed. |
| Tests for `claude-code.ts` may be sparse; resolver coverage might require new test file | Low | Group 2 creates the file if missing; no impact on shipping. |
| Env var name `GENIE_TMUX_SESSION` collides with user's shell env | Very Low | `GENIE_` prefix is project-owned namespace; no conflict observed. |

---

## Review Results

### Plan Review — 2026-04-21 (SHIP)
All 7 Plan Review checklist items pass. Zero gaps. Ready for `/work`.

- Problem statement: testable via resolution chain
- Scope IN: 6 concrete deliverables
- Scope OUT: 4 explicit exclusions
- Acceptance criteria: checkboxed per group
- Execution groups: Group 1 (schema + directory), Group 2 (executor resolver), Group 3 (gate) — each ≤1hr, independently shippable
- Dependencies: G2→G1, G3→G2, cross-wish `blocks: automagik-dev/omni:per-instance-bridge-tmux-session`
- Validation: `bun test ...` per group + `bun run check` overall

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/agent-yaml.ts                           (MODIFY — add field)
src/lib/agent-directory.ts                      (MODIFY — extend DirectoryEntry)
src/lib/agent-yaml.test.ts                      (MODIFY — add roundtrip test)
src/lib/agent-directory.test.ts                 (MODIFY or CREATE — sync passthrough test)
src/services/executors/claude-code.ts           (MODIFY — resolver chain, ~line 178)
src/services/executors/claude-code.test.ts      (MODIFY or CREATE — resolver unit tests)
```
