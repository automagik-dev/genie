---
name: juice-server
description: Manage the Namastex Juice router (router-for.me / CLIProxyAPI) and its OpenAI/Anthropic-compatible inference endpoints. Use when probing which endpoints work (/v1/models, /v1/chat/completions, /v1/responses, /v1/messages), inspecting usage and runtime config via the Management API (/v0/management/*), managing auth files, rotating keys, changing router config.yaml safely, or wiring OpenClaw model providers/defaults to use Juice and/or google-antigravity Claude Opus.
---

# Juice Server

## Quick start (read-only, safe)

### 1) Probe inference endpoints (OpenAI/Anthropic compatibility)
Run the bundled probe:

```bash
export JUICE_API_KEY="..."   # never paste keys into chat/logs
./scripts/juice-probe.sh
```

Useful variants:

```bash
# If the server expects x-api-key instead of Authorization: Bearer
JUICE_AUTH_MODE=x-api-key ./scripts/juice-probe.sh

# Force a model id
JUICE_MODEL="claude-3-5-sonnet-20241022" ./scripts/juice-probe.sh
```

Interpretation for OpenClaw provider `api`:
- `/v1/responses` works → prefer `api: openai-responses`
- else `/v1/chat/completions` works → `api: openai-completions`
- else `/v1/messages` works → `api: anthropic-messages`

### 2) Probe Management API (router-for.me)
Management API requires a *management key* (different from model API keys).
Avoid repeated wrong attempts: remote IPs can be temporarily banned after ~5 failures.

```bash
export JUICE_MGMT_KEY="..."
export JUICE_MGMT_BASE="https://juice.namastex.io/v0/management"
./scripts/juice-mgmt-probe.sh

# If management auth uses X-Management-Key instead of Authorization
JUICE_MGMT_AUTH_MODE=x-management-key ./scripts/juice-mgmt-probe.sh

# Print full JSON bodies
JUICE_VERBOSE=1 ./scripts/juice-mgmt-probe.sh
```

## Day-to-day operations (prefer GET first)

### Discover what's configured
Primary discovery endpoint:

```bash
curl -sS -H "Authorization: Bearer $JUICE_MGMT_KEY" "$JUICE_MGMT_BASE/config" | jq .
```

Common fields in `/config` to inspect:
- `openai-compatibility[]` (named OpenAI-compatible upstreams + model aliases)
- `claude-api-key[]`, `codex-api-key[]`, `gemini-api-key[]` (per-provider key entries)
- `request-log`, `request-retry`, `max-retry-interval`, `ws-auth`

Usage/telemetry:

```bash
curl -sS -H "Authorization: Bearer $JUICE_MGMT_KEY" "$JUICE_MGMT_BASE/usage" | jq .usage
```

### Download config snapshot before any changes

```bash
curl -sS -H "Authorization: Bearer $JUICE_MGMT_KEY" \
  "$JUICE_MGMT_BASE/config.yaml" > juice-config.backup.yaml
```

## Making changes (only with explicit user confirmation)

**Default posture:** do not mutate server state unless the user explicitly asks.

When changing config:
1) Backup `GET /config.yaml`
2) Apply a minimal patch to a local copy
3) `PUT /config.yaml`
4) Re-run probes

Potentially destructive endpoints (double-check intent):
- `DELETE /logs`
- `DELETE /auth-files?all=true`
- overwriting `PUT /config.yaml`

See `references/router-for-me-management-api.md` for the endpoint catalog.

## Wiring OpenClaw to Juice / Antigravity

### Juice as a custom OpenClaw provider
Use `models.providers` with `baseUrl` pointing at Juice (usually `.../v1`) and pick `api` based on probe results.

### "Hook into antigravity's Claude Opus"
OpenClaw model ref typically looks like:
- `google-antigravity/claude-opus-4-5-thinking`

If the user wants it as the default model, patch:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "google-antigravity/claude-opus-4-5-thinking",
        fallbacks: ["openai-codex/gpt-5.2"]
      }
    }
  }
}
```

Apply via `gateway config.patch` + restart *only after* the user confirms.
