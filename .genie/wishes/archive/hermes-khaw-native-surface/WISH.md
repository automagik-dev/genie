# Wish: Hermes/KHAW Native Plugin Surface for Genie

| Field | Value |
|-------|-------|
| **Status** | DONE — all 5 groups SHIP-reviewed; #2517 (dev) + #2516 (promotion) merged; live dogfood on Hermes 0.18 (2026-07-05) |
| **Slug** | `hermes-khaw-native-surface` |
| **Date** | 2026-07-04 |
| **Author** | Felipe (via Hermes plan) |
| **Appetite** | medium |
| **Branch** | `wish/hermes-khaw-native-surface` (cut from `origin/main` — this planning checkout is a stale fix branch) |
| **Repos touched** | `automagik-dev/genie`, KHAW (`/home/feliperosa/vm-home/prod/khaw`) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Ship a native Hermes plugin from the genie repo (`plugins/hermes-genie/`) that exposes read-only Genie state — doctor, board, wish/task queries, and `launch --dry-run` plans — as safe structured tools, slash commands, advisory hooks, and skills, so Hermes/KHAW can act as the expensive-model cockpit while Genie remains the zero-daemon execution system. Add a KHAW-side bridge (`plugins/khaw/genie_bridge.py` in the KHAW repo) that maps Brain/Purpose Sessions to Genie wishes and joins the KHAW work registry with Genie board state, without moving canonical ownership in either direction. MVP is strictly read-only: every tool returns `mutation: "none"` and wraps the `genie` CLI via argument arrays, never shell strings.

Source plan: `/home/feliperosa/vm-home/.hermes/plans/2026-07-04_173507-genie-hermes-khaw-native-plugin-surface.md`. The tool contract below was re-grounded on 2026-07-04 against the installed genie v5 CLI (5.260703.5) and Hermes Agent v0.18.0 — see Decisions #2–3 for where it corrects the source plan.

## Scope

### IN

- Hermes plugin package `plugins/hermes-genie/` (manifest `plugin.yaml`, `register(ctx)`, subprocess bridge, per-tool schemas) with 7 read-only tools grounded on the v5 CLI: `genie_status`, `genie_board`, `genie_wish_status`, `genie_task_list`, `genie_task_status`, `genie_work_plan`, `genie_review_plan`
- Slash commands `/genie` (subcommands: status, board, wish, work-plan, review-plan, help) plus `/genie-board`, `/genie-wish`, `/genie-work-plan`, `/genie-review-plan`
- Guarded Hermes CLI command tree `hermes genie ...` (only when `ctx.register_cli_command` exists)
- Advisory hooks: `on_session_start` (`.genie/` detection reminder), `pre_tool_call` (terminal-scrape/poll advisory, never blocking), `post_tool_call` (passthrough)
- 4 plugin skills: `genie`, `genie-work`, `genie-review`, `genie-khaw-bridge`
- pytest contract suites (plugin contract, bridge safety, commands) runnable via `uv run --with pytest --with pyyaml`
- Install/smoke scripts (`install-local.sh` with symlink default + `--copy`, `smoke.sh`) and docs: plugin README, `references/native-surface.md`, `references/mutation-gates.md`, root `README.md` section, `plugins/genie/README.md` cross-link, update to the existing `profiles/hermes/genie/README.md` profile seed on `origin/main` (add plugin install path + Hermes-native cross-link)
- KHAW bridge in the KHAW repo: `plugins/khaw/genie_bridge.py` (tools `khaw_genie_status`, `khaw_genie_work_registry`, `khaw_genie_link_plan`, `khaw_genie_brainstorm_prompt`), `/khaw-genie` command, `khaw-genie-bridge` extension point in `manifest/khaw-additions.yaml`, contract tests
- End-to-end operator smoke with evidence file in the KHAW repo

### OUT

