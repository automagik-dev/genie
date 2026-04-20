# Genie Wish Lifecycle

Every piece of work follows this flow:

```
 Idea → /brainstorm → /wish → /review → /work → /review → PR → Ship
         (explore)    (plan)   (gate)   (build)  (verify)
```

## Skills

| Skill | Purpose | When to use |
|-------|---------|-------------|
| `/brainstorm` | Explore ambiguous ideas interactively. Tracks Wish Readiness Score (WRS) across 5 dimensions. Auto-crystallizes into DESIGN.md at WRS 100. | Idea is fuzzy, scope unclear |
| `/wish` | Convert a design into a structured plan at `.genie/wishes/<slug>/WISH.md`. Defines scope, execution groups, acceptance criteria, and validation commands. | Idea is concrete, needs a plan |
| `/review` | Universal quality gate. Returns SHIP / FIX-FIRST / BLOCKED with severity-tagged gaps. | Before and after `/work`, or to validate any plan |
| `/work` | Execute an approved wish. Dispatches subagents per execution group. Runs fix loops on failures. | Wish is SHIP-approved, ready to build |
| `/fix` | Dispatch fix subagent for FIX-FIRST gaps from review. Re-reviews after fix, escalates after 2 failed loops. | Review returned FIX-FIRST |
| `/council` | Multi-perspective architectural review with 10 specialist viewpoints. | Major design decisions, tradeoff analysis |
| `/refine` | Transform a prompt into a structured, production-ready prompt via prompt-optimizer. | Prompt needs sharpening |
| `/report` | Investigate bugs — cascade through trace, capture evidence, create GitHub issue. | Bug reports, error investigation |
| `/trace` | Reproduce, trace, and isolate root cause without patching. | Unknown issues needing investigation |
| `/docs` | Audit, generate, and validate documentation against actual code. | Documentation needs updating |
| `/dream` | Batch-execute SHIP-ready wishes overnight. | Multiple wishes ready for autonomous execution |
| `/learn` | Diagnose and fix agent behavioral issues. | When the agent makes a recurring mistake |

## Team Execution

For autonomous execution, create a team with a wish:

```bash
genie team create my-feature --repo . --wish my-feature-slug
```

This creates a git worktree, hires default agents (team-lead, engineer, reviewer, qa, fix), and the team-lead orchestrates the full build-review-ship cycle.

### Monitoring

```bash
genie team ls                         # List all teams
genie team ls my-feature              # Show team members
genie wish status my-feature-slug     # Wish group progress
genie agent log team-lead             # Unified log
genie agent log team-lead --raw       # Raw pane output
```

### Team Lifecycle

```bash
genie team done <name>                # Mark done, kill members
genie team blocked <name>             # Mark blocked, kill members
genie team disband <name>             # Full cleanup
```

## Agent Resolution Order

When spawning, genie resolves agents in three tiers:
1. **Directory** — custom agents registered with `genie dir add`
2. **Built-in roles** — engineer, reviewer, qa, fix, refactor, trace, docs
3. **Fallback** — generic agent with the given name

## Communication

- **Same-session teammates** (spawned via `genie agent spawn`): Use `SendMessage` (Claude Code native IPC)
- **Cross-session agents** (different tmux windows/teams): Use `genie agent send`
