# Genie Dev Environment Configuration

Genie Dev relies on a small set of environment variables to steer the CLI, model selection, and self-improvement experiments. Configure these in a local `.env` and load them before running the CLI.

## Conventions
- Names: UPPER_SNAKE_CASE
- Types: string | int (ms) | bool (`0/1` or `true/false`)
- Scope legend: [required], [optional], [experimental]

## Core CLI
- APP_NAME [optional]: defaults to `Genie Dev`
- APP_ENV [optional]: `dev|staging|prod` (default `dev`)
- GENIE_BRANCH [optional]: branch name used for wish/forge guidance (default `genie-dev`)
- LOG_LEVEL [optional]: `trace|debug|info|warn|error` (default `info`)

## Genie Runtime
- GENIE_MODEL [required]: model identifier used by agents (e.g., `gpt-5`)
- GENIE_APPROVAL_POLICY [optional]: `on-request|on-failure|never|untrusted` (default approval behavior)
- GENIE_SANDBOX_MODE [optional]: `workspace-write|read-only|danger-full-access` (default sandbox mode)
- GENIE_CLI_STYLE [optional]: `plain|compact|art` (default `compact`)

Note: Agent-specific sandbox and approval settings in frontmatter override these defaults.

## Provider Credentials
- OPENAI_API_KEY or ALTERNATE_PROVIDER_KEY [required]: API key for the LLM provider
- PROVIDER_ENDPOINT [optional]: override base URL when pointing at non-default gateways
- PROVIDER_REGION [optional]: specify regional routing if required by service policy

## Experiment Toggles
- ENABLE_SELF_LEARN_SYNC [optional]: `0|1` (default `1`) — when disabled, self-learn updates are reported but not auto-applied
- ENABLE_TWIN_DEFAULT [optional]: `0|1` (default `0`) — automatically schedule twin audits for high-risk wishes
- DONE_REPORT_DIR [optional]: overrides `.genie/wishes/<slug>/reports/` when storing experiment evidence elsewhere

## Safety Limits
- MAX_CONCURRENT_AGENTS [optional]: limit parallel CLI sessions (default `5`)
- SESSION_TIMEOUT_SECONDS [optional]: auto-stop background sessions after N seconds (default `3600`)
- RATE_LIMIT_RPS [optional]: throttles outbound provider calls (default `60`)

## Example .env (development)
```env
APP_NAME="Genie Dev"
APP_ENV=dev
GENIE_BRANCH=genie-dev
LOG_LEVEL=debug

GENIE_MODEL=gpt-5
GENIE_APPROVAL_POLICY=on-request
GENIE_SANDBOX_MODE=workspace-write
GENIE_CLI_STYLE=compact

OPENAI_API_KEY=replace_me
ENABLE_SELF_LEARN_SYNC=1
ENABLE_TWIN_DEFAULT=0
MAX_CONCURRENT_AGENTS=5
SESSION_TIMEOUT_SECONDS=3600
```

## Notes
- Never commit real API keys or secrets; rely on `.env` files and secret managers
- Keep experimental toggles disabled by default when preparing release candidates for downstream repos
- Align CLI harness configuration with the approval policy documented in active wishes to avoid mismatched expectations
