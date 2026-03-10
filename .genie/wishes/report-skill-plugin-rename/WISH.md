# Wish: Plugin rename, /debug -> /trace, new /report skill

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `report-skill-plugin-rename` |
| **Date** | 2026-03-10 |
| **Design** | [DESIGN.md](../../brainstorms/report-skill-plugin-rename/DESIGN.md) |
| **depends-on** | `genie-default-command` (tui rename must land first to avoid double-editing files) |

## Summary

The plugin name `automagik-genie` is too verbose — skills show as `automagik-genie:brainstorm` instead of `genie:brainstorm`. The `/debug` skill conflicts with Claude Code's built-in debug. A new `/report` skill is needed that cascades through `/trace` (renamed `/debug`), opportunistically captures browser evidence (screenshots, video, console, network, perf), extracts observability data from project-configured tools (Sentry, PostHog, DataDog), and auto-creates a GitHub issue with all evidence attached.

## Scope

### IN

- Rename plugin: `automagik-genie` -> `genie` in `plugin.json` and `cliff.toml`
- Rename skill: `debug` -> `trace` (directory, SKILL.md frontmatter, all cross-references)
- Rename agent: `plugins/genie/agents/debug.md` -> `plugins/genie/agents/trace.md`
- Update `/fix` skill and agent references from `/debug` to `/trace`
- Create new `/report` skill that cascades through `/trace` + browser + observability
- `/report` auto-creates GitHub issues via `gh issue create`

### OUT

- No changes to agent-browser itself (use existing capabilities only)
- No installation of Sentry/PostHog/DataDog SDKs or MCPs (use project-local config if present)
- No changes to `/fix` skill logic (only update debug->trace references)
- No changes to the plugin build system or openclaw.plugin.json (already uses id "genie")
- No new CLI commands (these are skills, not genie CLI commands)
- No changes to council agent definitions (council--tracer is a different concept)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Plugin name: `genie` (clean break) | Few installs exist; clean break beats alias complexity |
| `/debug` -> `/trace` | Avoids Claude built-in conflict; "trace" implies following evidence |
| `/report` cascades through `/trace` | Reuse investigation logic; separation of concerns |
| Browser investigation is opportunistic | Auto-detect URL/dev server; not every bug is UI-related |
| Observability is project-dependent | Detect SENTRY_DSN, POSTHOG_KEY, DD_API_KEY, etc. and use what's available |
| Auto-create GitHub issue | Reduces friction; the whole point is a ready-to-action issue |
| Degrade gracefully without browser/observability | Code-level report is still valuable; don't block on missing tools |

## Success Criteria

- [ ] Skills show as `genie:trace`, `genie:brainstorm`, etc. (not `automagik-genie:`)
- [ ] `/trace` works identically to old `/debug` (renamed, same behavior)
- [ ] `/debug` no longer appears in skill list
- [ ] `/fix` skill references `/trace` not `/debug`
- [ ] `/report` produces a comprehensive bug report from user-provided symptoms
- [ ] `/report` runs `/trace` as first step of investigation
- [ ] `/report` captures screenshots when browser/URL is available
- [ ] `/report` pulls observability data when project has Sentry/PostHog/DataDog configured
- [ ] `/report` creates a GitHub issue via `gh issue create` with all evidence
- [ ] `/report` degrades gracefully when browser or observability tools are missing
- [ ] `bun run check` passes
- [ ] No remaining references to `automagik-genie` in plugin files
- [ ] No remaining references to `/debug` in any skill or agent definition

## Execution Groups

### Group 1: Plugin rename (automagik-genie -> genie)

**Goal:** Skills show as `genie:*` instead of `automagik-genie:*`.

**Deliverables:**
1. Edit `plugins/genie/.claude-plugin/plugin.json` line 2: `"name": "automagik-genie"` -> `"name": "genie"`
2. Edit `cliff.toml` line 40-41: update contributor attribution from `automagik-genie` to `genie`

**Acceptance criteria:**
- `grep -r 'automagik-genie' plugins/ cliff.toml` returns zero results
- `openclaw.plugin.json` still has `"id": "genie"` (unchanged, already correct)

**Validation:**
```bash
grep -rn 'automagik-genie' plugins/ cliff.toml && echo "FAIL" || echo "PASS"
grep -n '"id": "genie"' openclaw.plugin.json && echo "PASS" || echo "FAIL"
```

### Group 2: Rename debug -> trace (skill + agent)

**Goal:** Eliminate `/debug` naming, replace with `/trace` everywhere.

