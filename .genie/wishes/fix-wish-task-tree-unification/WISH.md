# Wish: Unify wish task trees + preserve group titles

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-wish-task-tree-unification` |
| **Date** | 2026-04-28 |
| **Author** | Felipe Rosa (housekeep pass) |
| **Appetite** | medium |
| **Branch** | `wish/fix-wish-task-tree-unification` |
| **Repos touched** | `automagik-dev/genie` |
| **Linked issue** | #1300 |
| **Design** | _No brainstorm — direct wish_ |

## Summary

The wish-creation flow produces two orphaned task trees per wish (one from `/wish` SKILL.md's manual `genie task create` steps, one from `/work`'s `wishState.getOrCreateState`) because manual tasks never carry a `wish_file`, and at the same time the canonical group titles (`### Group N: <title>`) are dropped before reaching PG so every child task is named `Group N`. This wish unifies the two trees by making `genie task create` wish-aware, preserving titles through the parser, and adopting any pre-existing manually created parent at runtime so `genie task list` stops being a duplicated noise board.

## Scope

### IN

- Extend `GroupDefinition` (`src/lib/wish-state.ts:48-51`) with a `title?: string` field and update `parseWishGroups` (`src/term-commands/dispatch.ts:191-228`) to capture the text after the colon in `### Group N: <title>`. Use it as the child task title when present; fall back to `Group ${name}` otherwise.
- Add `--wish <slug>` flag to `genie task create` (`src/term-commands/task.ts handleTaskCreate` + commander wiring near line 451): when set, populate `tasks.wish_file = '.genie/wishes/<slug>/WISH.md'` via the existing `wishFile` field on `task-service.createTask` (already plumbed at `src/lib/task-service.ts:545,592`).
- Add an adopt-by-title fallback in `getOrCreateState` (`src/lib/wish-state.ts:705`) AND at the top of `createState` (`src/lib/wish-state.ts:306`, since `createState` is also a public entrypoint): when `findParent` returns null, look for `(title IN (<slug>, <wishTitle>) AND parent_id IS NULL AND repo_path = ?)` and if found, set its `wish_file` + `metadata.groupsSignature` (via `jsonb_set` so unrelated keys survive) and reuse it as the parent (with all existing children migrated/reconciled). Surface a one-line stderr notice so the operator sees the adoption happened. `<wishTitle>` is parsed from the WISH.md H1 (`# Wish: <title>`) — see Group 3 deliverable 1 for the helper.
- Update `skills/wish/SKILL.md` Task Lifecycle Integration section to thread the new `--wish` flag into both the parent and child `task create` commands so manually authored wishes land on the same tree `/work` will reuse.
- Tests: parser (title captured), task CLI (--wish populates wish_file), wish-state adoption (manual parent + new groups merge into single tree), regression coverage so the prior "two trees, lost titles" failure mode is now an explicit failing-pre / passing-post case.

### OUT

