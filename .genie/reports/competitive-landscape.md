# Claude Code framework landscape: where genie fits and how to win

**Genie enters a crowded, fast-moving market dominated by obra/superpowers (~75k stars) with eight other major frameworks competing across four distinct niches.** The good news: most competitors over-engineer their solutions, inflate feature counts, or lock users into Claude Code exclusively — creating clear openings for genie's "simpler and more effective" positioning. The bad news: genie's 250 stars place it far behind in visibility, and the window to establish dominance is narrowing as the ecosystem matures rapidly. This report profiles all nine target competitors plus the most important discovery from broader search, then delivers actionable strategy for genie to win.

---

## The top 10 frameworks ranked by GitHub stars

The competitive landscape stratifies into clear tiers. Star counts for some repos warrant skepticism — several show suspicious ratios of stars to actual community engagement.

| Rank | Repository | Stars | Forks | Commits | License | Backing | Last Active | Category |
|------|-----------|-------|-------|---------|---------|---------|-------------|----------|
| 1 | **obra/superpowers** | ~75,000 | 5,800 | Active | MIT | Individual (Jesse Vincent) | Mar 2026 | Skills framework |
| 2 | **bmad-code-org/BMAD-METHOD** | ~35,400 | 4,400 | 1,350 | MIT + Trademark | LLC (BMad Code) | Mar 2026 | Agile SDLC framework |
| 3 | **wshobson/agents** ⚠️ | ~28,000 | 3,100 | 224 | MIT | Individual | Feb 2026 | Plugin catalog (markdown only) |
| 4 | **gsd-build/get-shit-done** | ~27,000 | 2,300 | 757 | MIT | Individual | Mar 2026 | Context engineering |
| 5 | **eyaltoledano/claude-task-master** | ~25,700 | 2,400 | 1,212 | MIT + Commons Clause | Individual | Mar 2026 | Task management |
| 6 | **SuperClaude-Org/SuperClaude** | ~21,300 | 1,800 | 341 | MIT | Community/Individual | Feb 2026 | Behavioral config |
| 7 | **ruvnet/ruflo** ⚠️ | ~20,200 | 2,200 | 5,800 | MIT | Individual | Mar 2026 | Swarm orchestration |
| 8 | **Yeachan-Heo/oh-my-claudecode** | ~8,500 | 589 | 380 | MIT | Individual | Mar 2026 | Multi-agent orchestration |
| 9 | **ComposioHQ/agent-orchestrator** | 2,700 | 274 | 131 | MIT | Company (Composio) | Feb 2026 | Fleet management |
| 10 | **automagik-dev/genie** | 250 | 34 | 2,022 | MIT | Company (Namastex Labs) | Mar 2026 | Markdown-native agents |

The ⚠️ flags on wshobson/agents and ruvnet/ruflo reflect credibility concerns: agents has **28k stars on a 224-commit markdown-only repo with just 7 open issues**, while ruflo shows multiple user reports of the product not working as documented and suspiciously high star-to-contributor ratios across all of ruvnet's repos.

---

## Detailed comparison across all dimensions

| Dimension | superpowers | BMAD | agents | GSD | Task Master | SuperClaude | ruflo | OMC | agent-orchestrator | **genie** |
|-----------|------------|------|--------|-----|-------------|-------------|-------|-----|-------------------|-----------|
| **README Quality** | 9/10 | 8/10 | 8/10 | 9/10 | 8/10 | 6/10 | 5/10 | 7/10 | 9/10 | 8/10 |
| **Codebase Maturity** | High | High | None (MD only) | Medium | High | Medium | Questionable | Medium | Early | Medium-High |
| **Real Code?** | Yes | Yes | No | Yes | Yes | Partial | Yes | Yes | Yes | Yes |
| **Provider-Agnostic** | Partial | Yes (10+) | No | Partial | Yes (13+ IDEs) | No | No | No | Yes | Yes |
| **Data Ownership** | Partial | Partial | N/A | Yes | Yes | No | No | No | No | **Yes (core)** |
| **Multi-Agent** | Yes (subagents) | Yes (Party Mode) | Config only | Yes | No | No | Yes (swarm) | Yes | Yes (fleet) | Yes |
| **Memory/Learning** | No | No | No | No | No | No | Claimed | No | No | **Yes (/brain, /learn)** |
| **TUI/Dashboard** | No | No | No | No | No | No | Partial | HUD | Yes (web) | **Yes (TUI)** |
| **Target** | All devs | Enterprise→Solo | Claude users | Solo devs | AI IDE users | Claude users | Claude users | Claude users | Teams | All devs |
| **Install Friction** | Low (plugin) | Low (npx) | Low (plugin) | Low (npx) | Low (npm) | Medium | Medium | Low (plugin) | High (build) | Low (npm) |

