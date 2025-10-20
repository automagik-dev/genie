# Wish: Self-Updating Ecosystem - Git Hooks + Auto-Documentation

**Created:** 2025-10-17
**Status:** Planning
**Complexity:** High (comprehensive git hook suite + Python automation)
**Branch:** `feat/self-updating-ecosystem`
**Related Issues:** #49 (telemetry/metrics)

---

## 🎯 Vision

**Comprehensive self-updating ecosystem with zero manual maintenance.**

**Git hooks orchestrate Python scripts to:**
1. **Validate** - Token counts, @ references, routing matrix, user files not committed
2. **Generate** - Agent graph, agent registry, CHANGELOG, QA scenarios from bugs
3. **Update** - AGENTS.md, STATE.md, validation statuses, universal headers
4. **Enforce** - Tests pass before push, token efficiency maintained

**Result:** Framework self-documents, self-validates, stays lean - automatically.

**Architecture Principle:** Python scripts as git hooks (standalone, stdlib only, newbie-friendly)

---

## 📋 Context Ledger

### Problem Statement

**Current state:**
- Token bloat can creep in unnoticed (@ reference duplication, content drift)
- Architecture hierarchy exists but requires manual documentation
- No enforcement mechanism for token efficiency
- Agent graph ("which file loads what") is described but not evidenced

**Pain points:**
- Discovered @ optimization backwards (would have exploded tokens) - need prevention
- Architecture changes (new agents, @ references) aren't auto-documented
- Manual verification required to ensure efficiency claims are true

### Opportunity

**Git hook that enforces AND documents:**
1. **Token Gate**: Block commits that increase total prompt tokens without justification
2. **Agent Graph**: Parse all @ references, build hierarchy tree
3. **Auto-Documentation**: Update AGENTS.md with current architecture map on every commit

**Strategic value:**
- ✅ Prevents token bloat automatically (learned from RC9 optimization)
- ✅ Makes "@ reference optimization" claims provable (evidence, not assertion)
- ✅ Self-documenting architecture (zero manual maintenance)
- ✅ Validates collective ecosystem structure continuously

### Success Metrics

**Token efficiency:**
- ✅ Baseline established (current token count documented)
- ✅ Commits blocked if tokens increase >5% without justification
- ✅ Override mechanism available (`--token-increase-justified "reason"`)

**Agent graph accuracy:**
- ✅ All @ references discovered and mapped
- ✅ Hierarchy depth calculated (CLAUDE.md → AGENTS.md → agents → custom)
- ✅ Circular references detected and warned
- ✅ Visual tree updated in AGENTS.md automatically

**Developer experience:**
- ✅ Hook runs fast (<2s for typical commit)
- ✅ Clear error messages when blocked
- ✅ Easy override for legitimate increases
- ✅ Agent graph readable and useful

---

## 🔧 Technical Design

### Component 1: Token Counter

**Files:**
- `.genie/scripts/count-tokens.ts` - Token counting utility
- Uses `tiktoken` for accurate GPT-4 token counting
- Recursively resolves @ references (full content load simulation)

**Scope:**
```typescript
// Files to count
const PROMPT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.genie/agents/**/*.md',
  '.genie/custom/**/*.md'
];

// Recursive @ reference resolution
function countTokensWithReferences(file: string, visited: Set<string>): number {
  // Parse @ references, follow them, accumulate tokens
  // Detect cycles (visited set)
  // Return total including referenced files
}
```

### Component 2: Agent Graph Builder

**Files:**
- `.genie/scripts/build-agent-graph.ts` - @ reference parser + hierarchy builder

**Output format:**
```markdown
## Agent Graph Architecture

**Total Prompt Tokens:** 47,234 (baseline: 45,123, change: +2,111)
**Last Updated:** 2025-10-17 18:45 UTC
**Commit:** abc1234

### Hierarchy Map

```
CLAUDE.md (1,234 tokens)
├─ @AGENTS.md (23,456 tokens)
│  ├─  (2,345 tokens)
│  ├─  (1,987 tokens)
│  ├─ @.genie/code/agents/implementor.md (3,210 tokens)
│  └─ ... (15 more agents)
├─ @.genie/MASTER-PLAN.md (4,567 tokens)
├─ @.genie/SESSION-STATE.md (890 tokens)
└─ @.genie/USERCONTEXT.md (2,345 tokens)
   ├─ @.genie/TODO.md (678 tokens)
   └─ @.genie/STATE.md (456 tokens)

### Custom Overrides (loaded conditionally)
.genie/skills/routing-decision-matrix.md (1,234 tokens) → loaded by genie agent only
.genie/custom/implementor.md (890 tokens) → loaded by implementor agent
... (8 more overrides)
```

**Token Distribution:**
- Core framework: 35,678 tokens (75%)
- Workflow agents: 6,789 tokens (14%)
- Execution agents: 4,567 tokens (10%)
- Custom overrides: 200 tokens (0.4%)
```

