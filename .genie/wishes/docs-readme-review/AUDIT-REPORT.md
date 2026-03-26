# Audit Report: Genie Docs vs CLI Reality

**Date:** 2026-03-25
**CLI Version:** v4.260326.1
**Total CLI commands:** 46 top-level commands
**README lines:** 75
**Docs pages:** 40+ (Mintlify)

---

## 1. README Gaps

The README is a 75-line landing page. Per the wish, it should stay concise but must accurately reflect v4 features.

| Feature | README mentions? | Reality | Action |
|---------|-----------------|---------|--------|
| Brainstorm/Wish/Work/Review pipeline | Yes (workflow diagram) | Correct | None |
| Parallel execution in worktrees | Yes | Correct | None |
| Automated severity-gated review | Yes | Correct | None |
| Overnight mode (/dream) | Yes | Correct | None |
| 10-critic council | Yes | Correct | None |
| Portable context (identity, memory) | Yes | Correct | None |
| **Boards & pipelines** | **No** | Shipped: `genie board` with templates, columns, gates | **Add to feature list** |
| **Projects** | **No** | Shipped: `genie project` with named task boards | **Add to feature list** |
| **Task lifecycle** | **No** | Shipped: `genie task` with 14 subcommands, stages, deps | **Add to feature list** |
| **Observability** | **No** | Shipped: `events`, `metrics`, `sessions`, `log` | **Add to feature list** |
| **Scheduling & daemon** | **No** | Shipped: `genie schedule` + `genie daemon` | **Add to feature list** |
| **QA system** | **No** | Shipped: `genie qa` with run/status/history | **Add to feature list** |
| **Export/Import** | **No** | Shipped: `genie export` (10 groups) + `genie import` | **Add to feature list** |
| **PG-backed messaging** | **No** | Shipped: `send`, `broadcast`, `inbox`, `chat` | **Add to feature list** |
| **Database management** | **No** | Shipped: `genie db` (status/migrate/query) | **Mention in architecture** |
| **Notifications** | **No** | Shipped: `genie notify` | **Minor — skip or mention** |
| **Tags, Types, Releases** | **No** | Shipped: `genie tag`, `genie type`, `genie release` | **Mention under task mgmt** |
| Command count / CLI scope | No (only shows 4 skills) | 46 commands, 100+ subcommands | **Add brief command overview** |
| Version / metrics freshness | Metrics table present | Metrics are auto-updated | None |
| Install command | `curl | bash` + `/wizard` | Correct and current | None |
| Docs link | Points to `docs.automagik.dev/genie` | Correct | None |

**README Summary:** 11 shipped features entirely missing. README reflects the brainstorm-to-PR workflow but none of the infrastructure that shipped in v4 (boards, tasks, observability, scheduling, projects).

---

## 2. Mintlify Docs — CLI Reference Gaps

### Commands WITH docs coverage:

| Command | Docs Page | Coverage | Issues |
|---------|-----------|----------|--------|
| `setup` | cli/infrastructure.mdx | Full | None |
| `doctor` | cli/infrastructure.mdx | Full | None |
| `update` | cli/infrastructure.mdx | Full | None |
| `shortcuts` | cli/infrastructure.mdx | Full | None |
| `team` (create/hire/fire/ls/disband/done/blocked) | cli/team.mdx | Full | None |
| `dir` (add/rm/ls/edit) | cli/directory.mdx | Full | None |
| `agent register` | cli/directory.mdx | Full | None |
| `send` | cli/messaging.mdx | Full | None |
| `broadcast` | cli/messaging.mdx | Full | None |
| `inbox` | cli/messaging.mdx | Full | None |
| `chat` | cli/messaging.mdx | Full | None |
| `brainstorm` | cli/dispatch.mdx | Full | None |
| `wish` | cli/dispatch.mdx | Full | None |
| `work` | cli/dispatch.mdx | Full | None |
| `review` | cli/dispatch.mdx | Full | None |
| `done` | cli/dispatch.mdx | Full | None |
| `status` | cli/dispatch.mdx | Full | None |
| `reset` | cli/dispatch.mdx | Full | None |
| `spawn` | cli/agents.mdx | Full | Missing new flags: `--layout`, `--color`, `--plan-mode`, `--permission-mode`, `--extra-args`, `--cwd`, `--session`, `--no-auto-resume` |
| `resume` | cli/agents.mdx | Full | Missing `--all` flag |
| `kill` | cli/agents.mdx | Full | None |
| `stop` | cli/agents.mdx | Full | None |
| `ls` | cli/agents.mdx | Full | Missing `--json` flag |
| `history` | cli/agents.mdx | Partial | Missing flags: `--after`, `--raw`, `--log-file` |
| `read` | cli/agents.mdx | Partial | Missing flags: `--from`, `--to`, `--range`, `--search`, `--grep`, `--follow`, `--all`, `--reverse`, `--json` |
| `answer` | cli/agents.mdx | Full | None |

