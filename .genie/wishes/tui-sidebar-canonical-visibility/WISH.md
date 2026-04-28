# Wish: TUI sidebar — canonical agent visibility & non-canonical separation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tui-sidebar-canonical-visibility` |
| **Date** | 2026-04-28 |
| **Author** | felipe |
| **Appetite** | small |
| **Branch** | `wish/tui-sidebar-canonical-visibility` |
| **Repos touched** | namastexlabs/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

The Genie TUI sidebar renders stopped (offline-but-registered) canonical agents in `palette.textDim`, making them visually indistinguishable from background and producing the perception that they have "disappeared" from the menu. Sub-agents (scoped names like `felipe/scout`, `genie/devrel`) share the same render hierarchy as canonicals with no explicit kind distinction. This wish makes every registered canonical workspace agent always visible and spawnable from the sidebar, and introduces an explicit canonical/sub-agent separation in the tree data and render.

## Scope

### IN

- G1 — Visibility: replace `palette.textDim` for `wsAgentState: 'stopped'` with a legible tone; optionally swap glyph from `○` to `◌` to signal "spawnable"
- G2 — Affordance: add ` [Enter to start]` suffix on stopped agent rows, mirroring the existing `stuck`/`paused`/`done` pattern in `getAgentSuffix`
- G3 — Kind distinction: add `kind: 'canonical' | 'subagent'` to the `TreeNode` shape, set it in `buildAgentNode`/`appendSubAgentNodes`, and render canonicals always at depth 0 with sub-agents always nested
- Tests covering each of the above (color, suffix, kind field)
- Manual QA reproduction recipe documented in QA Criteria

### OUT

- Orphan PG executor cleanup (stale rows like `engineer-pr1431-v6`, `felipe-alpha`, `felipe-test` that appear in `genie ls` but not in filesystem) — separate hygiene concern, will be filed independently
- Backend or DB schema changes
- New `genie` CLI verbs (no `genie agent prune --orphans` in this wish)
- Changes to `genie ls` output shape or its filter flags
- Redesign of legacy (non-workspace) mode — `buildSessionTree` stays as-is; this wish only improves the `buildWorkspaceTree` path
- Adding new palette colors (reuse existing semantic tokens unless absolutely required)

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Reuse existing palette semantic tokens (`palette.text` or `palette.textMuted` if it exists) for stopped state instead of introducing new ones | Lumon-MDR theme migration just landed; adding new tokens would re-open theme churn. Verify in `src/tui/theme.ts` which tokens are available; only add a new one if no existing token fits. |
| 2 | Sub-agents continue to render only as nested children of their parent canonical (existing `appendSubAgentNodes` behavior) — no flat tab/section split | The current nesting is the right shape; the bug is that the nesting was implicit (slash-in-name heuristic) rather than typed. Adding `kind` makes it explicit without restructuring the tree. |
| 3 | Workspace mode is the only target path for this wish | `workspaceRoot` resolution via `findWorkspace()` + saved root in `~/.genie/config.json` is reliable today. Legacy mode (no workspace) would benefit from similar work but is a smaller surface used only for ad-hoc tmux inspection. |
| 4 | Glyph change for stopped (`○` → `◌` dotted circle) is opt-in inside G1 | Visual signal of "spawnable" helps discoverability, but the primary fix is the color. Glyph swap should not block G1 if it surfaces design objections. |

## Success Criteria

- [ ] All canonical agents present in `<workspace>/agents/<name>/AGENTS.md` are visible in the TUI sidebar regardless of runtime state (running, stopped, error, spawning)
- [ ] Stopped canonical agents render with a legible color (not `palette.textDim`) — visible at a glance against the panel background
- [ ] Pressing Enter on a stopped canonical agent triggers `spawnAgent()` and the row's state transitions to `spawning` then `running` (no regression of the existing affordance at `Nav.tsx:124-134`)
- [ ] Stopped agent rows display ` [Enter to start]` suffix
- [ ] Sub-agents (scoped names with `/`) render only as children of their parent canonical, never at depth 0
- [ ] Tree nodes carry an explicit `kind: 'canonical' | 'subagent'` field that downstream consumers can rely on
- [ ] No regression in `running`, `error`, or `spawning` state rendering (color, icon, suffix)
- [ ] `genie wish lint tui-sidebar-canonical-visibility` passes
- [ ] All existing tests in `src/tui/` continue to pass

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Visibility — color + icon for stopped state |
| 2 | engineer | Affordance — `[Enter to start]` suffix |

