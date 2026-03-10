# Brainstorm: Dependency Bump + README Rewrite

## Topic 1: Dependency Audit

### Current State (bun outdated)

| Package | Current | Latest | Jump |
|---------|---------|--------|------|
| @inquirer/prompts | 7.10.1 | 8.3.0 | major |
| commander | 12.1.0 | 14.0.3 | major |
| uuid | 11.1.0 | 13.0.0 | major |
| zod | 3.25.76 | 4.3.6 | major |
| @biomejs/biome (dev) | 1.9.4 | 2.4.6 | major |
| @types/bun (dev) | 1.3.8 | 1.3.10 | patch |
| @types/node (dev) | 20.19.30 | 25.4.0 | major |
| esbuild (dev) | 0.27.2 | 0.27.3 | patch |
| knip (dev) | 5.85.0 | 5.86.0 | minor |

### Risk Assessment
- **@types/bun, esbuild, knip**: Safe patch/minor bumps, no breaking changes
- **@types/node**: 20→25 is cosmetic (type defs only), low risk
- **zod 3→4**: Major — need to check schema API changes
- **commander 12→14**: Major — need to check CLI API changes
- **uuid 11→13**: Major — need to check if API changed
- **@inquirer/prompts 7→8**: Major — need to check prompt API
- **@biomejs/biome 1→2**: Major — lint rules may change, config format may break

## Topic 2: README Rewrite

### What Paperclip Does Well (inspiration analysis)
1. **Identity-first headline**: "Open-source orchestration for zero-human companies" — immediately answers "what is this?"
2. **Positioning line**: "If OpenClaw is an employee, Paperclip is the company" — instant mental model
3. **3-step quickstart table**: Numbered, scannable, no jargon
4. **"Right for you if" section**: Self-qualifying checklist with checkmarks
5. **Problem/solution table**: "Without X / With X" — visceral contrast
6. **"What X is NOT" section**: Sets boundaries, prevents misunderstanding
7. **Feature grid**: 3x3 table with emoji headers, not a wall of text
8. **Visual hierarchy**: Center-aligned hero, badges, video, then content
9. **FAQ section**: Anticipates objections directly

### What Genie's Current README Gets Wrong
1. **"Markdown-native agent framework"** — too abstract, means nothing to newcomers
2. **First-person voice** ("I'm a markdown-native agent framework") — cute but unclear
3. **No positioning against alternatives** — what is this vs Cursor, vs Codex, vs raw Claude?
4. **Features are skill names** (`/dream`, `/brain`) — insiders-only language
5. **No "right for you if"** — reader can't self-qualify
6. **No problem/solution framing** — jumps straight to features
7. **CLI reference is a giant table dump** — overwhelming
8. **Missing: architecture diagram, video/gif, "what this is not"**
9. **Outdated references**: "terminal UI" (renamed to session), some stale commands

### Proposed README Structure (inspired by Paperclip)
1. Hero image + badges + tagline
2. One-liner positioning ("If Claude Code is a developer, Genie is the engineering manager")
3. 3-step quickstart (install → launch → wish)
4. "What is Genie?" — 3 sentences max
5. "Genie is right for you if" — checkbox list
6. Feature grid (3x3 with icons)
7. The Wish Pipeline (visual flow)
8. "Without Genie / With Genie" problem table
9. "What Genie is NOT"
10. CLI reference (collapsed)
11. Configuration (collapsed)
12. Development
13. Community + License
