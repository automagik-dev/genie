# Wish: rlmx README — Agent-First Production Guide

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `rlmx-readme` |
| **Date** | 2026-03-27 |
| **Design** | Council advisory (10/10 MODIFY) |
| **Repo** | `/home/genie/research/rlmx/` |

## Summary

Rewrite the rlmx README from a human-education document into an agent-first production integration guide. Current README is 348 lines describing v0.1. Actual shipped state is v0.4 with YAML config, observability, budget controls, CAG caching, and 14 Gemini 3 features. Add machine-readable reference, cost model, security model, troubleshooting, and deployment guide. The README is the product — if an agent can't parse it, rlmx doesn't get used.

## Scope

### IN

**Core sections (rewrite):**
1. **What is rlmx** — 2 paragraphs. Agent-first positioning. Not "what is RLM" — agents don't care about the paper.
2. **Quick Start** — 3 commands: install, init, query. Copy-paste works.
3. **Installation & Setup** — npm install + Python 3.10+ dependency + verification script
4. **Configuration** — rlmx.yaml reference with all sections, types, defaults, examples

**New sections (from council):**
5. **CLI Reference** — every flag, every mode, exit codes. Both human-readable table AND machine-readable JSON block.
6. **Output Schema** — TypeScript types for JSON output, stream events, stats. Agents parse this.
7. **Tool Levels & Batteries** — core/standard/full with function signatures
8. **CAG Mode** — --cache, --cache + --max-iterations spectrum, cost comparison table
9. **Gemini 3 Features** — gemini: section, thinking levels, web_search, structured output, media resolution
10. **Cost Model** — price per query by mode, CAG savings, batch savings, cost stacking table
11. **Observability** — --stats (stderr JSON), --log (JSONL), verbose output format, metric definitions
12. **Programmatic API** — TypeScript signatures, error types, AbortSignal, stream events
13. **Security** — REPL sandbox design, blocked builtins, TOOLS.md restrictions, safe mode
14. **Deployment** — Docker, CI, Python vendoring, verification checklist
15. **Troubleshooting** — top 5 failure modes with diagnostics
16. **Machine-Readable Reference** — JSON block at end with CLI schema, output schema, exit codes. Also `rlmx --schema` flag.

