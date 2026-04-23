# Wish: Wish Command Group Restructure

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `wish-command-group-restructure` |
| **Date** | 2026-04-19 |
| **Author** | felipe |
| **Appetite** | medium-large |
| **Branch** | `wish/wish-command-group-restructure` (from `genie@dev`) |
| **Repos touched** | `genie` only |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Restructure genie CLI's scattered wish-lifecycle commands into a coherent `genie wish` command group, and back it with a deterministic parser + schema + linter so wishes become machine-verifiable data instead of prose-by-convention. Relocate the three live framework dispatch primitives (`genie brainstorm <agent>`, `genie wish <agent>`, `genie review <agent>`) under a new `genie dispatch` command group — behavior preserved 1:1, only the command path changes. This frees the `wish` namespace for the lifecycle group. Their final fate (keep / rework / delete) is evaluated in a separate framework-skills brainstorm track. Build `genie wish lint` with `--fix` for deterministic structural violations and `--json` for agent consumption, so the next time an agent writes a malformed WISH.md the CLI blocks dispatch instead of silently producing "no execution groups found."

## Scope

### IN

- New `genie wish` command group: `new`, `lint`, `parse`, `status`, `done`, `reset`, `list`
- New `genie dispatch` command group hosting the three framework primitives: `dispatch brainstorm <agent> <slug>`, `dispatch wish <agent> <slug>`, `dispatch review <agent> <ref>` — behavior preserved 1:1, only the invocation path changes
- Remove the flat forms of `brainstorm`, `wish <agent>`, `review <agent>`, `status`, `done`, `reset` from the top level (replaced by the two command groups above)
- TypeScript `WishDocument` type + markdown parser (`src/services/wish-parser.ts`)
- Zod schema validating `WishDocument`
- `genie wish lint <slug>` with human-readable default output, `--json` machine-readable mode, `--fix` auto-repair for deterministic violations
- Extract wish template to `templates/wish-template.md` shared between `wish new` and the `/wish` skill
- Update `/wish` skill to reference extracted template and call `wish lint` in handoff step
- Test corpus: valid and invalid wish fixtures with explicit expected violations per fixture
- Update every framework skill (8 files) and doc (4 files) that invokes the three dispatch primitives to the new `genie dispatch <verb>` path

### OUT