**Features:**
- Hierarchical tree structure (indentation shows depth)
- Token count per file (shows weight)
- Conditional loading noted (custom overrides)
- Total distribution summary

### Component 3: Git Pre-Commit Hook

**Files:**
- `.git/hooks/pre-commit` - Hook entry point
- `.genie/scripts/validate-tokens.sh` - Token validation logic

**Workflow:**
```bash
#!/bin/bash
# .git/hooks/pre-commit

# 1. Generate agent graph (always - updates AGENTS.md)
node .genie/scripts/build-agent-graph.ts > /tmp/agent-graph.md

# 2. Extract current token count
CURRENT_TOKENS=$(grep "Total Prompt Tokens:" /tmp/agent-graph.md | awk '{print $4}')

# 3. Get baseline from AGENTS.md
BASELINE_TOKENS=$(grep "baseline:" AGENTS.md | awk '{print $2}' | tr -d ',')

# 4. Calculate change
CHANGE=$((CURRENT_TOKENS - BASELINE_TOKENS))
PERCENT=$(echo "scale=2; ($CHANGE / $BASELINE_TOKENS) * 100" | bc)

# 5. Check if increase exceeds threshold
if (( $(echo "$PERCENT > 5" | bc -l) )); then
  echo "❌ Token count increased by ${PERCENT}% (threshold: 5%)"
  echo "   Current: $CURRENT_TOKENS | Baseline: $BASELINE_TOKENS | Change: +$CHANGE"
  echo ""
  echo "If this increase is justified (new features/agents/skills):"
  echo "   git commit --token-increase-justified \"reason\""
  exit 1
fi

# 6. Update AGENTS.md with new agent graph
sed -i '/## Agent Graph Architecture/,/^## /!b;/^## Agent Graph Architecture/r /tmp/agent-graph.md' AGENTS.md

# 7. Stage updated AGENTS.md
git add AGENTS.md

echo "✅ Token validation passed (+${CHANGE} tokens, ${PERCENT}%)"
echo "✅ AGENTS.md updated with agent graph"
```

**Override mechanism:**
```bash
# .git/hooks/pre-commit (check for override)
if git config --get commit.token-override; then
  REASON=$(git config --get commit.token-override)
  echo "⚠️  Token increase justified: $REASON"
  git config --unset commit.token-override
  # Skip validation, update baseline
fi

# User invocation:
git config commit.token-override "Added 3 new agents for refactor workflow"
git commit -m "feat: add refactor workflow"
```

---

## 🗂️ Execution Groups

### Group A: Token Counter Foundation
**Complexity:** Medium
**Estimated:** 2-3 hours

**Tasks:**
1. Install `tiktoken` dependency
2. Implement `count-tokens.ts`:
   - File discovery (glob patterns)
   - Token counting per file
   - @ reference parser (regex: `@[\w/./-]+\.md`)
   - Recursive resolution with cycle detection
   - Aggregate total calculation
3. CLI interface: `node .genie/scripts/count-tokens.ts [file]`
4. Test with current codebase:
   - Verify token counts accurate
   - Test cycle detection
   - Validate @ reference resolution

**Evidence:**
- ✅ Script runs successfully
- ✅ Current baseline documented (commit output)
- ✅ @ references resolved correctly (manual spot check)

### Group B: Agent Graph Builder
**Complexity:** Medium
**Estimated:** 2-3 hours

**Tasks:**
1. Implement `build-agent-graph.ts`:
   - Parse @ references from all files
   - Build tree structure (parent-child relationships)
   - Calculate depth + token distribution
   - Format as markdown tree (indentation, tokens, percentages)
   - Detect conditional loading (custom overrides)
2. Generate output:
   - Hierarchical tree section
   - Token distribution summary
   - Metadata (total, baseline, change, commit, timestamp)
3. Test output:
   - Verify tree structure matches actual @ references
   - Validate token counts match counter script
   - Check formatting readability

**Evidence:**
- ✅ Agent graph generated for current state
- ✅ Tree structure validated (manual review)
- ✅ Token distribution accurate

### Group C: Git Hook Integration
**Complexity:** Low-Medium
**Estimated:** 1-2 hours

**Tasks:**
1. Create `.genie/scripts/validate-tokens.sh`:
   - Run agent graph builder
   - Extract current vs baseline tokens
   - Calculate percentage change
   - Check threshold (5%)
   - Update AGENTS.md with agent graph
   - Stage AGENTS.md automatically
2. Create `.git/hooks/pre-commit`:
   - Call validation script
   - Handle override flag
   - Exit codes (0 = pass, 1 = block)