- Mutation-capable tools (`genie_task_checkout`, `genie_task_done`, executing `genie launch`, any spawn/send) — require explicit later approval per the source plan's human-gate rule
- Hermes core patches of any kind; resident daemon or bridge service
- Wiring Hermes to `genie mcp` (v5 already ships a read-only stdio MCP server — separate follow-up wish)
- `src/genie-commands/doctor.ts` / `setup.ts` Hermes-plugin detection (source plan marked these optional — follow-up)
- CI wiring of the Python test suites into `bun run check` or GitHub Actions
- Claude Code plugin (`plugins/genie/`) behavior changes beyond a README cross-link
- Moving Brain/Purpose Session canonical ownership into Genie
- Packaging/publishing (PyPI, plugin marketplace) beyond local install scripts

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Read-only MVP: every tool, command, and hook reports `mutation: "none"` and performs no state writes | Source-plan mandate: human gate before any mutation-capable dispatch; safest first surface for a cockpit |
| 2 | Ground the tool contract on the real v5 CLI: `doctor --json`, `board --json [--wish]`, `task list --json [--wish] [--status]`, `task status <id>`, `launch <slug> --dry-run [--groups <csv>]` | Verified 2026-07-04 on genie 5.260703.5. The plan's `genie wish status --json` and `genie spawn` commands do NOT exist in v5; the task filter flag is `--status`, not `--state` |
| 3 | `genie_wish_status` composes `board --wish <slug> --json` + `task list --wish <slug> --json`; `genie_work_plan` wraps native `launch <slug> --dry-run`; the plan's `genie_spawn_dry_run` is dropped and `genie_task_status` (wrapping `task status <id>`) added to keep 7 tools | `launch --dry-run` already prints the dispatch plan (YAML, worktrees, prompts) without touching anything — a bespoke argv-validation tool for a nonexistent `spawn` command would mislead |
| 4 | Subprocess via argv arrays only; reject shell metacharacters (semicolons, boolean operators, backticks, `$(`, newlines); JSON parse with raw-text fallback plus explicit parse status | Source-plan security contract; some genie outputs are not JSON and the bridge must not pretend otherwise |
| 5 | `hasattr` guards around `register_cli_command`, `register_skill`, and `register_hook` | The live KHAW plugin proves `register_tool`/`register_command`/`register_cli_command`/`register_skill` on Hermes v0.18.0; `register_hook` is unproven there, so guard it and cover with FakeCtx tests |
| 6 | Python tests run via `uv run --with pytest --with pyyaml --no-project python -m pytest` | System python3 has pyyaml but no pytest (verified); uv is installed and this invocation works today |
| 7 | `install-local.sh` defaults to symlinking into `$HERMES_HOME/plugins/genie`, with `--copy` for release-style installs | Matches the live machine convention (`~/.hermes/plugins/khaw` is a symlink into the KHAW repo); symlink keeps the dev loop tight |
| 8 | KHAW work stays in the KHAW repo with its own commits and review gate; this wish tracks it as one execution group with an explicit target repo | Two repos, separate review; the wish remains the single coordination document |
| 9 | Uniform payload contract on every tool: `success`, `mutation`, `cwd`, `command`/`source`, `data`/`error` | Evidence-first surface shared by both plugins; the KHAW bridge mirrors the contract established in Group 1 |

## Success Criteria

- [x] `uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests -q` passes in the genie repo
- [x] Contract test proves all 7 read-only tools register via a FakeCtx and every handler returns a JSON string containing `success`, `mutation: "none"`, and `cwd`
- [x] Bridge safety test proves shell metacharacters are rejected with `ValueError`, and `grep -rn 'shell=True' plugins/hermes-genie/` finds nothing
- [x] Disposable install works: `export HERMES_HOME="$(mktemp -d)" && plugins/hermes-genie/scripts/install-local.sh && test -e "$HERMES_HOME/plugins/genie/plugin.yaml"`
- [x] Live smoke: `hermes plugins list` shows the genie plugin, or the exact Hermes version and limitation are documented in the evidence file with a direct-handler fallback run
- [x] KHAW: `uv run --with pytest --with pyyaml --no-project python -m pytest tests/contract/test_khaw_genie_bridge.py tests/contract/test_khaw_harness.py -q` passes in the KHAW repo
- [x] `manifest/khaw-additions.yaml` declares the `khaw-genie-bridge` extension point with owns/verification/forbidden lists
- [x] All four SKILL.md files pass frontmatter validation (byte-zero `---`, `name:` + `description:`, non-empty body)
- [x] `bun test` in the genie repo stays green (any pre-existing unrelated failures documented with exact output)

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | plugin-core: manifest + safe CLI bridge + schemas + 7 read-only tools + contract tests |