### Wave 2 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Kind distinction — `canonical` vs `subagent` field + render distinction |

Wave 1 groups are independent local edits in `TreeNode.tsx` (color/icon vs suffix logic) and can ship in parallel. Wave 2 depends on Wave 1 because G3 touches the same `TreeNode.tsx` render path and benefits from a stable visual baseline before adding kind-based styling.

## Execution Groups

### Group 1: Visibility — stopped agents legible

**Goal:** Replace `palette.textDim` for `wsAgentState: 'stopped'` with a tone that is clearly legible against the panel background, so registered canonical agents that are offline do not visually disappear.

**Deliverables:**
1. Update `getAgentColor` in `src/tui/components/TreeNode.tsx:158-169` so the `'stopped'` branch returns a legible color (`palette.text` or a new `palette.muted` semantic — choose based on what reads well in `src/tui/theme.ts`)
2. Update `getAgentIcon` in `src/tui/components/TreeNode.tsx:96-108` so the `'stopped'` branch returns `◌` (dotted circle, U+25CC) instead of `○` (U+25CB) to better signal "spawnable"
3. Add a unit test in `src/tui/components/TreeNode.test.tsx` (create file if absent) asserting `getAgentColor` and `getAgentIcon` return the expected legible color and `◌` glyph for a stopped agent node
4. Update `src/tui/theme.ts` only if a new `palette.muted` token is required — preserve Lumon-MDR semantics

**Acceptance Criteria:**
- [ ] Stopped agent color is no longer `palette.textDim` — verifiable via unit test
- [ ] Stopped icon is `◌` — verifiable via unit test
- [ ] Running (`palette.success` + `●`), error (`palette.error` + `⊘`), and spawning (`palette.warning` + `⏳`) branches unchanged
- [ ] No new top-level palette tokens unless theme.ts review shows none of the existing tokens fit

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/tui/components/TreeNode 2>&1
```

**depends-on:** none

---

### Group 2: Affordance — `[Enter to start]` hint

**Goal:** Add an inline suffix on stopped agent rows so users know pressing Enter spawns a fresh session, mirroring the existing pattern that already renders `[stuck — press R to retry]`, `[paused — auto-resume off]`, and `[done]` for work-states.

**Deliverables:**
1. Extend `getAgentSuffix` in `src/tui/components/TreeNode.tsx:182-195` with a case for `wsAgentState === 'stopped'` returning ` [Enter to start]`
2. Confirm no conflict between the new suffix and the existing `(N windows)` suffix — for stopped agents `windowCount` is `0` so the conditional path differs, but document the precedence explicitly
3. Add a unit test in `src/tui/components/TreeNode.test.tsx` asserting `getAgentSuffix` returns ` [Enter to start]` for a stopped agent and that running agents with multiple windows still get `(N windows)`
4. Add (or extend) a Nav-level test verifying that pressing `Enter` on a stopped agent invokes `spawnAgent` (regression coverage for `Nav.tsx:124-134` and `Nav.tsx:911`)

**Acceptance Criteria:**
- [ ] Stopped agents render ` [Enter to start]` suffix
- [ ] Running agents with `windowCount > 1` still render `(N windows)` suffix
- [ ] Work-state suffixes (`[stuck]`, `[paused]`, `[done]`) take precedence over `[Enter to start]` per existing branch order
- [ ] Pressing Enter on a stopped agent in tests triggers the spawn handler path

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/tui/components/TreeNode src/tui/components/Nav 2>&1
```

**depends-on:** none

---

### Group 3: Kind distinction — canonical vs sub-agent

**Goal:** Make the canonical/sub-agent distinction an explicit property of every agent tree node so downstream renderers and consumers do not have to re-derive it from name parsing, and so sub-agents are guaranteed to render only as children of canonicals.

**Deliverables:**
1. Add `kind: 'canonical' | 'subagent'` to the agent-node shape in `src/tui/types.ts` (extend the `TreeNode` discriminated union or its `data` payload — pick the cleaner location)
2. Set `kind: 'canonical'` in `buildAgentNode` for top-level entries (`src/tui/session-tree.ts:86-96`)
3. Set `kind: 'subagent'` in `appendSubAgentNodes` for nested entries (`src/tui/session-tree.ts:148-171`)
4. Update `getAgentColor`, `getAgentIcon`, or label rendering in `src/tui/components/TreeNode.tsx` to use `kind` for any visual distinction (e.g. canonicals get full label, sub-agents get a slightly indented marker even when expanded — judgment call, keep minimal)
5. Update tests in `src/tui/session-tree.test.ts` to assert `kind` is `'canonical'` for top-level nodes returned by `buildWorkspaceTree` and `'subagent'` for nodes inside `parent.children`
6. Confirm via test that no node with `kind: 'subagent'` appears at depth 0 in the flattened tree