- The `slug#N` depends-on prefix stripping in `parseWishGroups` — owned by wish #1406 (`fix-wish-parser-slug-prefix`). Coordinate by rebasing whichever wish lands second; the line-range overlap is small (~5 lines). Note: #1406 is the smaller / earlier merge candidate; this wish rebases onto it. The line-range overlap is ~5 lines around `parseWishGroups` — mechanical conflict resolution.
- Wholesale migration of `autoOrchestrateCommand` to the richer `src/services/wish-parser.ts:380` parser — out of appetite. We capture the title via the minimal regex extension and revisit a deeper integration in a separate wish if more fields are needed downstream.
- Schema migration adding `wish_file` — column already exists (`src/db/migrations/002_task_lifecycle.sql:32`, indexed at line 87). No DDL needed.
- Removing the manual task-creation steps from `/wish` SKILL.md entirely; we keep them, just with the `--wish` flag added. (Removing them would break operators who already run `/wish` end-to-end without `/work`.)
- Backfilling `wish_file` for historical orphan tasks created before this wish lands. The adopt-by-title fallback handles them lazily on next `/work` invocation; a bulk migration is out of scope.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Add `title?: string` to `GroupDefinition` rather than wiring `services/wish-parser.ts` into the dispatch path | Minimal diff that fixes the user-visible symptom (lost titles) without absorbing the broader parser unification. The richer parser stays available for a future wish that needs goal/deliverables/validation in PG too. |
| 2 | `genie task create --wish <slug>` instead of inferring the slug from cwd or a parent task | Explicit beats implicit; the operator running `/wish` already knows the slug. Inference would silently mis-attribute tasks created from inside an unrelated wish dir. |
| 3 | Adopt-by-title in `getOrCreateState`, not as a separate `genie task adopt` command | Adoption needs to happen on the hot path (`/work`) to rescue users who already followed the old SKILL.md. A standalone command would require operators to know they need it; they don't. |
| 4 | Adoption keys on `title IN (<slug>, <wishTitle>) AND parent_id IS NULL AND repo_path = ?` | Adoption keys on `title IN (<slug>, <wishTitle>) AND parent_id IS NULL AND repo_path = ?`. The slug-only key would miss every legacy parent created via the old SKILL.md guidance ("genie task create '<wish title>'"). Reading `<wishTitle>` from the WISH.md frontmatter ensures legacy rows are still rescued. |
| 5 | Coordinate with #1406 by declaring the slug# prefix issue OUT-of-scope | Both wishes touch `parseWishGroups`. The slug# fix is a one-line regex add; the title fix is a regex extension + interface change. Sequencing them as separate wishes keeps each diff reviewable. |

## Success Criteria

- [ ] `parseWishGroups("### Group 1: Parser layer\n**depends-on:** none")` returns `[{ name: "1", title: "Parser layer", dependsOn: [] }]`.
- [ ] `genie task create "fix-wish-task-tree-unification" --type software --wish fix-wish-task-tree-unification` creates a task with `wish_file = '.genie/wishes/fix-wish-task-tree-unification/WISH.md'` (verifiable via `genie task show #<seq>` or direct PG inspection).
- [ ] After running `genie task create "<slug>" --type software --wish <slug>` followed by `genie work <slug>`, exactly one parent task exists for that slug (no duplicate trees) and child task titles read `Group N: <title>` (or the title from WISH.md), not bare `Group N`.
- [ ] When a parent created without `--wish` already exists, `getOrCreateState` adopts it (sets `wish_file`, attaches `groupsSignature`) instead of creating a sibling tree, and prints a one-line adoption notice.
- [ ] `bun run check` green (typecheck + lint + dead-code + full test suite).
- [ ] `genie wish lint fix-wish-task-tree-unification` passes.

## Execution Strategy

### Wave 1

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Parser layer: extend `GroupDefinition` + `parseWishGroups` to capture `### Group N: <title>` text |

### Wave 2 (sequential after Group 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Task CLI: add `--wish <slug>` flag to `genie task create` and thread it through `task-service.createTask` |

### Wave 3 (parallel — both depend on Group 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Wish-state adoption: adopt-by-title fallback in `getOrCreateState`; use captured title when creating new children |
| 4 | engineer | Docs: update `skills/wish/SKILL.md` Task Lifecycle Integration to use `--wish <slug>` |

Group 3 consumes the new `title` field from Group 1 and the new `wish_file` semantic from Group 2. Group 4 only documents the `--wish` flag from Group 2, so it can run in parallel with Group 3.

## Execution Groups

### Group 1: Parser layer — capture group titles

**Goal:** Make `parseWishGroups` preserve the descriptive title from `### Group N: <title>` headings so downstream PG tasks can use it.

