---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [research-queue, x-research, market-intel, loop]
---

# X Research Queue — Market Intelligence Loop

## Mission
Not just virality — ANTICIPATE market needs. Study accounts to understand:
1. Where is the AI agent market going?
2. What features are people asking for that Genie already has (or should build)?
3. Who are the distribution channels (newsletters, curators, communities)?
4. What's our positioning gap vs competitors?
5. How do we make Genie the most popular OSS orchestration tool?

## Queue (one per 15-min loop iteration)

### Priority 1 — Product Intelligence (features, roadmaps, what's shipping)
| # | Handle | Category | Status | Brain File |
|---|--------|----------|--------|-----------|
| 1 | @claudeai | Anthropic official — new features, might copy us or inspire us | DONE | x-profiles/claudeai.md |
| 2 | @pbakaus | Product engineer, tools builder — creativity × tech | DONE | x-profiles/pbakaus.md |
| 3 | @huang_chao4969 | HKU AI Lab — LightRAG, CLI-Anything, DeepCode, nanobot | DONE | x-profiles/huang_chao4969.md |
| 4 | @om_patel5 | 16yo SaaS dev, $10k/m — builder perspective, Claude Code power user | DONE | x-profiles/om_patel5.md |

### Priority 2 — Distribution & Amplification (newsletters, communities, curators)
| # | Handle | Category | Status | Brain File |
|---|--------|----------|--------|-----------|
| 5 | @AlphaSignalAI | AI news for 280K devs — potential partnership/feature | DONE | x-profiles/AlphaSignalAI.md |
| 6 | @RoundtableSpace | Crypto & AI content — Mario Nawfal's account, 218K | DONE | x-profiles/RoundtableSpace.md |
| 7 | @aiwithmayank | AI education content — practical AI use | DONE | x-profiles/aiwithmayank.md |
| 8 | @heygurisingh | AI + no-code tools — 47K, practical audience | DONE | x-profiles/heygurisingh.md |

### Priority 3 — Already Studied (refresh when stale >7d)
| # | Handle | Last Studied | Brain File |
|---|--------|-------------|-----------|
| - | @karpathy | 2026-03-26 | karpathy-bespoke-software.md |
| - | @JayaGup10 | 2026-03-26 | jaya-gupta-profile.md + context-graphs-thesis.md |
| - | @steipete | 2026-03-26 | openclaw-paperclip-study.md |
| - | @openclaw | 2026-03-26 | openclaw-paperclip-study.md |
| - | @dotta | 2026-03-26 | openclaw-paperclip-study.md |
| - | @DrJimFan | 2026-03-26 | x-landscape-study.md |
| - | @rough__sea | 2026-03-26 | x-landscape-study.md |
| - | @joaomdmoura | 2026-03-26 | x-landscape-study.md |
| - | @rowancheung | 2026-03-26 | x-landscape-study.md |

### Priority 4 — From Felipe's Following (promoted to active queue)
| # | Handle | Category | Status | Brain File |
|---|--------|----------|--------|-----------|
| 9 | @sama | OpenAI CEO, 4.5M — shapes the entire AI narrative | DONE | x-profiles/sama.md |
| 10 | @ClementDelangue | HuggingFace CEO, 227K — OSS AI leader | DONE | x-profiles/ClementDelangue.md |
| 11 | @swyx | AI Engineer ecosystem, coined term | DONE | x-profiles/swyx.md |
| 12 | @danshipper | AI newsletter, 97K | DONE | x-profiles/danshipper.md |
| 13 | @heyshrutimishra | AI content, 177K | DONE | x-profiles/heyshrutimishra.md |
| 14 | @dannypostma | Build-in-public, 171K | PENDING | |
| 15 | @bentossell | Ben's Bites newsletter, 189K | PENDING | |
| 16 | @blader | AI/startup, 167K | PENDING | |

### Archive — Original Priority 4 list (for reference)
| Handle | Followers | Category |
|--------|----------:|----------|
| @DarioAmodei | 261K | Anthropic CEO |
| @ylecun | 1.1M | Meta AI |
| @ClementDelangue | 227K | HuggingFace CEO |
| @dannypostma | 171K | Build-in-public |
| @bentossell | 189K | Ben's Bites newsletter |
| @blader | 167K | AI/startup |
| @danshipper | 97K | AI newsletter |
| @heyshrutimishra | 177K | AI content |
| @swyx | varies | AI Engineer ecosystem |

## Research Protocol (per iteration)

### What to Capture
For each account, produce a brain file with:

1. **Profile** — who they are, follower count, bio, what they're known for
2. **Content analysis** — top 20 tweets sorted by views, content patterns, posting cadence
3. **Market signals** — what are they talking about that relates to:
   - Agent orchestration
   - Context engineering
   - Multi-agent coordination
   - Developer tools
   - Build-in-public
   - Any feature Genie has or should have
4. **Engagement patterns** — what format works (text, image, video, thread)
5. **Genie relevance** — how does this account/content connect to Genie's positioning
6. **Action items** — should we engage? follow? bookmark specific tweets?

### Rules
- `sleep 5` between ALL clix calls
- Max 5 API calls per profile (profile + tweets + 1-2 thread fetches + bookmark)
- Bookmark anything >50K views relevant to agent orchestration
- Follow anyone with >10K followers in the AI dev tools space
- Save brain file IMMEDIATELY after analysis (don't batch)
- Update research-queue.md status after each profile
- If rate-limited, STOP and resume next iteration

### What We're Looking For (Market Intelligence)
1. **Features people want** that Genie already has → content angle ("we already do that")
2. **Features people want** that Genie doesn't have → roadmap input
3. **Pain points** in AI agent workflows → validate our "context collapse" framing
4. **Distribution channels** → newsletters, podcasts, communities to target
5. **Competitor moves** → what OpenClaw, CrewAI, Paperclip, Cursor are doing
6. **Narrative shifts** → new terms, concepts, framings emerging in the discourse
7. **Potential advocates** → people who would naturally promote Genie if they knew about it
