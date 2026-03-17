<p align="center">
  <picture>
    <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@automagik/genie"><img alt="npm version" src="https://img.shields.io/npm/v/@automagik/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://github.com/automagik-dev/genie"><img alt="GitHub" src="https://img.shields.io/github/stars/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="Discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<h2 align="center">Wishes in, PRs out.</h2>

<p align="center">Describe the problem. Genie interviews you, plans the work, dispatches agents, and reviews the code.<br/>You approve and ship.</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> &middot;
  <a href="#quick-start"><strong>Quick Start</strong></a> &middot;
  <a href="#features"><strong>Features</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a>
</p>

<br/>

## What is Genie?

Genie is a CLI that turns vague ideas into shipped PRs through a structured pipeline. Describe what you want — Genie interviews you to capture the full context, builds a plan with acceptance criteria, dispatches specialized agents to execute in parallel, and runs automated review before anything reaches your eyes. You make decisions. Genie does everything else.

## Genie is right for you if

- ✅ You've re-explained your codebase architecture to Claude Code for the third time this week
- ✅ You have 5+ AI coding tabs open and can't remember which one is doing what
- ✅ You've watched an AI agent spiral for 20 minutes because it lost the original context
- ✅ You want AI to ask *you* the right questions before writing code, not the other way around
- ✅ You want to go to lunch and come back to reviewed PRs, not a stuck terminal
- ✅ You want a repeatable process that works the same whether you're focused or half-asleep
<br/>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

Sets up everything: Bun, tmux, Claude Code plugin, orchestration config. Update anytime with `genie update`.

<details>
<summary>Alternative: npm install</summary>

```bash
npm install -g @automagik/genie
```

> Installs the CLI only. You'll need Bun 1.3.10+, tmux, and `genie setup` for full plugin integration.

</details>