**Deliverables:**
1. Add `title?: string` to `GroupDefinition` in `src/lib/wish-state.ts:48-51`.
2. Update the `groupPattern` regex (`src/term-commands/dispatch.ts:193`) from `/^### Group ([A-Za-z0-9]+):/gim` to `/^### Group ([A-Za-z0-9]+):\s*(.*)$/gim` and the capture loop (`src/term-commands/dispatch.ts:195-225`) to also capture `match[2]`, trim it, and assign to `title` only when non-empty (`title: trimmed.length > 0 ? trimmed : undefined`). Header missing a title (`### Group 1:` with empty trailer) yields `title: undefined`, not an empty string. Note: the inner `nextGroupIdx` regex at line 202 (`/^### Group [A-Za-z0-9]+:/m`) does NOT need updating — it only locates the next heading, doesn't capture.
3. Update `computeGroupsSignature` (`src/lib/wish-state.ts:66-71`) to keep the canonical form stable — title MUST NOT participate in the signature (otherwise prose edits to WISH.md flip the signature and force `genie reset`). Add a comment locking this invariant.
4. Tests in `src/term-commands/dispatch.test.ts`:
   - `should capture group title from heading` — `### Group 1: Parser layer` → `title: "Parser layer"`.
   - `should handle missing title gracefully` — `### Group 1:` with empty trailer → `title: undefined`.
   - `should preserve title across multiple groups with deps` — two-group fixture with deps, asserts both titles + dependsOn arrays.
   - `should not include title in groupsSignature` — same group set with different titles produces identical signatures.

**Acceptance Criteria:**
- [ ] All four new dispatch tests pass.
- [ ] Existing `parseWishGroups` tests continue to pass.
- [ ] `bun test src/term-commands/dispatch.test.ts src/lib/wish-state.test.ts` green.
- [ ] No diff in `services/wish-parser.ts` (out of scope — we are not wiring it in).

**Validation:**
```bash
bun test src/term-commands/dispatch.test.ts
bun test src/lib/wish-state.test.ts
bun run typecheck
```

**depends-on:** none

---

### Group 2: Task CLI — `--wish <slug>` flag

**Goal:** Make `genie task create` wish-aware so manually created parent + child tasks land on the same tree `/work` later resolves via `wish_file`.

**Deliverables:**
1. Add `wish?: string` to `CreateOptions` in `src/term-commands/task.ts:307-324`.
2. Wire `--wish <slug>` into the commander config near line 451 (between `--external-url` and `.action(...)`). Description: `Associate task with a wish (sets wish_file)`.
3. In `handleTaskCreate` (`src/term-commands/task.ts:340`): when `options.wish` is set, compute `wishFile = '.genie/wishes/<slug>/WISH.md'` and pass it via the existing `wishFile` field on `ts.createTask` (`src/lib/task-service.ts:545,592` already accept it).
4. Validation: error if `--wish` value does not match the slug pattern `^[a-z0-9][a-z0-9-]*$`. This rejects: spaces, uppercase, leading hyphens, path separators, `..`, absolute paths, and any non-slug-shaped input. Test cases: `--wish="My Wish"` (space), `--wish="UPPER"` (uppercase), `--wish="-leading"` (leading hyphen), `--wish="../oops"` (path traversal), `--wish="/abs/path"` (absolute path) — all reject with clear error.
5. Tests in `src/term-commands/task.test.ts` (or new file if missing): create with `--wish <slug>` and assert the resulting task row has `wish_file = '.genie/wishes/<slug>/WISH.md'`.

**Acceptance Criteria:**
- [ ] `genie task create "title" --type software --wish my-wish` succeeds and `genie task show #<seq>` shows the wish_file (or the test asserts directly via task-service).
- [ ] `genie task create "title" --wish ../oops` fails with a clear error.
- [ ] Existing `task create` invocations without `--wish` are unchanged (regression).
- [ ] `bun test src/term-commands/task.test.ts` passes (test file required, not optional).
- [ ] All five hardening test cases reject with a clear error message naming the invalid input.