- **Deciding the long-term fate of the dispatch primitives** (`brainstorm`, `wish <agent>`, `review <agent>`) — keep verbatim under `genie dispatch`, rework them, or delete them entirely. That decision belongs to the separate framework-skills brainstorm track (covering the 4 major framework dispatchers: `brainstorm`, `wish`, `review`, `work`). This wish only moves them off the top level; it does not judge them.
- Evaluating what `genie work` does — that's part of the same framework-skills brainstorm track
- Broader `dispatch.ts` dead-code audit beyond the registrations touched here (separate `/brainstorm` track — felipe's call)
- Full genie skills audit across all 16 skills (separate effort — different wish)
- Moving `genie work <ref>` into any group (deliberately kept flat at top level — hot path, and its evaluation is in the framework-skills track)
- Rewriting existing malformed wishes (`nudge-cleanup`, `owner-canonical-routing`) — that's per-wish work to be done after this lands, using the new `wish lint --fix`
- Trimming `/review` Plan Review checklist to semantic-only items (follows in skills audit track)
- Deprecation aliases for old flat commands — felipe decided: clean break, no aliases

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Relocate `brainstorm <agent>`, `wish <agent>`, `review <agent>` under new `genie dispatch` group (not deletion) | These are live framework-skill dispatchers, not dead code. Felipe explicitly flagged this. Moving them off the top level is required to free the `wish` namespace; judging them belongs to the separate framework-skills brainstorm track. Clean break from the flat names, no aliases. |
| 2 | Keep `genie work <ref>` flat at top level | Hot path, daily-use. Moving under any group adds friction. Final decision on its shape belongs to the framework-skills brainstorm track. |
| 3 | Move `status`/`done`/`reset` into `genie wish` group | Wish-scoped verbs belong in the wish namespace. Symmetrical with `genie task done`/`status`. |
| 4 | Parser + Zod schema before CLI surface | Schema is the source of truth. Linter, `wish new`, `wish parse`, state mutations all consume the same `WishDocument`. Building CLI first would re-derive structure in each handler. |
| 5 | `--fix` handles structural violations only, never content | Deterministic. Content correctness is the author's job. `--fix` makes the skeleton parseable; author fills meaning. |
| 6 | `--json` output format as first-class | Agents running `/work` need machine-readable violations to decide "fix vs escalate." English prose can't drive control flow. |
| 7 | Single `templates/wish-template.md` file as canonical template | Skill markdown and `wish new` both reference it. No drift possible. |
| 8 | Two-layer health model: linter (structural) + `/review` Plan (semantic) | Linter is fast/deterministic, catches mechanical errors. Reviewer adds judgment. Current `/review` Plan Review conflates both. |

## Success Criteria

- [ ] `genie wish lint session-lifetime-decoupling` exits 0 (reference wish, already correct)
- [ ] `genie wish lint nudge-cleanup` exits non-zero with explicit violations naming missing `## Execution Groups` header and non-conforming `### Grupo N — X` headers
- [ ] `genie wish lint nudge-cleanup --fix` converts `### Grupo N — Title` to `### Group N: Title`, inserts `## Execution Groups` header, adds missing field labels; re-running `wish lint` passes or reports only non-fixable content violations
- [ ] `genie wish lint nudge-cleanup --json` emits valid JSON conforming to the violation schema (parseable by `jq`)
- [ ] `genie wish new test-slug` produces a file that passes `genie wish lint test-slug` out of the box
- [ ] `genie wish status session-lifetime-decoupling` shows same output as old flat `genie status session-lifetime-decoupling` (behavior-preserving rename)
- [ ] `genie brainstorm`, `genie wish <agent>`, `genie review <agent>` (flat forms) return "unknown command" from Commander
- [ ] `genie dispatch brainstorm <agent> <slug>`, `genie dispatch wish <agent> <slug>`, `genie dispatch review <agent> <ref>` invoke the same handler code paths the flat forms did (behavior preserved, only path changed)
- [ ] `/wish` skill template section replaced by pointer to `templates/wish-template.md`; skill handoff step now includes `genie wish lint <slug>` invocation
- [ ] `bun run check` clean after all changes
- [ ] New test suite in `src/services/__tests__/wish-parser.test.ts` + `src/term-commands/__tests__/wish.test.ts` passes; fixtures cover every violation rule

## Execution Strategy

Four waves. Wave 1 builds the foundation. Wave 2 parallelizes CLI surface and template work (both consume only the parser). Wave 3 ships the linter (needs both parser AND the CLI stub to attach its handler). Wave 4 locks everything with the test corpus.

### Wave 1 (sequential — foundation)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Parser + Zod schema + `WishDocument` type |

### Wave 2 (parallel after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | `genie wish` command group + relocate dispatch primitives under new `genie dispatch` group (registers `wish lint` as stub handler) |
| 4 | engineer | Extract template + update `/wish` skill |

### Wave 3 (after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `wish lint` + `--fix` + `--json` — replaces the stub from Group 2 with the real handler |

### Wave 4 (after Wave 3)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Test corpus + regression suite |

_Final review runs automatically after Wave 4 completes — it's a phase, not a parseable group._

---

## Execution Groups

### Group 1: Parser + schema + WishDocument type
**Goal:** Build the canonical structured representation of a wish so every downstream consumer (CLI, linter, skill handoff) reads from one source of truth.

**Deliverables:**
1. `src/services/wish-parser.ts` exporting `parseWish(markdown: string): WishDocument` and `parseWishFile(slug: string): Promise<WishDocument>`. The parser extracts: metadata table (status/slug/date/author/appetite/branch), summary, scope IN/OUT bullets, decisions table rows, success criteria checkboxes, execution strategy waves table, execution groups (each with goal/deliverables/acceptance criteria/validation bash block/depends-on), QA criteria, assumptions/risks, review results, files to create.
2. `src/services/wish-schema.ts` exporting a Zod schema `WishDocumentSchema` and derived TypeScript type `WishDocument`. Schema enforces: required top-level sections present, OUT scope non-empty, at least one execution group, each group has all five required fields (goal/deliverables/acceptance/validation/depends-on), `depends-on` is either `"none"` or a comma-separated list of group refs (`Group N` or `slug#group`).
3. Parser tolerates prose flexibility inside fields (multi-paragraph goals, tables vs lists in deliverables) while strictly enforcing section headers and required field labels as the structural skeleton.
4. Parser exports a rich error type `WishParseError` carrying line/column/rule-id so the linter can consume structured violations directly without re-scanning the markdown.
5. Unit tests at `src/services/__tests__/wish-parser.test.ts` using at minimum the `brain-permanent` wish as a positive fixture (must parse cleanly and pass schema).
6. `bun run check` clean.

**Acceptance Criteria:**
- [ ] `parseWishFile('brain-permanent')` returns a `WishDocument` with ≥5 execution groups and all metadata fields populated
- [ ] `WishDocumentSchema.parse()` on that output returns without throwing
- [ ] `parseWishFile('nudge-cleanup')` throws `WishParseError` with rule `missing-execution-groups-header` at the correct line
- [ ] TypeScript export surface includes `WishDocument`, `WishDocumentSchema`, `parseWish`, `parseWishFile`, `WishParseError`, `ViolationRule` (string literal union of all rule names)
- [ ] `bun test src/services/__tests__/wish-parser.test.ts` passes

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test src/services/__tests__/wish-parser.test.ts && \
  bun run check
```

**depends-on:** none

---

### Group 2: `genie wish` command group + relocate dispatch primitives to `genie dispatch`
**Goal:** Replace the scattered flat wish-lifecycle commands with a coherent `genie wish` command group, and free the `wish` namespace by relocating the three live framework dispatch primitives (`brainstorm <agent>`, `wish <agent>`, `review <agent>`) under a new `genie dispatch` command group. These primitives are kept verbatim — final fate is decided by the separate framework-skills brainstorm track (out of scope here).

**Deliverables:**
1. New file `src/term-commands/wish.ts` exporting `registerWishCommands(program: Command)`. Creates `const wish = program.command('wish').description('Wish lifecycle management')` as command group.
2. Subcommands registered on the `wish` group:
   - `wish new <slug>` — reads `templates/wish-template.md`, writes `.genie/wishes/<slug>/WISH.md` with slug/date filled in, errors if directory already exists unless `--force`.
   - `wish lint <slug> [--json] [--fix]` — delegates to Group 3's lint implementation (receives as dependency).
   - `wish parse <slug> [--json]` — calls `parseWishFile(slug)`, emits the `WishDocument` as pretty JSON (default) or one-line JSON (`--json` for piping).
   - `wish status <slug>` — migrated behavior from `state.ts:461` flat `status` handler.
   - `wish done <ref>` — migrated from `state.ts:454` flat `done` handler.
   - `wish reset <ref>` — migrated from `state.ts:468` flat `reset` handler, preserving `--yes` option.
   - `wish list` — enumerate `.genie/wishes/*/WISH.md`, parse each, show `slug | status | group count | ready/in-progress/done counts`. Gracefully degrade on unparseable wishes (mark as `malformed`, don't crash the list).
3. New file `src/term-commands/dispatch-group.ts` exporting `registerDispatchCommands(program: Command)` (or extend an existing dispatcher registration). Creates `const dispatch = program.command('dispatch').description('Framework skill dispatch primitives (brainstorm/wish/review)')` as command group. Move the three live framework primitives under it, **behavior preserved 1:1 — only the command path changes**:
   - `dispatch brainstorm <agent> <slug>` — body from `dispatch.ts:705` (was flat `brainstorm`). Reuses `brainstormCommand` unchanged.
   - `dispatch wish <agent> <slug>` — body from `dispatch.ts:712` (was flat `wish`). Reuses `wishCommand` unchanged. This frees the `wish` namespace for the lifecycle group above.
   - `dispatch review <agent> <ref>` — body from `dispatch.ts:736` (was flat `review`). Reuses `reviewCommand` unchanged.
4. Delete the **flat** registrations only (the command-group versions above replace them). Underlying handler functions (`brainstormCommand`, `wishCommand`, `reviewCommand`) stay exported and are invoked by the new group subcommands:
   - `dispatch.ts:705` — flat `brainstorm <agent> <slug>` registration removed; handler reused by `genie dispatch brainstorm`.
   - `dispatch.ts:712` — flat `wish <agent> <slug>` registration removed; handler reused by `genie dispatch wish`. **This is the specific edit that unblocks Commander.js from registering `wish` as a group.**
   - `dispatch.ts:736` — flat `review <agent> <ref>` registration removed; handler reused by `genie dispatch review`.
   - `state.ts:454` — flat `done` registration removed (body moves into `wish.ts` as `wishDoneCommand`).
   - `state.ts:461` — flat `status` registration removed (body moves into `wish.ts` as `wishStatusCommand`).
   - `state.ts:468` — flat `reset` registration removed (body moves into `wish.ts` as `wishResetCommand`).
5. Keep `genie work` flat and untouched (confirmed scope — the larger `genie work` evaluation is a separate brainstorm track).
6. Update `src/genie.ts` top-level registration to import and call `registerWishCommands(program)` and ensure the dispatch group is registered. Verify state-handler registration is still called for any remaining state commands (delete the file if it becomes empty after the 3 extractions).
7. Skills audit: every framework skill and doc that invokes `genie brainstorm <agent> <slug>`, `genie wish <agent> <slug>`, or `genie review <agent> <ref>` gets updated to `genie dispatch <verb> …`. Scope of audit stays as enumerated in this wish's Context block (8 skill files + 4 doc files). No behavior changes beyond the command path.
8. `bun run check` clean.

**Acceptance Criteria:**
- [ ] `genie wish --help` lists all 7 subcommands (`new`, `lint`, `parse`, `status`, `done`, `reset`, `list`)
- [ ] `genie dispatch --help` lists 3 subcommands (`brainstorm`, `wish`, `review`)
- [ ] `genie dispatch brainstorm <agent> <slug>` invokes the same code path the old flat `genie brainstorm <agent> <slug>` did (behavior preserved)
- [ ] `genie dispatch wish <agent> <slug>` invokes the same code path the old flat `genie wish <agent> <slug>` did
- [ ] `genie dispatch review <agent> <ref>` invokes the same code path the old flat `genie review <agent> <ref>` did
- [ ] `genie brainstorm foo bar` exits non-zero with Commander's "unknown command" error (flat form gone)
- [ ] `genie review foo bar` exits non-zero (flat form gone)
- [ ] `genie status session-lifetime-decoupling` exits non-zero (flat command removed)
- [ ] `genie done session-lifetime-decoupling#1` exits non-zero (flat command removed)
- [ ] `genie reset session-lifetime-decoupling` exits non-zero (flat command removed)
- [ ] `genie wish status session-lifetime-decoupling` shows the same output the old flat command did (behavior preserved under the new namespace)
- [ ] `genie wish done session-lifetime-decoupling#1` shows the same behavior the old flat `done` did
- [ ] `genie wish list` outputs a table-like view with all 10+ wishes in `.genie/wishes/`
- [ ] `wish lint` subcommand is registered in Group 2 as a stub handler (prints "lint handler not wired yet") — full implementation lands in Group 3
- [ ] `genie work <ref>` still works exactly as before (unchanged by this wish)
- [ ] `grep -rn "genie brainstorm \|genie wish <\|genie review <" skills/ docs/ plugins/` returns zero matches in production docs (only migrated `genie dispatch <verb>` invocations remain)
- [ ] `bun run check` clean

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun run cli wish --help | grep -E "new|lint|parse|status|done|reset|list" | wc -l | grep -q "^7$" && \
  bun run cli dispatch --help | grep -E "brainstorm|wish|review" | wc -l | grep -q "^3$" && \
  ! bun run cli brainstorm foo bar 2>&1 >/dev/null && \
  ! bun run cli review foo bar 2>&1 >/dev/null && \
  ! bun run cli status foo 2>&1 >/dev/null && \
  ! bun run cli done foo#1 2>&1 >/dev/null && \
  ! bun run cli reset foo 2>&1 >/dev/null && \
  bun run cli wish list && \
  bun run cli work --help > /dev/null && \
  bun run check
```

**depends-on:** Group 1

---

### Group 3: Linter with `--fix` and `--json`
**Goal:** Ship `genie wish lint` as the structural health gate. Deterministic errors with exact locations, agent-consumable JSON output, auto-fix for violations that don't require human judgment.

**Deliverables:**
1. `src/services/wish-lint.ts` exporting `lintWish(doc: WishDocument | WishParseError, markdown: string, options?: { fix?: boolean }): LintReport`. The linter runs **after** the parser — if parsing succeeds, run schema validation + extra structural checks; if parsing fails, surface the parse error as a lint violation.
2. `LintReport` shape:
   ```ts
   interface LintReport {
     wish: string;
     file: string;
     violations: Violation[];
     summary: { total: number; fixable: number; unfixable: number };
   }
   interface Violation {
     rule: ViolationRule;
     severity: 'error' | 'warning';
     line: number;
     column: number;
     message: string;
     fixable: boolean;
     fix: FixAction | null; // null when not fixable
   }
   interface FixAction {
     kind: 'insert' | 'rewrite' | 'delete';
     at: { line: number; column?: number };
     content?: string;
     range?: { endLine: number; endColumn: number };
   }
   ```
3. Violation rules covered (minimum set; exhaustive list in the test corpus):
   - `missing-execution-groups-header` (fixable: insert `## Execution Groups` above first `### Group`)
   - `group-header-format` (fixable: `### Grupo N — X` or `### Group N - X` → `### Group N: X`)
   - `missing-required-field` (fixable for missing label; not fixable if entire section absent) — one rule per required field: `missing-goal-field`, `missing-deliverables-field`, `missing-acceptance-field`, `missing-validation-field`, `missing-depends-on-field`
   - `empty-out-scope` (not fixable — requires human judgment to invent exclusions)
   - `missing-validation-command` (not fixable — cannot invent test commands)
   - `depends-on-malformed` (fixable if wrong format but group ref is real; not fixable if dangling reference)
   - `validation-not-fenced-bash` (fixable: wrap existing content in ```bash fence)
   - `metadata-table-missing-field` (fixable: insert stub row with `status=DRAFT`, `date=today`)
   - `scope-section-missing` (partial: fixable if IN or OUT exists alone, not fixable if both missing)
4. `applyFixes(markdown: string, report: LintReport): string` — applies all fixable `FixAction`s in reverse-line order (so line numbers stay stable during in-place edits) and returns the new markdown. **Idempotency mechanism:** each fix is designed so that after it applies, re-parsing the markdown no longer triggers the same rule. Example: `group-header-format` rewrites `### Grupo 1 — X` to `### Group 1: X`; when the parser re-scans, that line now matches the canonical format and the rule silently accepts it. This is a per-rule invariant, not an accident of reverse-line-order (reverse-line-order only prevents line-number drift during multi-fix application). Tests assert `applyFixes(applyFixes(x, report1), report2) === applyFixes(x, report1)` on every fixable fixture.
5. CLI wiring inside Group 2's `wish lint` subcommand:
   - Default: pretty-printed human-readable output grouped by severity, colored for TTY, with trailing summary line. Exits 0 if zero errors, 1 if any error violation.
   - `--json`: emits the full `LintReport` as JSON to stdout. Exit code matches default.
   - `--fix`: runs `applyFixes`, writes back to the wish file, reruns lint, reports what was fixed and what remains. Never touches non-fixable violations. Dry-run via `--fix --dry-run` prints diff without writing.
6. Unit tests at `src/services/__tests__/wish-lint.test.ts` covering each violation rule: positive case (clean wish → no violation), negative case (malformed wish → correct violation emitted), and for fixable rules, the fix-and-revalidate cycle.
7. `bun run check` clean.

**Acceptance Criteria:**
- [ ] `lintWish(parse('brain-permanent'), markdown).violations` is empty
- [ ] `lintWish(parse('nudge-cleanup'), markdown).violations` includes at minimum `missing-execution-groups-header` and `group-header-format` × (count of Portuguese-style group headers in that file)
- [ ] `genie wish lint nudge-cleanup` emits human-readable output showing each violation with `file:line:col: rule — message`
- [ ] `genie wish lint nudge-cleanup --json | jq '.violations | length'` returns a positive integer matching the count in the non-JSON output
- [ ] `genie wish lint nudge-cleanup --json | jq '.summary'` returns `{ total, fixable, unfixable }` summing correctly
- [ ] `genie wish lint nudge-cleanup --fix --dry-run` prints a diff but leaves the file unchanged (verify via `git diff`)
- [ ] After `genie wish lint nudge-cleanup --fix`, running `genie wish lint nudge-cleanup` exits 0 OR reports only non-fixable violations (content issues the author must address)
- [ ] `applyFixes` is idempotent: applying the same fix report twice yields the same output as once (tested explicitly)
- [ ] `bun run check` clean

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test src/services/__tests__/wish-lint.test.ts && \
  bun run cli wish lint session-lifetime-decoupling && \
  ! bun run cli wish lint nudge-cleanup 2>&1 >/dev/null && \
  bun run cli wish lint nudge-cleanup --json | jq -e '.violations | length > 0' && \
  bun run check
```

**depends-on:** Group 1, Group 2 (replaces the stub handler Group 2 registered)

---

### Group 4: Template extraction + `/wish` skill update
**Goal:** Move the wish template from inline markdown in the skill to a versioned file in the repo, making the skill and the linter share a single source of truth. Update the skill to call `wish lint` in its handoff step.

**Deliverables:**
1. Create `templates/wish-template.md` in the genie repo. Content: a canonical empty wish scaffold with every required section and group placeholder filled with `<TODO>` markers. The scaffold MUST pass `wish lint --allow-todo-placeholders` (a bypass flag for `wish new` output) but MUST fail `wish lint` without that flag (enforcing that authors replace TODOs before dispatch).
2. Wire `wish new <slug>` in Group 2 to read `templates/wish-template.md`, substitute `{{slug}}` and `{{date}}` placeholders, write the result.
3. Update `/wish` skill at `skills/wish/SKILL.md`:
   - Replace the embedded template section (lines ~60-155) with: "The wish template lives at `templates/wish-template.md` in the genie repo. Use `genie wish new <slug>` to scaffold a wish from it."
   - Update the Flow section: step 8 "Handoff" now runs `genie wish lint <slug>` before auto-invoking `/review`. If lint reports any error violations (fixable or not), the skill MUST report them to the user and stop — do not hand off to `/review` with a structurally broken wish.
   - Add a note in Rules: "Never write WISH.md by hand — always `genie wish new <slug>` then edit. The scaffold guarantees structural correctness by construction; handwritten wishes regularly fail `wish lint`."
4. Update `CLAUDE.md` or equivalent rule file at the genie repo root if it documents command usage — point any stale references to the new surface.
5. `bun run check` clean.

**Acceptance Criteria:**
- [ ] `templates/wish-template.md` exists and contains `{{slug}}` and `{{date}}` substitution tokens
- [ ] `genie wish new demo-slug` creates `.genie/wishes/demo-slug/WISH.md` with `demo-slug` substituted and today's date
- [ ] `genie wish lint demo-slug --allow-todo-placeholders` passes (scaffold is structurally valid)
- [ ] `genie wish lint demo-slug` (without bypass) fails with `todo-placeholder-remaining` violations
- [ ] `/wish` skill file no longer embeds the full template — references `templates/wish-template.md` instead
- [ ] `/wish` skill Flow step 8 documents the `genie wish lint` call before `/review` handoff
- [ ] `bun run check` clean

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  test -f templates/wish-template.md && \
  grep -q "{{slug}}" templates/wish-template.md && \
  grep -q "{{date}}" templates/wish-template.md && \
  bun run cli wish new demo-lint-test && \
  bun run cli wish lint demo-lint-test --allow-todo-placeholders && \
  ! bun run cli wish lint demo-lint-test 2>&1 >/dev/null && \
  rm -rf .genie/wishes/demo-lint-test && \
  ! grep -q "Wish Template" skills/wish/SKILL.md && \
  grep -q "genie wish lint" skills/wish/SKILL.md && \
  bun run check
```

**depends-on:** Group 1

---

### Group 5: Test corpus + regression suite
**Goal:** Build the fixture library that locks every violation rule into a regression test, so future parser or linter changes can't silently regress wish validation.

**Deliverables:**
1. Fixture directory `src/services/__tests__/fixtures/wishes/` with one subdirectory per fixture. Each fixture contains:
   - `input.md` — the markdown wish text to parse/lint
   - `expected-violations.json` — expected `LintReport.violations` (rule, line, fixable) for that fixture
   - `expected-fixed.md` — for fixable fixtures, the expected content after `--fix` (so fix idempotency can be asserted)
2. Minimum fixtures — one per violation rule from Group 3, plus two positive cases and the todo-placeholder rule from Group 4. Target: 17 fixtures total, 1:1 mapping to every rule defined in Groups 3 and 4.

   Positive cases (must parse + validate clean, zero violations):
   - `clean-minimal` — smallest valid wish (1 group, all required fields)
   - `clean-multi-group` — 3 groups with depends-on chain

   Structural violations (fixable by `--fix`):
   - `missing-exec-groups-header` — groups exist but no `## Execution Groups` parent
   - `portuguese-group-headers` — `### Grupo 1 — X` (rule: `group-header-format`)
   - `missing-goal-field` — group has deliverables but lacks the Goal field label line
   - `missing-deliverables-field` — group has a goal but lacks the Deliverables field label line
   - `missing-acceptance-field` — group has deliverables but lacks the Acceptance Criteria field label line
   - `missing-validation-field` — group has acceptance criteria but lacks the Validation field label line (distinct from `missing-validation-command` below: label absent vs label present with empty block)
   - `missing-depends-on-field` — group has all other fields but lacks the depends-on field label line
   - `validation-not-fenced` — validation block has commands but no ```bash fence
   - `metadata-missing-status` — no status row in metadata table (rule: `metadata-table-missing-field`)
   - `depends-on-malformed-fixable` — depends-on label line has wrong format (e.g., `Groups 1 and 2` instead of `Group 1, Group 2`) but referenced groups exist

   Content violations (not fixable — require human/agent judgment):
   - `missing-validation-command` — Validation label present but fenced bash block is empty
   - `empty-out-scope` — `### OUT` section exists but has no bullets
   - `depends-on-dangling` — depends-on value references a group that does not exist (e.g., `Group 99`)
   - `scope-section-missing` — entire `## Scope` section absent (or both IN and OUT missing)
   - `todo-placeholders` — scaffold with `<TODO>` markers still present (rule: `todo-placeholder-remaining`; not fixable without `--allow-todo-placeholders` bypass)

   Every fixture carries a `fixture.json` metadata file declaring which rule(s) it tests, so a test matrix generator can confirm 1:1 rule-to-fixture coverage automatically. Build will fail if a rule lacks a fixture.
3. Integration test at `src/__tests__/wish-cli.integration.test.ts` that runs actual CLI commands against fixture dirs (spawn `bun run cli wish lint ...`, assert exit code + output).
4. Regression coverage for the full flow: `wish new` → edit → `wish lint` → `wish lint --fix` → `wish lint` clean.
5. Snapshot test: parse `brain-permanent` WISH.md (real in-tree wish), verify `WishDocument.executionGroups.length` and a few structural invariants. If this snapshot breaks in the future, the PR author must update it deliberately — drift detection.
6. `bun run check` + `bun test` clean across the new suites.

**Acceptance Criteria:**
- [ ] Exactly 17 fixture directories exist, each with `input.md`, `fixture.json` (rule metadata), `expected-violations.json`, and `expected-fixed.md` where applicable
- [ ] Coverage test: every `ViolationRule` literal in `src/services/wish-lint.ts` has at least one fixture declaring it in its `fixture.json`. Test fails if a rule has zero fixtures.
- [ ] Every fixable fixture: running `--fix` produces output matching `expected-fixed.md` byte-for-byte
- [ ] Every non-fixable fixture: `--fix` leaves the file unchanged (or only applies the fixable violations present alongside, leaving non-fixable ones in place)
- [ ] `bun test src/services/__tests__/wish-lint.test.ts` passes all fixtures
- [ ] `bun test src/__tests__/wish-cli.integration.test.ts` passes (real CLI invocation tests)
- [ ] `bun run check` clean
- [ ] Snapshot test for `brain-permanent` exists and passes

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  test "$(ls src/services/__tests__/fixtures/wishes/ | wc -l)" = "17" && \
  bun test src/services/__tests__/wish-parser.test.ts && \
  bun test src/services/__tests__/wish-lint.test.ts && \
  bun test src/__tests__/wish-cli.integration.test.ts && \
  bun run check
```

**depends-on:** Group 1, Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] `genie wish new qa-test-wish` creates a scaffolded WISH.md
- [ ] Editing that WISH.md with one deliberately malformed group (e.g., rename `### Group 1:` to `### Grupo 1 —`), then running `genie wish lint qa-test-wish --fix` auto-corrects the header and re-validates clean
- [ ] `genie wish lint nudge-cleanup --fix` on the real wish converts it to the parseable format; `genie status nudge-cleanup` (after Group 2 migration, this is `genie wish status`) now shows parsed groups instead of "no execution groups found"
- [ ] Dispatching `/work` on a freshly-created wish with `<TODO>` placeholders fails fast (linter gates dispatch) instead of silently producing zero groups
- [ ] Old flat commands (`genie brainstorm`, `genie wish <agent>`, `genie review`, `genie status`, `genie done`, `genie reset`) return "unknown command" with exit code 1
- [ ] `/wish` skill invocation produces a WISH.md that passes `genie wish lint <slug>` out of the box

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Hidden flat-command consumers in skills or external scripts break on removal | Medium | Grep `~/workspace/repos/` for the old command patterns before merge; list unexpected callers in PR description. Felipe decides: fix in this PR or accept breakage. |
| Parser's prose tolerance vs strict schema balance is wrong — either too lenient (doesn't catch real issues) or too strict (rejects valid prose variations) | Medium | Test corpus with real in-tree wishes as positive fixtures. Tune rules against observed failures, not a-priori guess. |
| `--fix` byte-level idempotency under edge cases (unicode whitespace, Windows line endings, CRLF) | Low | Normalize line endings on read; test fixture with mixed line endings; document expected behavior. |
| Template drift between `templates/wish-template.md` and the parser's expected structure | Low | Test: `wish new` + `wish lint --allow-todo-placeholders` must pass in CI. If template drifts from parser, this test fails. **Note:** this catches forward-drift (template adds sections the parser rejects) but not backward-drift (parser adds required sections the template lacks). Backward-drift surfaces the first time `wish new` is run after a parser change — acceptable because `WishDocumentSchema` in Group 1 is the actual source of truth, not the template. |
| Deleting dispatch primitives breaks a skill that calls `genie wish <agent>` | Medium | Skills audit (track B) follows this wish and fixes any stragglers. In this PR, grep `skills/` for old patterns and at minimum document what will break. |
| Removing flat `status`/`done`/`reset` breaks muscle memory for anyone running genie outside this conversation | Low | Felipe's call: clean break accepted (decision 1). Release notes document the rename. |
| `/wish` skill's calling convention expects embedded template for context — moving it to a file might break skill execution if the skill runtime can't read repo files | Low | Verify skill runtime has filesystem access; if not, keep a fallback inline copy but mark the repo template as source of truth. Test by running `/wish` once post-merge. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Create
src/services/wish-parser.ts                               # Group 1
src/services/wish-schema.ts                               # Group 1
src/services/wish-lint.ts                                 # Group 3
src/services/__tests__/wish-parser.test.ts                # Group 1
src/services/__tests__/wish-lint.test.ts                  # Group 3
src/services/__tests__/fixtures/wishes/clean-minimal/               # Group 5
src/services/__tests__/fixtures/wishes/clean-multi-group/           # Group 5
src/services/__tests__/fixtures/wishes/missing-exec-groups-header/  # Group 5
src/services/__tests__/fixtures/wishes/portuguese-group-headers/    # Group 5
src/services/__tests__/fixtures/wishes/missing-goal-field/          # Group 5
src/services/__tests__/fixtures/wishes/missing-deliverables-field/  # Group 5
src/services/__tests__/fixtures/wishes/missing-acceptance-field/    # Group 5
src/services/__tests__/fixtures/wishes/missing-validation-field/    # Group 5
src/services/__tests__/fixtures/wishes/missing-depends-on-field/    # Group 5
src/services/__tests__/fixtures/wishes/missing-validation-command/  # Group 5
src/services/__tests__/fixtures/wishes/empty-out-scope/             # Group 5
src/services/__tests__/fixtures/wishes/depends-on-dangling/         # Group 5
src/services/__tests__/fixtures/wishes/depends-on-malformed-fixable/ # Group 5
src/services/__tests__/fixtures/wishes/scope-section-missing/       # Group 5
src/services/__tests__/fixtures/wishes/validation-not-fenced/       # Group 5
src/services/__tests__/fixtures/wishes/metadata-missing-status/     # Group 5
src/services/__tests__/fixtures/wishes/todo-placeholders/           # Group 5
src/__tests__/wish-cli.integration.test.ts                # Group 5
src/term-commands/wish.ts                                 # Group 2
templates/wish-template.md                                # Group 4

# Modify
src/genie.ts                                              # Group 2 — register wish command group
src/term-commands/dispatch.ts                             # Group 2 — delete brainstorm/wish/review primitives
src/term-commands/state.ts                                # Group 2 — delete flat status/done/reset, or delete file if empty
skills/wish/SKILL.md                                      # Group 4 — replace template, update handoff step
scripts/wishes-lint.ts                                    # Group 3 — either delete (superseded by `genie wish lint`) or repurpose as brainstorm-link-only check

# Potentially delete
src/term-commands/state.ts                                # if empty after Group 2 migration
scripts/wishes-lint.ts                                    # if repo check script is fully subsumed by `genie wish lint`
```
