# Wish: Unified output primitives (genie side)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `output-primitives-unified` |
| **Date** | 2026-05-04 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | medium (~4–6 engineer-days) |
| **Branch** | `wish/output-primitives-unified` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [SHARED-DESIGN.md](./SHARED-DESIGN.md) |

> **Companion document:** [SHARED-DESIGN.md](./SHARED-DESIGN.md) — cross-repo unification spec (byte-identical to `automagik/omni#output-primitives-unified` SHARED-DESIGN.md).
> **Sibling wish:** [`automagik/omni#output-primitives-unified`](../../../../omni/.genie/wishes/output-primitives-unified/WISH.md) — both wishes ship in parallel; each repo owns its own implementation; only the public surface (`output.ts` exports, glyph table, JSON-mode contract) is shared.

## Summary

Genie has zero centralized output helpers. Across `src/genie-commands/*.ts` (11 command files), the codebase has **175+ direct `console.log` / `console.error` / `console.warn` calls** and **115+ hardcoded ANSI escape sequences** (literal `\x1b[32m`, `\x1b[31m`, etc.). Worst offenders: `setup.ts` (38 ansi / 66 console calls), `doctor.ts` (33/62), `update.ts` (9/46), `uninstall.ts` (18/28). No JSON output mode. No `NO_COLOR` honoring. No pipe-buffer drain (`bun` truncates `--json | cat > file` writes >64KB on Linux). No table render helper. Glyph drift between files.

This wish ports omni's battle-tested `output.ts` (322 LOC, 11 functions, JSON+human dual-mode, pipe-flush-aware) into `automagik-dev/genie/src/lib/output.ts` byte-for-byte, extends it with the new `step` / `spinner` / `banner` / `progress` / `divider` primitives that the install/update flows need, migrates all 7 affected command files to use it, adds `chalk` + `ora` + `boxen` + `cli-progress` deps, and lands a lint rule banning bare `console.log` outside `output.ts` itself. Result: zero hardcoded ANSI in command files, identical look-and-feel between `genie` and `omni`, JSON mode usable for agent consumption.

## Scope

### IN

**Group 1 — `output.ts` foundation (omni parity)**
- Create `src/lib/output.ts` byte-similar in shape to omni's reference.
- Exports: `success`, `error`, `warn`, `tip`, `info`, `data`, `list`, `keyValue`, `header`, `dim`, `raw`, `disableColors`, `areColorsEnabled`, `getCurrentFormat`, `flushStdout`, `setMaxCellWidth`.
- JSON-mode contract per `SHARED-DESIGN.md` §5.
- `NO_COLOR` / TTY auto-detect per `SHARED-DESIGN.md` §6.
- `flushStdout()` wired into `src/genie.ts` exit hook so `--json | cat > file` doesn't truncate.
- Resolution of "current format" via a new `~/.genie/config.json` field `outputFormat: 'human' | 'json'` defaulting to `'human'`, overridable by CLI `--json` flag.

**Group 2 — `output.ts` extensions (additions to the shared surface)**
- `step(message)` — bold cyan ▸ stage divider.
- `spinner(text): OutputSpinner` — ora wrapper with format-aware degradation.
- `banner(message, options): void` — boxen wrapper.
- `progress(label): OutputProgress` — cli-progress wrapper.
- `divider(): void` — `─` × terminal width.
- Tests for every new export per `SHARED-DESIGN.md` §10.

**Group 3 — Migrate `update.ts`**
- Replace 9 ANSI escapes + 46 `console.log` calls with `output.*`.
- Closes the loop on `update-unify-stages` G5 (which proposed `ora` + `chalk` migration; this wish is what actually ships it via `output.spinner` + `output.banner`).
- The `verify` block of the diagnostic schema gets a final-banner render via `output.banner`.