> **Requirements:** macOS or Linux, [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Quick Start

**Interactive (you drive):**

| Step | Command |
|------|---------|
| **01. Launch** | `genie` |
| **02. Wish** | `/wish fix the authentication bug in the login flow` |
| **03. Ship** | Genie asks questions, builds a plan, executes it. You approve the PR. |

**Autonomous (team-lead drives):**

| Step | Command |
|------|---------|
| **01. Plan** | `/wish` — define scope, acceptance criteria, execution groups |
| **02. Launch** | `genie team create auth-fix --repo . --wish auth-bug` |
| **03. Ship** | Team-lead hires agents, dispatches work, runs review loops. You approve the PR. |
<br/>

## Features

<table>
<tr>
<td align="center" width="33%"><h3>🧞 Wish Pipeline</h3>
Brainstorm, plan, execute, review, ship — consistent results every time.
</td>
<td align="center" width="33%"><h3>🤖 Autonomous Team-Lead</h3>
<code>genie team create --wish</code> — team-lead hires agents, dispatches work, runs fix loops, and opens the PR. You approve.
</td>
<td align="center" width="33%"><h3>🧠 Context Preservation</h3>
Scoped specialists instead of one bloated window. No context rot.
</td>
</tr>
<tr>
<td align="center"><h3>💾 Persistent Memory</h3>
Knowledge vault that agents search before answering. Compounds daily.
</td>
<td align="center"><h3>🔍 Automated Review</h3>
Severity-tagged review. Nothing ships with CRITICAL or HIGH issues.
</td>
<td align="center"><h3>🌙 Overnight Execution</h3>
Queue wishes before bed. Wake up to reviewed PRs.
</td>
</tr>
<tr>
<td align="center"><h3>👥 10-Critic Council</h3>
10 specialists critique your design before you commit to anything.
</td>
<td align="center"><h3>🎯 Behavioral Learning</h3>
Genie adapts to your codebase conventions and preferences.
</td>
<td align="center"><h3>📦 Portable Context</h3>
Identity, skills, memory — markdown files you own. Git-versioned.
</td>
</tr>
</table>
<br/>

## Without Genie vs. With Genie

| ❌ Without Genie | ✅ With Genie |
|---|---|
| Re-explain your codebase to Claude every session | Genie interviews you once. Context flows to every agent. |
| Copy-paste requirements, hope it understood | `/wish` captures scope and acceptance criteria upfront |
| One Claude tab per task, alt-tab between 5 of them | Parallel agents in live terminal sessions |
| Eyeball generated code, miss a bug, fix at 2am | Automated `/review` with severity-tagged gaps |
| 45 min in, Claude forgets your instructions | Scoped specialists — no context window accumulates junk |
| 10 min of setup before any work starts | `genie team create auth-fix --repo . --wish auth-bug` — team-lead handles the rest |
<br/>

## The Wish Pipeline

💭 `/brainstorm` → 🧞 `/wish` → ⚙️ `/work` → 🔍 `/review` → 🚀 **ship**

| Stage | What happens |
|-------|-------------|
| **Brainstorm** | Think out loud. Genie asks clarifying questions until the idea is concrete. |
| **Wish** | Crystallize intent into a plan with scope and acceptance criteria. |
| **Work** | Agents spawn in isolated worktrees, execute in parallel. |
| **Review** | Automated review with severity gates. Nothing merges without passing. |
| **Ship** | PR created, checks pass, you merge. |
<br/>

<details id="cli-reference">
<summary><strong>CLI Reference</strong></summary>

**Entry point:**

| Command | Description |
|---------|-------------|
| `genie` | Persistent session in current directory |
| `genie --session <name>` | Named/resumed leader session |

**Team (autonomous execution):**

| Command | Description |
|---------|-------------|
| `genie team create <name> --repo <path>` | Form team + git worktree |
| `genie team create <name> --repo <path> --wish <slug>` | Form team and auto-spawn team-lead with wish context |
| `genie team hire <agent>` | Add agent to team |
| `genie team hire council` | Hire all 10 council members |
| `genie team fire <agent>` | Remove agent from team |
| `genie team ls [<name>]` | List teams or team members |
| `genie team done <name>` | Mark team done, kill all members |
| `genie team blocked <name>` | Mark team blocked, kill all members |
| `genie team disband <name>` | Kill members, remove worktree, delete config |

**Dispatch (lifecycle orchestration):**

| Command | Description |
|---------|-------------|
| `genie brainstorm <agent> <slug>` | Spawn agent with brainstorm context |
| `genie wish <agent> <slug>` | Spawn agent with design for wish creation |
| `genie work <agent> <slug>#<group>` | Check deps, set in\_progress, spawn with context |
| `genie review <agent> <slug>#<group>` | Spawn agent with review scope |
| `genie done <slug>#<group>` | Mark group done, unblock dependents |
| `genie reset <slug>#<group>` | Reset in-progress group back to ready |
| `genie status <slug>` | Show wish group states |

**Agent lifecycle:**

| Command | Description |
|---------|-------------|
| `genie spawn <name>` | Spawn registered agent or built-in role |
| `genie kill <name>` | Force kill agent |
| `genie stop <name>` | Stop current run, keep pane alive |
| `genie ls` | List agents, teams, state |
| `genie history <name>` | Compressed session timeline |
| `genie read <name>` | Tail agent pane output |
| `genie answer <name> <choice>` | Answer agent prompt |

**Messaging:**

| Command | Description |
|---------|-------------|
| `genie send '<msg>' --to <name>` | Direct message (scoped to own team) |
| `genie broadcast '<msg>'` | Leader to all team members |
| `genie chat '<msg>'` | Team group channel |
| `genie chat read` | Read team channel history |
| `genie inbox [<name>]` | View inbox |

**Directory (agent registry):**

| Command | Description |
|---------|-------------|
| `genie dir add <name>` | Register agent (`--dir`, `--prompt-mode`, `--model`, `--roles`) |
| `genie dir rm <name>` | Remove agent from directory |
| `genie dir ls [<name>]` | List all or show single entry |
| `genie dir edit <name>` | Update entry fields |

**Infrastructure:**

| Command | Description |
|---------|-------------|
| `genie setup` | Interactive setup wizard |
| `genie doctor` | Diagnose configuration issues |
| `genie update` | Update to latest version (`--next` for dev builds, `--stable` for releases) |
| `genie shortcuts show\|install\|uninstall` | tmux keyboard shortcuts |

</details>

<details id="configuration">
<summary><strong>Configuration</strong></summary>

### Agent Directory

Register custom agents with a directory path, prompt mode, and optional model. Built-in roles (engineer, reviewer, qa, fix, refactor, trace, docs, learn, council) are available out of the box.

```bash
genie dir add my-agent --dir /path/to/agent --prompt-mode append
genie dir ls                          # List all registered agents
genie dir ls --builtins               # Include built-in roles
genie dir edit my-agent --model opus  # Update config
genie dir rm my-agent                 # Remove registration
```

### Worktrees

Teams work in isolated git worktrees so agents never conflict with your working tree.

```
~/.genie/worktrees/<project>/<team>/
```

Configurable via `genie setup --terminal` → `worktreeBase`. Worktrees are created on `genie team create` and cleaned up on `genie team disband`.

### Setup

```bash
genie setup              # Interactive wizard (hooks, terminal, shortcuts, sessions)
genie setup --quick      # Recommended defaults
genie setup --show       # Show current configuration
genie setup --reset      # Reset to defaults
```

### Config Files

| File | Purpose |
|------|---------|
| `~/.genie/config.json` | Terminal settings, session config, worker profiles |
| `~/.claude/settings.json` | Claude Code settings (hooks registered here) |

</details>

<br/>

## Development

```bash
bun run build     # Build CLI
bun run check     # Typecheck + lint + dead-code + test
bun test          # Run tests
genie doctor      # Diagnose issues
```

Uninstall: `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash -s -- uninstall`

---

<p align="center">
  <a href="https://github.com/automagik-dev/genie">GitHub</a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R">Discord</a> &middot;
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <sub>You make the decisions. Genie does everything else.</sub>
</p>
