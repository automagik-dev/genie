# Wish: PR 2545 Ultra release gate remediation

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `pr-2545-ultra-release-gate` |
| **Date** | 2026-07-10 |
| **Author** | Codex PM, from the seven-lane specialist-panel review requested by Felipe |
| **Appetite** | medium — bounded release hardening, not a redesign |
| **Branch** | `fix/pr2545-ultra-gate` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | Seven Ultra specialist lanes plus native Codex review of PR #2545 at `42c11eeb`; follow-up rebased onto `dev` `5101fd35` |
| **Promotion state** | PR #2545 merged via `6f682e2b` from promoted source `10ceb2c0`; this wish now ships as a follow-up targeting `dev` |

## Summary

Make the Codex integration introduced by PR #2545 safe to install, update, review, and trust. The original PR has since merged; this branch is a bounded follow-up on current `dev`, not a retroactive claim that the reviewed PR passed its blocked gates. Implementation has replaced the nine-command hook set, physicalized the skill payload, and hardened ownership/lifecycle paths, while aggregate validation, exact-final-SHA GitHub CI, human approval, and stable-release authorization remain open.

The review ledger is [`REVIEW-DISPOSITION.md`](./REVIEW-DISPOSITION.md), the exact nine-command audit is [`HOOK-AUDIT.md`](./HOOK-AUDIT.md), and the read-only user-asset baseline is [`USER-ASSET-BASELINE.md`](./USER-ASSET-BASELINE.md). Every implementation claim must close against those artifacts rather than a prose-only “remaining issues” bucket.

## Scope

### IN

- Replace the nine Codex hook commands with a minimal deterministic set that performs no install, dependency resolution, global synchronization, home-dotfile mutation, or workspace scaffolding on lifecycle events.
- Ship a real plugin-contained Codex skill payload and make updates preserve unmanaged or user-modified shared skills and role agents.
- Fix review-confirmed PR regressions in version ordering, install/update rollback and convergence, Codex/Omni execution, setup/doctor lifecycle ownership, and integration-removal reporting.
- Make the required local gates green, add focused failure-path tests, and make the docs accurately describe hook trust and the shipped Codex surfaces.
- Preserve and verify the user's installed 36 adapted skills and 14 custom-agent profiles without executing update or uninstall against the live home.

### OUT

- Merging PR #2545 to `main`, publishing a release, trusting hooks for the user, or changing production repository settings.
- Unchanged historical release-pipeline debt such as repository-wide action SHA pinning and arbitrary-ref release dispatch; these remain separate stable-release blockers that must be remediated before stable release.
- Adding the user's personal specialist-panel/persona skills to the Genie product payload; those 36 skills are already installed in the user's shared Codex tier.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Codex SessionStart is diagnostic-only | Official Codex hooks run outside the model sandbox; installation and configuration belong behind explicit commands. |
| 2 | Keep only bounded SessionStart context, deterministic PreToolUse guards, and registry-routed PermissionRequest | The other six commands are mutating, repeated prompt injection, post-side-effect validation, or protocol-inert. |
| 3 | Omni approval runs once, on PermissionRequest only | Codex does not support PreToolUse `ask`; its current 15-second host timeout cannot contain the 110-second poll. |
| 4 | Plugin components stay physically inside the plugin root | Source marketplace installs must match packaged installs and may not depend on an escaping symlink. |
| 5 | Unmanaged or modified personal artifacts are skipped/kept, never adopted and overwritten | A tool must not take ownership of same-name user data merely because it ships a similarly named skill or agent. |
| 6 | Engineers edit disjoint scopes; reviewers are independent; the PM alone integrates and marks tasks done | This follows the repository's task-ownership and reviewer-separation contract. |
| 7 | Top-level `skills/` is the canonical runtime-neutral source; `plugins/genie/skills/` is a committed, deterministic mirror | Claude/Hermes agent-sync keep their established source while Codex receives an in-root plugin payload. A generator and parity test make duplication observable and fail closed on drift. |
| 8 | PR-scope SHIP is not stable-release authorization | Inherited CRITICAL/HIGH publication risks live in the separate [`stable-release-security-gate`](../stable-release-security-gate/WISH.md) wish and continue to block stable promotion until remediated; human approval is an additional post-remediation gate, never a waiver. |
| 9 | The prior `agent-sync-hardening` wish is superseded only criterion-by-criterion | `REVIEW-DISPOSITION.md` maps old criteria to new evidence. Group E may update status/index text only after each mapped criterion has passing evidence. |

## Success Criteria