**Validation:**
```bash
bun run build
# Task CLI test must exist and pass
bun test src/term-commands/task.test.ts
# Task service test runs separately
bun test src/lib/task-service.test.ts
node dist/genie.js task create "smoke" --type software --wish smoke-fixture
node dist/genie.js task show "$(node dist/genie.js task list --json | jq -r '.[] | select(.title=="smoke") | .seq | "#" + tostring' | head -1)" | grep -i 'wish_file\|.genie/wishes/smoke-fixture'
node dist/genie.js task done "$(node dist/genie.js task list --json | jq -r '.[] | select(.title=="smoke") | .seq | "#" + tostring' | head -1)"
```

**depends-on:** Group 1

---

### Group 3: Wish-state — adopt-by-title fallback + use captured titles

**Goal:** Stop creating duplicate parent tasks. When a manually created parent already exists for the slug, adopt it (set `wish_file`, attach `groupsSignature`); when creating new children, use the captured group titles.

**Deliverables:**
1. Add a private helper `readWishTitle(slug, cwd)` in `src/lib/wish-state.ts` (place it near `wishFilePath` and `resolveRepoPath`, ~line 130-180): read `<repoPath>/.genie/wishes/<slug>/WISH.md` from disk, regex-match the first `^# Wish:\s*(.+)$` line, return the trimmed capture; return `null` if the file is missing or no H1 matches. The function MUST NOT throw on read errors — fall back to `null` so adoption silently degrades to slug-only matching. Tested via Group 3 test "should adopt legacy parent created with wish title" (which writes a fixture WISH.md).
2. Add a private helper `adoptParentByTitle(sql, slug, repoPath, wishFile)` in `src/lib/wish-state.ts` (place near `findParent` ~line 190): runs the adoption query
   ```sql
   SELECT * FROM tasks
   WHERE title IN (<slug>, <wishTitle>)
         AND parent_id IS NULL
         AND repo_path = <repoPath>
         AND (wish_file IS NULL OR wish_file = <wishFile>)
   LIMIT 1
   ```
   where `<wishTitle>` comes from `readWishTitle(slug, cwd)` and is omitted from the IN-list when null (the function should build the IN-list dynamically: `IN (slug)` if title is null, `IN (slug, wishTitle)` otherwise — never inject a literal `null` into IN). If a row is returned, UPDATE it with `wish_file = <wishFile>` and `metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('groupsSignature', <fresh sig>)` (preserves any other metadata keys; safer than overwrite). Return the adopted row.
3. Call `adoptParentByTitle` from two sites:
   - In `getOrCreateState` (`src/lib/wish-state.ts:705`): after `getState` returns null and BEFORE the call to `createState`. If a parent is adopted, fall through into `createState` with a flag (or call a new shared internal function) so children/deps are reconciled rather than duplicated.
   - At the top of `createState` (`src/lib/wish-state.ts:306`), inside an `if (!existingParent)` branch immediately after the existing `findParent` call (line 314): if `findParent` returns null, try `adoptParentByTitle` next. If adoption succeeds, use the adopted parent's `id` instead of inserting a new one — replace the `INSERT INTO tasks ... RETURNING *` (lines 323-330) with a branch that either INSERTs (no adoption) or skips the insert (adoption returned a row).