---

## Competitor profiles

### obra/superpowers — The 800-pound gorilla nobody can ignore

Superpowers is the undisputed leader at **~75,000 stars**, listed in Claude Code's official plugin marketplace, and credited by GitHub Next as inspiration for their Agentic Workflows project. Created by Jesse Vincent, it takes a composable "skills" approach: **20+ battle-tested skills** that auto-activate for specific tasks like brainstorming, TDD, plan writing, code review, and subagent-driven development. The `/brainstorm → /write-plan → /execute-plan` workflow is clean and proven. It also supports Codex and OpenCode, making it partially cross-platform.

The README is excellent — clear, professional, and focused on workflows rather than feature counts. Its main weakness is the **lack of persistent memory** between sessions. It also doesn't offer a full TUI or daemon mode. The ecosystem around it (superpowers-lab, superpowers-marketplace, superpowers-chrome, superpowers-ccg) shows maturity but also fragmentation. Genie's advantages: persistent knowledge vault (/brain), behavioral learning (/learn), full TUI cockpit, daemon mode, and genuine vendor independence. What superpowers has that genie doesn't: massive adoption, official marketplace listing, and the network effects that come with 75k stars.

### BMAD-METHOD — Enterprise agile dressed in open-source clothing

The most professionally organized framework at **~35,400 stars**, backed by BMad Code LLC with registered trademarks. BMAD brings traditional agile methodology to AI coding: PRDs, epics, stories, sprints, architecture reviews — the full SDLC. It offers **21 specialized agents, 50+ guided workflows**, and a module ecosystem (BMM core, BMad Builder, TEA, BMGD, CIS). It supports 10+ platforms including Claude Code, Cursor, Codex, Gemini, and Windsurf.

The README is comprehensive but dense, leaning heavily on enterprise terminology that may alienate solo developers. The v6 beta creates version confusion alongside the stable v4. BMAD's key strength is **scale-adaptiveness** — it adjusts from bug fixes to enterprise platforms. Its weakness is complexity: five modules, dozens of agents, and agile jargon everywhere. The documentation site (docs.bmad-method.org) follows Diataxis principles, showing real investment in developer education. Genie's edge: dramatically simpler workflow (wish pipeline vs. PRD/epic/sprint ceremony), data ownership philosophy, and the "/brain" knowledge system. What BMAD has: broader platform support, deeper enterprise methodology, and 140× more stars.

### wshobson/agents — Massive star count, zero executable code

At **~28,000 stars**, this repo is misleading: it contains **no actual code**. The "112 agents" and "73 plugins" are markdown persona files and configuration templates for Claude Code's plugin marketplace. The 224 total commits and only 7 open issues against 28k stars represent the most suspicious engagement ratio in this entire landscape.

The README is well-organized with practical quick-start instructions and a clear progressive-disclosure architecture (metadata → instructions → resources). The plugin categorization across 24 categories is genuinely useful as a catalog. But calling markdown templates an "agent framework" overpromises significantly. Genie's advantage is fundamental: **genie is real software** with TypeScript, a TUI, daemon mode, and actual agent lifecycle management. What agents has: a massive catalog of pre-built persona definitions and the simplicity of "just markdown."

### gsd-build/get-shit-done — Anti-enterprise insurgent with real traction

GSD at **~27,000 stars** has the most distinctive voice in the space — profane, contrarian, and explicitly positioned against BMAD and other "enterprise roleplay." Created by solo developer "glittercowboy," it solves context rot through spec-driven development with fresh context windows per execution plan. The `/gsd:discuss-phase → /gsd:plan-phase → /gsd:execute-phase → /gsd:verify-work` pipeline is effective and well-documented.