**Group 4 — Migrate `install.ts` + `setup.ts` + `uninstall.ts`**
- Replace ~152 `console.log` calls + ~94 ANSI escapes across these three files.
- Install/uninstall pipelines get `output.step` for stage dividers, `output.spinner` for long ops, `output.banner` for terminal "installation complete" / "uninstall complete" announcements.
- Setup wizard prompts unchanged (we don't touch input flow); only output flow.

**Group 5 — Migrate `doctor.ts` + `perf-check.ts` + `shortcuts.ts` + `session.ts`**
- Replace remaining ~108 `console.log` + ~50 ANSI escapes.
- `doctor.ts` gets `output.list` for check tables, `output.banner` for final pass/fail summary.
- `perf-check.ts` benchmark output uses `output.list` + `output.keyValue`.
- `session.ts` ID/name/PID listing uses `output.data` (auto-table).

**Group 6 — Lint rule + CHANGELOG**
- Custom Biome / regex-based lint rule (`scripts/lint/no-bare-console.cjs`) that fails CI when any file under `src/genie-commands/` or `src/term-commands/` calls `console.{log,error,warn}` without an explicit `// biome-ignore lint/genie/no-bare-console: <reason>` comment.
- `output.ts` itself is allowlisted.
- CHANGELOG entry naming the contract: *"Genie command output now flows through `output.ts`. Direct `console.log` calls are lint-blocked outside the helper itself."*
- Help text in `genie --help` (and per-subcommand help) gets a one-line note: `Run with --json for machine-readable output. Run with --no-color to disable ANSI.`

### OUT

- **Ink, OpenTUI, Solid for command output.** Streaming linear output stays linear; per `SHARED-DESIGN.md` §11.
- **Modifying genie's existing TUI** (`src/tui/`). OpenTUI keeps owning the TUI; this wish only touches `src/genie-commands/` and `src/term-commands/`.
- **Internationalization.** Messages stay English-only.
- **Telemetry on output.** Separate wish.
- **Cross-CLI shared package.** Independent implementations per `SHARED-DESIGN.md` decision #1.
- **Replacing `commander` help-text styling.** Commander owns its surface.
- **Migrating `src/term-commands/*.ts`** beyond what intersects with the 7 files above. Term-commands get a follow-up wish if the audit shows ANSI drift there too.
- **`terminal-link` adoption.** Deferred to v2 per `SHARED-DESIGN.md` decision #8.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Port omni's `output.ts` byte-for-byte rather than design our own | omni's 322-LOC version has 6+ months of production hardening (pipe-flush bug fixes, JSON-mode bugs, table-render edge cases). Don't reinvent. |
| 2 | Land in `src/lib/output.ts` (not `src/genie-commands/output.ts`) | Reusable across `src/genie-commands/`, `src/term-commands/`, `src/lib/` — anywhere the CLI prints. |
| 3 | `--json` flag added at the root command level (not per subcommand) | One mental model. Subcommands inherit. |
| 4 | Lint rule lands in same wish as the migration | Without it, drift returns. Tested by deliberately adding a `console.log` and watching CI fail. |
| 5 | Glyph + color choices match the bash `install.sh` helpers | bash and TS sides look identical to operators. |
| 6 | `flushStdout()` wired in `src/genie.ts` exit hook (not per-command) | Catch every code path; centrally owned. |
| 7 | New deps (`chalk`, `ora`, `boxen`, `cli-progress`) added in Group 1 | Without them, Group 1 doesn't compile. |
| 8 | `outputFormat` config field added to `~/.genie/config.json` | Lets operators set a permanent default without `--json` on every invocation. |

## Success Criteria

- [ ] `src/lib/output.ts` exists with the 16 baseline exports + 5 new exports per `SHARED-DESIGN.md` §3.
- [ ] `chalk`, `ora`, `boxen`, `cli-progress` added to `package.json` at the locked versions.
- [ ] All 7 command files (`update.ts`, `install.ts`, `setup.ts`, `uninstall.ts`, `doctor.ts`, `perf-check.ts`, `shortcuts.ts`) have ZERO direct `console.log/error/warn` calls and ZERO hardcoded ANSI escapes.
- [ ] `genie update --json` produces stdout-only valid JSON; spinner/banner/info/warn/tip messages route to stderr as `{ spinner|banner|info|warn|tip: "..." }` lines.
- [ ] `genie update | cat > file.txt` (piped, non-TTY) produces no spinner animation, no \r overwrites; `info`/`success` lines render as plain text without color.
- [ ] `NO_COLOR=1 genie update` produces no color codes anywhere.
- [ ] `FORCE_COLOR=1 genie update | cat > file.txt` produces ANSI even when piped.
- [ ] `genie update --json` written to a file >64KB does not truncate (validates `flushStdout` wired in exit hook).
- [ ] Lint rule blocks a deliberate `console.log` added to `src/genie-commands/test-fixture.ts` (CI red).
- [ ] CHANGELOG entry present.
- [ ] All existing `__tests__/*.test.ts` continue to pass byte-identically (visual snapshots updated where applicable).
- [ ] `bun run check` (typecheck + lint + dead-code + tests) passes on the wish branch.

## Execution Strategy

### Wave 1 — Foundation (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Create `src/lib/output.ts` (port from omni) + add 4 deps + wire `flushStdout` in exit hook + JSON-mode plumbing. |
| 2 | engineer | Add `step` / `spinner` / `banner` / `progress` / `divider` to the surface. Tests for every new export. |

### Wave 2 — Migration (sequential after Wave 1, but Groups 3-5 can run parallel by file disjointness)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Migrate `update.ts` (proves the API in production). |
| 4 | engineer | Migrate `install.ts` + `setup.ts` + `uninstall.ts`. |
| 5 | engineer | Migrate `doctor.ts` + `perf-check.ts` + `shortcuts.ts` + `session.ts`. |

### Wave 3 — Enforcement (sequential after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Lint rule + CHANGELOG + help-text note. |

## Execution Groups

### Group 1: `output.ts` foundation

**Goal:** Ship the canonical helper with omni-parity surface, no migrations yet.

**Deliverables:**
1. `src/lib/output.ts` — port byte-similar from `omni/packages/cli/src/output.ts` (322 LOC). Adapt imports for genie's module layout.
2. `package.json` adds: `chalk@^5.4.0`, `ora@^8.1.1`, `boxen@^7.1.1`, `cli-progress@^3.12.0`. `bun install` re-locks.
3. `src/lib/genie-config.ts` — extend with `outputFormat?: 'human' | 'json'` field; default `'human'`.
4. `src/genie.ts` — root-level `--json` flag wired; `--no-color` flag; `flushStdout()` invoked in process-exit hook.
5. Tests at `src/lib/__tests__/output.test.ts` — every baseline export, JSON mode, NO_COLOR, pipe-flush.

**Acceptance Criteria:**
- [ ] `import { success, error, warn, info, tip, data, list, keyValue, header, dim, raw } from '../lib/output.js'` resolves and typechecks.
- [ ] `genie --json --version` emits `{"version":"..."}\n` (canonical JSON) to stdout.
- [ ] `genie --no-color --version` emits no ANSI.
- [ ] `flushStdout()` called from a synthetic 70KB `--json` write path; output not truncated.
- [ ] `__tests__/output.test.ts` passes; >90% line coverage.

**Validation:**
```bash
bun test src/lib/__tests__/output.test.ts
bun run typecheck
genie --json --version | jq .
NO_COLOR=1 genie --version | grep -v $'\x1b'
```

**depends-on:** none

---

### Group 2: `step` / `spinner` / `banner` / `progress` / `divider`

**Goal:** Add the 5 new primitives that install/update flows need. Pure additions to `output.ts`.

**Deliverables:**
1. `src/lib/output.ts` extension with the 5 new exports per `SHARED-DESIGN.md` §3.
2. Stub implementations for JSON mode (stderr emission) per `SHARED-DESIGN.md` §5.
3. Non-TTY degradation for `spinner` and `progress` per `SHARED-DESIGN.md` §6.
4. Tests covering: human TTY path, human non-TTY path, JSON mode, NO_COLOR.

**Acceptance Criteria:**
- [ ] `step('Installing dependencies...')` emits bold-cyan `▸ Installing dependencies...` in human mode.
- [ ] `step` emits `{ step: "..." }` to stderr in JSON mode.
- [ ] `spinner('Checking version...').start().succeed('v1.2.3')` produces a real ora animation in TTY mode.
- [ ] `spinner` in non-TTY mode degrades to plain `info` line on start, `success` on succeed, no `\r`.
- [ ] `banner('Updated to v1.2.3', { borderStyle: 'double', borderColor: 'green' })` produces a 3-line boxed banner.
- [ ] `progress('Downloading binary')` returns a working `cli-progress.SingleBar` in TTY mode; in JSON mode emits at most one `{ progress: ... }` line per second.
- [ ] `divider()` prints `─` × `process.stdout.columns || 80` in human mode; no-op in JSON mode.

**Validation:**
```bash
bun test src/lib/__tests__/output.test.ts -t "step\|spinner\|banner\|progress\|divider"
```

**depends-on:** Group 1

---

### Group 3: Migrate `update.ts`

**Goal:** Eliminate all 9 ANSI escapes + 46 `console.log` calls in `src/genie-commands/update.ts`. Final banner uses `output.banner`. Spinners replace each `▸` step. Closes the `update-unify-stages#g5` loop.

**Deliverables:**
1. `update.ts` — every `console.log`, `console.error`, `console.warn` replaced with the appropriate `output.*` call.
2. The 3-line success banner (CLI v… / Server v… / Auth …) wrapped in `output.banner` with `borderStyle: 'round'` + `borderColor: 'green'`.
3. Each install / restart / verify step uses `output.spinner`.
4. Tests at `src/genie-commands/__tests__/update.test.ts` — the existing locked-string tests need a 1-line update where the literal `\x1b[32m✔\x1b[0m` is replaced by `output.success` invocation; the test asserts the call rather than the literal output. Snapshot tests for the banner.

**Acceptance Criteria:**
- [ ] `grep -E '\\\\x1b\[|console\.(log|error|warn)' src/genie-commands/update.ts | wc -l` → `0`.
- [ ] `genie update --json | jq` parses cleanly; spinners/banners go to stderr.
- [ ] Banner renders identically (visual snapshot lock).
- [ ] All existing `update.test.ts` cases pass.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts
grep -E '\\\\x1b\[|console\.(log|error|warn)' src/genie-commands/update.ts | wc -l
```

**depends-on:** Group 2

---

### Group 4: Migrate `install.ts` + `setup.ts` + `uninstall.ts`

**Goal:** Eliminate all `console.log` + ANSI in the install/setup/uninstall trio (~152 + 94 occurrences combined).

**Deliverables:**
1. `install.ts` — all output through `output.*`; each install stage gets `output.step`; final "installation complete" banner via `output.banner`.
2. `setup.ts` — same pattern. Setup wizard input (prompts) unchanged; only output flow.
3. `uninstall.ts` — same pattern. Final "uninstall complete" banner.
4. Tests adjusted; snapshot tests for the banners.

**Acceptance Criteria:**
- [ ] Each of the 3 files has zero direct `console.*` and zero ANSI literals.
- [ ] `genie install --dry-run --json` produces parseable stdout JSON.
- [ ] `genie uninstall --dry-run` shows step-by-step `▸` lines via `output.step`.

**Validation:**
```bash
for f in install setup uninstall; do
  echo "=== $f.ts ==="
  grep -cE '\\\\x1b\[|console\.(log|error|warn)' "src/genie-commands/$f.ts"
done
bun test src/genie-commands/__tests__/install.test.ts
bun test src/genie-commands/__tests__/setup.test.ts
bun test src/genie-commands/__tests__/uninstall.test.ts
```

**depends-on:** Group 2

---

### Group 5: Migrate `doctor.ts` + `perf-check.ts` + `shortcuts.ts` + `session.ts`

**Goal:** Eliminate all `console.log` + ANSI in the diagnostics + ergonomics trio (~108 + 50 occurrences combined).

**Deliverables:**
1. `doctor.ts` — diagnostic checks render via `output.list` (table) or `output.keyValue` (per-check); final pass/fail summary via `output.banner`.
2. `perf-check.ts` — benchmark results via `output.list` (sorted descending by ms) + `output.keyValue` for the headline.
3. `shortcuts.ts` — keymap listing via `output.list`.
4. `session.ts` — session listing via `output.data` (auto-table).
5. Tests adjusted.

**Acceptance Criteria:**
- [ ] Each of the 4 files has zero direct `console.*` and zero ANSI literals.
- [ ] `genie doctor --json` produces a parseable check-list array.
- [ ] `genie perf-check --json` produces a parseable benchmark array.
- [ ] `genie shortcuts --json` produces a parseable keymap object.
- [ ] `genie session ls --json` produces a parseable session array.

**Validation:**
```bash
for f in doctor perf-check shortcuts session; do
  echo "=== $f.ts ==="
  grep -cE '\\\\x1b\[|console\.(log|error|warn)' "src/genie-commands/$f.ts"
done
bun test src/genie-commands/__tests__/
```

**depends-on:** Group 2

---

### Group 6: Lint rule + CHANGELOG + help-text

**Goal:** Lock the contract. Make regression a CI fail.

**Deliverables:**
1. `scripts/lint/no-bare-console.cjs` — Node script that scans `src/genie-commands/` and `src/term-commands/`, fails on any `console.{log,error,warn}` not preceded by `// biome-ignore lint/genie/no-bare-console: <reason>`.
2. Wire into `bun run check` and `bun run lint`.
3. `CHANGELOG.md` entry: *"Output unified through `src/lib/output.ts`. Bare `console.log` calls in `src/genie-commands/` and `src/term-commands/` are now lint-blocked. Use `output.{success,info,warn,error,step,spinner,banner,progress,divider}` instead."*
4. `genie --help` (root) gets a 2-line append: `Output flags: --json (machine-readable), --no-color (no ANSI). Per-subcommand help shows applicable variants.`
5. Test deliberately adds `console.log("test")` to a fixture file under `src/genie-commands/.test-fixtures/`, runs the lint, asserts non-zero exit.

**Acceptance Criteria:**
- [ ] `bun run lint` fails on a deliberately-added bare `console.log` in `src/genie-commands/`.
- [ ] `bun run lint` passes on the migrated tree.
- [ ] CHANGELOG entry present.
- [ ] `genie --help | grep -E 'json|no-color'` matches the new lines.

**Validation:**
```bash
bun run lint && echo "OK"
grep -F "Output unified through" CHANGELOG.md
genie --help | grep -E '(--json|--no-color)'
```

**depends-on:** Group 5

---

## Cross-wish dependencies

- **paired-with** [`automagik/omni#output-primitives-unified`](../../../../omni/.genie/wishes/output-primitives-unified/WISH.md) — both wishes ship in parallel against their respective `dev` branches. omni's existing `output.ts` is the byte-reference; this wish absorbs it.
- **builds-on** `update-unify-stages#g5` — that wish proposed migrating `update.ts` to ora+chalk; this wish closes the loop by delivering the actual `output.spinner` + `output.banner` primitives that g5 needs.
- **enables** future `term-commands` migrations, future `--json` mode for any subcommand.

## QA Criteria

_What must be verified on `dev` after merge._

- [ ] Functional — `genie update`, `genie install`, `genie setup`, `genie doctor`, `genie perf-check`, `genie shortcuts`, `genie session` all visually identical post-migration (checked against pre-migration baseline screenshots; minor formatting drift OK if explained).
- [ ] Functional — `--json` mode works for every migrated subcommand; stdout is valid JSON; stderr has all human breadcrumbs.
- [ ] Functional — `--no-color` mode produces zero ANSI for every migrated subcommand.
- [ ] Functional — `NO_COLOR=1` env var honored equivalently to `--no-color`.
- [ ] Functional — `FORCE_COLOR=1` honored when piped.
- [ ] Integration — `genie update --json | jq` produces parseable JSON.
- [ ] Integration — `genie status --json > status.json` (>64KB output) does not truncate.
- [ ] Regression — Visual snapshot of each migrated command is captured; diff'd against the pre-migration version; differences justified.
- [ ] Regression — All current `__tests__/*.test.ts` cases pass.
- [ ] Regression — Lint rule fails CI on a deliberate bare-console regression.
- [ ] Cross-CLI parity — `diff <(grep -E "^export" src/lib/output.ts | sort) <(grep -E "^export" ../../../omni/packages/cli/src/output.ts | sort)` produces zero meaningful differences (allowing for path-only or comment-only deltas).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Port of omni's `output.ts` introduces a subtle behavior diff (e.g., the pipe-flush logic depends on Bun-specific stream semantics) | High | Group 1 ships with a 70KB `--json` regression test; if Bun semantics differ between repos, the test catches it before Group 2. |
| Migration causes visual snapshot churn in many test files | Medium | Snapshot tests are easy to update; the diff is reviewable per-snapshot in the PR. Document in PR description which snapshots changed and why. |
| New deps (4 of them) bloat install size | Low | ~100 KB combined; rounding error vs current 5+ MB binary. |
| Lint rule misfires on legitimate `console.log` (e.g., in `src/lib/`) | Low | Scope the rule to `src/genie-commands/` and `src/term-commands/` only; allowlist `output.ts` itself. |
| Banner / spinner / progress wrappers add latency on hot paths | Low | These wrap fast libs (boxen, ora, cli-progress); per-call overhead is microseconds. Benchmark in Group 2 acceptance. |
| `flushStdout` exit hook conflicts with existing process-exit logic in `src/genie.ts` | Medium | Group 1 acceptance includes the 70KB pipe regression; if conflicts arise, document and refactor the existing exit logic (no architectural change required). |
| Operators with custom shell aliases that grep stdout for specific ANSI patterns break post-migration | Low | The glyphs and color choices match `install.sh`; the literal text doesn't change. CHANGELOG warns explicitly. |
| Snapshot test infra (`@opentui` visual snapshots) doesn't cover non-TUI streaming output | Low | Add a separate text-snapshot harness for streaming output if needed; trivial. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Create
src/lib/output.ts
src/lib/__tests__/output.test.ts
scripts/lint/no-bare-console.cjs
src/genie-commands/.test-fixtures/lint-regression.ts        # only for the lint negative test

# Modify
package.json                                                # +chalk +ora +boxen +cli-progress
src/genie.ts                                                # --json flag, --no-color flag, flushStdout exit hook
src/lib/genie-config.ts                                     # outputFormat field
src/genie-commands/update.ts
src/genie-commands/install.ts
src/genie-commands/setup.ts
src/genie-commands/uninstall.ts
src/genie-commands/doctor.ts
src/genie-commands/perf-check.ts
src/genie-commands/shortcuts.ts
src/genie-commands/session.ts
src/genie-commands/__tests__/update.test.ts
src/genie-commands/__tests__/install.test.ts                # if it exists; create if not
# (one test per migrated file — extend or create as needed)
CHANGELOG.md

# Reference (read-only)
.genie/wishes/output-primitives-unified/SHARED-DESIGN.md
```
