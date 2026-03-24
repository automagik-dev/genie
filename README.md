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

<!-- METRICS:START -->

| Metric | Value | Updated |
|--------|-------|---------|
| Releases/day | **0** | 2026-03-24 |
| Avg bug-fix time | **2.0h** | 2026-03-24 |
| SHIP rate | **100.0%** | 2026-03-24 |
| Parallel agents | **3** | 2026-03-24 |

<!-- METRICS:END -->

## What is Genie?

Genie is an AI orchestration CLI that turns vague ideas into shipped PRs. You describe the problem — Genie interviews you, plans the work, dispatches parallel agents, and reviews the code. You approve and ship.

## Get Started

**Prerequisites:** curl, bash, git (pre-installed on macOS/Linux/WSL)

Run these commands in sequence to install Genie and initialize your workspace:

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
genie
/wizard
```

That's it. The wizard handles everything: project scaffold, identity, first wish, execution, and review. In ~5 minutes, you'll have your workspace scaffolded and ready to execute your first wish.

## What Happens Next

```
 You describe an idea
  └─ /brainstorm ─── Genie asks clarifying questions until the idea is concrete
      └─ /wish ───── Crystallizes intent into a plan with scope + acceptance criteria
          └─ /work ── Agents spawn in isolated worktrees, execute in parallel
              └─ /review ── Automated severity-gated review. You approve the PR.
```

## Why Genie?

- **No re-explaining** — Genie captures context once. Every agent inherits it.
- **Parallel execution** — Multiple agents work simultaneously in isolated worktrees.
- **Automated review** — Severity-tagged gaps. Nothing ships with CRITICAL issues.
- **Overnight mode** — Queue wishes before bed. Wake up to reviewed PRs.
- **10-critic council** — 10 specialists critique your design before you commit.
- **Portable context** — Identity, skills, memory — markdown files you own, git-versioned.

---

<p align="center">
  <a href="https://docs.automagik.dev/genie"><strong>Documentation</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center">
  <sub>You make the decisions. Genie does everything else.</sub>
</p>