The README is compelling storytelling: "I'm a solo developer. I don't write code." Installation is a one-liner npx command. The six-step workflow walkthrough with exact commands and file outputs is one of the best onboarding experiences in the space. Key weaknesses: the **$GSD crypto token on Solana** raises serious credibility concerns, the edgy language alienates enterprise users, and **136 open issues** (many tagged "needs-triage") suggest a maintenance backlog. Genie's advantages: company backing (more sustainable), knowledge persistence (/brain vs. no memory), approval gates for human oversight, and no crypto baggage. GSD's edge: dramatically better marketing narrative, user testimonials from Amazon/Google/Shopify engineers, and 100× more stars.

### eyaltoledano/claude-task-master — The AI project manager everyone knows

Task Master at **25,700 stars** is the most widely recognized tool in this category, going from zero to 15.5k stars in nine weeks. It parses PRDs into structured tasks with dependencies, priorities, and subtasks. It supports **13+ IDEs** (Cursor, Claude Code, Windsurf, VS Code, Kiro, Zed) and 36 MCP tools across multiple LLM providers (Anthropic, OpenAI, Google, Perplexity, Ollama).

The README is professional with NPM download badges, CI status, and clear dual installation paths (MCP + CLI). The MIT + Commons Clause license restricts reselling, which is notable. Its core strength is **editor-agnostic task management** — it works everywhere, not just in Claude Code. Weaknesses: no multi-agent orchestration, no persistent memory, no TUI, and the README is very long. Genie's advantages: multi-agent orchestration with the wish pipeline, persistent /brain knowledge, purpose-driven ephemeral agents, and TUI cockpit. Task Master's edge: broader IDE support, PRD decomposition maturity, and established npm presence with high download counts.

### SuperClaude Framework — Behavioral injection with international appeal

SuperClaude at **21,300 stars** is a behavioral configuration layer that enhances Claude Code through markdown instruction files. It offers **30 slash commands, 16 specialist agents, 7 behavioral modes**, and the Wave→Checkpoint→Wave parallel execution pattern (claiming 3.5x speed improvement). Multi-language README support (Japanese, Korean, Chinese) gives it strong international reach.

The README is emoji-heavy and somewhat informal — the donation appeal for the maintainer's Claude Max subscription highlights its community-project nature. The concept of "behavioral configuration" versus actual software may confuse newcomers. It's **Claude Code-exclusive**, limiting its addressable market. The sister projects (SuperGemini, SuperQwen) show ambition but fragment effort. Genie's advantages: real executable software vs. behavioral configs, provider independence, persistent knowledge, company backing. SuperClaude's edge: international community, simpler mental model (just "make Claude behave better"), and deep Claude Code integration.

### ruvnet/ruflo — Ambitious claims, questionable execution

Ruflo at **~20,200 stars** claims to be "the leading agent orchestration platform" with **60+ agents, 175+ MCP tools**, self-learning neural capabilities, WASM/Rust kernels, and swarm intelligence. The feature list is staggering — GOAP goal planning with A* pathfinding, truth verification systems, and vector graph neural networks.