- [ ] The Codex hook manifest contains only the three approved behaviors; no retained hook installs software, mutates user/workspace configuration, or repeatedly injects free-form repository text.
- [ ] Canonical Codex hook fixtures prove valid JSON output, `apply_patch` decoding, matcher scoping, one-shot Omni evaluation, fail-closed timeout/denial, and portable command launching.
- [ ] A source marketplace install and an extracted release plugin both contain every declared Codex skill inside the plugin root, with valid Codex skill metadata.
- [ ] `genie update` and uninstall leave the 36 installed adapted user skills and modified role TOMLs byte-identical; Genie-owned clean artifacts still update/remove normally.
- [ ] Final-versus-prerelease ordering, identical/stale auxiliary trees, every PR-added auxiliary-tree swap stage, future-dated locks, lost Codex resume threads, blank JSONL output, and option-like prompts have regression coverage.
- [ ] `bun run check`, `bun test`, targeted lifecycle/hook/package tests, and `git merge-tree --write-tree origin/dev HEAD` pass on the final follow-up head.
- [ ] The final review returns SHIP for the implemented scope; hooks remain untrusted until the installed cache is refreshed and the user reviews each retained hash in a new task.
- [ ] `REVIEW-DISPOSITION.md` has final evidence for every panel/native finding, and no inherited stable-release blocker is mislabeled as closed by this PR.
- [ ] `USER-ASSET-BASELINE.md` is unchanged after isolated fixture tests and a final read-only live comparison.

## Execution Strategy

### Wave 1 (parallel, exclusive files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A | `genie_engineer_complex` | 7 — hook protocol, approval routing, timeout and trust boundary | inherit active Ultra model | Minimal safe hooks and exact Codex wire protocol |
| B | `genie_engineer_complex` | 6 — plugin packaging plus 23 skill manifests | inherit active Ultra model | Self-contained Codex skill payload and source/package parity |
| C | `genie_engineer_complex` | 7 — ownership state, migration, uninstall data preservation | inherit active Ultra model | Personal-skill and role-agent collision/ownership safety |

### Wave 2 (after A–C)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| D1 | `genie_engineer_complex` | 7 — transactional install/update state | inherit active Ultra model | Version ordering, content integrity, swaps, and update convergence |
| D2 | `genie_engineer_complex` | 6 — project/runtime lifecycle coordination | inherit active Ultra model | Setup, doctor, init, launch, and MCP ownership |
| D3 | `genie_engineer_complex` | 5 — provider stream/session correctness | inherit active Ultra model | Codex/Omni argument, JSONL, and resume recovery |

### Wave 3 (after D1–D3)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| E | `genie_engineer_standard` | 5 — docs, release notes, generated formatting and final gates | inherit active Ultra model | Align contracts, dispositions, and release evidence |

## Execution Groups

### Group A: Minimal safe Codex hooks

**Goal:** Reduce and repair the Codex hooks so trusting them authorizes only bounded, documented behavior.

**Deliverables:**
1. Remove Codex smart-install, first-run scaffolding, both wish validators, repeated UserPromptSubmit context, and inert Stop validation.
2. Sanitize/cap SessionStart context to validated slug/status/count fields; remove free-form headings and titles.
3. Route deterministic PreToolUse guards and PermissionRequest through correct Codex envelopes, canonical `apply_patch` inputs, configured matchers, and exactly one Omni path.
4. Add a cross-platform plugin-local launcher; no bare `env VAR=... genie` dependency.
5. Close every row in `HOOK-AUDIT.md`, including previous-binary compatibility, malformed/structurally invalid envelopes, interrupted approval cleanup, matcher privacy, Windows startup, and the documented guardrail-only limitation of PreToolUse.

**Exclusive files:**
- `plugins/genie/hooks/codex-hooks.json`
- `plugins/genie/hooks/hooks.json` only if the shared launcher contract requires it
- `plugins/genie/scripts/dispatch-runtime.cjs`
- `plugins/genie/scripts/src/session-context.ts`
- `plugins/genie/scripts/session-context.cjs`
- `src/hooks/**`
- `src/lib/omni-config.ts`
- Hook-specific tests; Group A reports evidence to the PM but does not edit PM-owned review artifacts

**Acceptance Criteria:**
- [ ] The retained manifest commands are local, deterministic, bounded, and non-mutating apart from explicitly configured approval queue state.
- [ ] Remote timeout/failure cannot silently allow work; PreToolUse never waits on Omni; PermissionRequest timeout exceeds the configured poll budget.
- [ ] Manifest-level fixtures execute every retained command and prove documented stdout/exit behavior.
- [ ] The original nine commands have an evidence-backed keep/remove disposition and the three retained definitions remain untrusted pending post-install hash review.

