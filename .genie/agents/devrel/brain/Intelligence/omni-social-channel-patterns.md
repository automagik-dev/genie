---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [omni, social, architecture, x-tool]
---

# Omni Social Channel Patterns (from PR #181)

## What PR #181 Did
Added LinkedIn as first-class social channel via `SocialChannelPlugin` base class.
Status: OPEN (not merged). Author: Rodrigo Nader + Claude Opus 4.6.

## Reusable Architecture

### SocialChannelPlugin (extends BaseChannelPlugin)
- Typed methods: createPost(), getFeed(), getComments(), reactToPost(), getConnections()
- 9 social event types: post.received/created/updated/deleted, comment.received/sent, connection.received/accepted, mention.received
- 4 capabilities: canCreatePost, canReadFeed, canComment, canHandleConnections

### Channel-Agnostic DB Schema
- **socialPosts** — posts with engagement tracking (likes, comments, reposts, views)
- **socialComments** — threaded comments (parentCommentId for reply chains)
- **socialConnections** — network relationships (followers, following)
- **socialEngagementSnapshots** — engagement curves over time

### Browser Layer (Anti-Bot)
- BrowserManager (persistent Chromium, headless optional)
- RateLimiter (per-operation limits)
- Humanized delays (random pauses)
- Active hours window (8AM-10PM configurable)
- Selector health checks with fallbacks

### Data Flow
```
Platform → Browser/Playwright → Scraper → Sync Engine (diff) → DB → Events → Agents
```

## How X/Twitter Fits

### Package: channel-twitter
```
actions/   — send-dm, create-post, retweet, like, reply, follow
scrapers/  — timeline, mentions, messages, followers, profile
sync/      — timeline-poller, mentions-poller, messages-poller, differ
browser/   — manager, selectors, humanizer
```

### Implementation Options
- **A) Browser-only (Playwright)** — no API keys, but slower + fragile
- **B) API v2 only** — clean but costs $100+/mo and has restrictions
- **C) Hybrid** — API for writes, browser for reads when quota exhausted (RECOMMENDED)

### Event Mapping
- post.received → new tweet in timeline/mentions
- post.created → bot posted tweet
- comment.received → reply to bot's tweet
- mention.received → @mention
- connection.received → new follower