**Acceptance Criteria:**
- [ ] `TreeNode` agent nodes carry a `kind` field with values `'canonical'` or `'subagent'`
- [ ] `buildWorkspaceTree` produces canonicals at depth 0 with `kind: 'canonical'`
- [ ] All sub-agents appear as `kind: 'subagent'` nested under their parent canonical
- [ ] No sub-agent appears as a top-level node in the flattened tree (assert via test)
- [ ] Existing nesting behavior preserved — sub-agents still render under parents at `depth: 1`

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/tui/session-tree src/tui/components/TreeNode src/tui/components/Nav 2>&1
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional — Launch `genie` from `~/workspace/agents/felipe/` (or any subdir of the workspace). Sidebar shows every canonical agent listed in `~/workspace/agents/<name>/AGENTS.md` (currently aegis, brain, email, felipe, felipe-notes, genie, genie-configure, genie-docs, genie-pgserve, juice-keeper) regardless of runtime state.
- [ ] Functional — Kill an agent's tmux session (e.g. `tmux kill-session -t felipe`), relaunch TUI; the killed agent still appears in the sidebar with stopped styling and ` [Enter to start]` suffix.
- [ ] Functional — Press Enter on a stopped canonical agent. The row transitions to spawning (`⏳` warning color), then to running (`●` success color) once Claude attaches.
- [ ] Integration — Sub-agents (e.g. `felipe/notes`, `genie/devrel`, `genie-docs/reviewer`) appear only as children of their parent canonical. Expanding the parent reveals them at depth 1; no slashed name appears at depth 0.
- [ ] Regression — Running agents still render bright green `●`. Error agents still render `⊘` in red. Spawning agents still render `⏳` in warning color.
- [ ] Regression — Existing keyboard navigation (`j`/`k`/arrows, `h`/`l` to expand/collapse, Enter to attach/spawn, Tab/context-menu) all work as before.
- [ ] Regression — `genie ls`, `genie agent directory`, and other CLI verbs are unaffected.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Chosen "muted but legible" color still reads as low-contrast in some terminal themes (especially light backgrounds) | Medium | Pick from existing semantic tokens that have already been validated against the Lumon-MDR theme; if no token fits, prefer adding `palette.muted` with explicit RGB values that pass a contrast check against `palette.bg` |
| Adding `kind` to `TreeNode` breaks an undiscovered downstream consumer | Low | Field is additive; consumers that don't read it are unaffected. Run full test suite before merge. |
| Sub-agent depth assumption (always 1 level) is hard-coded; future deeper hierarchies would need richer kind handling | Low | Current `scanSubAgents` (`src/lib/workspace.ts:301-313`) only walks one level. If hierarchy ever extends, the kind enum and `appendSubAgentNodes` will need revisit — document this in the code comment |
| Glyph change `○` → `◌` may not render correctly in some terminals lacking the U+25CC code-point | Low | Both glyphs are widely supported; if a terminal lacks `◌`, it falls back to a placeholder square. If this is observed in QA, revert glyph change and keep the color fix |
| `[Enter to start]` suffix may overflow narrow sidebar widths | Low | Existing suffixes (`[stuck — press R to retry]` is longer) already render fine; truncation behavior is inherited from OpenTUI's `text` element |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/tui/types.ts                       # G3: add kind field to TreeNode
src/tui/session-tree.ts                # G3: set kind in buildAgentNode + appendSubAgentNodes
src/tui/theme.ts                       # G1: optionally add palette.muted (only if no existing token fits)
src/tui/components/TreeNode.tsx        # G1+G2+G3: color, icon, suffix, kind-aware rendering
src/tui/components/TreeNode.test.tsx   # G1+G2: color, icon, suffix unit tests (create if absent)
src/tui/session-tree.test.ts           # G3: kind field assertions for canonical vs subagent
src/tui/components/Nav.test.tsx        # G2: regression test that Enter on stopped triggers spawn (extend if exists)
```
