# Design: Dependency Bump + README Rewrite

## Problem

Genie has the highest engineering-to-visibility ratio in the Claude Code framework space (2,022 commits / 250 stars). The README undersells the product with abstract jargon ("markdown-native agent framework"), first-person voice, insider skill names, and an overwhelming CLI dump. Dependencies are stale with 9 outdated packages (5 major bumps). Both need fixing.

## Scope

### IN
- Bump all dependencies to latest compatible versions
- Full README rewrite (~120 lines) with new positioning, structure, and voice
- Move CLI reference and configuration sections to docs or collapsible sections

### OUT
- Plugin marketplace listing (separate wish)
- Comparison pages vs competitors (separate wish)
- Video/GIF recording (separate wish — needs actual recording)
- Architecture diagram (separate wish — needs design work)
- Content strategy / blog posts (separate wish)
- Cross-platform support documentation (separate wish)

## Decisions

### D1: Positioning angle — Cognitive load reduction
Genie lowers YOUR cognitive load. It interviews you into clarity during brainstorm, captures comprehensive context, then executes a standardized pipeline with consistent results. The orchestrator preserves its own context window by dispatching scoped specialists.

### D2: Tagline
**Hero:** "Wishes in, PRs out."
**Subtitle:** Describe the problem. Genie interviews you, plans the work, dispatches agents, and reviews the code. You approve and ship.

### D3: Voice — Third person, pain-first
Kill first-person Genie voice. Clear, direct, third-person. Lead with developer pain, not feature names.

### D4: README structure (~120 lines)
1. Hero image + badges + tagline + subtitle
2. Quick nav links (Install, Quick Start, Features, Docs, Discord)
3. "What is Genie?" — 3 sentences max
4. "Right for you if" — pain-moment checklist (6 items)
5. 3-step quickstart (install → launch → wish)
6. Feature grid (3x3 with short descriptions)
7. "Without Genie / With Genie" pain table (6 rows)
8. The Wish Pipeline (one-line flow + 5 one-line descriptions)
9. CLI reference (collapsed `<details>`)
10. Configuration (collapsed `<details>`)
11. Development (4 commands)
12. Community + License + footer

### D5: Security signals
- npm as primary install path
- No `--dangerously-skip-permissions` in README examples
- Prerequisites listed explicitly

### D6: Dependency bump strategy
| Package | Current | Target | Risk |
|---------|---------|--------|------|
| @types/bun | ^1.1.0 | ^1.3.10 | None (patch) |
| @types/node | ^20.10.5 | ^22.0.0 | Low (type defs only) |
| esbuild | ^0.27.2 | ^0.27.3 | None (patch) |
| knip | ^5.85.0 | ^5.86.0 | None (minor) |
| zod | ^3.22.4 | ^3.25.0 | Low (stay on v3, skip v4 — breaking API) |
| commander | ^12.1.0 | ^13.0.0 | Medium (check breaking changes, skip v14 initially) |
| uuid | ^11.1.0 | ^11.1.0 | None (skip v13 — breaking ESM changes) |
| @inquirer/prompts | ^7.0.0 | ^7.10.0 | None (stay on v7, skip v8 — breaking) |
| @biomejs/biome | ^1.9.4 | ^1.9.4 | None (skip v2 — config format breaking) |
| husky | ^9.1.7 | ^9.1.7 | None (already latest v9) |
| typescript | ^5.3.3 | ^5.8.0 | Low (minor TS features) |
| @commitlint/* | ^20.4.1 | ^20.4.1 | None (already latest) |

**Strategy:** Bump safe patches/minors. Stay on current majors for zod (v3), commander (v12→v13 only), @inquirer/prompts (v7), biome (v1), uuid (v11). Skip risky major bumps (zod v4, biome v2, uuid v13, inquirer v8, commander v14).

## Risks
- **R1:** "Wishes" is jargon — mitigated by using plain language in hero, introducing term in body
- **R2:** Tmux as implementation detail — mitigated by saying "live terminal sessions" not "tmux"
- **R3:** Commander v13 breaking changes — mitigate with test suite verification
- **R4:** Feature grid may undersell depth — mitigated by linking to full docs

## Acceptance Criteria
- [ ] README is under 150 lines (excluding collapsed sections)
- [ ] No first-person voice
- [ ] 3-step quickstart (install, launch, try)
- [ ] Feature grid (3x3 or similar)
- [ ] "Without/With" pain table (6 rows)
- [ ] No `--dangerously-skip-permissions` in any example
- [ ] CLI reference and config in collapsed `<details>` sections
- [ ] All safe dependency bumps applied
- [ ] `bun run check` passes after all changes
- [ ] Prerequisites listed explicitly (macOS/Linux, Bun, Claude Code)

## Content Blocks (pre-written)

### "What is Genie?"
> Genie is a CLI that turns vague ideas into shipped PRs through a structured pipeline. You describe what you want — Genie interviews you to capture the full context, builds a plan with acceptance criteria, dispatches specialized agents to execute in parallel, and runs automated review before anything reaches your eyes. You make decisions. Genie does everything else.

### "Genie is right for you if"
- You've re-explained your codebase architecture to Claude Code for the third time this week
- You have 5+ AI coding tabs open and can't remember which one is doing what
- You've watched an AI agent spiral for 20 minutes because it lost the original context
- You want AI to ask *you* the right questions before writing code, not the other way around
- You want to go to lunch and come back to reviewed PRs, not a stuck terminal
- You want a repeatable process that works the same whether you're focused or half-asleep

### "Without Genie / With Genie"
| Without Genie | With Genie |
|---|---|
| *"Wait, did I already tell Claude about the auth middleware?"* — Re-explain context every session. | Genie interviews you once during brainstorm. That context flows to every agent automatically. |
| Copy-paste requirements into Claude, hope it understood, watch it build the wrong thing. | `/wish` captures scope, boundaries, and acceptance criteria before a single line of code. |
| One Claude Code tab. One task. Alt-tab to check. Alt-tab back. Repeat for 5 tasks. | Parallel agents in live terminal panes. Watch all of them. Or don't — review when they're done. |
| AI generates code, you eyeball it, you miss a bug, you ship it, you fix it at 2am. | Automated `/review` with severity-tagged gaps. Nothing ships with CRITICAL or HIGH issues. |
| 45 minutes in, Claude forgets your earlier instructions. Context rot. | Orchestrator dispatches scoped specialists. No single context window accumulates junk. |
| "Let me set up the prompt, load the files, explain the conventions..." — 10 min before work starts. | `genie work bd-42` — agent inherits project context, conventions, and task scope automatically. |

## Execution Groups

### Group 1: Dependency bump (safe patches/minors + careful majors)
- Bump @types/bun, @types/node, esbuild, knip, typescript, zod (within v3), commander (to v13)
- Run `bun run check` after each batch
- Validate: `bun run check` passes, no type errors, no test failures

### Group 2: README rewrite
- Write new README.md following the structure in D4 with pre-written content blocks
- Validate: under 150 lines (excluding collapsed), no first-person, all sections present