**Validation:**
```bash
bun test src/hooks plugins/genie/scripts src/lib/smart-install-hook.test.ts
bun run typecheck
```

**depends-on:** none

---

### Group B: Codex-native plugin skills

**Goal:** Make the repository marketplace and release tarball ship the same usable, in-root Codex skill set.

**Deliverables:**
1. Replace `plugins/genie/skills -> ../../skills` with a real plugin-contained Codex skill tree.
2. Port all 23 shipped workflows to valid Codex metadata and runtime-neutral/Codex-native invocation language, including `agents/openai.yaml`.
3. Extend skill/package smoke checks to reject plugin-root escapes, unsupported metadata, missing declared skills, and source/package layout drift.
4. Preserve Claude behavior in its existing product surface; do not import personal specialist skills into the product.
5. Add a deterministic mirror generator: root `skills/` is canonical and runtime-neutral; plugin `skills/` is regenerated and parity-checked byte-for-byte before build/release.

**Exclusive files:**
- `skills/**`
- `plugins/genie/skills/**`
- `plugins/genie/.codex-plugin/plugin.json`
- `scripts/sync-plugin-skills.ts` and its tests
- `scripts/skills-lint.ts`, `scripts/skills-lint.test.ts`
- `scripts/fresh-install-smoke.ts`, `scripts/fresh-install-smoke.test.ts`
- `scripts/build-binary.sh`, `scripts/build.js`, `scripts/version.ts`, and formatting-preservation tests

**Acceptance Criteria:**
- [ ] Clean source-plugin copying without symlink dereference retains all skills.
- [ ] Every bundled Codex skill validates and its `openai.yaml` prompt names the correct `$skill`.
- [ ] Built and source plugin layouts expose the same declared component inventory.
- [ ] Claude lifecycle, Codex `$skill`, and isolated agent-sync fixtures all consume the canonical/mirrored contract without drift.

**Validation:**
```bash
bun run skills:lint
bun test scripts/skills-lint.test.ts scripts/fresh-install-smoke.test.ts
```

**depends-on:** none

---

### Group C: Personal artifact ownership safety

**Goal:** Ensure install, update, and uninstall never take ownership of or destroy personal skills and modified role-agent files.

**Deliverables:**
1. Skip and report unmanaged/corrupt-manifest collisions; preserve modified managed artifacts instead of overwriting them.
2. Keep recovery data outside any root later deleted by uninstall, and preserve modified legacy `.curated` content.
3. Use one digest-backed role-agent inventory/classifier across install, doctor, refresh, and uninstall.
4. Treat lock-acquisition I/O failure and future-dated locks safely; never synchronize without owning the lock.
5. Record structured integration-removal failures and keep cleanup retryable; never print unconditional success after a requested removal fails.
6. Put deadlines on every external integration subprocess and return structured timeout/failure results to callers.

**Exclusive files:**
- `src/lib/agent-sync.ts`, `src/lib/agent-sync.test.ts`
- `src/lib/runtime-integrations.ts`, `src/lib/runtime-integrations.test.ts`
- `src/genie-commands/uninstall.ts`, `src/genie-commands/uninstall.test.ts`
- Ownership/recovery helpers introduced solely for these files

**Acceptance Criteria:**
- [ ] User-owned same-name skills and agents remain byte-identical across update/uninstall.
- [ ] Clean Genie-owned artifacts still update and remove; modified ones are kept with an actionable report.
- [ ] Lock failure/race/future-time fixtures never permit concurrent destructive sync or suppress sync indefinitely.
- [ ] Tests run only against copied temporary HOME/CODEX_HOME/GENIE_HOME fixtures; a final read-only comparison matches every digest in `USER-ASSET-BASELINE.md`.

**Validation:**
```bash
bun test src/lib/agent-sync.test.ts src/lib/runtime-integrations.test.ts src/genie-commands/uninstall.test.ts
```

**depends-on:** none

---

### Group D1: Transactional install and update

**Goal:** Repair version ordering, auxiliary-tree convergence, and update swap/recovery defects without expanding into inherited publication redesign.

**Deliverables:**
1. Implement correct prerelease ordering and malformed-version handling.
2. Make the PR-added auxiliary-tree swaps rollback-safe; remove identical extracted residue and compare contents rather than trusting mutable version stamps. Inherited live-binary rollback remains F31 in the stable-release wish.
3. Validate integration/update options before any destructive finisher and make manual update refresh plugin/hooks/agents through Group C's ownership-safe API.
4. Preserve fresh and previous artifacts at every injected failure point and surface per-tree outcomes.