However, **multiple GitHub issues (#624, #958) report users unable to get basic functionality working**. Feature counts appear inflated — numbers vary across different pages (60 agents vs. 64, 87 tools vs. 175+). The README is overwhelmingly long and reads more like a marketing deck than developer documentation. The star-to-contributor ratio across all ruvnet repos warrants skepticism. With **427 open issues** — the highest of any competitor — maintenance capacity is questionable. Genie's advantage: genie actually works. Its honest README, working CLI, and real engineering (2,022 commits) stand in stark contrast. What ruflo claims to offer: self-learning capabilities and Rust/WASM performance, if they function as documented.

### Yeachan-Heo/oh-my-claudecode — Power modes for Claude Code maximalists

OMC at **~8,500 stars** offers five execution modes (Autopilot, Ultrapilot, Swarm, Pipeline, Ecomode) with **32 specialized agents** and smart model routing that claims 30-50% token savings. "Ralph Mode" provides persistent execution that won't stop until architect-verified complete. The installation via Claude Code's plugin marketplace is the simplest in the space — two commands.

The README's aggressive tone ("A weapon, not a tool") and grammatical issues ("Your Claude Just Have been Steroided") hurt professionalism. But the **131+ releases and 817 closed PRs** show serious development velocity. It's Claude Code-exclusive, limiting reach. The magic keywords system (/deep-interview, /council, /swarm) provides intuitive shortcuts. Genie's advantages: provider independence, persistent /brain knowledge, data ownership, company backing. OMC's edge: simpler installation via plugin marketplace, more execution modes, and token-saving model routing.

### ComposioHQ/agent-orchestrator — Company-backed fleet management

Agent-orchestrator at **2,700 stars** is the only framework explicitly designed for **managing fleets of 30+ parallel AI agents**. Backed by Composio (a funded company), it provides runtime-agnostic (tmux/Docker/k8s), agent-agnostic (Claude Code/Codex/Aider), and tracker-agnostic (GitHub/Linear) orchestration. The plugin architecture with 8 swappable slots (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Lifecycle) is the most extensible design in the space.

The README is the most professionally written of all competitors — clear problem/solution framing ("Running one AI agent is easy. Running 30 is a coordination problem"). But it's the least mature: only 131 commits, must build from source (no npm), and 67 open PRs suggest a review bottleneck. Claims of **84.6% CI success rate** across self-correcting agent branches are compelling but early. Genie's advantages: working npm distribution, TUI, persistent knowledge, simpler workflow. Agent-orchestrator's edge: true fleet-scale parallel execution, corporate backing from Composio, and the plugin architecture's extensibility.

---

## How genie compares head-to-head against each competitor

### What genie has that no competitor offers

Three capabilities set genie apart across the entire landscape:

- **Persistent knowledge vault (/brain):** An Obsidian-style note system where agents search before answering and write back intelligence. No other framework builds compounding knowledge over time. Claude-mem offers session memory, but not project-level knowledge graphs.
- **Behavioral learning (/learn):** Interactive mode that explores codebases, asks questions, and builds learning plans with approval gates. Zero competitors offer this.
- **True data portability:** All context lives in local markdown files — portable, transparent, and never locked in a vendor database. While GSD and Task Master use local files, neither makes data ownership a core philosophy the way genie does.
- **Purpose-driven ephemeral agents:** Workers born for one task, execute obsessively, report back, and dissolve. This is architecturally cleaner than persistent agent pools.
- **10-specialist Council review:** Architect, Simplifier, Sentinel, Operator, Deployer, Ergonomist, Questioner, Tracer, Benchmarker, Measurer critique designs. No competitor offers structured multi-perspective review.

### Specific head-to-head gaps

| Competitor | What genie has, they don't | What they have, genie doesn't |
|------------|---------------------------|-------------------------------|
| **superpowers** | /brain knowledge vault, /learn behavioral learning, TUI cockpit, daemon mode, Council review | 75k stars, official marketplace listing, 20+ battle-tested skills, massive ecosystem |
| **BMAD** | Simpler workflow, data ownership, /brain, /learn, ephemeral agents | 10+ platform support, enterprise agile methodology, documentation site, LLC structure |
| **agents** | Actual executable software, agent lifecycle management, TUI, daemon | Massive plugin catalog (73 plugins, 112 agent templates), plugin marketplace presence |
| **GSD** | /brain persistence, /learn, Council review, company backing, no crypto baggage | 100× more stars, compelling narrative marketing, user testimonials, discuss-phase |
| **Task Master** | Multi-agent orchestration, /brain, /learn, TUI, Council | 13+ IDE support, PRD decomposition, high npm downloads, Perplexity research integration |
| **SuperClaude** | Real software (not just configs), provider independence, /brain, /learn | International community (JP/KR/CN), 30 slash commands, deep Claude Code behavioral tuning |
| **ruflo** | Actually works reliably, honest README, real engineering | Self-learning claims (SAFLA), Rust/WASM components, swarm topologies (if functional) |
| **OMC** | Provider independence, /brain, /learn, Council, data ownership | Plugin marketplace installation, 5 execution modes, model routing (30-50% token savings) |
| **agent-orchestrator** | Working npm distribution, TUI, /brain, /learn, simpler UX | Fleet-scale orchestration (30+ agents), plugin architecture (8 slots), web dashboard |

---

## Strategic recommendations for genie to win

### 1. Own the "honest framework" narrative

The single most powerful positioning move genie can make is to **lean into authenticity in a space plagued by inflated metrics**. Ruflo claims 175+ tools that users report don't work. Agents has 28k stars on markdown files. GSD has a crypto token. BMAD requires enterprise ceremony. Genie should explicitly position as "the framework that does what it says" — highlight the 2,022 real commits, the working TUI, the actual TypeScript codebase. A comparison page showing commit-to-star ratios and actual functionality versus claims would be devastating to competitors.

### 2. Get into Claude Code's plugin marketplace immediately

Superpowers, OMC, and agents all distribute through Claude Code's native plugin marketplace. This is now table stakes for discovery. **Genie's absence from the marketplace is its single biggest distribution gap.** The plugin install experience (`/plugin marketplace add` → `/plugin install`) is dramatically lower friction than npm. Prioritize this above all other distribution work.

### 3. Double down on /brain and /learn as the killer differentiator

No competitor offers persistent, compounding project knowledge. This is genie's moat. The README should lead with this: "Your AI forgets everything between sessions. Genie doesn't." Build demo videos showing /brain in action — an agent searching project knowledge before answering, writing back discoveries, and another agent benefiting from that knowledge days later. This is the feature that makes "simpler and more effective" concrete and provable.

### 4. Build a "genie vs. X" comparison page for each major competitor

BMAD, GSD, Task Master, and superpowers all have enough stars that developers will evaluate them first. Genie needs **dedicated comparison pages** (like Notion vs. Confluence style) that honestly show feature-by-feature differences. The key narrative for each:
- vs. superpowers: "Superpowers gives you skills. Genie gives you a brain."
- vs. BMAD: "Skip the enterprise ceremony. Ship with wishes."
- vs. GSD: "Same simplicity, real persistence, no crypto."
- vs. Task Master: "Don't just manage tasks. Let agents learn your codebase."

### 5. Fix the README's star-count gap with social proof and architecture clarity

Genie's README has a distinctive voice (written as the Genie itself) which is memorable, but it undersells the technical depth. Add three things: **(1)** An architecture diagram showing the wish pipeline, daemon, TUI, /brain, and agent lifecycle — this would instantly differentiate from markdown-only competitors. **(2)** A "Who uses genie" section with real testimonials, even from 5-10 early adopters. **(3)** A 30-second GIF showing the TUI cockpit in action — no competitor has this, and it's visually compelling.

### 6. Pursue cross-platform support aggressively

Task Master supports 13+ IDEs. BMAD supports 10+ platforms. Genie is already provider-agnostic in philosophy, but the README should make this louder. Test and document explicit support for Cursor, Windsurf, VS Code Copilot, Codex CLI, and Gemini CLI. Each supported platform is a new discovery channel and a reason for developers locked into Claude Code-only tools to switch.

### 7. Target the superpowers ecosystem gap

Superpowers lacks persistent memory, a TUI, daemon mode, and behavioral learning. Its users are the most sophisticated Claude Code developers — exactly the audience that would value /brain and /learn. Consider building a **superpowers compatibility layer** or superpowers-to-genie migration guide. If genie can be framed as "superpowers + memory + orchestration," it immediately inherits credibility from the market leader.

### 8. Launch a "context engineering" content strategy

Coleam00's context-engineering-intro has **12,400 stars** as a methodology template — proof that educational content drives massive awareness. Genie should publish a "Context Engineering with Genie" guide that teaches the methodology while demonstrating genie's /brain, /learn, and Council features as the implementation. Blog posts, YouTube tutorials, and a landing page on context engineering would capture search traffic from developers discovering this space.

## Conclusion

The Claude Code framework market is large, noisy, and surprisingly shallow. Most competitors optimize for star counts and feature lists over working software and genuine developer experience. **Genie's 2,022 commits against 250 stars represent the highest engineering-to-visibility ratio in the entire space** — the product is undermarketed, not underbuilt. The /brain knowledge vault, /learn behavioral system, and Council review are genuine differentiators that no competitor matches. The strategic path forward is clear: get into the plugin marketplace for distribution, lead with /brain as the headline differentiator, build comparison content against each major competitor, and ride the "honest framework" narrative in a market where inflated claims are the norm. The window is still open — but with the space maturing this fast, the next 90 days matter more than the next year.
