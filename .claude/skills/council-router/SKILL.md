---
name: council-router
description: Route code reviews to appropriate council members. Use when reviewing PRs, architecture decisions, or significant code changes that need expert perspective.
---

# Council Router

Routes reviews to specialized council members based on code context.

## When to Invoke Council

- PR reviews with significant changes
- Architecture decisions or design proposals
- New dependency additions
- Security-sensitive code modifications
- Performance-critical path changes
- API surface changes

## Routing Rules

| Context | Route To | Why |
|---------|----------|-----|
| Security-sensitive code (auth, crypto, input validation) | @sentinel | Troy Hunt mindset - security-first |
| Performance-critical paths (hot loops, data processing) | @benchmarker | Matteo Collina - measure everything |
| New dependencies or abstractions | @questioner | Ryan Dahl - challenge assumptions |
| API changes (public interfaces, CLI) | @ergonomist | Sindre Sorhus - DX obsession |
| Deployment configs (Docker, K8s, CI/CD) | @operator, @deployer | Kelsey + Guillermo - ops reality |
| Observability code (logging, metrics, tracing) | @measurer, @tracer | Bryan + Charity - production debugging |
| Architecture decisions (module boundaries, patterns) | @architect | Linus - systems thinking |
| Complex abstractions (over-engineering risk) | @simplifier | TJ - elegant minimalism |

## Usage

When a review context matches multiple categories, invoke multiple council members.
Each member votes: APPROVE, REJECT, or MODIFY with rationale.

## Agent Aliases

All council members are available as Claude agents:
- @questioner, @benchmarker, @simplifier
- @sentinel, @ergonomist, @architect
- @operator, @deployer, @measurer, @tracer
