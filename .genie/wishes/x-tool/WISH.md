# Wish: x-tool — Ultimate X/Twitter CLI for AI Agents

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `x-tool` |
| **Date** | 2026-03-26 |
| **Design** | [DESIGN.md](../../brainstorms/x-tool/DESIGN.md) |
| **Omni Issue** | automagik-dev/omni#306 |
| **Blocks** | Viralizador wish (needs `xt post` for content loop) |

## Summary

Build an agent-first X/Twitter CLI by merging the best of 5 reference tools: clix's architecture + twitter-cli's anti-detection + infatoshi's analytics. Python, cookie-based auth primary, installable via `uv tool install`. Ships with 40+ MCP tools, SKILL.md, and a clear path to becoming an Omni social channel.

## Scope

### IN
- Python CLI tool (`xt`) — fork clix, merge twitter-cli's transport
- Cookie auth primary (no API keys for core features)
- Full read: feed, search, trending, tweets, threads, users, bookmarks, lists, DMs
- Full write: post, reply, quote, thread (atomic), like, retweet, bookmark, follow, DM, block, mute
- Analytics via API v2 (optional, needs keys)
- Engagement scoring filter
- 40+ MCP tools via `xt mcp`
- SKILL.md for Claude Code
- `xt doctor` diagnostics
- Anti-detection: TLS fingerprinting (curl_cffi), jitter, xclienttransaction
- Multi-account support

### OUT
- Omni channel adapter (Phase 2, separate wish)
- TypeScript rewrite (Phase 2)
- Dashboard, browser extension, cross-platform
- Growth automation / bot scripts

## Success Criteria

- [ ] `xt feed --json` returns ≥20 tweets without API keys
- [ ] `xt post "Hello from xt"` creates tweet via cookie auth
- [ ] `xt thread "Part 1" "Part 2" "End"` posts atomic thread
- [ ] `xt reply <id> "text"` works via cookie auth
- [ ] `xt like <id>` works via cookie auth (API removed this)
- [ ] `xt search "query"` returns structured results
- [ ] `xt user <handle>` returns profile + recent tweets
- [ ] `xt dm inbox` lists DM conversations
- [ ] `xt trending` returns trending topics
- [ ] `xt auth login` extracts cookies from browser
- [ ] `xt doctor` validates auth + connectivity + deps
- [ ] `xt mcp` starts MCP server with ≥30 tools
- [ ] All commands support `--json`, `--yaml`, `--compact`
- [ ] Non-TTY auto-defaults to JSON output
- [ ] Exit codes: 0 success, 1 error, 2 auth, 3 rate limit
- [ ] SKILL.md exists at project root
- [ ] Installable via `uv tool install x-tool` (single command, no pip/Node)
- [ ] **Ask Felipe:** X API tier? Existing X_AUTH_TOKEN/X_CT0 credentials?

## Execution Strategy

### Wave 1 (parallel — foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fork clix, merge twitter-cli's client.py transport (curl_cffi + xclienttransaction + TLS fingerprinting) into clix's core/ |
| 2 | engineer | Add new commands: `thread` (atomic), `thread-context`, `profile-brief`, `watch`, `batch-tweets`, `batch-users` |

### Wave 2 (parallel — features)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Add engagement scoring from twitter-cli's filter.py, `score` command, `--filter` flag on feed/search |
| 4 | engineer | Add infatoshi's metrics command (API v2), `me` command, `schedule`/`scheduled`/`unschedule` |

### Wave 3 (sequential — integration)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Unify config (TOML + env vars), `xt doctor`, `xt auth` commands, multi-account |
| 6 | engineer | MCP server with 40+ tools, SKILL.md, AGENTS.md, output modes (json/yaml/compact) |
| review | reviewer | Review all changes against criteria |

## Execution Groups

### Group 1: Merge Anti-Detection Transport

**Goal:** Replace clix's HTTP client with twitter-cli's battle-tested anti-detection layer.

**Deliverables:**
1. Fork clix codebase into `tools/x-tool/`
2. Merge twitter-cli's `client.py` (curl_cffi + Chrome TLS fingerprinting)
3. Merge `xclienttransaction` header generation
4. Merge `graphql.py` (dynamic queryId resolution via JS bundle scanning)
5. Verify all existing clix commands still work with new transport

**Acceptance Criteria:**
- [ ] `xt feed` works with merged transport
- [ ] TLS fingerprint matches Chrome (verify via JA3 hash check)
- [ ] Dynamic queryId scanning works (not hardcoded operation IDs)
- [ ] All clix tests pass with new transport

**Validation:**
```bash
cd tools/x-tool && python -m pytest tests/ && xt feed --json | python -c "import json,sys; d=json.load(sys.stdin); print('PASS' if len(d.get('tweets',[])) > 0 else 'FAIL')"
```

**depends-on:** none

---

### Group 2: New Agent-First Commands

**Goal:** Add commands that none of the 5 reference tools have.