### Wave 2 (parallel, after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | plugin-surface: slash commands, advisory hooks, guarded CLI tree, 4 skills + tests |
| 3 | engineer | plugin-docs: READMEs, references, profile seed, install/smoke scripts |
| 4 | engineer | khaw-bridge: KHAW repo bridge module + registration + manifest + contract tests |

### Wave 3 (sequential, after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | qa | validation-e2e: full suites in both repos, bun test regression, disposable install, live operator smoke + evidence |

## Execution Groups

### Group 1: plugin-core

**Goal:** A discoverable Hermes plugin package exposing 7 safe read-only Genie tools through a tested subprocess bridge.

**Deliverables:**
1. `plugins/hermes-genie/plugin.yaml` — `name: genie`, declaring 7 `provides_tools`, 3 `provides_hooks`, 5 `provides_commands`, `provides_cli_commands: [genie]`, 4 `provides_skills`
2. `plugins/hermes-genie/__init__.py` — `register(ctx)` registering all 7 tools with toolset `genie`, description, and emoji (surface extras land in Group 2)
3. `plugins/hermes-genie/genie_bridge.py` — `build_genie_argv` (metacharacter rejection), `resolve_cwd`, `payload`, `run_genie` (argv-only subprocess, 30s default timeout, capture stdout/stderr/returncode, JSON parse with raw fallback and parse status)
4. `plugins/hermes-genie/schemas.py` — one schema per tool with typed properties (`cwd`, `slug`, `wish`, `status`, `groups`, `id`)
5. Tool-to-CLI mapping (grounded): `genie_status` wraps `doctor --json` plus a `.genie/` presence check; `genie_board` wraps `board --json [--wish]`; `genie_wish_status` composes `board --wish <slug> --json` + `task list --wish <slug> --json`; `genie_task_list` wraps `task list --json [--wish] [--status]`; `genie_task_status` wraps `task status <id>` (raw capture); `genie_work_plan` wraps `launch <slug> --dry-run [--groups <csv>]`; `genie_review_plan` composes wish status + Success Criteria/QA extraction from `.genie/wishes/<slug>/WISH.md`
6. `plugins/hermes-genie/tests/test_plugin_contract.py` and `tests/test_genie_bridge.py`, TDD-first per source plan Tasks 2–4 (manifest assertions, FakeCtx registration, argv safety, payload fields)

**Acceptance Criteria:**
- [x] FakeCtx registration test passes: all 7 tools present with callable handlers
- [x] `build_genie_argv` rejects semicolons, `&&`, `||`, backticks, `$(`, and newline characters with `ValueError`
- [x] Every handler returns a JSON string with `success`/`mutation`/`cwd`/`command`; `mutation` is always `"none"`
- [x] No shell-string execution anywhere in the plugin (subprocess argv only, no `shell=True`)

**Validation:**
```bash
cd /home/feliperosa/vm-home/workspace/repos/genie \
  && uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests/test_plugin_contract.py plugins/hermes-genie/tests/test_genie_bridge.py -q \
  && ! grep -rn 'shell=True' plugins/hermes-genie/
```

**depends-on:** none

---

### Group 2: plugin-surface

**Goal:** Operators drive Genie from Hermes chat and CLI without memorizing tool names, and sessions are nudged toward structured Genie state.