3. Override mechanism:
   - `git config commit.token-override "reason"`
   - Auto-clear after use
4. Test hook:
   - Make benign commit (should pass)
   - Add large content (should block)
   - Use override (should pass with reason logged)

**Evidence:**
- ✅ Hook blocks token increases >5%
- ✅ Override mechanism works
- ✅ AGENTS.md auto-updated on every commit
- ✅ Clear error messages

### Group D: Documentation + Validation
**Complexity:** Low
**Estimated:** 1 hour

**Tasks:**
1. Document in AGENTS.md:
   - New section: "Agent Graph Architecture" (hook auto-maintains)
   - New section: "Token Efficiency Protocol" (how hook works, override usage)
2. Update README.md:
   - Hook setup instructions
   - Override usage examples
   - Agent graph location
3. Add to `.genie/scripts/check-triad.sh`:
   - Verify agent graph section exists in AGENTS.md
   - Validate baseline token count present
4. Test full workflow:
   - Fresh clone → hook setup → commit → validation
   - Verify AGENTS.md updated correctly
   - Check override flow

**Evidence:**
- ✅ Documentation complete
- ✅ Hook setup instructions clear
- ✅ Full workflow tested (green)

---

## 🔍 Evidence Checklist

**Token Counter:**
- [ ] Baseline established: [current tokens] committed
- [ ] @ reference resolution tested (CLAUDE.md → AGENTS.md → agents)
- [ ] Cycle detection works (test with circular refs)
- [ ] Performance acceptable (<1s for full count)

**Agent Graph:**
- [ ] Tree structure generated correctly
- [ ] Token distribution accurate (spot check 5 files)
- [ ] Hierarchy depth shown (CLAUDE.md = depth 0, agents = depth 2+)
- [ ] Conditional loading noted (custom overrides)

**Git Hook:**
- [ ] Blocks token increases >5% (tested)
- [ ] Override mechanism works (`git config commit.token-override "..."`)
- [ ] AGENTS.md auto-updated on every commit
- [ ] Clear error messages guide user

**Integration:**
- [ ] Fresh clone → hook works immediately
- [ ] Existing workflow unaffected (commits still fast)
- [ ] Agent graph readable and useful
- [ ] Token efficiency enforced automatically

---

## 🚫 Blockers

**None anticipated.**

**Potential risks:**
- Token counting accuracy (tiktoken vs approximation) → Start with tiktoken (accurate)
- Hook performance (recursive @ resolution) → Cache results, invalidate on file changes
- AGENTS.md update conflicts → Hook stages automatically, resolve conflicts normally

---

## 🔄 Implementation Strategy

**Branch:** `feat/token-efficiency-gate`

**Sequence:**
1. Group A (counter) → Establish baseline
2. Group B (graph) → Generate current state
3. Group C (hook) → Enforce + auto-document
4. Group D (docs) → Complete integration

**Checkpoints:**
- After Group A: Baseline token count committed
- After Group B: Agent graph visible in AGENTS.md
- After Group C: Hook enforcing on every commit
- After Group D: Documentation complete, full workflow tested

**Forge plan:** TBD (after approval)

---

## 📝 Notes

**Key insight:** This wish combines **enforcement** (token gate) with **visibility** (agent graph) in one automated flow. Every commit becomes a validation + documentation event.

**Architectural benefit:** Makes @ reference optimization **provable** - not just described, but evidenced with token counts and hierarchy maps.

**Maintenance:** Zero manual work - hook maintains agent graph automatically.

---

## 🎯 Success Definition

**When complete:**
- ✅ Every commit validates token efficiency (<5% increase threshold)
- ✅ AGENTS.md always shows current agent graph (auto-updated)
- ✅ Architecture hierarchy visible and accurate
- ✅ Override mechanism available for legitimate increases
- ✅ Token efficiency claims provable with evidence

**User experience:**
```bash
git commit -m "feat: add new feature"
# ✅ Token validation passed (+234 tokens, 0.5%)
# ✅ AGENTS.md updated with agent graph

# Later, adding large agent...
git commit -m "feat: add comprehensive audit agent"
# ❌ Token count increased by 8.2% (threshold: 5%)
#    Current: 51,234 | Baseline: 47,234 | Change: +4,000
#
# If this increase is justified:
#    git config commit.token-override "Added audit agent with 18 validation rules"
#    git commit -m "feat: add comprehensive audit agent"

git config commit.token-override "Added audit agent (18 validation rules)"
git commit -m "feat: add comprehensive audit agent"
# ⚠️  Token increase justified: Added audit agent (18 validation rules)
# ✅ AGENTS.md updated with agent graph
# ✅ Baseline updated: 51,234 tokens
```

---

**Status:** Ready for forge
**Next:** Approval → Branch → Forge → Implementation