4. After successful adoption, print a single-line stderr notice via `console.warn`: `Adopted existing task #<seq> as parent for wish "<slug>" (was missing wish_file).` AND emit a runtime event via `publishSubjectEvent` (`src/lib/runtime-events.ts:259`):
   ```ts
   await publishSubjectEvent(repoPath, 'genie.task.adopted', {
     kind: 'state',
     source: 'hook',
     agent: 'wish-state',
     text: `Adopted task #${seq} as parent for wish "${slug}"`,
     data: { taskId, seq, slug, wishFile, previousTitle, repoPath },
   });
   ```
   `kind: 'state'` is required because the runtime-events type union (`src/lib/runtime-events.ts:50-58`) does NOT include `task.adopted` — the audit semantic lives in the `subject` string. The stderr line is for the operator; the event is for observability.
5. In the child-INSERT loop (`src/lib/wish-state.ts:332-343`), use `group.title ? \`Group ${group.name}: ${group.title}\` : \`Group ${group.name}\`` as the child title.
6. Reconcile pre-existing children of an adopted parent: query existing children with `SELECT id, group_name, title FROM tasks WHERE parent_id = <adoptedId>`. For each new `GroupDefinition`:
   - If a child with matching `group_name` exists: UPDATE its `title` to the new `Group N: <title>` format (idempotent — if title already matches, the UPDATE is a no-op). Preserve the existing `id`, `status`, and dependency rows.
   - If no child with matching `group_name` exists: INSERT a new child as in the no-adoption path.
   - For pre-existing children whose `group_name` does NOT appear in the new `GroupDefinition[]`: leave them untouched (they may have been added manually). They will only flag drift if the operator runs `genie reset`. This avoids destroying operator-authored child rows.
   - Re-run dependency INSERTs idempotently with `ON CONFLICT (task_id, depends_on_id) DO NOTHING` — the `task_dependencies` PRIMARY KEY is `(task_id, depends_on_id)` per `src/db/migrations/002_task_lifecycle.sql:125` (note: `dep_type` is NOT part of the PK, so the conflict target is the composite `(task_id, depends_on_id)`).
7. Tests in `src/lib/wish-state.test.ts`:
   - `should adopt existing parent created without wish_file` — pre-insert a task with `(title=slug, parent_id=null, wish_file=null)`, call `getOrCreateState`, assert the same task id is reused and its `wish_file` is now set.
   - `should adopt legacy parent created with wish title (not slug)` — pre-insert a task with `(title='Some Long Wish Title', parent_id=null, wish_file=null)`, call `getOrCreateState` after editing the WISH.md to have `# Wish: Some Long Wish Title` as the first heading. Assert the same task id is reused and its `wish_file` is now set.
   - `should preserve group titles when creating children` — call `createState` with `[{name:"1", title:"Parser"}]` and assert child title = `Group 1: Parser`.
   - `should fall back to "Group N" when title missing` — call with `[{name:"1"}]` and assert child title = `Group 1`.
   - `should not adopt parent from a different repo_path` — pre-insert at `/other/repo`, ensure a fresh parent is created (no cross-repo adoption).
   - `should reconcile pre-existing children titles on adoption` — pre-insert a parent + one child with `(group_name='1', title='Group 1')`, then call `getOrCreateState` with `[{name:'1', title:'Parser'}]`. Assert the child's id is preserved and its title is updated to `Group 1: Parser`. Assert no second child row is inserted for `group_name='1'`.

**Acceptance Criteria:**
- [ ] All six new wish-state tests pass.
- [ ] Existing wish-state tests continue to pass (no regression on the create/getOrCreate happy paths).
- [ ] Adoption notice appears on stderr exactly once per adoption.
- [ ] `genie.task.adopted` runtime event is published once per adoption with the full payload.
- [ ] `bun test src/lib/wish-state.test.ts` green.

**Validation:**
```bash
bun test src/lib/wish-state.test.ts
bun run typecheck
# Manual smoke (optional, requires PG): create parent via task create without --wish, then run genie work
genie task create "smoke-adopt" --type software
genie work smoke-adopt  # should adopt the parent, not create a duplicate
genie task list | grep smoke-adopt | wc -l   # expect 1 parent line + N child lines, no duplicate parent
```

**depends-on:** Group 1, Group 2

---

### Group 4: Docs — `/wish` SKILL.md updated to use `--wish <slug>`

**Goal:** Stop instructing operators to create orphan trees. Update the canonical guidance to thread `--wish <slug>` through both parent and child commands.