**Deliverables:**
1. `xt thread "p1" "p2" "p3"` — atomic thread posting (all tweets or none)
2. `xt thread-context <id>` — full conversation chain in one call
3. `xt profile-brief <handle>` — structured intelligence brief for agent priming
4. `xt watch mentions|feed|keyword` — persistent polling loop with event output
5. `xt batch-tweets <id1> <id2> ...` — bulk tweet fetch
6. `xt batch-users <h1> <h2> ...` — bulk user fetch

**Acceptance Criteria:**
- [ ] Thread posts 3+ tweets atomically (rolls back on failure)
- [ ] `thread-context` returns full parent chain as flat array
- [ ] `profile-brief` returns JSON with: bio, follower count, recent topics, engagement avg
- [ ] `watch` outputs one JSON object per event on stdout (newline-delimited)

**depends-on:** Group 1

---

### Group 3: Engagement Scoring

**Goal:** Port twitter-cli's scoring system so agents can prioritize feeds.

**Deliverables:**
1. Port `filter.py` engagement scoring (configurable weights)
2. `xt score <id>` command
3. `--filter` flag on `feed` and `search` (ranked by score)
4. Configurable weights in TOML config

**Acceptance Criteria:**
- [ ] `xt feed --filter` returns tweets sorted by engagement score
- [ ] `xt score <id>` returns numeric score with breakdown
- [ ] Weights configurable in `~/.config/xt/config.toml`

**depends-on:** Group 1

---

### Group 4: Analytics & Scheduling (API v2)

**Goal:** Add features that require the official X API.

**Deliverables:**
1. `xt metrics <id>` — impressions, clicks, engagement rate
2. `xt me` — own account stats
3. `xt schedule "text" --at "time"` / `xt scheduled` / `xt unschedule <id>`
4. OAuth credential management for API v2
5. Graceful degradation when API keys not configured

**Acceptance Criteria:**
- [ ] `xt metrics` works with API keys configured
- [ ] `xt metrics` returns helpful error when no API keys (not crash)
- [ ] `xt schedule` creates a scheduled tweet
- [ ] `xt scheduled` lists pending scheduled tweets

**depends-on:** Group 1

---

### Group 5: Config, Auth & Diagnostics

**Goal:** Unified configuration, multi-account, and self-diagnosis.

**Deliverables:**
1. TOML config at `~/.config/xt/config.toml`
2. `xt auth login` — interactive cookie extraction
3. `xt auth status` — show current auth method + validity
4. `xt auth switch <account>` — multi-account switching
5. `xt doctor` — check: auth valid, deps installed, rate limit status, API keys
6. Env var fallbacks for headless: `X_AUTH_TOKEN`, `X_CT0`, `X_API_KEY`, etc.

**Acceptance Criteria:**
- [ ] Config file created on first run with defaults
- [ ] `auth login` detects browser cookies
- [ ] `auth status` reports method (cookie/API) and expiry
- [ ] `doctor` outputs pass/fail for each check
- [ ] Multi-account: switch between accounts without re-login

**depends-on:** Group 1

---

### Group 6: MCP, SKILL.md & Output Modes

**Goal:** Make xt fully agent-integrated.

**Deliverables:**
1. `xt mcp` — FastMCP server with 40+ tools (stdio transport)
2. SKILL.md — Claude Code integration guide
3. AGENTS.md — AI assistant context file
4. Output modes: `--json`, `--yaml`, `--compact`, `--full-text`
5. Non-TTY auto-JSON detection
6. Exit codes: 0/1/2/3
7. `meta.rate_limit` object in every JSON response

**Acceptance Criteria:**
- [ ] `xt mcp` starts and responds to MCP tool listing
- [ ] ≥20 MCP tools exposed (covering read + write + search + user)
- [ ] SKILL.md discoverable by Claude Code
- [ ] `echo "test" | xt feed` outputs JSON (non-TTY detection)
- [ ] `xt feed --compact` output is ≤50% of `--json` output size

**depends-on:** Groups 1-5

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| X rotates GraphQL operation IDs | High | Live bundle scanning; static fallbacks |
| Cookie expiration in headless | High | `doctor` detects; env var fallback |
| Account suspension | High | Jitter (1.5-4s), rate caps, proxy support |
| xclienttransaction changes | Medium | Pin version; track upstream |
| clix upstream diverges | Low | Full fork, not wrapper |

## Questions for Felipe

- [ ] Do we have X account credentials (cookies or API keys) to test with?
- [ ] What X API tier (if any)? Free works for MVP, Basic unlocks analytics.
- [ ] Binary name: `xt` confirmed? (twin's recommendation, avoids `x` shell conflict)

## Files to Create

```
tools/x-tool/                    # New tool directory
├── pyproject.toml               # Package config
├── src/xt/
│   ├── core/                    # Business logic (zero CLI deps)
│   │   ├── api.py
│   │   ├── auth.py
│   │   ├── client.py           # curl_cffi transport
│   │   ├── config.py
│   │   ├── endpoints.py        # GraphQL ID scanner
│   │   ├── filter.py           # Engagement scoring
│   │   └── models/
│   ├── cli/                    # typer commands
│   ├── mcp/                    # FastMCP server
│   ├── display/                # Rich formatting
│   └── utils/
├── SKILL.md
├── AGENTS.md
├── tests/
└── README.md
```
