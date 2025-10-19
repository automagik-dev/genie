# Forge Plan – Token-Efficient Output
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Generated:** 2025-10-15 18:45Z
**Wish:** token-efficient-output-wish.md
**Branch:** feat/token-efficient-output
**Target:** 96-98% token reduction (16k → 0.3-0.5k tokens per view)

## Summary

Replace verbose 4-layer Ink rendering pipeline with simple 2-layer markdown formatter. Delete Ink completely (no backwards compatibility needed), replace executor-prompt with readline-based alternative. Four execution groups with strict sequencing: A (formatter) must complete before B (delete Ink), C (executor-prompt) can run parallel to B, D (validation) must wait for A+B+C.

## Spec Contract (from wish)

**Scope:**
- Create markdown formatter with 3 output modes (final, recent, overview)
- Delete Ink rendering layer completely (render.tsx, views/*, ViewEnvelope)
- Replace executor-prompt.tsx with readline-based alternative
- Validate MCP integration with real orchestration test

**Out of scope:**
- Backwards compatibility (no users, breaking change acceptable)
- Phased rollout or deprecation periods
- Dual output paths (markdown + Ink)
- JSON/HTML output modes (can add later if needed)

**Success metrics:**
- 96-98% token reduction (16k → 0.3-0.5k per view)
- Information loss <5%
- Zero Ink imports remaining in codebase
- Real orchestration session with 3-4 subagents validates efficiency gain

**Dependencies:** None (self-contained refactoring)

**External tasks:** Update Issue #42 with completion evidence

## Execution Groups

### Group A – Markdown Formatter (NEW)

**Goal:** Create simple markdown formatter for ChatMessage[] → markdown string

**Scope:** Build new formatter module with 3 output modes, token budget enforcement

**Inputs:**
- `@.genie/cli/src/executors/transcript-utils.ts:253-378` (ChatMessage[] structure)
- `` (current ViewEnvelope structure for reference)
- Wish specification for 3 modes (final, recent, overview)

**Deliverables:**

**Files to create:**
1. `.genie/cli/src/lib/markdown-formatter.ts` (~150 lines)
   - `formatTranscriptMarkdown(messages: ChatMessage[], meta: SessionMeta, mode: OutputMode): string`
   - `formatSessionList(sessions: SessionEntry[]): string`
   - Types: `OutputMode = 'final' | 'recent' | 'overview'`
   - Types: `SessionMeta = { sessionId, agent, status, executor, tokens?, toolCalls?, model? }`

**Implementation details:**
- **final mode:** Last message only, mini-report format
  - Format: `## Session: <id>\n**Status:** <status>\n**Last message:** <title>\n\n<body>`
  - Target: ~500 tokens max
- **recent mode (default):** Latest 5 messages, compact
  - Format: `## Session: <id>\n### Message <n>: <title>\n<body>\n\n`
  - Target: ~300 tokens max
- **overview mode:** Session metadata + checkpoints
  - Format: `## Session: <id>\n**Agent:** <agent>\n**Status:** <status>\n**Tokens:** <count>\n**Messages:** <count>`
  - Target: ~400 tokens max
- Token budget enforcement: truncate messages if approaching limits
- Metadata formatting: clean key-value pairs (no ANSI, no React)
- Session list formatting: compact table (sessionId, agent, status, executor)

**Tests required:**
- Unit tests for 3 output modes
- Token count measurements (validate <500 tokens per mode)
- Edge cases: empty transcript, very long messages, missing metadata

**Evidence:**
- Unit tests passing in `.genie/cli/src/lib/__tests__/markdown-formatter.test.ts`
- Token count measurements logged in `qa/markdown-samples.md`
- Example outputs for all 3 modes captured in `qa/markdown-samples.md`

**Validation hooks:**
```bash
# Run unit tests
cd .genie/cli && pnpm test -- markdown-formatter.test.ts

# Verify token counts
cat .genie/wishes/token-efficient-output/qa/markdown-samples.md | wc -c
# Expected: Each example <2000 chars (~500 tokens)
```

**External tracker:** None

**Suggested persona:** implementor

**Dependencies:** None (can start immediately)

**Branch:** feat/token-efficient-output (create from main)

**Approval checkpoint:** Validate output format and token counts before proceeding to Group B

---

### Group B – Replace View Layer

**Goal:** Delete Ink rendering, use markdown formatter instead

**Scope:** Replace all Ink usage in view/list commands with markdown formatter, delete Ink files

**Inputs:**
- `@.genie/cli/src/lib/markdown-formatter.ts` (completed from Group A)
- `@.genie/cli/src/commands/view.ts` (current implementation)
- `@.genie/cli/src/commands/list.ts` (current implementation)
- `` (delete target)
- `` (delete target)
- `@.genie/cli/src/views/runs.ts` (delete target)

**Deliverables:**

**Files to modify:**
1. `.genie/cli/src/commands/view.ts`
   - Replace `buildChatView()` calls with `formatTranscriptMarkdown()`
   - Replace `emitView()` with `console.log()` or direct stdout write
   - Remove ViewEnvelope imports
   - Add markdown-formatter import
   - Detect output mode from flags: `--full` → overview, `--live` → final, default → recent

2. `.genie/cli/src/commands/list.ts`
   - Replace session list rendering with `formatSessionList()`
   - Remove ViewEnvelope imports
   - Add markdown-formatter import
   - Output markdown table directly to stdout

**Files to delete:**
1. `.genie/cli/src/view/render.tsx` (560 lines, entire Ink rendering layer)
2. `.genie/cli/src/views/chat.ts` (158 lines, ViewEnvelope builders)
3. `.genie/cli/src/views/runs.ts` (95 lines, ViewEnvelope builders)
4. `.genie/cli/src/views/common.ts` (if exists and has no other consumers)
5. `.genie/cli/src/view/view-model.ts` (ViewEnvelope type definitions, if no other consumers)
6. `.genie/cli/src/view/theme.ts` (if no other consumers)

**Implementation details:**
- Before deletion: capture before token measurements
  ```bash
  ./genie view <session-id> --full | wc -c  # Should be ~16k chars
  ```
- Replace ViewEnvelope with direct markdown output
- Ensure error handling preserved (missing session, invalid ID)
- Preserve all functionality (--full, --live flags, orphaned session detection)
- After implementation: capture after token measurements
  ```bash
  ./genie view <session-id> --full | wc -c  # Should be ~300-500 chars
  ```

**Dependencies to update:**
- Check `package.json` for Ink dependencies (can remove after Group C completes)
- Check for other Ink consumers before deleting theme.ts

**Tests required:**
- Manual testing: `./genie view <session-id>` (all modes)
- Manual testing: `./genie list` (session table)
- Before/after token measurements
- Verify output still usable (not broken, truncated, or garbled)

**Evidence:**
- Before/after token measurements in `qa/token-measurements.md`
- CLI output examples in `qa/cli-output-comparison.md`
- Screenshots/captured output showing markdown format
- Verification command results in `reports/done-group-b.md`

**Validation hooks:**
```bash
# Verify Ink rendering removed
grep -r "renderEnvelope\|ViewEnvelope" .genie/cli/src/ | grep -v node_modules
# Expected: 0 results

# Verify markdown formatter used
grep -r "formatTranscriptMarkdown" .genie/cli/src/commands/
# Expected: view.ts, list.ts

# Token measurement (after)
./genie view <session-id> --full | wc -c
# Expected: ~300-500 chars (vs 16k before)

# Test output modes
./genie view <session-id>          # recent mode
./genie view <session-id> --full   # overview mode
./genie view <session-id> --live   # final mode
```

**External tracker:** None

**Suggested persona:** implementor, polish (cleanup verification)

**Dependencies:** **MUST complete Group A first** (requires markdown-formatter.ts)

**Branch:** feat/token-efficient-output (same branch as Group A)

**Approval checkpoint:** Verify no breaking changes, compare outputs before/after

---

### Group C – Replace Executor Prompt

**Goal:** Replace Ink-based executor selection with readline/simple prompts

**Scope:** Rewrite executor-prompt without Ink dependency, update all consumers

**Inputs:**
- `` (current Ink implementation)
- `@.genie/cli/src/commands/init.ts` (consumer)
- `@.genie/cli/src/commands/update.ts` (consumer)
- `@.genie/cli/src/commands/model.ts` (consumer, if exists)

**Deliverables:**

**Files to replace:**
1. Delete `.genie/cli/src/lib/executor-prompt.tsx`
2. Create `.genie/cli/src/lib/executor-prompt.ts` (~80 lines)
   - `promptExecutorChoice(availableExecutors: string[], defaultExecutor: string): Promise<string>`
   - Use Node.js `readline` module (no external deps)
   - Simple numbered list: "1. codex\n2. claude\nSelect (1-2, default: 2):"
   - Arrow key navigation if feasible, otherwise number-based selection
   - Validate input, default on empty/invalid

**Files to modify:**
1. `.genie/cli/src/commands/init.ts`
   - Update import from `.tsx` to `.ts`
   - No functionality change (same interface)

2. `.genie/cli/src/commands/update.ts`
   - Update import from `.tsx` to `.ts`
   - No functionality change (same interface)

3. Other consumers (search for `executor-prompt`)
   - Update imports as needed

**Implementation details:**
- **Simple approach:** Readline with number selection
  ```typescript
  import readline from 'readline';

  export async function promptExecutorChoice(
    availableExecutors: string[],
    defaultExecutor: string
  ): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('Select executor:');
    availableExecutors.forEach((exec, i) => {
      const marker = exec === defaultExecutor ? ' (default)' : '';
      console.log(`  ${i + 1}. ${exec}${marker}`);
    });

    return new Promise((resolve) => {
      rl.question('Choice (1-N, Enter for default): ', (answer) => {
        rl.close();
        const index = parseInt(answer.trim()) - 1;
        if (index >= 0 && index < availableExecutors.length) {
          resolve(availableExecutors[index]);
        } else {
          resolve(defaultExecutor);
        }
      });
    });
  }
  ```

- **Better UX (if feasible):** Use `keypress` events for arrow keys
  - Consider `inquirer` package (already may be in deps)
  - Or `prompts` package (lightweight, no Ink)
  - Keep it simple, avoid heavy dependencies

**Tests required:**
- Manual testing: `./genie init` (interactive selection)
- Manual testing: `./genie update` (interactive selection)
- Verify default selection works (press Enter)
- Verify numbered selection works (type 1 or 2)
- UX validation (usable, not ugly)

**Evidence:**
- Interactive selection tested and documented in `qa/executor-prompt-ux.md`
- Screenshots/recordings of UX in `qa/`
- Verification command results in `reports/done-group-c.md`

**Validation hooks:**
```bash
# Verify Ink removed from executor-prompt
grep -r "import.*ink" .genie/cli/src/lib/executor-prompt.ts
# Expected: 0 results

# Verify all consumers updated
grep -r "executor-prompt.tsx" .genie/cli/src/
# Expected: 0 results

# Test interactive selection
./genie init      # Should prompt for executor
./genie update    # Should prompt for executor
```

**External tracker:** None

**Suggested persona:** implementor

**Dependencies:** None (independent of Groups A/B, can run in parallel with B)

**Branch:** feat/token-efficient-output (same branch)

**Approval checkpoint:** Test interactive UX, ensure not worse than before

---

### Group D – MCP Integration & Validation

**Goal:** Validate MCP consumes markdown correctly, measure token savings

**Scope:** End-to-end validation with real orchestration session, token measurements, evidence capture

**Inputs:**
- `@.genie/cli/src/lib/markdown-formatter.ts` (completed from Group A)
- `.genie/cli/src/commands/view.ts` (completed from Group B)
- `.genie/cli/src/commands/list.ts` (completed from Group B)
- Real MCP orchestration session (3-4 subagents)

**Deliverables:**

**Validation tasks:**
1. **Before measurements:**
   - Run orchestration session on OLD code (main branch)
   - Capture token usage: 36-48k expected for 3-4 subagents
   - Save session transcript for comparison

2. **After measurements:**
   - Run same orchestration session on NEW code (feat branch)
   - Capture token usage: <2k expected
   - Save session transcript for comparison
   - Calculate reduction percentage

3. **Information loss assessment:**
   - Compare before/after transcripts
   - Identify missing/lost information
   - Target: <5% information loss
   - Document any acceptable losses (ANSI codes, visual formatting)

4. **MCP integration test:**
   - Use `mcp__genie__view` with sessionId and full=true
   - Verify markdown output usable by AI
   - Test all 3 output modes via MCP
   - Confirm no parsing errors, no encoding issues

5. **Real orchestration validation:**
   - Run orchestration with 3-4 specialist agents
   - Example: plan → wish → forge → implementor workflow
   - Measure total token consumption
   - Verify workflow still functional with markdown output

**Implementation details:**
- Use same session scenario before/after for fair comparison
- Document token counting methodology (chars ÷ 4 estimate, or actual API count)
- Capture full transcripts for evidence
- Use real-world orchestration (not synthetic test)

**Tests required:**
- Before orchestration: capture baseline metrics
- After orchestration: capture new metrics
- Side-by-side comparison: token count, information preserved
- MCP validation: all tools work with markdown

**Evidence:**
- Session transcripts compared in `qa/mcp-validation-session.md`
- Token counts logged in `qa/token-measurements.md`
- Before/after comparison table in `qa/token-measurements.md`
- Information loss analysis in `qa/information-loss-assessment.md`
- MCP integration proof (screenshots, logs) in `qa/mcp-validation-session.md`

**Validation hooks:**
```bash
# Token measurement comparison
echo "Before: $(cat qa/token-measurements.md | grep 'Before:' | awk '{print $2}') tokens"
echo "After: $(cat qa/token-measurements.md | grep 'After:' | awk '{print $2}') tokens"
echo "Reduction: $(cat qa/token-measurements.md | grep 'Reduction:' | awk '{print $2}')%"

# Verify reduction target met
# Expected: Reduction ≥96%

# Test MCP integration
# Run orchestration session with 3-4 subagents
# Monitor token usage in real-time
# Document in qa/mcp-validation-session.md
```

**External tracker:** None

**Suggested persona:** review (QA validation), tests (orchestration setup)

**Dependencies:** **MUST complete Groups A, B, and C first**

**Branch:** feat/token-efficient-output (same branch)

**Approval checkpoint:** Review token savings proof, verify <5% information loss

---

## Final Cleanup & Dependency Updates

**After all groups complete:**

1. **Remove Ink dependencies:**
   ```bash
   # Check for remaining Ink usage
   grep -r "import.*ink" .genie/cli/src/ | grep -v node_modules
   # Expected: 0 results

   # Update package.json
   # Remove: "ink": "^5.0.1" (if no other consumers)
   # Remove: "@types/react" (if no other consumers)
   # Run: pnpm install
   ```

2. **Verify cleanup:**
   ```bash
   # No ViewEnvelope references
   grep -r "ViewEnvelope" .genie/cli/src/ | grep -v node_modules
   # Expected: 0 results

   # No renderEnvelope references
   grep -r "renderEnvelope" .genie/cli/src/ | grep -v node_modules
   # Expected: 0 results

   # No executor-prompt.tsx references
   grep -r "executor-prompt.tsx" .genie/cli/src/
   # Expected: 0 results
   ```

3. **Build verification:**
   ```bash
   cd .genie/cli
   pnpm run build
   # Expected: Clean build, no errors
   ```

4. **Integration test:**
   ```bash
   # Test all commands still work
   ./genie list
   ./genie view <session-id>
   ./genie view <session-id> --full
   ./genie init --help
   ./genie update --help
   ```

---

## Sequencing & Dependencies

```
┌─────────────┐
│   Group A   │  Markdown Formatter (NEW)
│  (Create)   │  • No dependencies, can start immediately
└──────┬──────┘
       │
       ├──────────────────┬─────────────────┐
       │                  │                 │
       ▼                  ▼                 ▼
┌─────────────┐    ┌─────────────┐   ┌─────────────┐
│   Group B   │    │   Group C   │   │             │
│  (Replace)  │    │  (Replace)  │   │   Wait for  │
│  View Layer │    │  Executor   │   │   A + B + C │
│             │    │   Prompt    │   │             │
└──────┬──────┘    └──────┬──────┘   └─────────────┘
       │                  │                 │
       └──────────────────┴─────────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │   Group D   │
                   │ (Validate)  │
                   │  MCP + E2E  │
                   └─────────────┘
```

**Critical path:**
- A → B → D (markdown formatter required before replacing view layer)
- C can run parallel to B (independent paths)
- D must wait for A + B + C (needs all changes complete)

**Estimated effort:**
- Group A: ~2-3 hours (new code, tests)
- Group B: ~3-4 hours (replacements, deletions, verification)
- Group C: ~1-2 hours (simpler replacement)
- Group D: ~2-3 hours (validation, measurements, evidence)
- **Total: ~8-12 hours**

---

## Branch Strategy

**Branch:** `feat/token-efficient-output` (dedicated, create from main)

**Workflow:**
1. Create branch: `git checkout -b feat/token-efficient-output`
2. Implement Groups A → B → C → D sequentially (or B+C parallel)
3. Capture all evidence in `qa/` and `reports/`
4. Final cleanup and dependency updates
5. Single PR after all groups complete
6. Squash merge to main

**Commits:**
- Group A: "feat: add markdown formatter with 3 output modes"
- Group B: "feat: replace Ink view layer with markdown formatter"
- Group C: "feat: replace Ink executor prompt with readline"
- Group D: "test: validate token reduction and MCP integration"
- Cleanup: "chore: remove Ink dependencies"

---

## Evidence Storage

**QA artifacts:** `.genie/wishes/token-efficient-output/qa/`
- `markdown-samples.md` - Example outputs (final, recent, overview modes)
- `cli-output-comparison.md` - Before/after CLI outputs
- `token-measurements.md` - Detailed token counts (before/after)
- `mcp-validation-session.md` - Real orchestration test evidence
- `information-loss-assessment.md` - What was lost/preserved
- `executor-prompt-ux.md` - Interactive UX validation

**Reports:** `.genie/wishes/token-efficient-output/reports/`
- `done-group-a-<timestamp>.md` - Group A completion
- `done-group-b-<timestamp>.md` - Group B completion
- `done-group-c-<timestamp>.md` - Group C completion
- `done-group-d-<timestamp>.md` - Group D completion
- `forge-plan-validation-<timestamp>.md` - Final review report

---

## Approval Checkpoints

1. **After Group A:** Validate output format and token counts
   - Review `qa/markdown-samples.md`
   - Confirm all 3 modes work correctly
   - Verify token budgets met (<500 tokens per mode)
   - **Human approval required before Group B**

2. **After Group B:** Verify no breaking changes, compare outputs
   - Review `qa/cli-output-comparison.md`
   - Test all CLI commands (view, list)
   - Confirm functionality preserved
   - Check token measurements (96%+ reduction)
   - **Human approval required before Group D**

3. **After Group C:** Test interactive UX
   - Review `qa/executor-prompt-ux.md`
   - Test executor selection (init, update)
   - Verify UX acceptable
   - **Human approval required before Group D**

4. **After Group D:** Review token savings proof
   - Review `qa/token-measurements.md`
   - Review `qa/mcp-validation-session.md`
   - Verify 96%+ reduction achieved
   - Verify <5% information loss
   - Confirm MCP integration works
   - **Human approval required before merge**

---

## Risks & Mitigations

**Risk 1:** Token measurements unreliable
- **Mitigation:** Use consistent methodology (chars ÷ 4 + actual API count)
- **Mitigation:** Document counting method in qa/token-measurements.md

**Risk 2:** Information loss >5%
- **Mitigation:** Careful comparison of before/after transcripts
- **Mitigation:** Document acceptable losses (ANSI codes, visual only)
- **Mitigation:** If exceeded, refine markdown formatter to preserve more info

**Risk 3:** MCP integration breaks
- **Mitigation:** Test all MCP tools (view, list, resume) with markdown
- **Mitigation:** Validate markdown parsing (no encoding issues)
- **Mitigation:** Fallback: keep JSON mode as alternative

**Risk 4:** Executor prompt UX worse than before
- **Mitigation:** User testing before approval
- **Mitigation:** Consider inquirer/prompts package for better UX
- **Mitigation:** Fallback: keep numbered selection simple and clear

**Risk 5:** Missed Ink consumers
- **Mitigation:** Comprehensive grep for all Ink imports
- **Mitigation:** Build verification after cleanup
- **Mitigation:** Integration tests for all commands

---

## Follow-up Actions

**After wish completion:**
1. Update Issue #42 with completion evidence and close
2. Document new output modes in CLI help text
3. Update README with token efficiency metrics
4. Consider future enhancements:
   - JSON output mode (if needed)
   - HTML output mode (for web embedding)
   - Configurable token budgets per mode
   - Streaming markdown output for long sessions

**Monitoring:**
- Track actual token usage in production orchestration sessions
- Gather user feedback on markdown output readability
- Monitor for any missed Ink references or regressions

---

**Plan Status:** Ready for execution
**Next Step:** Create branch `feat/token-efficient-output` and start Group A
