# 5 Task Naming Convention Proposals
**Created:** 2025-10-21
**For:** Felipe - Choose Your Preferred Standard
**Goal:** Same language across GitHub, Forge, Wish, Agents

---

## 🎯 Selection Criteria

**Must Have:**
1. ✅ Unified across GitHub, Forge, Agents
2. ✅ Shows phase/type at a glance
3. ✅ Includes GitHub issue reference (Amendment #1)
4. ✅ Easy to scan and parse
5. ✅ Action-oriented and clear

**Comparison Dimensions:**
- **Brevity** - Shorter = better for scanning
- **Clarity** - Instantly recognizable type
- **Consistency** - Same format everywhere
- **GitHub Compatibility** - Works with existing conventions
- **Human Readability** - Natural language feel

---

## 📋 PROPOSAL 1: Emoji + Colon (Visual Scanners)

### Format
```
<emoji> <Type>: <Title> (#NNN)
```

### Examples
```
🐛 Bug: Forge executor hardcodes base_branch (#154)
💭 Wish: MCP Authentication for remote access (#152)
📚 Learn: Task naming convention standardization (#NNN)
⚙️ Forge: Drop-in replacement executor (#143)
✅ Review: Bounty system implementation (#NNN)
🔨 Refactor: Session state schema cleanup (#NNN)
📖 Docs: MCP integration guide (#NNN)
🧹 Chore: Update dependencies to latest (#NNN)
```

### Prefix Table
| Emoji | Type | Usage |
|-------|------|-------|
| 🐛 | Bug | Something broken |
| 💭 | Wish | Discovery/planning |
| 📚 | Learn | Research/investigation |
| ⚙️ | Forge | Implementation |
| ✅ | Review | Quality assurance |
| 🔨 | Refactor | Code improvement |
| 📖 | Docs | Documentation |
| 🧹 | Chore | Maintenance |

### Agent Variations
```
🧞 Genie: plan:bounty-marketplace
🔧 Git: Create wish issue for bounty system
👨‍💻 Implementor: Forge executor auto-branch
🧪 Tests: Bounty calculation validation
🚀 Release: v2.4.0-rc.37 preparation
✍️ Prompt: Wish blueprint template update
```

### Pros
- ✅ **Instant visual recognition** - Scan by emoji, not text
- ✅ **Language-agnostic** - Emoji understood globally
- ✅ **Fun and modern** - Engaging developer experience
- ✅ **GitHub native** - Emoji render in issue lists
- ✅ **Unique prefixes** - No text collision

### Cons
- ❌ **Accessibility concerns** - Screen readers may struggle
- ❌ **CLI rendering** - Some terminals don't show emoji
- ❌ **Search difficulty** - Can't grep for emoji easily
- ❌ **Emoji choice debates** - Which emoji for which type?
- ❌ **Professional perception** - Some teams view as "too casual"

### Score
- Brevity: ⭐⭐⭐⭐⭐ (shortest possible)
- Clarity: ⭐⭐⭐⭐ (emoji = instant recognition)
- Consistency: ⭐⭐⭐⭐⭐ (exact same format everywhere)
- GitHub Compatibility: ⭐⭐⭐⭐⭐ (native support)
- Human Readability: ⭐⭐⭐ (depends on familiarity)

**Overall: 22/25** - Best for visual scanners, modern teams

---

## 📋 PROPOSAL 2: Simple Colon (Minimalist)

### Format
```
<Type>: <Title> (#NNN)
```

### Examples
```
Bug: Forge executor hardcodes base_branch (#154)
Wish: MCP Authentication for remote access (#152)
Learn: Task naming convention standardization (#NNN)
Forge: Drop-in replacement executor (#143)
Review: Bounty system implementation (#NNN)
Refactor: Session state schema cleanup (#NNN)
Docs: MCP integration guide (#NNN)
Chore: Update dependencies to latest (#NNN)
```

### Prefix Table
| Type | Usage |
|------|-------|
| Bug | Something broken |
| Wish | Discovery/planning |
| Learn | Research/investigation |
| Forge | Implementation |
| Review | Quality assurance |
| Refactor | Code improvement |
| Docs | Documentation |
| Chore | Maintenance |

### Agent Variations
```
Genie: plan:bounty-marketplace
Git: Create wish issue for bounty system
Implementor: Forge executor auto-branch
Tests: Bounty calculation validation
Release: v2.4.0-rc.37 preparation
Prompt: Wish blueprint template update
```

### Pros
- ✅ **Clean and simple** - No extra characters
- ✅ **Easy to type** - Just word + colon
- ✅ **Universal compatibility** - Works everywhere (CLI, GitHub, Forge)
- ✅ **Easy to search** - `grep "^Bug:"` works perfectly
- ✅ **Professional** - Clean, enterprise-friendly
- ✅ **Conventional** - Matches commit message conventions (feat:, fix:)

### Cons
- ❌ **GitHub vs Forge distinction lost** - No [BRACKETS] for issues
- ❌ **Less visual pop** - Plain text, slower to scan
- ❌ **Case sensitivity matters** - "bug:" vs "Bug:" inconsistency risk

### Score
- Brevity: ⭐⭐⭐⭐⭐ (minimal characters)
- Clarity: ⭐⭐⭐⭐ (clear, conventional)
- Consistency: ⭐⭐⭐⭐⭐ (identical everywhere)
- GitHub Compatibility: ⭐⭐⭐⭐ (works, but not native convention)
- Human Readability: ⭐⭐⭐⭐⭐ (natural language)

**Overall: 23/25** - Best for simplicity and universality

---

## 📋 PROPOSAL 3: Hybrid Brackets (GitHub Native)

### Format
```
GitHub: [TYPE] <Title>
Forge:  Type: <Title> (#NNN)
Agents: Agent: <operation>
```

### Examples

**GitHub Issues:**
```
[BUG] Forge executor hardcodes base_branch
[WISH] MCP Authentication for remote access
[LEARN] Task naming convention standardization
[FORGE] Drop-in replacement executor
[REVIEW] Bounty system implementation
[REFACTOR] Session state schema cleanup
[DOCS] MCP integration guide
[CHORE] Update dependencies to latest
```

**Forge Tasks:**
```
Bug: Forge executor hardcodes base_branch (#154)
Wish: MCP Authentication for remote access (#152)
Learn: Task naming convention standardization (#NNN)
Forge: Drop-in replacement executor (#143)
Review: Bounty system implementation (#NNN)
Refactor: Session state schema cleanup (#NNN)
Docs: MCP integration guide (#NNN)
Chore: Update dependencies to latest (#NNN)
```

**Agent Sessions:**
```
Genie: plan:bounty-marketplace
Git: Create wish issue for bounty system
Implementor: Forge executor auto-branch
```

### Prefix Table
| GitHub | Forge | Agent | Usage |
|--------|-------|-------|-------|
| [BUG] | Bug: | Implementor: | Something broken |
| [WISH] | Wish: | Wish: | Discovery/planning |
| [LEARN] | Learn: | Learn: | Research/investigation |
| [FORGE] | Forge: | Implementor: | Implementation |
| [REVIEW] | Review: | Review: | Quality assurance |
| [REFACTOR] | Refactor: | Implementor: | Code improvement |
| [DOCS] | Docs: | Prompt:/Learn: | Documentation |
| [CHORE] | Chore: | Various | Maintenance |

### Pros
- ✅ **GitHub convention** - Matches existing [WISH], [IMPLEMENTATION] pattern
- ✅ **Visual distinction** - Brackets = GitHub, Colon = Forge/Agents
- ✅ **Familiar** - Team already uses [WISH] format
- ✅ **Clear separation** - Different formats for different systems

### Cons
- ❌ **Inconsistent** - Two different formats to remember
- ❌ **Manual translation** - Must convert [BUG] → Bug: when creating Forge task
- ❌ **Duplication risk** - Easy to mismatch across systems
- ❌ **Extra cognitive load** - "Which format am I in?"

### Score
- Brevity: ⭐⭐⭐⭐ (GitHub brackets add chars)
- Clarity: ⭐⭐⭐⭐ (clear, but two formats)
- Consistency: ⭐⭐⭐ (intentionally different per system)
- GitHub Compatibility: ⭐⭐⭐⭐⭐ (native convention)
- Human Readability: ⭐⭐⭐⭐ (familiar)

**Overall: 20/25** - Best for GitHub-first teams who want familiar format

---

## 📋 PROPOSAL 4: Emoji + Brackets (Maximum Visual)

### Format
```
<emoji>[TYPE] <Title> (#NNN)
```

### Examples
```
🐛[BUG] Forge executor hardcodes base_branch (#154)
💭[WISH] MCP Authentication for remote access (#152)
📚[LEARN] Task naming convention standardization (#NNN)
⚙️[FORGE] Drop-in replacement executor (#143)
✅[REVIEW] Bounty system implementation (#NNN)
🔨[REFACTOR] Session state schema cleanup (#NNN)
📖[DOCS] MCP integration guide (#NNN)
🧹[CHORE] Update dependencies to latest (#NNN)
```

### Prefix Table
| Emoji + Bracket | Usage |
|-----------------|-------|
| 🐛[BUG] | Something broken |
| 💭[WISH] | Discovery/planning |
| 📚[LEARN] | Research/investigation |
| ⚙️[FORGE] | Implementation |
| ✅[REVIEW] | Quality assurance |
| 🔨[REFACTOR] | Code improvement |
| 📖[DOCS] | Documentation |
| 🧹[CHORE] | Maintenance |

### Agent Variations
```
🧞 Genie: plan:bounty-marketplace
🔧 Git: Create wish issue for bounty system
👨‍💻 Implementor: Forge executor auto-branch
```

### Pros
- ✅ **Best of both worlds** - Emoji + text redundancy
- ✅ **Scannable** - Emoji for speed, text for search
- ✅ **Accessible fallback** - Screen readers get text
- ✅ **Unique** - Stands out in issue lists
- ✅ **Same everywhere** - One format for all systems

### Cons
- ❌ **Verbose** - Longest prefix format
- ❌ **Redundant** - Emoji + text says same thing
- ❌ **Visual clutter** - Too much decoration
- ❌ **Overkill** - More complexity than needed

### Score
- Brevity: ⭐⭐ (longest format)
- Clarity: ⭐⭐⭐⭐⭐ (impossible to miss)
- Consistency: ⭐⭐⭐⭐⭐ (exact same everywhere)
- GitHub Compatibility: ⭐⭐⭐⭐⭐ (supports both)
- Human Readability: ⭐⭐⭐ (cluttered)

**Overall: 19/25** - Best for maximum redundancy/clarity, but verbose

---

## 📋 PROPOSAL 5: Slash Notation (Developer Native)

### Format
```
<type>/<Title> #NNN
```

### Examples
```
bug/forge-executor-hardcodes-base-branch #154
wish/mcp-authentication-remote-access #152
learn/task-naming-convention-standardization #NNN
forge/drop-in-replacement-executor #143
review/bounty-system-implementation #NNN
refactor/session-state-schema-cleanup #NNN
docs/mcp-integration-guide #NNN
chore/update-dependencies #NNN
```

### Prefix Table
| Type | Usage |
|------|-------|
| bug/ | Something broken |
| wish/ | Discovery/planning |
| learn/ | Research/investigation |
| forge/ | Implementation |
| review/ | Quality assurance |
| refactor/ | Code improvement |
| docs/ | Documentation |
| chore/ | Maintenance |

### Agent Variations
```
genie/plan:bounty-marketplace
git/create-wish-issue-bounty-system
implementor/forge-executor-auto-branch
tests/bounty-calculation-validation
release/v2.4.0-rc.37-preparation
prompt/wish-blueprint-template-update
```

### Pros
- ✅ **Git branch naming** - Matches `feature/`, `bugfix/` conventions
- ✅ **URL-friendly** - Slugified, no special chars
- ✅ **CLI-friendly** - Easy to type, no shift key
- ✅ **Searchable** - `grep "^bug/"` works perfectly
- ✅ **Developer familiar** - Looks like file paths

### Cons
- ❌ **Lowercase only** - Loses capitalization clarity
- ❌ **Dash-separated** - Harder to read long titles
- ❌ **Less natural** - Not how humans write sentences
- ❌ **GitHub unfamiliar** - Not a common GitHub issue pattern
- ❌ **Issue reference format** - `#NNN` instead of `(#NNN)` - less clear

### Score
- Brevity: ⭐⭐⭐⭐⭐ (minimal, no brackets/colons)
- Clarity: ⭐⭐⭐ (lowercase = harder to scan)
- Consistency: ⭐⭐⭐⭐⭐ (exact same everywhere)
- GitHub Compatibility: ⭐⭐ (not a GitHub convention)
- Human Readability: ⭐⭐⭐ (technical, not natural)

**Overall: 18/25** - Best for CLI/Git-centric developers

---

## 📊 Comparison Matrix

| Proposal | Brevity | Clarity | Consistency | GitHub | Readability | **Total** |
|----------|---------|---------|-------------|--------|-------------|-----------|
| **1. Emoji + Colon** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | **22/25** |
| **2. Simple Colon** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **23/25** |
| **3. Hybrid Brackets** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **20/25** |
| **4. Emoji + Brackets** | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | **19/25** |
| **5. Slash Notation** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | **18/25** |

---

## 🎯 Recommendation

**Top 3 Choices:**

### 🥇 #2 Simple Colon (23/25) - RECOMMENDED
**Best for:** Universal compatibility, professional teams, long-term maintainability

**Why:**
- Matches conventional commit format (feat:, fix:, docs:)
- Works perfectly in CLI, GitHub, Forge, everywhere
- Easy to search and parse programmatically
- Clean, professional, timeless
- Zero learning curve for developers

**Example:**
```
Bug: Forge executor hardcodes base_branch (#154)
```

### 🥈 #1 Emoji + Colon (22/25) - RUNNER-UP
**Best for:** Modern teams, visual learners, quick scanning

**Why:**
- Fastest visual recognition
- Engaging and fun developer experience
- GitHub native emoji support
- Unique and memorable

**Example:**
```
🐛 Bug: Forge executor hardcodes base_branch (#154)
```

### 🥉 #3 Hybrid Brackets (20/25) - CONSERVATIVE
**Best for:** GitHub-first workflows, existing [WISH] convention

**Why:**
- Matches current team conventions
- Familiar [BRACKETS] format
- Clear system separation

**Example:**
```
GitHub: [BUG] Forge executor hardcodes base_branch
Forge: Bug: Forge executor hardcodes base_branch (#154)
```

---

## 🗳️ Decision Template

**Felipe, choose one:**

- [ ] **Option 1:** Emoji + Colon (🐛 Bug: Title #NNN)
- [ ] **Option 2:** Simple Colon (Bug: Title #NNN) ⭐ RECOMMENDED
- [ ] **Option 3:** Hybrid Brackets ([BUG] Title vs Bug: Title #NNN)
- [ ] **Option 4:** Emoji + Brackets (🐛[BUG] Title #NNN)
- [ ] **Option 5:** Slash Notation (bug/title #NNN)
- [ ] **Option 6:** Custom (describe below)

**Your choice:** ___________

**Rationale:** ___________________________________________

---

## 📝 Additional Notes

**If you choose Emoji + Colon (#1):**
- We'll need to define emoji for each agent type
- Add emoji rendering tests for CLI
- Document accessibility considerations

**If you choose Simple Colon (#2):**
- Immediate adoption possible
- Matches industry standards (conventional commits)
- Easy to enforce with automation

**If you choose Hybrid Brackets (#3):**
- Need clear documentation on when to use which format
- Manual translation required between GitHub ↔ Forge
- Higher cognitive load but respects existing conventions

**If you choose Emoji + Brackets (#4):**
- Maximum redundancy (good for accessibility)
- Longer titles, visual clutter consideration
- Best clarity, but verbose

**If you choose Slash Notation (#5):**
- Developer-centric, CLI-first approach
- Need to educate team on lowercase convention
- Less GitHub-native, more Git-native

---

## ✅ Next Steps After Your Choice

1. **You select preferred option**
2. **I update specification with chosen format**
3. **I create AGENTS.md amendment**
4. **I generate migration plan**
5. **I begin remediation of current violations**

**Ready for your decision! 🚀**