**Deliverables:**
1. `plugins/hermes-genie/commands.py` — `/genie` dispatcher (`status|board|wish|work-plan|review-plan|help`) with outcome-first human-readable output; unknown subcommand answers with a clear pointer to `/genie help`; thin wrappers for `/genie-board`, `/genie-wish`, `/genie-work-plan`, `/genie-review-plan`
2. `plugins/hermes-genie/hooks.py` — `on_session_start` (inject a short reminder when cwd contains `.genie/`), `pre_tool_call` (advisory when a terminal command uses `tmux capture-pane` or sleep-polling for Genie state — never a hard block), `post_tool_call` (no-op passthrough; the source plan's "compact evidence footer" normalization is deferred past MVP — this matches the plan's own Task 6 reference implementation); all return `mutation: "none"`
3. Guarded `ctx.register_cli_command("genie", ...)` with subparsers `status`, `board`, `wish`, `work-plan`, `review-plan` implemented in `commands.py` as `setup_cli`
4. Four skills created and registered (guarded by `hasattr(ctx, "register_skill")`): `skills/genie/SKILL.md` (cockpit contract: Genie is the execution system, tools before terminal, human gates, evidence-first reporting), `skills/genie-work/SKILL.md` (work-plan first, no direct execution unless requested, dispatch stays in the Genie/Claude Code lane, reviewer differs from engineer), `skills/genie-review/SKILL.md` (SHIP/FIX-FIRST/BLOCKED verdicts, evidence against acceptance criteria, no self-review), `skills/genie-khaw-bridge/SKILL.md` (Brain/Purpose Sessions canonical in KHAW, Genie owns execution detail, bridge reports mapping + evidence)
5. `plugins/hermes-genie/tests/test_commands.py` plus contract-test extensions for hooks, skills, and CLI registration (source plan Tasks 5–8)

**Acceptance Criteria:**
- [x] `/genie help` lists all subcommands; unknown subcommand output contains "Unknown" and points to `/genie help`
- [x] Hooks registered for all three events; no handler returns a blocking directive
- [x] All SKILL.md files start with byte-zero `---` frontmatter carrying `name:` and `description:` and have a non-empty body
- [x] `register(ctx)` completes cleanly on a ctx missing `register_cli_command`/`register_skill`/`register_hook` (guard test)

**Validation:**
```bash
cd /home/feliperosa/vm-home/workspace/repos/genie \
  && uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests -q \
  && python3 - <<'PY'
from pathlib import Path
paths = list(Path('plugins/hermes-genie/skills').glob('*/SKILL.md'))
assert len(paths) == 4, paths
for p in paths:
    text = p.read_text(encoding='utf-8')
    assert text.startswith('---'), p
    head, body = text[3:].split('\n---\n', 1)
    assert 'name:' in head and 'description:' in head and body.strip(), p
print('skill files ok')
PY
```

**depends-on:** plugin-core

---

### Group 3: plugin-docs

**Goal:** Anyone can install, smoke-test, and understand the boundary of the Hermes-native surface from the docs alone.

**Deliverables:**
1. `plugins/hermes-genie/README.md` — install (symlink default, `--copy` alternative), smoke commands, and the boundary statement: Hermes is the chat/reasoning cockpit; Genie remains the execution system and source of task truth
2. `plugins/hermes-genie/references/native-surface.md` — layer map (tools/commands/CLI/hooks/skills) and payload contract; `plugins/hermes-genie/references/mutation-gates.md` — read-only MVP boundary, deferred mutation tools, human-gate rules
3. `plugins/hermes-genie/scripts/install-local.sh` — `set -euo pipefail`, symlink `$HERMES_HOME/plugins/genie` to the repo plugin dir by default (`$HERMES_HOME` defaulting to `~/.hermes`), `--copy` flag for copy installs; `plugins/hermes-genie/scripts/smoke.sh` — `hermes plugins list | grep -i genie` plus a `/genie help` probe; both executable
4. Root `README.md` — "Hermes-native surface" section after the Claude Code plugin docs
5. `plugins/genie/README.md` — cross-link between the Claude Code plugin and the Hermes plugin
6. `profiles/hermes/genie/README.md` — MODIFY the existing profile seed on `origin/main` (7 committed files, "Genie Hermes Profile Seed"): preserve the seed content, add the plugin install path and a "Hermes-native" cross-link. The source plan's "modify" is correct against main — this planning checkout simply predates `profiles/`. `SOUL.md` stays untouched (OUT)

