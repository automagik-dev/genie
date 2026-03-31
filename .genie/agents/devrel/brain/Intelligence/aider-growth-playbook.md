---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [aider, growth-playbook, benchmarks, competitive-intel, oss-growth]
---

# Aider Growth Playbook — What Genie Should Steal

## The Formula
**Aider's Growth = (Benchmarks x Transparency x Responsiveness x Community) x New LLMs**

Every new model release = benchmark run = leaderboard update = blog post = testimonials = trust. It's a perpetual content machine powered by the LLM release cycle.

## Key Stats
- 5.7M PyPI installs
- 15B tokens/week usage
- 88% of its own code written by Aider itself (self-shipping proof, like Genie's 96% SHIP rate)
- Top 20 on OpenRouter
- 100+ releases in ~1.5 years

## What Made Them Grow

### 1. Benchmark-Driven Content Marketing (STEAL THIS)
- Exercism-based benchmark: 225 multi-language coding challenges
- Polyglot leaderboard redesigned when old one saturated
- Published as YAML for reproducibility
- Every new LLM = new leaderboard entry = blog post = traffic
- Community can CONTRIBUTE benchmark runs via Docker

**For Genie:** Create orchestration benchmarks. "Can your agent framework ship a feature from wish to PR?" Multi-agent coordination, parallel execution, review quality. No one benchmarks ORCHESTRATION yet — first mover.

### 2. Live Metrics in README
Aider tracks: installs, tokens/week, rankings, code % written by itself.

**For Genie:** Already have metrics in README (48 PRs, 0.7h merge, 96% SHIP). Add live badges: npm installs/week, wishes completed, SHIP rate.

### 3. 30+ Testimonials in README
Systematically scraped from Discord, X, HN, GitHub issues. Each linked to source.

**For Genie:** Start collecting. Every user comment, Discord message, GitHub issue that praises Genie = README testimonial.

### 4. README Structure (Masterclass)
```
1. Logo + tagline
2. Live metric badges
3. Feature grid (12 features with icons)
4. Quick start (3 model examples)
5. 30+ testimonials
```

### 5. Documentation as SEO
Each feature gets its own doc page. Docs rank well for "code editing benchmark" searches.

### 6. Responsive to Market Events
Published "DeepSeek V3 is down, alternatives" within 24 hours. Shows real-time relevance.

## Genie vs Aider

| Aspect | Aider | Genie |
|--------|-------|-------|
| Scope | Code editing (pair programming) | Agent orchestration (team coordination) |
| Interface | Chat | Wish pipeline + skills |
| Self-shipping | 88% of own code | 96% SHIP rate |
| Community | Large, active Discord | Growing |
| Benchmarks | Exercism-based leaderboard | NONE YET (opportunity) |

**Don't compete on code editing benchmarks** — Aider owns that. Genie's benchmarks should be orchestration-specific: multi-step workflows, parallel agent coordination, review quality, decision trace completeness.

## Immediate Actions
1. Create "Genie Orchestration Benchmark" (first in category)
2. Add live metric badges to README (npm, SHIP rate)
3. Start collecting testimonials systematically
4. Study Aider's blog cadence — one post per LLM release is genius