### Commands with NO docs page (20 commands):

| Command | Subcommands | Priority | Proposed Page |
|---------|-------------|----------|---------------|
| **`task`** | create, list, show, move, assign, tag, comment, block, unblock, done, checkout, release, unlock, dep | **CRITICAL** | cli/tasks.mdx |
| **`board`** | create, list, show, edit, delete, columns, use, export, import, template | **CRITICAL** | cli/boards.mdx |
| **`project`** | list, create, show, set-default | **HIGH** | cli/projects.mdx |
| **`events`** | list, errors, costs, tools, timeline, summary | **HIGH** | cli/observability.mdx |
| **`metrics`** | now, history, agents | **HIGH** | cli/observability.mdx |
| **`sessions`** | list, replay, search, ingest | **HIGH** | cli/observability.mdx |
| **`log`** | (unified feed, --follow, --team, --type) | **HIGH** | cli/observability.mdx |
| **`schedule`** | create, list, cancel, retry, history | **MEDIUM** | cli/scheduling.mdx |
| **`daemon`** | install, start, stop, status, logs | **MEDIUM** | cli/scheduling.mdx |
| **`db`** | status, migrate, query | **MEDIUM** | cli/infrastructure.mdx (add section) |
| **`type`** | list, show, create | **MEDIUM** | cli/tasks.mdx (subsection) |
| **`tag`** | list, create | **MEDIUM** | cli/tasks.mdx (subsection) |
| **`release`** | create, list | **MEDIUM** | cli/tasks.mdx (subsection) |
| **`export`** | all, boards, tasks, tags, projects, schedules, agents, apps, comms, config | **MEDIUM** | cli/data.mdx |
| **`import`** | --fail, --merge, --overwrite, --groups | **MEDIUM** | cli/data.mdx |
| **`notify`** | set, list, remove | **LOW** | cli/messaging.mdx (add section) |
| **`qa`** | run, status, history | **LOW** | cli/qa.mdx |
| **`qa-report`** | (internal) | **LOW** | Skip (internal) |
| **`hook dispatch`** | (internal) | **LOW** | config/hooks.mdx (already covers concept) |
| **`uninstall`** | (standalone) | **LOW** | cli/infrastructure.mdx (add) |

---

## 3. Mintlify Docs — Concept Page Gaps

| Concept | Page exists? | Status | Action |
|---------|-------------|--------|--------|
| Wishes | concepts/wishes.mdx | Current | None |
| Agents | concepts/agents.mdx | Current | None |
| Teams | concepts/teams.mdx | Current | None |
| Skills | concepts/skills.mdx | Current | None |
| BYOA | concepts/byoa.mdx | Current | None |
| **Boards** | **No** | Shipped: boards, templates, columns, gates, WIP limits | **Create concepts/boards.mdx** |
| **Projects** | **No** | Shipped: named task boards, default project | **Create concepts/projects.mdx** |
| **Observability** | **No** | Shipped: events, metrics, sessions, log | **Consider concepts/observability.mdx** |

---

## 4. Mintlify Docs — Architecture Page Gaps

| Page | Status | Issues |
|------|--------|--------|
| architecture/overview.mdx | Mostly current | Missing boards/projects from subsystem list |
| architecture/postgres.mdx | **STALE** | Documents 3 migrations (001-003). Actual DB has 10 migrations (001-009 + duplicate 007). Missing tables: boards, board_templates, board_columns, board_column_gates, agents, agent_templates, agent_checkpoints, os_config, app_store |
| architecture/messaging.mdx | Current | None |
| architecture/scheduler.mdx | Current | None |
| architecture/state.mdx | Current | None |
| architecture/transcripts.mdx | Current | None |

---

## 5. Existing Docs — Stale Flag/Option Issues