**Deliverables:**
1. Edit `skills/wish/SKILL.md` Task Lifecycle Integration section (lines 68-95):
   - Step 1 changes to `genie task create "<slug>" --type software --wish <slug>` (use the slug as the title so adoption keys align).
   - Step 2 changes to `genie task create "<group title>" --parent #<parent-seq> --wish <slug>`.
   - Summary table updated to match.
   - Add a one-line note: "The `--wish <slug>` flag wires `wish_file` so `/work` reuses the same task tree instead of creating a parallel one (issue #1300)."
2. Verify `genie wish lint fix-wish-task-tree-unification` still passes after the doc edits — lint operates on the wish, not the skill, but the wish references skill commands so a manual cross-check is cheap.

**Acceptance Criteria:**
- [ ] `skills/wish/SKILL.md` Task Lifecycle Integration commands all include `--wish <slug>`.
- [ ] No other skill files modified.
- [ ] `genie wish lint fix-wish-task-tree-unification` exits 0.
- [ ] Diff in `skills/wish/SKILL.md` is scoped to lines ~68-95.

**Validation:**
```bash
genie wish lint fix-wish-task-tree-unification
git diff skills/wish/SKILL.md | head -60
bun run check
```

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: running the canonical `/wish` flow (`genie wish new`, edit, `genie task create "<slug>" --type software --wish <slug>`, then `genie work <slug>`) produces a single parent task with descriptive child titles — `genie task list` shows one tree, not two.
- [ ] Integration: a parent task created without `--wish` (legacy invocation) is adopted by the next `genie work <slug>` invocation: same task id is preserved, `wish_file` is populated retroactively, and a single one-line adoption notice appears on stderr.
- [ ] Regression: existing wishes whose parent tasks already have `wish_file` set (created via `/work` in current main) continue to round-trip without spurious adoption notices or duplicated trees. `groupsSignature` validation still detects WISH.md group structure drift after the title field lands (title changes alone must NOT trigger drift).
- [ ] Regression: `genie task create` invocations without `--wish` still work and produce tasks with `wish_file = NULL`.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Adoption picks up an unrelated task that happens to share the slug as its title | Low | Adoption keys also require `parent_id IS NULL` and `wish_file IS NULL OR wish_file = <expected>`. Operators creating standalone tasks named after a wish slug is a contrived case; if it happens, the worst case is one merge that the operator can split via `genie task move` etc. |
| Conflict with #1406 on the same `parseWishGroups` block | Medium | Coordinate via PR base — whichever wish lands second rebases. The diff hotspot is ~10 lines; the conflict is mechanical. We declare slug# stripping OUT of this wish so neither PR grows. |
| Title-in-signature regression — including title in `computeGroupsSignature` would cause every WISH.md prose edit to flip the signature and demand `genie reset` | High if missed | Group 1 explicitly excludes title from the signature and adds a regression test that asserts identical signatures across title changes. Reviewer must confirm the `computeGroupsSignature` body is unchanged. |
| Adoption logic races with concurrent `/work` invocations | Low | `getOrCreateState` already runs serially per-wish in practice; the adoption SELECT-then-UPDATE happens inside the same logical operation. PG row locks are not strictly needed at this scale, but if reviewers want them, wrap in `BEGIN; SELECT ... FOR UPDATE; UPDATE; COMMIT;` — call this out in PR review. |
| `wish_file` index is partial (`WHERE wish_file IS NOT NULL`) — adoption updates may invalidate cached query plans temporarily | Low | One-time cost per adoption; no functional impact. |

---

## Review Results

### Codex Review - 2026-04-28 (Plan)

**Verdict:** FIX-FIRST

**Evidence:**
- `genie wish parse fix-wish-task-tree-unification` passed and parsed 4 execution groups, success criteria, validations, QA criteria, and file list.
- `genie wish lint fix-wish-task-tree-unification` passed with no structural violations.
- `gh issue view 1300` passed; issue #1300 is open and matches the plan's main fixes: duplicate task trees, lost group titles, `--wish`, adoption fallback, and `/wish` skill update.