**Acceptance Criteria:**
- [x] `bash -n` passes on both scripts and both are executable
- [x] Disposable install into `HERMES_HOME="$(mktemp -d)"` yields a readable `plugin.yaml` with `name: genie`
- [x] `grep -R "Hermes-native"` hits root README, `plugins/genie/README.md`, and the profile seed

**Validation:**
```bash
cd /home/feliperosa/vm-home/workspace/repos/genie \
  && bash -n plugins/hermes-genie/scripts/install-local.sh plugins/hermes-genie/scripts/smoke.sh \
  && test -x plugins/hermes-genie/scripts/install-local.sh \
  && HERMES_HOME="$(mktemp -d)" plugins/hermes-genie/scripts/install-local.sh \
  && grep -q "Hermes-native" README.md \
  && grep -q "Hermes-native" plugins/genie/README.md \
  && grep -q "Hermes-native" profiles/hermes/genie/README.md
```

**depends-on:** plugin-core

---

### Group 4: khaw-bridge

**Goal:** KHAW exposes read-only Genie bridge tools that map Purpose Sessions to wishes and join both work registries, declared additively. Target repo: `/home/feliperosa/vm-home/prod/khaw` (separate commits, own review gate).

**Deliverables:**
1. `plugins/khaw/genie_bridge.py` — Python stdlib only, locates `genie` with `shutil.which`, optional read-only `genie --version` probe, accepts `project_root`/`cwd` defaulting to repo root; tools: `khaw_genie_status` (KHAW plugin status + Genie availability), `khaw_genie_work_registry` (joins `khaw_work_registry` output with `genie board --json` / `genie task list --json` for linked wishes), `khaw_genie_link_plan` (proposes Purpose Session to Genie wish mapping paths without writing files), `khaw_genie_brainstorm_prompt` (3-lens council-style prompt targeting creation/update of a Genie wish); all payloads mirror the Group 1 contract (`success`, `mutation: "none"`, evidence sources)
2. `plugins/khaw/__init__.py` — import and register the 4 bridge tools (toolset `khaw`) and the `/khaw-genie` command (`status|registry|link-plan`); if nested `/khaw genie ...` dispatch is feasible, alias it and document the choice
3. `plugins/khaw/plugin.yaml` — extend `provides_tools` with the 4 bridge tools and `provides_commands` with `khaw-genie`
4. `manifest/khaw-additions.yaml` — add `khaw-genie-bridge` extension point (`kind: hermes-general-plugin-plus-tools`; owns: mapping plans, registry readback, non-mutating handoff prompts, human-gate packet for mutations; verification: the four read-only assertions from the source plan; forbidden: moving Brain ownership, mutating `.genie` or brain/wishes in MVP, embedding secrets/sessions/live channel IDs)
5. `tests/contract/test_khaw_genie_bridge.py` (read-only payload assertions, link-plan no-mutation, manifest extension-point assertions) and a new assertion in `tests/contract/test_khaw_harness.py` that `plugin.yaml` exposes the bridge tools and command (source plan Tasks 10–12)

**Acceptance Criteria:**
- [x] Every bridge tool returns `mutation: "none"`; `khaw_genie_link_plan` proposes paths without writing any file
- [x] `khaw_genie_status` reports Genie installed/missing without crashing when the binary is absent
- [x] Harness test asserts the 4 tools + `khaw-genie` command in `plugin.yaml`
- [x] Extension-point test asserts id/kind/owns for `khaw-genie-bridge`
- [x] Existing KHAW contract tests still pass (no regression to `khaw_status`, `/wish`, `/brainstorm`)

**Validation:**
```bash
cd /home/feliperosa/vm-home/prod/khaw \
  && uv run --with pytest --with pyyaml --no-project python -m pytest tests/contract/test_khaw_genie_bridge.py tests/contract/test_khaw_harness.py -q
```

**depends-on:** plugin-core

---

### Group 5: validation-e2e

**Goal:** Prove the full cockpit contract live — Hermes reasons, Genie reports task truth, KHAW links Purpose Sessions — with recorded evidence.