| Page | Command | Documented | Actual | Action |
|------|---------|-----------|--------|--------|
| cli/agents.mdx | `genie spawn` | `--model`, `--provider` | Also has: `--layout`, `--color`, `--plan-mode`, `--permission-mode`, `--extra-args`, `--cwd`, `--session`, `--no-auto-resume` | Add missing flags |
| cli/agents.mdx | `genie resume` | `<name>` only | Also has: `--all` flag | Add flag |
| cli/agents.mdx | `genie ls` | Basic | Missing `--json` flag | Add flag |
| cli/agents.mdx | `genie history` | `--full`, `--since`, `--last`, `--type`, `--json`, `--ndjson` | Also has: `--after`, `--raw`, `--log-file` | Add flags |
| cli/agents.mdx | `genie read` | `-n, --lines` | Also has: `--from`, `--to`, `--range`, `--search`, `--grep`, `-f/--follow`, `--all`, `-r/--reverse`, `--json` | Major update needed |
| cli/team.mdx | `genie team` | create/hire/fire/ls/disband | Missing: `done`, `blocked` subcommands | Add subcommands |
| cli/infrastructure.mdx | Setup area | setup/doctor/update/shortcuts | Missing: `uninstall`, `db` commands | Add |

---

## 6. docs.json Navigation Gaps

Current navigation has these groups:
- Getting Started (4 pages)
- Core Concepts (5 pages)
- Skills Reference (14 pages)
- CLI Reference (7 pages)
- Configuration (5 pages)
- Architecture (6 pages)
- Hacks & Tips (1 page)
- Contributing (1 page)

**Missing from navigation (new pages needed):**

| Proposed Page | Group | Priority |
|---------------|-------|----------|
| genie/cli/tasks.mdx | CLI Reference | CRITICAL |
| genie/cli/boards.mdx | CLI Reference | CRITICAL |
| genie/cli/projects.mdx | CLI Reference | HIGH |
| genie/cli/observability.mdx | CLI Reference | HIGH |
| genie/cli/scheduling.mdx | CLI Reference | MEDIUM |
| genie/cli/data.mdx | CLI Reference | MEDIUM |
| genie/concepts/boards.mdx | Core Concepts | CRITICAL |
| genie/concepts/projects.mdx | Core Concepts | HIGH |

---

## 7. Cross-Reference: README vs Docs Contradictions

| Item | README says | Docs say | Reality | Issue |
|------|------------|----------|---------|-------|
| Feature scope | 6 features listed | 8 capabilities on features.mdx | 46 commands, dozens of features | README undersells; docs are closer but still incomplete |
| Install flow | `curl \| bash` → `genie` → `/wizard` | installation.mdx: `curl \| bash` → `genie setup` → `genie doctor` | Both work; wizard is the newer DX | Minor inconsistency |
| "Wishes in, PRs out" | Tagline | Docs explain full pipeline | Accurate | None |

No major contradictions between README and docs — the issue is omission, not conflict.

---

## 8. Summary Statistics

| Metric | Count |
|--------|-------|
| Total CLI commands | 46 |
| Commands with full docs | 26 (57%) |
| Commands with partial docs | 4 (9%) |
| Commands with NO docs | 16 (35%) |
| Internal-only commands (skip) | 2 (hook dispatch, qa-report) |
| Concept pages needed | 2 (boards, projects) |
| Architecture pages needing update | 1 (postgres.mdx) |
| CLI pages needing flag updates | 3 (agents.mdx, team.mdx, infrastructure.mdx) |
| New CLI pages needed | 6 |
| New concept pages needed | 2 |
| docs.json entries to add | 8 |
| README features to add | 11 |

---

## 9. Recommended Fix Priority

### CRITICAL (must fix)
1. **README:** Add boards, projects, task lifecycle, observability to feature list
2. **New page:** `cli/tasks.mdx` — task, type, tag, release commands
3. **New page:** `cli/boards.mdx` — board commands + templates
4. **New page:** `concepts/boards.mdx` — boards concept page
5. **Update:** `architecture/postgres.mdx` — add migrations 004-009 and new tables

### HIGH (should fix)
6. **New page:** `cli/projects.mdx` — project commands
7. **New page:** `cli/observability.mdx` — events, metrics, sessions, log
8. **New page:** `concepts/projects.mdx` — projects concept page
9. **Update:** `cli/agents.mdx` — add missing spawn/read/history flags
10. **Update:** `docs.json` — add all new pages to navigation

### MEDIUM (nice to have)
11. **New page:** `cli/scheduling.mdx` — schedule + daemon commands
12. **New page:** `cli/data.mdx` — export/import commands
13. **Update:** `cli/infrastructure.mdx` — add uninstall, db commands
14. **Update:** `cli/team.mdx` — add done/blocked subcommands

### LOW (can defer)
15. **Update:** `cli/messaging.mdx` — add notify commands
16. **New page:** `cli/qa.mdx` — qa system docs
