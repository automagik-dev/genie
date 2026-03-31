---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [karpathy, bespoke-software, thought-leadership, ai-vision, x-research]
---

# Karpathy: "The Coming Era of Highly Bespoke Software"

**Source:** https://x.com/karpathy/status/2024583544157458452
**Date:** Feb 19, 2026 | **Views:** 1.93M | **Likes:** 12,060 | **Bookmarks:** 7,983

## The Thesis

Karpathy built a custom health tracking app (RHR 50→45 experiment, 8-week zone 2 + HIIT plan) using AI. The app is a dark-themed dashboard with weekly targets, progress bars, zone tracking — clearly vibe-coded with an LLM. His argument:

> The "app store" of discrete apps you choose from is an increasingly outdated concept. Software is becoming so cheap to create that everyone will have bespoke, personal software — custom-built for their exact needs.

His framing: the world has **sensors** (health trackers, APIs, data sources) and **actuators** (notifications, controls, actions). AI agents sit in the middle, constructing custom interfaces and workflows on demand. The "app" as a discrete product dissolves.

## Key Quotes from the Thread

**Karpathy on OpenClaw:**
> "Are you using openclaw yet?" — @stevedakh
> "no i'm too scared, but i like the concept." — @karpathy

**Karpathy on software abundance:**
> "These reactions are still rooted in a scarcity mindset of software. 2 years ago AI was botching autocomplete, today it is almost one-shotting browsers and C compilers. Where is it in 2 more? 10? 20? Software so insanely cheap and abundant..."

**Karpathy on NanoClaw (OpenClaw derivative):**
> "I've been meaning to check it out. I love their config vs skill philosophy, it's new and interesting."

**Michael Nielsen (quantum computing researcher):**
> "You can just describe things"

## Notable Replies & Counter-Arguments

**@lauriewired (771K views):** "You think your grandma wants to make her own app? Much less maintain it. Everyone neglects the mental energy it takes to even *think* of what it is exactly you want."
- **Karpathy's response:** "Grandma certainly shouldn't have to know apps. Her LLM agent should."

**@kepano (Obsidian founder):** Chef analogy — "the food synthesizer doesn't turn everyone into a chef, it makes it so any one chef can feed everyone"
- **Karpathy's response:** Disagrees — "scarcity mindset of software"

**@swyx:** Points to dps.pub as "the closest to an AI-native personal software app store"
- **Karpathy's response:** "Visionary... I do have an affiliation :)"

**@DanielMiessler:** "The whole world has APIs. We all have AI digital assistants that interact with that world on our behalf."

**@snakajima:** "Natural language is great for intent, but too ambiguous for reliable execution. Traditional programming languages are precise, but too unconstrained." — argues for DSLs designed for LLMs.

## Why This Matters for Genie

### 1. Karpathy's Vision = Genie's Reality
Karpathy describes the future: AI agents sit between sensors and actuators, constructing bespoke software. **Genie already does this for code.** The wish pipeline IS the "bespoke software" creation loop — describe what you want, agents build it.

### 2. "Config vs Skill Philosophy"
Karpathy loved NanoClaw's approach where "features are contributed as skills that show an agent how to modify the code." **Genie's skill system (14 built-in, extensible) IS this pattern.** Skills are not code features — they're prompt programs that teach agents how to do things.

### 3. The "Scarcity Mindset" Reframe
People argue "not everyone can build apps." Karpathy says that's thinking in old terms. The right frame: "describe what you want, the agent builds it." This is literally Genie's tagline: **"You make the decisions. Genie does everything else."**

### 4. The Grandma Test
The LaurieWired pushback is real — not everyone wants to describe software. Genie's answer: the developer describes it ONCE (the wish), and agents handle everything else. The developer isn't building bespoke software from scratch — they're describing intent and reviewing output.

### 5. Content Angle
A post that connects Genie to Karpathy's bespoke software vision would resonate hard:
> "Karpathy says the era of bespoke software is coming. We built the assembly line. Describe a wish → agents build it → you review the PR. That's it."

## Bookmarked Insights
- 7,983 bookmarks = extremely high save rate. This is reference content people come back to.
- The chef/food-synthesizer metaphor from @kepano is useful — Genie is the "food synthesizer" that lets one developer-chef feed an entire org.
- @snakajima's DSL point is interesting — structured wishes (WISH.md) ARE a DSL for agent orchestration.
