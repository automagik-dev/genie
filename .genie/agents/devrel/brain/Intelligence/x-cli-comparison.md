---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [x-tool, research, comparison, twitter]
---

# X/Twitter CLI Comparison Matrix

## Winner Summary
- **Immediate use:** clix (cookie-based, DMs, Lists, Scheduling, 46 MCP tools)
- **Best anti-detection:** twitter-cli (TLS fingerprinting, Chrome version matching)
- **Most powerful:** XActions (140+ MCP tools, streaming, sentiment, workflows, plugins)
- **Best API v2:** infatoshi-x-cli (clean, minimal, analytics)
- **Skip:** x-cli (Rust legacy, OAuth 1.0a only)

## Feature Matrix

| Feature | twitter-cli | x-cli | infatoshi | clix | XActions |
|---------|:-:|:-:|:-:|:-:|:-:|
| POST tweets | Y | Y | Y | Y | Y |
| READ timeline | Y | Y | Y | Y | Y |
| SEARCH | Y | Y | Y | Y | Y |
| DMs | N | Y | N | **Y** | Y |
| MEDIA upload | Y | ~ | N | Y | Y |
| ANALYTICS | N | N | **Y** | N | **Y** |
| SCHEDULING | N | N | N | **Y** | Y |
| MCP server | N | N | N | **46** | **140+** |
| Real-time stream | N | Y | N | N | **Y** |
| Workflows | N | N | N | N | **Y** |
| Sentiment | N | N | N | N | **Y** |
| API keys needed | N | Y | Y | N | N |
| Anti-detection | **Best** | N | N | Good | ~ |

## Recommended Hybrid: "Best of All Worlds"

1. **Core CLI:** clix architecture (DMs, Lists, Scheduling, media)
2. **Anti-detection:** twitter-cli's curl_cffi + TLS fingerprinting
3. **Analytics:** infatoshi-x-cli's metrics API
4. **Advanced:** XActions' streaming + sentiment + workflows
5. **Auth:** Multi-mode (cookies + OAuth + browser automation)
6. **Output:** TypeScript + Bun for Genie ecosystem compatibility

## API Restrictions (as of March 2026)
- Free tier: 500 posts/mo, no bookmarks, likes removed Aug 2025
- Basic ($100/mo): 10k posts/mo, bookmarks, full features
- Programmatic replies restricted Feb 2026 — only if author @mentioned you
- Workaround: use quote tweets instead of replies