**Deliverables:**
1. Genie-side battery green: full plugin pytest suite plus a `bun test` regression run (pre-existing unrelated failures documented verbatim)
2. KHAW-side battery green: bridge + harness contracts plus the broader suite (`test_khaw_work_registry_contract.py`, `test_khaw_purpose_sessions.py`, `test_khaw_slash_wish.py`, `test_khaw_slash_brainstorm.py`)
3. Disposable-`HERMES_HOME` install validation (mktemp home, install, assert `plugin.yaml` parses with `name: genie`)
4. Live operator smoke: `hermes plugins list` shows the genie plugin; `hermes chat -q '/genie help'` and `'/genie status'` return non-error — or the exact Hermes version and limitation are documented and the direct-handler fallback is executed instead (no live-integration claims without visibility)
5. Disposable-repo smoke: `git init && genie init` in a mktemp dir, then `genie_status` against it detects `.genie/`
6. Evidence file `docs/evidence/genie-hermes-khaw-native-surface-smoke-<date>.md` in the KHAW repo with exact commands and outputs

**Acceptance Criteria:**
- [x] Both repo suites pass, or unrelated pre-existing failures are documented with exact output
- [x] Live integration is claimed only if visible through `hermes plugins list`; otherwise the limitation is recorded with the Hermes version string
- [x] Evidence file exists and contains command transcripts for the Hermes smoke, KHAW bridge smoke, and disposable install

**Validation:**
```bash
cd /home/feliperosa/vm-home/workspace/repos/genie \
  && uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests -q \
  && HERMES_HOME="$(mktemp -d)" plugins/hermes-genie/scripts/install-local.sh \
  && cd /home/feliperosa/vm-home/prod/khaw \
  && uv run --with pytest --with pyyaml --no-project python -m pytest tests/contract/test_khaw_genie_bridge.py tests/contract/test_khaw_harness.py tests/contract/test_khaw_work_registry_contract.py tests/contract/test_khaw_purpose_sessions.py tests/contract/test_khaw_slash_wish.py tests/contract/test_khaw_slash_brainstorm.py -q \
  && ls docs/evidence/ | grep genie-hermes-khaw-native-surface-smoke
```

**depends-on:** plugin-surface, plugin-docs, khaw-bridge

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [x] Functional: in a live Hermes session, `/genie help`, `/genie status`, and `/genie board` return non-error, outcome-first output grounded in `genie` CLI evidence
- [x] Integration: `/khaw-genie status` returns JSON with `mutation: "none"` and both KHAW and Genie evidence sources; `khaw_genie_link_plan` proposes a mapping for a real Purpose Session slug without writing files
- [x] Integration: starting a Hermes session in a repo containing `.genie/` surfaces the advisory reminder from `on_session_start`
- [x] Regression: existing KHAW tools (`khaw_status`, `khaw_work_registry`, `/wish`, `/brainstorm`) behave unchanged; `bun test` in the genie repo unaffected

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Hermes plugin API drift — `register_hook` is unproven on v0.18.0 (KHAW uses tools/commands/cli/skills only) | Medium | `hasattr` guards; FakeCtx guard test; record the actual Hermes version in evidence |
| Genie CLI drift — installed CLI is 5.260703.5 while this checkout's branch is older; flags could move again before execution | Medium | Tool contract pinned to flags verified 2026-07-04 (`--json` on doctor/board/task list, `--status` filter, `launch --dry-run`); bridge marks JSON parse status and falls back to raw text |
| `hermes chat -q` may not expose plugin toolsets non-interactively | Medium | Plan-sanctioned fallback: direct handler invocation, document the exact limitation and Hermes version — never claim live integration without `hermes plugins list` visibility |
| System python3 lacks pytest | Low | All validation via `uv run --with pytest --with pyyaml --no-project` (verified working today) |
| KHAW repo has no Python project config (no pyproject/venv) | Low | Bridge is stdlib-only; tests run from repo root via the same uv invocation |
| Two-repo coordination — genie and KHAW changes land in different repos | Medium | khaw-bridge group is isolated to the KHAW repo with its own commits/review; payload contract mirrored from Group 1 keeps the surfaces consistent |
| Stale planning checkout — this branch lacks `profiles/` entirely, while `origin/main` ships a populated 7-file profile seed | Low | Wish branch is cut from `origin/main` (see Branch field); Group 3 modifies the existing seed README, preserving its content; no SOUL.md work in MVP |