**Deliverables:**
1. Rename directory `skills/debug/` -> `skills/trace/`
2. In `skills/trace/SKILL.md`:
   - Frontmatter: `name: debug` -> `name: trace`
   - Description: update to reference "trace" not "debug"
   - Title: `/debug` -> `/trace`
   - All internal references to "debug" -> "trace" where referring to this skill
   - Handoff text: "Hand off to `/fix`" (unchanged, but verify `/debug` isn't mentioned)
3. Rename `plugins/genie/agents/debug.md` -> `plugins/genie/agents/trace.md`
   - Update agent name/description inside the file
4. In `skills/fix/SKILL.md`:
   - Lines 12, 21: update `/debug` -> `/trace` references
   - Update any "debug subagent" -> "trace subagent" references
5. In `plugins/genie/agents/fix.md`:
   - Line 3: update debug role reference to trace

**Acceptance criteria:**
- No directory `skills/debug/` exists
- `grep -rn '/debug' skills/ plugins/genie/agents/` returns zero results (for skill references)
- `/trace` skill frontmatter has `name: trace`
- `/fix` skill references `/trace` for handoff

**Validation:**
```bash
[ -d skills/debug ] && echo "FAIL: debug dir still exists" || echo "PASS"
grep -rn '/debug' skills/ plugins/genie/agents/ | grep -v 'node_modules' && echo "FAIL" || echo "PASS"
grep -n 'name: trace' skills/trace/SKILL.md && echo "PASS" || echo "FAIL"
```

### Group 3: Create /report skill

**Goal:** New skill that produces comprehensive, evidence-rich bug reports and creates GitHub issues.

**Deliverables:**
1. Create `skills/report/SKILL.md` with the following structure:

**Skill flow:**
```
Phase 1: Collect symptoms (user input — description, URL, error messages)
Phase 2: Run /trace (code-level root cause investigation)
Phase 3: Browser investigation (opportunistic)
  - Detect: URL provided? Dev server running on common ports (3000, 5173, 8080, etc.)?
  - If available: use agent-browser for:
    - Screenshot of affected page (annotated)
    - Full-page screenshot
    - Video recording of reproduction steps
    - Console log capture (errors, warnings)
    - Network waterfall (failed requests, timing)
    - Performance profile (if perf-related)
  - If unavailable: skip, note in report
Phase 4: Observability data (project-dependent)
  - Detect project config for: Sentry (SENTRY_DSN, sentry.*.config.*),
    PostHog (POSTHOG_KEY), DataDog (DD_API_KEY), LogRocket, etc.
  - If found: use available API/CLI to pull recent errors, events, traces
  - If not found: skip gracefully
Phase 5: Compile report
  - Merge /trace root cause analysis + browser evidence + observability data
  - Generate GitHub issue body with structured template
  - Attach screenshots/videos as assets
Phase 6: Create GitHub issue
  - Verify gh auth status
  - gh issue create --title "<title>" --body "<report>"
  - If gh fails: print report to stdout as fallback
```

**GitHub issue template sections:**
- Summary (1-2 sentences)
- Reproduction Steps (numbered)
- Expected vs Actual Behavior
- Root Cause Analysis (from /trace: file, line, causal chain, confidence)
- Evidence: Screenshots, Console Logs, Network, Performance, Observability
- Environment (OS, runtime, browser, deps)
- Suggested Fix (from /trace recommendation)
- Labels: `bug`, plus auto-detected area labels

**Degradation rules:**
- No browser -> skip Phase 3, note "Browser evidence not available"
- No observability tools -> skip Phase 4, note "No observability integrations detected"
- No `gh` auth -> print report to stdout, suggest manual issue creation
- No URL or dev server -> skip browser, rely on code-level trace only

2. Add `report` to the skills index if one exists

**Acceptance criteria:**
- `skills/report/SKILL.md` exists with valid frontmatter (`name: report`)
- Skill references `/trace` (not `/debug`) for code investigation
- Skill references `agent-browser` for browser capabilities
- Degradation paths documented for missing browser/observability/gh
- GitHub issue template includes all evidence sections

**Validation:**
```bash
[ -f skills/report/SKILL.md ] && echo "PASS" || echo "FAIL"
grep -n 'name: report' skills/report/SKILL.md && echo "PASS" || echo "FAIL"
grep -n '/trace' skills/report/SKILL.md && echo "PASS" || echo "FAIL"
grep -n 'agent-browser' skills/report/SKILL.md && echo "PASS" || echo "FAIL"
grep -n 'gh issue create' skills/report/SKILL.md && echo "PASS" || echo "FAIL"
```

### Group 4: Final validation

**Goal:** All changes integrate cleanly.

**Deliverables:**
1. Verify no stale references remain
2. Run quality gates

**Acceptance criteria:**
- No `automagik-genie` in plugin files
- No `/debug` skill references in skills or agents
- No `debug.md` agent file
- `bun run check` passes

**Validation:**
```bash
grep -rn 'automagik-genie' plugins/ cliff.toml && echo "FAIL: plugin name" || echo "PASS"
grep -rn '/debug' skills/ plugins/genie/agents/ | grep -v node_modules && echo "FAIL: debug refs" || echo "PASS"
[ -f plugins/genie/agents/debug.md ] && echo "FAIL: debug agent" || echo "PASS"
bun run check
```

## Assumptions / Risks

| Risk | Mitigation |
|------|------------|
| Plugin rename breaks existing installs | Clean break — users reinstall. Few installs currently. |
| `/trace` name confusion with browser DevTools tracing | Context makes it clear — `/trace` = root cause investigation, not browser profiling |
| agent-browser not available in all environments | Graceful degradation — skip browser evidence, note in report |
| `gh` auth may not be configured | Fall back to printing report to stdout |
| Observability API tokens may be expired/invalid | Try-catch each; skip and note in report |
| Video recording produces large files for GH issues | Use screenshots as primary; video as supplementary |
| `/report` SKILL.md is complex (multi-phase orchestration) | Keep each phase clearly documented with explicit detection + skip logic |