### OUT
- No tutorial-style walkthrough (agents don't read tutorials)
- No changelog (use GitHub releases)
- No contributing guide (separate CONTRIBUTING.md)
- No badges wall (one or two max)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Agent-first, not human-first | Primary users are AI coding agents invoking rlmx as subprocess. Humans are secondary. |
| Machine-readable JSON block in README | Agents need structured CLI schema, not regex-parsed help text. |
| `rlmx --schema` flag | Runtime self-discovery for agents — outputs JSON with CLI flags, output schema, exit codes. |
| Cost model as explicit section | Agents need cost visibility before invocation. Budget impact is operational. |
| Security section mandatory | REPL executes code. Must document sandbox, restrictions, trust model. |
| Single rlmx.yaml in examples | Show the consolidated config, not the legacy .md files. |

## Success Criteria

- [ ] README covers all v0.4 features (YAML, budget, CAG, Gemini 3, batteries, observability)
- [ ] Machine-readable JSON block parseable by `jq` — CLI flags, output schema, exit codes
- [ ] `rlmx --schema` flag outputs JSON schema for agent self-discovery
- [ ] Cost model table: base vs cached vs batch vs stacked pricing
- [ ] Quick Start works in 3 commands on clean environment
- [ ] Security section documents REPL sandbox restrictions
- [ ] Troubleshooting covers: Python missing, API key missing, timeout, config parse error, REPL crash
- [ ] An agent reading ONLY the README can successfully: install, configure, invoke, parse output, handle errors

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `rlmx --schema` flag implementation + JSON schema definition |
| 2 | engineer | README rewrite: sections 1-8 (core + config + CLI + batteries + CAG) |

### Wave 2 (parallel, after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | README sections 9-12 (Gemini 3, cost model, observability, API) |
| 4 | engineer | README sections 13-16 (security, deployment, troubleshooting, machine-readable) |

### Wave 3 (ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Integration: wire --schema flag, final README assembly, verify all sections |
| review | reviewer | Review README for completeness, accuracy, agent-parsability |

## Execution Groups

### Group 1: --schema Flag
**Goal:** Add `rlmx --schema` that outputs machine-readable JSON with CLI flags, output types, and exit codes.

**Deliverables:**
1. **`src/cli.ts`** — `--schema` flag, outputs JSON to stdout
2. **`src/schema.ts`** — JSON schema definition: CLI flags (name, type, default, description), output JSON schema, exit codes
3. Schema includes all v0.4 flags including --thinking, --cache, --batch-api, --tools

**Acceptance Criteria:**
- [ ] `rlmx --schema | jq .flags` outputs parseable JSON array of CLI flags
- [ ] `rlmx --schema | jq .output` outputs JSON Schema for output format
- [ ] `rlmx --schema | jq .exitCodes` lists all exit codes with meanings

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node dist/src/cli.js --schema | jq '.flags | length' | xargs test 10 -le && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: README Core (Sections 1-8)
**Goal:** Rewrite README with agent-first positioning, quick start, config reference, CLI reference, batteries, CAG mode.

**Deliverables:**
1. **`README.md`** sections 1-8:
   - What is rlmx (2 paragraphs, agent-first)
   - Quick Start (3 commands)
   - Installation (npm + Python + verify)
   - Configuration (full rlmx.yaml reference with all sections)
   - CLI Reference (table of all flags + JSON block)
   - Output Schema (TypeScript types for json/stream/stats)
   - Tool Levels & Batteries (core/standard/full with function list)
   - CAG Mode (--cache spectrum, cost comparison)

**Acceptance Criteria:**
- [ ] Quick Start works: `npm install -g rlmx && rlmx init && rlmx "test"`
- [ ] All CLI flags documented with type and default
- [ ] rlmx.yaml reference covers: model, system, tools, criteria, context, budget, cache, gemini
- [ ] CAG cost comparison table present

**Validation:**
```bash
cd /home/genie/research/rlmx && grep -q "Quick Start" README.md && grep -q "rlmx.yaml" README.md && grep -q "CAG" README.md && grep -q "batteries" README.md && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: README Advanced (Sections 9-12)
**Goal:** Gemini 3 features, cost model, observability, programmatic API.

**Deliverables:**
1. **`README.md`** sections 9-12:
   - Gemini 3 Features (gemini: section, thinking levels, web_search, structured output, media resolution)
   - Cost Model (price table: base, cached, batch, stacked. Example: "100 queries over 500K context = $1.50")
   - Observability (--stats format, --log JSONL schema, --verbose, metric definitions)
   - Programmatic API (TypeScript signatures, error types, AbortSignal, stream events)

**Acceptance Criteria:**
- [ ] Gemini 3 section covers all 14 features
- [ ] Cost table shows 4 pricing tiers
- [ ] Observability shows --stats JSON example and --log JSONL example
- [ ] API section has TypeScript function signatures

**Validation:**
```bash
cd /home/genie/research/rlmx && grep -q "thinking" README.md && grep -q "Cost Model" README.md && grep -q "Observability" README.md && grep -q "rlmLoop" README.md && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 4: README Operations (Sections 13-16)
**Goal:** Security, deployment, troubleshooting, machine-readable reference.

**Deliverables:**
1. **`README.md`** sections 13-16:
   - Security (blocked builtins list, REPL subprocess isolation, env var passthrough, TOOLS restrictions)
   - Deployment (Docker example, CI pipeline, Python vendoring, verification script)
   - Troubleshooting (top 5 errors: Python missing, API key, timeout, config parse, REPL crash)
   - Machine-Readable Reference (JSON block: CLI flags, output schema, exit codes — parseable by jq)

**Acceptance Criteria:**
- [ ] Security lists blocked builtins (eval, exec, input, compile, globals, locals)
- [ ] Deployment has Docker example
- [ ] Troubleshooting covers 5 failure modes
- [ ] Machine-readable JSON block validates with jq

**Validation:**
```bash
cd /home/genie/research/rlmx && grep -q "Security" README.md && grep -q "Docker" README.md && grep -q "Troubleshooting" README.md && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 5: Final Assembly
**Goal:** Merge all sections, wire --schema flag, verify end-to-end.

**Deliverables:**
1. Final README.md assembled from Groups 2-4
2. --schema flag from Group 1 integrated into CLI
3. Table of contents at top
4. Version bumped in package.json if needed
5. Push and PR

**Acceptance Criteria:**
- [ ] README is one coherent document, not 4 fragments
- [ ] `rlmx --schema` works
- [ ] Table of contents links work
- [ ] An agent can: install, configure, invoke, parse output, handle errors — using ONLY the README

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node dist/src/cli.js --schema > /dev/null && wc -l README.md | awk '{print ($1 > 300) ? "PASS" : "FAIL"}'
```

**depends-on:** Groups 1-4

---

## QA Criteria

- [ ] Fresh `npm install -g rlmx` + Quick Start works
- [ ] `rlmx --schema | jq .` parses successfully
- [ ] All code examples in README are syntactically valid
- [ ] Machine-readable JSON block at end parses with jq
- [ ] README covers every flag in `rlmx --help`

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| README too long (>1000 lines) | Medium | Table of contents + collapsible sections. Agent-relevant sections first. |
| Machine-readable block becomes stale | Medium | Generated from schema.ts — single source of truth. |
| v0.4 features not all working | Medium | Dogfood proved 10/10 tasks pass. Document what works, flag what's preview. |
| Agents don't read READMEs | Low | --schema flag provides runtime self-discovery alternative. |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
MODIFY  README.md           — complete rewrite (16 sections)
MODIFY  src/cli.ts          — add --schema flag
CREATE  src/schema.ts       — JSON schema definition for CLI, output, exit codes
MODIFY  package.json        — version if needed
```