---

## Review Results

| Scope | Verdict | Notes |
|-------|---------|-------|
| Plan review (pre-execution) | FIX-FIRST → SHIP | profiles/ grounding corrected (seed exists on main), env-var scoping + validation fixes |
| Group 1 plugin-core | FIX-FIRST → SHIP | reviewer proved a path-traversal exploit; fixed with `validate_ref` + in-bounds WISH.md read incl. symlink-escape defense; 28 tests |
| Group 2 plugin-surface | SHIP | 3 LOWs applied (tilde-cwd degrade, list-argv advisory); 46 tests |
| Group 3 plugin-docs | SHIP | 2 LOW doc fixes applied (`ln -sfn`, payload wording); both install modes verified |
| Group 4 khaw-bridge | SHIP | read-only invariant proven (grep + tests + before/after snapshots); 15+29 tests green in KHAW |
| Group 5 validation-e2e | PASS | live Hermes smoke native (`/genie help/status` in `hermes chat`); evidence in KHAW `docs/evidence/genie-hermes-khaw-native-surface-smoke-2026-07-04.md` |
| Promotion #2516 (dev→main) | MERGE (×2 independent) | merge-integrity proof (1 conflict, superset resolution, 0 reversions); 6 bot findings verified — follow-ups fixed in #2520 (reaction guard, `--`, stderr) and follow-up branches |

Shipped: genie stable ≥ 5.260704.3 (plugin synced to `~/.genie/plugins/hermes-genie` on update); KHAW dev `7658d93`.

---

## Files to Create/Modify

```
# genie repo (/home/feliperosa/vm-home/workspace/repos/genie)
plugins/hermes-genie/plugin.yaml                          create  (G1)
plugins/hermes-genie/__init__.py                          create  (G1, extended G2)
plugins/hermes-genie/genie_bridge.py                      create  (G1)
plugins/hermes-genie/schemas.py                           create  (G1)
plugins/hermes-genie/commands.py                          create  (G2)
plugins/hermes-genie/hooks.py                             create  (G2)
plugins/hermes-genie/skills/genie/SKILL.md                create  (G2)
plugins/hermes-genie/skills/genie-work/SKILL.md           create  (G2)
plugins/hermes-genie/skills/genie-review/SKILL.md         create  (G2)
plugins/hermes-genie/skills/genie-khaw-bridge/SKILL.md    create  (G2)
plugins/hermes-genie/tests/test_plugin_contract.py        create  (G1, extended G2)
plugins/hermes-genie/tests/test_genie_bridge.py           create  (G1)
plugins/hermes-genie/tests/test_commands.py               create  (G2)
plugins/hermes-genie/README.md                            create  (G3)
plugins/hermes-genie/references/native-surface.md         create  (G3)
plugins/hermes-genie/references/mutation-gates.md         create  (G3)
plugins/hermes-genie/scripts/install-local.sh             create  (G3)
plugins/hermes-genie/scripts/smoke.sh                     create  (G3)
README.md                                                 modify  (G3)
plugins/genie/README.md                                   modify  (G3)
profiles/hermes/genie/README.md                           modify  (G3)

# KHAW repo (/home/feliperosa/vm-home/prod/khaw)
plugins/khaw/genie_bridge.py                              create  (G4)
plugins/khaw/__init__.py                                  modify  (G4)
plugins/khaw/plugin.yaml                                  modify  (G4)
manifest/khaw-additions.yaml                              modify  (G4)
tests/contract/test_khaw_genie_bridge.py                  create  (G4)
tests/contract/test_khaw_harness.py                       modify  (G4)
docs/evidence/genie-hermes-khaw-native-surface-smoke-<date>.md  create  (G5)
```