**Exclusive files:**
- `src/genie-commands/install.ts`, `src/genie-commands/install.test.ts`
- `src/genie-commands/update.ts`, `src/genie-commands/__tests__/update.test.ts`
- New version/auxiliary-tree helpers used only by install/update

**Acceptance Criteria:**
- [ ] Failure at every PR-added auxiliary-tree swap stage preserves the prior live artifact and recoverable fresh artifact.
- [ ] Final/RC comparisons, malformed versions, stale/identical trees, pre-mutation option rejection, and same/cross-filesystem swaps have focused tests.
- [ ] Plugin refresh uses ownership-safe APIs and `--sync-only` remains bounded/no-network.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts src/genie-commands/install.test.ts
```

**depends-on:** A, B, C

---

### Group D2: Codex project and runtime lifecycle

**Goal:** Give setup, doctor, init, and launch one consistent project-root/MCP/runtime contract.

**Deliverables:**
1. Centralize Git worktree-root resolution and Codex plugin-versus-fallback MCP reconciliation.
2. Preserve explicit runtime choices in sectional and full setup; reject wrong-shaped JSON safely.
3. Add deadlines and structured errors to doctor/external probes, while reusing Group C's role inventory.
4. Remove worker-side `task done`, correct launch quoting tests, and align task ownership with the orchestrator-only contract.
5. Propagate Group C integration failures through setup/doctor/init/launch without reporting false success.

**Exclusive files:**
- `src/genie-commands/setup.ts`, `src/genie-commands/setup.test.ts`
- `src/genie-commands/doctor.ts`, `src/genie-commands/doctor.test.ts`
- `src/term-commands/init.ts`, `src/term-commands/init.test.ts`
- `src/term-commands/launch.ts`, `src/term-commands/launch.test.ts`
- `src/lib/codex-project-mcp.ts` and its tests
- `src/lib/genie-config.ts`, `src/lib/genie-config.test.ts`
- `src/lib/codex-config.ts`, `src/lib/codex-config.test.ts`
- `src/lib/genie-home.ts` and its tests

**Acceptance Criteria:**
- [ ] Root, nested-directory, and linked-worktree fixtures produce exactly one usable MCP path.
- [ ] Hanging probes time out; preserved disabled plugins never suppress the only MCP fallback.
- [ ] Setup paths preserve explicit agent choice and launch prompts leave completion to the PM.

**Validation:**
```bash
bun test src/genie-commands/setup.test.ts src/genie-commands/doctor.test.ts src/term-commands/init.test.ts src/term-commands/launch.test.ts
```

**depends-on:** A, B, C

---

### Group D3: Codex/Omni execution recovery

**Goal:** Make provider execution fail visibly and recover safely from option-like prompts, incomplete JSONL, and missing sessions.

**Deliverables:**
1. Insert `--` before all user-controlled Codex prompts.
2. Require one non-empty agent reply before acknowledging success; validate unknown JSON shapes without unchecked assertions.
3. Detect missing resume sessions, retry fresh once, atomically replace the stored thread id, and keep failure retryable.

**Exclusive files:**
- `src/lib/omni-runner.ts`, `src/lib/omni-runner.test.ts`

**Acceptance Criteria:**
- [ ] `--version`, `--help`, and `-m` are delivered as prompt text.
- [ ] Empty/unrelated/truncated JSONL is an error, not a blank successful reply.
- [ ] Missing-session recovery succeeds once or returns an actionable retryable error without stale routing state.

**Validation:**
```bash
bun test src/lib/omni-runner.test.ts
```

**depends-on:** A

---

### Group E: Documentation and final release gate

**Goal:** Make contributor, operator, and release guidance match the code and produce final independent evidence.

**Deliverables:**
1. Keep the Codex manifest formatter-stable across version/build scripts and correct overclaims about plugin-shipped subagents.
2. Document the reduced hook set, exact side effects, explicit setup/update path, `/hooks` review, and new-task requirement.
3. Correct stale native orchestration, task ownership, skill-tier, release-asset, and migration-caveat documentation.
4. Remove or formally supersede resurrected generated metrics state and close only wish/index criteria supported by real evidence.
5. Expand Build Tarballs PR inputs and add the migration caveat, but leave inherited publication security and the legacy verifier to the separate stable-release wish.

**Exclusive files:**
- `README.md`, `CLAUDE.md` (do not modify `AGENTS.md`)
- `plugins/genie/README.md`, `plugins/genie/references/**`
- `.genie/agents/metrics-updater/**`, `.genie/INDEX.md`, affected wishes and the three review artifacts in this wish
- `.github/workflows/build-tarballs.yml`, `.github/workflows/release-publish.yml` only for PR-input coverage and migration-note text
- Documentation/release tests not owned by Groups A–D3
- `plugins/genie/codex-agents/genie-reviewer.toml` and reviewer-permission tests

**Acceptance Criteria:**
- [ ] Version/build commands do not recreate a Biome failure.
- [ ] Docs distinguish plugin skills, CLI-installed role agents, personal skills, and untrusted hooks accurately.
- [ ] Full local gates, focused tests, tarball/source inventory checks, and merge-tree simulation pass.

**Validation:**
```bash
bun run check
bun test
git diff --check
git merge-tree --write-tree origin/dev HEAD
```

**depends-on:** A, B, C, D1, D2, D3

---

## QA Criteria

- [ ] Review the new Codex hook manifest command-by-command; execute only deterministic fixtures, never trust the live set during QA.
- [ ] Verify source plugin, extracted plugin, CLI install/update, and uninstall in isolated temporary HOME/CODEX_HOME/GENIE_HOME fixtures.
- [ ] Verify the user's currently installed 36 adapted skills remain unchanged.
- [ ] Run `bun install --frozen-lockfile`, full checks/tests under Bun `>=1.3.10`, and inspect exact source/extracted plugin inventories plus all supported tarballs.
- [ ] Confirm refreshed GitHub repository workflows run jobs and pass on the exact final SHA; obtain independent human approval before main merge.
- [ ] Reviewer/QA sandboxes may write only to temporary fixtures and dependency caches, never live HOME/CODEX_HOME/GENIE_HOME.
- [ ] PR-remediation SHIP is recorded separately from the still-blocked stable-release authorization.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Hook tests accidentally execute mutating legacy commands | High | Test manifest structure and fake launchers in isolated HOME; keep live hooks untrusted. |
| Parallel writers overlap ownership/lifecycle files | High | Every group has an explicit exclusive file list; D1/D2/D3 start only after A–C independent reviews. |
| Personal skill migration is overwritten by the current updater | High | Do not run live `genie update`; test with isolated homes until Group C lands. |
| Local Bun is 1.3.9, below the repository minimum | Medium | Treat current results as provisional; require supported Bun/CI evidence before ship. |
| Scope expands into inherited release security debt | Medium | Keep it OUT, track it in the blocking stable-release wish, and do not authorize stable release until remediated. |

---

## Review Results

Seven-lane specialist panel at the starting head: Repository hygiene BLOCKED; security/supply-chain BLOCKED; architecture, code quality, QA, performance, and DX/docs FIX-FIRST. Native Codex review added ten diff-local findings. No lane returned SHIP.

Plan review rounds 1 and 2 returned FIX-FIRST. Round 3 returned SHIP after the plan added the canonical skill source/mirror contract, exact file ownership, complete finding and hook ledgers, a live-asset digest baseline, split lifecycle groups, and a separate inherited stable-release blocker.

Execution update 2026-07-11: PR #2545 merged via `6f682e2b` from source `10ceb2c0`. Remediation commit `a2e3155a` was rebased onto `dev` `5101fd35`; Group E continues as an uncommitted follow-up. `WISH.md` stays IN_PROGRESS until the aggregate suite, exact-final-SHA GitHub jobs, final post-test baseline comparison, and independent approval are recorded. Rows F16–F18/F31 remain stable-release blockers regardless of the follow-up verdict.

---

## Files to Create/Modify

```text
Group A: plugins/genie/hooks/{codex-hooks,hooks}.json; dispatch/session-context scripts; src/hooks/**; src/lib/omni-config.ts
Group B: skills/**; plugins/genie/skills/**; plugin manifest; sync/lint/smoke/build/version scripts
Group C: src/lib/{agent-sync,runtime-integrations}*; src/genie-commands/uninstall*
Group D1: src/genie-commands/{install,update}*
Group D2: src/genie-commands/{setup,doctor}*; src/term-commands/{init,launch}*; src/lib/{codex-project-mcp,genie-config,codex-config,genie-home}*
Group D3: src/lib/omni-runner*
Group E: contributor/plugin references except AGENTS.md; reviewer TOML; PM ledgers; metrics/index/wishes; bounded build/release docs and tests
```
