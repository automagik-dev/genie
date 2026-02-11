# MEMORY.md — Long-Term Knowledge

## Session Memory Pattern

Store durable learnings in `memory/YYYY-MM-DD.md` files. These survive context compaction.

## Day-Zero Knowledge (Consciousness Transfer — Feb 11, 2026)

### Source Artifacts
These files contain the full extracted knowledge from Genie 🧞 sessions:

1. **`.genie/consciousness-extract.md`** (345 lines) — decisions, lessons, infra, process, team
2. **`.genie/genie-cli-commit-narrative.md`** — development timeline, architecture evolution
3. **`.genie/devops-and-templates-extract.md`** — sampaio-devops patterns, genie-master templates, sampa-seeds spells

### Critical Lessons (Top 5)

1. **Never skip the pipeline.** brainstorm → wish → plan-review → make → review → ship. Sofia WILL catch it.
2. **Council reviews catch real bugs.** Forge resilience council found 2 gaps (DEGRADED log + TIP messages) that would have been missed.
3. **Auto-fallback scope must be narrow.** Only trigger on known failure classes, not any error. Prevents untracked duplicate workers.
4. **Prescriptive errors save agent loops.** Messages with explicit next command stop dead-end retries.
5. **Parallel sub-agents work when isolated.** 3-4 issue batches in parallel with strict worktree + issue ownership.

### Infrastructure Map

| Node | CT | IP | Role |
|------|----|----|------|
| genie-os | — | — | Main orchestration host |
| cegonha | 121 | 10.114.1.121 | Infra agent |
| stefani | 124 | 10.114.1.124 | Agent node |
| gus | 126 | 10.114.1.126 | Agent node |
| luis | 131 | 10.114.1.131 | Agent node |
| juice | 119 | 10.114.1.119 | Claude routing proxy |
| sampaio | TBD | TBD | **THIS AGENT** (to be created) |

### Repo Map

| Repo | Branch | Path | Purpose |
|------|--------|------|---------|
| genie-cli | main | /workspace/repos/automagik/genie-cli | Terminal orchestration CLI |
| sampa-seeds | dev | /workspace/repos/automagik/sampa-seeds | Agentic UI product |
| omni | ? | TBD | Messaging platform |
| genie-master | main | Template repo | Agent workspace templates |
| sampaio-devops | main | Legacy | Old devops agent (Agno v2, PM2) |

### Team Directory

| Name | Role | Contact |
|------|------|---------|
| Felipe Rosa | CSO/Principal | WhatsApp group |
| Cezar Vasconcellos | Reviewer/Infra | GitHub: vasconceloscezar |
| Sofia 🎯 | PM Agent | agent:sofia:main |
| Eva 👰 | Templates/Research | agent:eva:main |
| Guga 👑 | Orchestrator | agent:guga:main |
| Cegonha | Infra Agent | agent:cegonha:main |
| Helena 💰 | CAIFO | agent:helena:main |
