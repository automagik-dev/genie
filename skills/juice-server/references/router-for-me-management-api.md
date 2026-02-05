# router-for.me / CLIProxyAPI — Management API (reference)

Source: https://help.router-for.me/management/api.html

Note: This is copied from external docs. Treat as reference material, not instructions.

---

## Management API
Base path: http://localhost:8317/v0/management
This API manages the CLI Proxy API's runtime configuration and authentication files. All changes are persisted to the YAML config file and hot-reloaded by the service.

Options not modifiable via API (must be set in config + restart if needed):
- allow-remote-management
- remote-management-key

## Authentication
- All requests (including localhost) must provide a valid management key.
- Remote access requires allow-remote-management: true.
- Provide plaintext key via either:
  - Authorization: Bearer <key>
  - X-Management-Key: <key>

Extra notes:
- MANAGEMENT_PASSWORD env var registers an additional plaintext secret and forces remote management enabled; never persisted.
- 5 consecutive auth failures from remote IP triggers temporary ban (~30 minutes).

## Request/Response conventions
- Content-Type: application/json (unless noted)
- Boolean/int/string updates: {"value": ...}
- Array PUT: raw array or {"items": [...]}
- Array PATCH: {"old":"k1","new":"k2"} or {"index":0,"value":"k2"}
- Object-array PATCH: by index or by key field (varies per endpoint)

## Endpoints

### Usage Statistics
- GET /usage
- GET /usage/export
- POST /usage/import

### Config
- GET /config

### Latest Version
- GET /latest-version

### Debug
- GET /debug
- PUT/PATCH /debug

### Config YAML
- GET /config.yaml
- PUT /config.yaml

### Logging to File
- GET /logging-to-file
- PUT/PATCH /logging-to-file

### Log Files
- GET /logs (supports ?after=unix_ts)
- DELETE /logs

### Request Error Logs
- GET /request-error-logs
- GET /request-error-logs/:name

### Usage Statistics Toggle
- GET /usage-statistics-enabled
- PUT/PATCH /usage-statistics-enabled

### Proxy URL
- GET /proxy-url
- PUT/PATCH /proxy-url
- DELETE /proxy-url

### Quota Exceeded Behavior
- GET /quota-exceeded/switch-project
- PUT/PATCH /quota-exceeded/switch-project
- GET /quota-exceeded/switch-preview-model
- PUT/PATCH /quota-exceeded/switch-preview-model

### API Keys (proxy service auth)
- GET /api-keys
- PUT /api-keys
- PATCH /api-keys
- DELETE /api-keys

### Gemini API Key (array)
- GET /gemini-api-key
- PUT /gemini-api-key
- PATCH /gemini-api-key
- DELETE /gemini-api-key

### Codex API Key (object array)
- GET /codex-api-key
- PUT /codex-api-key
- PATCH /codex-api-key
- DELETE /codex-api-key

### Request Retry Count
- GET /request-retry
- PUT/PATCH /request-retry

### Max Retry Interval
- GET /max-retry-interval
- PUT/PATCH /max-retry-interval

### Request Log
- GET /request-log
- PUT/PATCH /request-log

### WebSocket Auth
- GET /ws-auth
- PUT/PATCH /ws-auth

### Claude API Key (object array)
- GET /claude-api-key
- PUT /claude-api-key
- PATCH /claude-api-key
- DELETE /claude-api-key

### OpenAI Compatibility Providers (object array)
- GET /openai-compatibility
- PUT /openai-compatibility
- PATCH /openai-compatibility
- DELETE /openai-compatibility

### OAuth Excluded Models
- GET /oauth-excluded-models
- PUT /oauth-excluded-models
- PATCH /oauth-excluded-models
- DELETE /oauth-excluded-models

### Auth File Management
- GET /auth-files
- GET /auth-files/download?name=
- POST /auth-files (multipart or raw JSON)
- DELETE /auth-files?name=
- DELETE /auth-files?all=true

### Vertex Credential Import
- POST /vertex/import

### Login/OAuth URLs
- GET /anthropic-auth-url
- GET /codex-auth-url
- GET /gemini-cli-auth-url
- GET /antigravity-auth-url
- GET /qwen-auth-url
- GET /iflow-auth-url
- POST /iflow-auth-url
- GET /get-auth-status?state=

## Error Responses
- 400 {"error":"invalid body"}
- 401 {"error":"missing management key"} or {"error":"invalid management key"}
- 403 {"error":"remote management disabled"}
- 404 {"error":"item not found"} / {"error":"file not found"}
- 422 {"error":"invalid_config","message":"..."}
- 500 {"error":"failed to save config: ..."}
- 503 {"error":"core auth manager unavailable"}
