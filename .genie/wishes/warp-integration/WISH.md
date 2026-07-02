# Wish: Warp Integration — `genie init`, Launch-Config Emitter, Multi-Session /work

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `warp-integration` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~3-4 days |
| **Branch** | `wish/warp-integration` (from `dev` — now v5 mainline; PR back to `dev`) |
| **Design** | [DESIGN.md](../../brainstorms/genie-v5-lightweight-body/DESIGN.md) — umbrella Group 3 |
| **Depends on** | wishes `v5-foundation`, `v5-demolition`, `taxonomy-rehoming` (all DONE, merged to dev) |

## Summary

The original v5 thesis: stop controlling agents, let Warp be the multi-session cockpit. This wish makes that real — `genie init` scaffolds a repo (closing the e2e's ignore-rules TODO), a launch-config emitter turns a wish's ready groups into a Warp Launch Configuration (one pane per group, each in its own worktree, each running its agent), and `genie launch <slug>` creates the worktrees, writes the config, and opens Warp via the `warp://launch/` URI. `/work` gains an opt-in multi-session mode on top of its default native-team dispatch.

## Scope

### IN
- **`genie init`**: idempotent repo scaffold — create `.genie/` with `INDEX.md` (jar skeleton) if absent, append the three `genie.db*` ignore rules to the repo `.gitignore` if missing (exactly what the e2e currently hand-copies — its qa.md TODO closes), print honest next steps (skills lifecycle, `genie board`). No network, no daemon, re-runnable with zero diff the second time.
- **Warp launch-config emitter** (`src/lib/v5/warp-launch.ts`): pure function from `{slug, groups: [{name, worktreePath, command}]}` to Launch Configuration YAML (schema: name/windows/tabs/title/color/layout/cwd/split_direction/panes/commands/exec; `cwd` MUST be absolute — Warp rejects `~`). Pane placement: up to 4 panes per tab (2x2 via nested splits), overflow to additional tabs titled `<slug> (2)`, …. Platform-aware config-dir resolution: macOS `~/.warp/launch_configurations/`, Linux `${XDG_DATA_HOME:-~/.local/share}/warp-terminal/launch_configurations/`. Emitted file: `genie-<slug>.yaml`.
- **`genie launch <slug>`**: reads the wish's ready groups from genie.db (tasks with `--wish <slug>`, status ready), creates one worktree per group (`git worktree add` under `~/.genie/worktrees/<repo>-<slug>-<group>/`, branch `wish/<slug>-<group>` from the current branch; reuse if it already exists), writes each group's kickoff prompt to a file (`<worktree>/.genie/launch/<group>.prompt`; the YAML pane command is `claude "$(cat <abs-prompt-path>)"`) — the prompt names the wish, the group, and every ready task id in the group with per-task `genie task checkout <id> --worker <group>` claim instructions (one pane per GROUP, claiming all its ready tasks); writes the launch config, then opens it (`open "warp://launch/<abs-path>"` on macOS; on Linux try `xdg-open`; if neither works, print the path + URI and exit 0 — emitting is the contract, opening is best-effort). `--dry-run` prints the YAML + planned worktrees without touching disk. `--no-open` writes but doesn't launch.
- **Command surface reconciliation**: `init` and `launch` register top-level; the v4 `install` no-op stub is REMOVED (it does nothing and its "managed installs" reservation moved to the distribution wish) — net: 11 real commands. README command table + count updated; `genie setup` line reviewed for overlap with init (setup = global config/hooks, init = per-repo scaffold — both stay, distinction documented).
- **/work multi-session opt-in** (repo `skills/work/SKILL.md`): a new "Multi-session dispatch (Warp)" subsection — when the user asks for parallel sessions (or the wave is large), the orchestrator MAY run `genie launch <slug>` for the wave's groups instead of Agent-tool dispatch; state flows through the same genie.db claims either way; native-team dispatch stays the default. skills-lint stays green (`launch` and `init` exist in `--help` after this wish).
- **Tests + e2e**: unit tests for the emitter (YAML snapshot, absolute-cwd invariant, 4-pane overflow, platform paths via injected env), init idempotency tests (fresh repo → scaffold; second run → no diff), launch `--dry-run` test against a fixture wish in genie.db; `tests/e2e/v5-lifecycle.sh` switches its hand-copied ignore-rules step to `genie init` (closing the recorded TODO) and gains a `genie launch --dry-run` assertion.
- Docs coherence: README (commands, one Warp paragraph moved from Roadmap to shipped-with-caveats — launching requires Warp installed; emitting works everywhere), TAXONOMY.md worktree note if paths change.

### OUT
- Warp **Tab Configs** (.toml) — the newer format has no confirmed programmatic launch path (open feature requests warpdotdev/Warp#9083, #12343); legacy launch configs are URI-launchable today and still supported. Revisit when Tab Config URI lands — recorded as a follow-up, the emitter's output layer is the swap point.
- Driving real Warp in CI (no Warp on runners — `--dry-run` is the CI surface; real-launch verification is a manual QA note).
- Omni port (next wish), Codex/Hermes emit, CDN distribution, version-scheme change.
- Warp AI rules/profiles templates — YAGNI until a concrete need; `genie init` scaffolds genie's own things only.
- Windows support (unchanged umbrella deferral).
- Changing /work's default dispatch — native teams remain primary; Warp is opt-in.
- User-level `~/.claude/skills` update for the launch mode — follows once the repo skill pattern settles (one-line pointer is enough for now).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Target legacy Launch Configurations (YAML + `warp://launch/` URI), not Tab Configs | Launch configs are programmatically launchable TODAY and still supported; Tab Configs have no URI/CLI path yet (open upstream issues). The emitter isolates the format for a later swap |
| 2 | Opening Warp is best-effort; emitting the config is the contract | Headless/CI/Linux-without-warp environments must not fail the command; the file + URI are always printed |
| 3 | Worktrees live under `~/.genie/worktrees/<repo>-<slug>-<group>/` | Matches the v4 convention already noted in .gitignore; keeps repo clean; survives repo moves |
| 3b | `git worktree add` is the mechanism — NOT `git clone --shared`, despite the v4-era comment in src/genie.ts:30-31 | genie.db state sharing is DESIGNED on worktrees: genie-db resolves the store via `git rev-parse --git-common-dir`, and the foundation's two-real-worktrees test proves it. A shared clone has its own .git → its own genie.db → state fragmentation. The historical core.bare-corruption fear is mitigated: the startup guard in genie.ts stays, and G3 asserts `core.bare` remains false on the parent after multi-worktree creation |
| 4 | `install` no-op stub removed; net 11 top-level commands | A stub that prints "no-op" is surface without substance; the managed-install reservation belongs to the distribution wish; README count updated honestly |
| 5 | Pane command is `claude "$(cat <prompt-file>)"` — prompt written to `<worktree>/.genie/launch/<group>.prompt`, YAML carries only the path | Keeps genie out of the agent-control business; sidesteps YAML-escaping of long prompts entirely; the prompt stays inspectable on disk. One pane per GROUP; the prompt enumerates all the group's ready task ids with per-task checkout instructions |
| 6 | /work multi-session is opt-in, native teams default | Native dispatch works everywhere with zero setup; Warp mode needs Warp + human eyes on panes — the orchestrator can't await pane-session completion programmatically, so it's for interactive supervision |

## Success Criteria

- [ ] Fresh repo: `genie init` scaffolds `.genie/INDEX.md` + gitignore rules; second run exits 0 with no diff (test-proven).
- [ ] `genie launch <slug> --dry-run` on a fixture wish prints valid launch-config YAML (parseable, absolute cwds, one pane per ready group, correct overflow) and the planned worktrees, touching nothing (test-proven).
- [ ] Real run (manual QA, recorded in qa notes): `genie launch` on a 3-group wish creates 3 worktrees, writes `genie-<slug>.yaml` in the platform config dir, and opens Warp with 3 panes, each in its worktree.
- [ ] The e2e drives ignore rules via `genie init` (TODO closed) and asserts the `--dry-run` output; full suite + `bun run check` green.
- [ ] `install` gone; `init` + `launch` present; `--help` shows 11 commands; README table matches reality (grep-gated).
- [ ] `skills/work/SKILL.md` documents the opt-in Warp mode; skills-lint green.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1, Group 2 | init (CLI+scaffold) ∥ emitter (pure lib) — disjoint files |
| 2 | Group 3 | `genie launch` composes G1's conventions + G2's emitter; command-surface reconciliation |
| 3 | Group 4 | /work skill + e2e + README coherence over the finished surface |

---

## Execution Groups

### Group 1: `genie init`
**Goal:** Idempotent per-repo scaffold — the onboarding command genie has been missing.

**Deliverables:**
1. `src/term-commands/init.ts` — `genie init`: create `.genie/INDEX.md` (jar skeleton: Raw/Simmering/Ready/Poured) if absent; append `.genie/genie.db`, `.genie/genie.db-wal`, `.genie/genie.db-shm` to `.gitignore` (create it if the repo lacks one) only when missing; refuse politely outside a git repo (typed error, exit 1); `--json` optional. Print next steps (skills lifecycle + `genie board`).
2. Registration in `src/genie.ts`.
3. Colocated tests: fresh tmp repo scaffold, second-run no-diff (compare file bytes), no-git-repo refusal, existing-partial-state merge (INDEX exists but rules missing → only rules added).

**Acceptance Criteria:**
- [x] Idempotency proven by byte-comparison test.
- [x] Non-repo cwd → exit 1 with clear stderr.
- [x] typecheck + tests green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/term-commands/init.test.ts
bun run typecheck
bun run build
bun dist/genie.js init --help >/dev/null
```

**depends-on:** none

---

### Group 2: Warp launch-config emitter
**Goal:** A pure, tested library that turns groups+worktrees into schema-correct Warp YAML.

**Deliverables:**
1. `src/lib/v5/warp-launch.ts` — types (`LaunchSpec`, `PaneSpec`), `buildLaunchConfigYaml(spec)` (pure), `resolveWarpConfigDir(env)` (platform-aware, injectable env for tests), `writeLaunchConfig(spec)` (returns absolute path), `launchUri(path)` (`warp://launch/<abs-path>`). Absolute-cwd invariant enforced (throw typed error on relative/`~`). 4-panes-per-tab overflow via nested vertical/horizontal splits; tab titles `<slug>`, `<slug> (2)`…; tab color cycling from the allowed ANSI set.
2. YAML emission via the runtime's built-in `Bun.YAML.stringify` (verified present in Bun 1.3.9; binary is bun-target) — build a plain object, stringify; NO hand-rolled YAML, NO new dependency. Colocated tests: round-trip via `Bun.YAML.parse` for 1/3/4/5/9-group specs (structure: pane counts, tab overflow, cwds), absolute-cwd rejection, hostile-content round-trip (spaces/quotes/`&&` in titles and commands — stringify owns the quoting, tests prove it), platform dir resolution (darwin/linux + XDG override).

**Acceptance Criteria:**
- [x] No new runtime dependency (package.json unchanged).
- [x] Emitted YAML matches the documented schema (name/windows/tabs/layout/cwd/split_direction/panes/commands/exec) and quoting survives hostile titles/commands.
- [x] typecheck + tests green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/lib/v5/warp-launch.test.ts
bun run typecheck
if git diff --name-only | grep -q '^package.json$'; then echo "FAIL: new dependency introduced"; exit 1; fi
```

**depends-on:** none

---

### Group 3: `genie launch` + command-surface reconciliation
**Goal:** One command from wish slug to open Warp cockpit; the CLI surface tells the truth.

**Deliverables:**
1. `src/term-commands/launch.ts` — `genie launch <slug>`: read ready tasks for the wish from genie.db (reuse `listTasks`/`genie task list --wish --status ready --json`), grouped by `group_name` — one PANE per distinct group, a group's pane owns all its ready tasks; per group ensure a worktree at `~/.genie/worktrees/<repo>-<slug>-<group>/` (branch `wish/<slug>-<group>`; reuse existing; typed error if the path exists but isn't a worktree); write each group's kickoff prompt to `<worktree>/.genie/launch/<group>.prompt` (pane command: `claude "$(cat <abs-prompt-path>)"`; prompt enumerates wish slug, group name, ALL the group's ready task ids, and per-task checkout instructions); call the G2 emitter; open via `open`/`xdg-open` on the URI, best-effort (Decision 2) — always print path + URI. Flags: `--dry-run` (print YAML + planned worktrees, touch nothing), `--no-open`, `--groups <csv>` (subset).
2. Remove the `install` no-op: registration + `src/genie-commands/install.ts` + its references (update.ts imports pm2 names from install? — verify; the stub was already severed in demolition G2, confirm and delete cleanly).
3. Registration; README command table update (11 commands: board, doctor, hook, init, launch, setup, shortcuts, task, uninstall, update, help); command-count gate references updated if any assert ≤10 (demolition's historical criterion stays historical — only live gates/text change).
4. Colocated tests: dry-run against a fixture wish (create tasks in a tmp repo's genie.db, assert YAML pane count/cwds/commands and zero side effects), worktree creation + reuse + collision error (real git repos in tmp), subset via `--groups`.

**Acceptance Criteria:**
- [ ] `--dry-run` provably touches nothing (no worktrees, no config file — asserted).
- [ ] Worktree lifecycle correct incl. reuse and collision; parent repo's `core.bare` remains `false` after creating multiple worktrees (asserted in tests — the historical corruption mode the genie.ts guard exists for).
- [ ] `install` gone from `--help`; `init`+`launch` present; count = 11.
- [ ] typecheck + full test suite green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/term-commands/launch.test.ts
bun run typecheck
bun run build
HELP=$(bun dist/genie.js --help)
echo "$HELP" | grep -qE '^  launch' || { echo "FAIL: launch missing"; exit 1; }
echo "$HELP" | grep -qE '^  init' || { echo "FAIL: init missing"; exit 1; }
if echo "$HELP" | grep -qE '^  install'; then echo "FAIL: install stub still present"; exit 1; fi
COUNT=$(echo "$HELP" | grep -cE '^  [a-z]')
[ "$COUNT" -eq 11 ] || { echo "FAIL: expected 11 commands, got $COUNT"; exit 1; }
```

**depends-on:** group-1, group-2

---

### Group 4: /work opt-in mode, e2e, docs coherence
**Goal:** The skill, the e2e, and the README all reflect the shipped surface.

**Deliverables:**
1. `skills/work/SKILL.md`: "Multi-session dispatch (Warp)" subsection — when to use (interactive supervision of a large wave / user asks), how (`genie launch <slug> --groups …`), what stays the same (genie.db claims, reviewer≠engineer, orchestrator validates), and the honest limitation (the orchestrator cannot await pane sessions — human-in-the-loop mode). Native-team dispatch remains the documented default.
2. `tests/e2e/v5-lifecycle.sh`: ignore-rules step replaced with `bun "$DIST" init` (closes the qa.md TODO — update the qa.md note); new assertion block placed IMMEDIATELY AFTER task creation (while all 3 groups are still ready — later lifecycle steps consume the ready set): `launch --dry-run` emits YAML containing one pane per ready group with absolute cwds.
3. README: command table (from G3), Warp paragraph moved from Roadmap to a shipped section with the honest caveat (emitting works everywhere; opening requires Warp; real cockpit = macOS/Linux with Warp installed); Roadmap keeps Tab-Config upgrade + deeper integration as future. NOTE: the README↔help command-existence check below is INTRODUCED by this group (no committed gate exists today — prior uses were one-shot validation); it stays a wish-validation one-shot for now, graduating into `bun run check` only if a later wish decides so.
4. Manual QA note (`.genie/wishes/warp-integration/qa.md`): the real-Warp 3-pane run recorded with observations (this machine has Warp).

**Acceptance Criteria:**
- [ ] e2e green with init-driven scaffold + dry-run assertion; full `bun run check` green.
- [ ] skills-lint green (launch/init resolvable in fresh build).
- [ ] README names only real commands (the command-existence check introduced here) and the Warp section matches Decision 2's honesty.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
bun run check
HELP=$(bun dist/genie.js --help)
for c in $(grep -oE '`genie [a-z]+' README.md | sed 's/`genie //' | sort -u); do
  echo "$HELP" | grep -qE "^  $c( |$)" || { echo "FAIL: README names missing command: $c"; exit 1; }
done
test -f .genie/wishes/warp-integration/qa.md
```

**depends-on:** group-3

---

## Cross-wish dependencies

- **Follows:** v5-foundation / v5-demolition / taxonomy-rehoming (merged to dev).
- **Next after this:** omni runner port (umbrella Group 5).
- **Feeds:** distribution wish (managed-install reservation moved there; Tab-Config upgrade recorded as follow-up).
