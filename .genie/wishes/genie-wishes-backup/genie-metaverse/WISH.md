# Wish: Genie Metaverse — Per-Workspace Instances with Git-Controlled Publishing

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-metaverse` |
| **Date** | 2026-04-09 |
| **Design** | [DESIGN.md](../../brainstorms/genie-metaverse/DESIGN.md) |
| **depends-on** | `genie-simulations` (publish gate requires sim scores) |

## Summary

Transform genie-app from a generic workspace viewer into a dedicated, identity-bound deployment platform. Each install is permanently bound to a workspace (containing one or many agents), gets a unique ID, and the app controls git — dev branch for drafting/simulation, main for production, publish gated by simulation scores. Optional central registry creates a discoverable "metaverse" of genie workspaces.

## Scope

### IN
- Enhanced wizard: 3 setup paths (select folder, create new + optional GitHub repo, import from GitHub URL+branch)
- Unique workspace ID: UUIDv4 generated at first setup, immutable, stored in workspace.json
- Immutable workspace binding: folder + repo URL locked permanently
- Agent auto-detection: scan `.genie/agents/` + root AGENTS.md for all agents/subagents in workspace
- App-controlled git: branch switching, publish (dev → main + auto-tag vN)
- Publish gate: blocks unless latest sim scores ≥ configurable threshold (across all agents with scenarios)
- Deployment mode: `prod` / `dev` field in workspace config, determines app behavior
- Workspace lifecycle view in app: draft (dev) → simulate → publish → production → destroy
- Optional central registry: workspace instances register with metadata (name, agent roster, version, scores)
- GitHub repo creation from app (optional, for "create new" path)

### OUT
- Agent optimization loop (auto-improve from sim failures — future wish)
- Central registry browser / metaverse discovery UI (future — this wish only registers)
- Kubernetes deployment automation (khal-os infra layer, not app concern)
- Data mirror / PII sync from prod to dev (separate infra wish — tightly coupled but different subsystem)
- Simulation engine itself (covered by `genie-simulations` wish)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Workspace = deployment unit (not single agent) | A workspace contains N agents. They ship together, version together, simulate independently. Eugenia = orchestrator + seller in one workspace |
| Auto-detect agents in workspace | App scans `.genie/agents/` and root AGENTS.md for registered agents + subagents. All are simulatable if configured |
| Immutable workspace binding | A workspace IS its identity. Rebinding would create identity confusion. Destroy + recreate is cleaner |
| App owns git for publish | Lovable-style: non-technical user clicks "Publish", app handles merge + tag. No CLI git knowledge needed |
| dev = draft, main = production | Standard git convention. dev is always the working branch, main is always what's live |
| Auto-tagging (v1, v2, v3...) | Every publish is an immutable snapshot. Rollback = point Omni at an older tag |
| Publish gate = sim score ≥ threshold | Quality-controlled releases. Can't ship a broken agent. Threshold configurable per workspace |
| Dual deployment (prod + dev) | Dev needs real data to simulate realistically, but real users must never talk to dev |
| Unique ID per workspace | Offline-first identity. UUIDv4 generated at setup, never changes. Used for PG scoping, registry, log correlation |
| Central registry is opt-in | Privacy-first. Workspace metadata only (name, agents, score, version, repo URL), never conversations or PII |

## Success Criteria

- [ ] First-time wizard offers 3 paths: select folder, create new (+ optional GitHub repo creation), import from GitHub URL+branch
- [ ] Unique workspace ID generated on first setup, stored in workspace.json, immutable
- [ ] Workspace folder binding is permanent — app refuses to rebind to different repo
- [ ] App auto-detects all agents and subagents in workspace (scans .genie/agents/ + AGENTS.md hierarchy)
- [ ] Each detected agent shown in workspace overview with simulation status
- [ ] App controls git: branch switching, publish (dev → main + auto-tag vN)
- [ ] Publish gate: blocks unless latest sim scores ≥ configurable threshold across all agents with scenarios
- [ ] deployment_mode field (prod/dev) in workspace config — determines behavior
- [ ] GitHub repo creation works from "create new" wizard path
- [ ] Optional central registry: workspace can register for metaverse directory
- [ ] Workspace lifecycle visible in app: draft (dev) → simulate → publish → production
- [ ] Existing wizard functionality (select folder, open existing) still works

## Execution Strategy

### Wave 1 (parallel — foundations)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Workspace identity: unique ID generation, immutable binding, deployment_mode |
| 2 | engineer | Agent auto-detection: workspace scanner for agents/subagents |

### Wave 2 (parallel — after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Enhanced wizard: 3 setup paths + GitHub repo creation |
| 4 | engineer | Git lifecycle: branch switching, publish (merge + auto-tag) |

### Wave 3 (parallel — after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Publish gate: sim score threshold check + UI |
| 6 | engineer | Workspace lifecycle view in app |

### Wave 4 (after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Central registry: opt-in registration + workspace metadata |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Workspace Identity — Unique ID, Immutable Binding, Deployment Mode
**Goal:** Extend workspace.json with unique identity, immutable repo binding, and deployment mode.

**Deliverables:**
1. `packages/genie-app/src-backend/workspace.ts` — extend `Workspace` interface with:
   - `id: string` (UUIDv4, generated once on first setup, never changes)
   - `repoUrl: string | null` (set on setup, immutable after)
   - `repoBranch: string` (current active branch, mutable)
   - `deploymentMode: 'prod' | 'dev'` (determines app behavior)
   - `publishThreshold: number` (default 70, configurable)
   - `createdAt: string` (ISO timestamp, set once)
2. Validation: reject any attempt to change `id` or `repoUrl` after initial setup
3. Migration: existing workspaces get a generated ID on first open (backwards compat)

**Acceptance Criteria:**
- [ ] New workspace gets UUIDv4 id on creation
- [ ] Existing workspace gets id generated on first open (migration)
- [ ] Attempting to change repoUrl after setup is rejected with error
- [ ] deploymentMode defaults to 'dev' for new workspaces

**Validation:**
```bash
bunx biome check packages/genie-app/src-backend/workspace.ts && bunx tsc --noEmit
```

**depends-on:** none

---

### Group 2: Agent Auto-Detection — Workspace Scanner
**Goal:** Scan a workspace to discover all registered agents and subagents.

**Deliverables:**
1. `packages/genie-app/src-backend/agent-scanner.ts` — scans workspace for:
   - Root AGENTS.md (top-level agent definition)
   - `.genie/agents/*/AGENTS.md` (subagents)
   - Parses frontmatter from each: name, model, role, color, promptMode
   - Returns typed `WorkspaceAgent[]` with hierarchy (parent/child relationships)
2. NATS subject handler: `agents.scan` — triggers scan and returns agent roster
3. Agent roster cached in workspace state, refreshed on branch switch or manual trigger

**Acceptance Criteria:**
- [ ] Scanner discovers root agent + all subagents from `.genie/agents/`
- [ ] Frontmatter parsed correctly (name, model, role, color)
- [ ] Parent/child hierarchy detected (subagents reference parent)
- [ ] Works with eugenia-style repos (orchestrator + seller)

**Validation:**
```bash
bunx biome check packages/genie-app/src-backend/agent-scanner.ts && bunx tsc --noEmit
```

**depends-on:** none

---

### Group 3: Enhanced Wizard — 3 Setup Paths + GitHub Repo Creation
**Goal:** Upgrade the first-time wizard from 2 paths (new/existing) to 3 paths with GitHub integration.

**Deliverables:**
1. `packages/genie-app/views/wizard/ui/WizardView.tsx` — rewrite wizard with 3 paths:
   - **Select folder** — pick existing local workspace (current "Open Existing" behavior)
   - **Create new** — enter name, select folder, init `.genie/`, optionally create GitHub repo via `gh repo create`
   - **Import from GitHub** — enter repo URL + branch, clone to selected folder, bind workspace
2. GitHub integration: use `gh` CLI for repo creation and cloning (graceful fallback if `gh` not installed)
3. Post-setup: generate unique ID, set repoUrl, set deploymentMode, show agent roster from auto-detection
4. Immutability messaging: clear UI indication that "this workspace is permanently bound to this repo"

**Acceptance Criteria:**
- [ ] All 3 wizard paths produce a working workspace with unique ID
- [ ] "Import from GitHub" clones repo at specified branch
- [ ] "Create new" + GitHub creates a public/private repo and pushes initial commit
- [ ] Fallback works when `gh` CLI is not installed (manual repo creation instructions)
- [ ] Post-setup shows detected agents from Group 2's scanner

**Validation:**
```bash
bunx biome check packages/genie-app/views/wizard/ && bunx tsc --noEmit
```

**depends-on:** Group 1, Group 2

---

### Group 4: Git Lifecycle — Branch Switching, Publish (Merge + Auto-Tag)
**Goal:** App takes control of git for branch management and publishing.

**Deliverables:**
1. `packages/genie-app/src-backend/git-lifecycle.ts` — git operations:
   - `switchBranch(branch: string)` — checkout + pull, refresh agent roster
   - `publish()` — merge dev → main (fast-forward), auto-tag `vN` (next sequential), push main + tags
   - `getVersionHistory()` — list tags with dates and commit messages
   - `getCurrentBranch()` — current branch name
   - `getBranchStatus()` — ahead/behind main, dirty working tree check
2. NATS subject handlers: `workspace.branch`, `workspace.publish`, `workspace.versions`
3. Publish refuses to run if current branch is already main (can't publish main to main)
4. Tag naming: `v1`, `v2`, `v3` etc., auto-incrementing from highest existing tag

**Acceptance Criteria:**
- [ ] Branch switching works and triggers agent roster refresh
- [ ] Publish merges dev → main with fast-forward, creates auto-tag
- [ ] Version history shows all tags with dates
- [ ] Publish from main branch is rejected with clear error
- [ ] Dirty working tree warning shown before publish

**Validation:**
```bash
bunx biome check packages/genie-app/src-backend/git-lifecycle.ts && bunx tsc --noEmit
```

**depends-on:** Group 1

---

### Group 5: Publish Gate — Sim Score Threshold Check + UI
**Goal:** Block publishing unless simulation scores meet the configured threshold.

**Deliverables:**
1. `packages/genie-app/src-backend/publish-gate.ts` — pre-publish validation:
   - Query `genie_sim_runs` for latest run per agent on current branch
   - Check each agent's latest score ≥ `publishThreshold` from workspace config
   - Return gate result: `{ allowed: boolean, agents: [{ name, score, threshold, pass }] }`
   - Agents with no scenarios configured are flagged as "no simulation data" (warning, not blocking)
2. Publish button in UI: shows gate status (green/red per agent), score badges, threshold indicator
3. "Run Simulations" quick action when gate fails — links to `/simulate` or `genie sim run --all`
4. Override: no override — hard gate, score must be ≥ threshold

**Acceptance Criteria:**
- [ ] Publish blocked when any agent's latest sim score < threshold
- [ ] Gate shows per-agent breakdown: name, score, pass/fail
- [ ] Agents without scenarios show warning but don't block
- [ ] "Run Simulations" button visible when gate fails
- [ ] Threshold configurable in workspace settings (default 70)

**Validation:**
```bash
bunx biome check packages/genie-app/src-backend/publish-gate.ts && bunx tsc --noEmit
```

**depends-on:** Group 4, `genie-simulations` wish (PG tables must exist)

---

### Group 6: Workspace Lifecycle View
**Goal:** App view showing the workspace's full lifecycle: identity, agents, branch state, version history, publish controls.

**Deliverables:**
1. Enhance existing dashboard or create workspace panel in app showing:
   - **Identity card** — workspace name, unique ID, repo URL, deployment mode badge (prod/dev)
   - **Agent roster** — auto-detected agents with name, role, model, last sim score, sim status
   - **Branch status** — current branch, commits ahead of main, dirty indicator
   - **Version history** — published tags (v1, v2, v3...) with dates, clickable for diff
   - **Publish button** — with gate status (green checkmarks or red X per agent)
   - **Lifecycle indicator** — visual: draft → simulate → publish → production
2. Wire to NATS subjects from Groups 2, 4, 5
3. Add to NAV_ITEMS in App.tsx (or integrate into existing dashboard)

**Acceptance Criteria:**
- [ ] Identity card shows workspace ID, repo URL, deployment mode
- [ ] Agent roster lists all detected agents with last sim scores
- [ ] Branch status accurate (current branch, ahead/behind main)
- [ ] Version history shows all published tags
- [ ] Publish button respects gate (disabled with explanation when blocked)
- [ ] Lifecycle indicator reflects current state

**Validation:**
```bash
bunx biome check packages/genie-app/views/ && bunx tsc --noEmit
```

**depends-on:** Group 2, Group 4, Group 5

---

### Group 7: Central Registry — Opt-In Registration
**Goal:** Allow workspace instances to register with a central directory for discovery.

**Deliverables:**
1. `packages/genie-app/src-backend/registry.ts` — registry client:
   - `register()` — POST workspace metadata to registry API (name, ID, repo URL, agent roster, latest version, aggregate sim score, deployment mode)
   - `heartbeat()` — periodic update (every 5min when app is running)
   - `deregister()` — on workspace destroy
   - Registry URL configurable in workspace settings (default: Namastex-hosted)
2. Settings toggle in app: "Register in Genie Metaverse" (default off)
3. Registration payload: workspace metadata only — never conversations, PII, or credentials
4. Graceful degradation: registry unavailable = silent skip, app works fully offline

**Acceptance Criteria:**
- [ ] Opt-in toggle in settings, default off
- [ ] Registration sends metadata only (name, ID, agents, version, score)
- [ ] Heartbeat keeps registration alive while app is running
- [ ] Deregister on workspace destroy
- [ ] App works fully offline when registry is unavailable

**Validation:**
```bash
bunx biome check packages/genie-app/src-backend/registry.ts && bunx tsc --noEmit
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] Fresh install: all 3 wizard paths produce a working workspace with unique ID and agent detection
- [ ] Existing workspace: opens with auto-generated ID (migration), no data loss
- [ ] Publish flow: dev → main + tag works end-to-end, gate blocks when score < threshold
- [ ] Agent detection: multi-agent workspace (like eugenia) correctly shows orchestrator + subagents
- [ ] Immutability: app rejects attempts to rebind workspace to different repo
- [ ] Registry: opt-in registration works, app functions fully without it
- [ ] `bun run check` passes (typecheck + lint + dead-code + test)

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Lock-in (can't rebind workspace) | Low | By design. Clear wizard messaging: "This binding is permanent" |
| Git conflicts (app vs user CLI pushes) | Medium | App owns publish. Dev branch accepts external pushes. Publish always fast-forwards |
| `gh` CLI not installed | Low | Graceful fallback: show manual repo creation instructions |
| Central registry availability | Low | Fully optional, offline-first. Silent skip on unavailable |
| Threshold gaming | Low | Future: scenario coverage requirements per rule category |
| Breaking existing wizard users | Medium | Migration path: existing workspaces get ID on first open, no behavior change until user opts in |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# New files
packages/genie-app/src-backend/agent-scanner.ts   — Workspace agent/subagent discovery
packages/genie-app/src-backend/git-lifecycle.ts    — Branch switching, publish, tagging
packages/genie-app/src-backend/publish-gate.ts     — Sim score threshold validation
packages/genie-app/src-backend/registry.ts         — Central metaverse registry client

# Modified files
packages/genie-app/src-backend/workspace.ts        — Extend Workspace with id, repoUrl, deploymentMode
packages/genie-app/src-backend/pg-bridge.ts         — Add NATS handlers for workspace/publish/registry
packages/genie-app/views/wizard/ui/WizardView.tsx   — 3-path wizard + GitHub integration
packages/genie-app/lib/subjects.ts                  — Add workspace/publish/registry NATS subjects
packages/genie-app/src/App.tsx                       — Add lifecycle view to NAV_ITEMS
packages/genie-app/manifest.ts                       — Register workspace lifecycle view (if separate)
packages/genie-app/components.ts                     — Lazy import for lifecycle view
```