**Blocking gap:**
- HIGH: The adoption plan does not fully rescue the legacy flow from issue #1300. Current `/wish` guidance creates the parent task as `<wish title>`, but Group 3 only adopts `title = <slug>`. Amend Group 3 to adopt both slug-titled and current-guidance title-titled parents, or derive the WISH title and query `title IN (<slug>, <wish title>)` with existing repo/wish-file guards. Add a test for a parent titled with the WISH title and no `wish_file`.

**Non-blocking gaps:**
- MEDIUM: Group 2 validation can mask a failing task CLI test because it uses `bun test src/term-commands/task.test.ts || bun test src/lib/task-service.test.ts`. Require the task CLI test to exist and pass directly; run task-service tests separately if desired.
- MEDIUM: `--wish` validation should use the existing slug validator or `^[a-z0-9][a-z0-9-]*$`, with tests for spaces, uppercase, and path traversal.

---

### Claude Code Review - 2026-04-28 (Plan)

**Verdict:** AGREE with Codex FIX-FIRST, with two refinements and one parallelization opportunity.

**Agreement with Codex:**
- HIGH (legacy-rescue scope): yes. Decision #4 keys adoption on `title = <slug>`, but current SKILL.md teaches operators to use `<wish title>` (free-form). Adoption-by-title misses every existing legacy parent. **Fix:** widen the adopt query to `title IN (<slug>, <wishTitle>) AND parent_id IS NULL AND repo_path = ?`. Read `<wishTitle>` from the WISH.md frontmatter. Add a regression test that pre-inserts `(title='Some Long Wish Title', parent_id=null, wish_file=null)` and asserts `getOrCreateState` adopts it.
- MEDIUM (test fallback masks failures): yes. Replace `||` with explicit assertions; require both files to exist and pass.
- MEDIUM (slug validation hardening): yes. Use `^[a-z0-9][a-z0-9-]*$`, add tests for spaces / uppercase / `..` / absolute paths.

**Additional refinements Codex missed:**

- **LOW — Group 4 (docs) can run in parallel with Group 3.** The skill update doesn't depend on wish-state implementation, only on `--wish` flag existing (Group 2). Currently scoped sequential 1→2→3→4. Re-strategize as Wave 1 (Group 1, sequential) → Wave 2 (Group 2) → Wave 3 (Group 3 || Group 4 in parallel). Cuts ~25% of dispatch time on a "medium" wish.
- **MEDIUM — adoption notice channel.** Decision row says "single-line stderr notice." But the rest of `genie work` writes structured events to PG (`publishSubjectEvent`). An adoption that flips a row's `wish_file` is exactly the kind of event a future audit/observability dashboard would want. Recommend emitting both: stderr line for the operator + a `genie.task.adopted` runtime event for the audit trail. 5 extra lines in Group 3 deliverable 1.

**Out-of-scope but worth noting:** the conflict with #1406 (slug# prefix) is real — both wishes touch `parseWishGroups`. The wish correctly declares OUT and recommends rebasing. Suggest adding a sentence: *"#1406 is the smaller / earlier merge candidate; this wish rebases onto it."*

**Next:** /fix the codex gaps (legacy title rescue, test fallback, slug validation) + apply the parallelization restrategy. Then SHIP.

---

## Files to Create/Modify

```
src/lib/wish-state.ts                 # +title? on GroupDefinition; adopt-by-title in getOrCreateState/createState; use group.title in child INSERT
src/lib/wish-state.test.ts            # +4 tests (adoption + title preservation + fallback + cross-repo isolation)
src/term-commands/dispatch.ts         # extend parseWishGroups regex + capture loop to read title
src/term-commands/dispatch.test.ts    # +4 tests (title captured, missing title, multi-group with deps, signature stability)
src/term-commands/task.ts             # +CreateOptions.wish; +commander --wish flag; +wishFile plumbing in handleTaskCreate
src/term-commands/task.test.ts        # +1 test (--wish populates wish_file) — create file if absent
skills/wish/SKILL.md                  # update Task Lifecycle Integration to use --wish <slug>
```
