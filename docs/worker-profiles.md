# Worker Profiles

Worker profiles configure how genie-cli spawns Claude Code workers. Each profile bundles:
- **Launcher**: `claude` (direct) or `claudio` (via LLM router)
- **Claudio Profile**: Which claudio model routing profile to use (if using claudio)
- **Claude Args**: CLI arguments passed to Claude Code

## Default Profiles

The template config (`templates/genie-config.template.json`) includes these profiles:

| Profile | Launcher | Purpose |
|---------|----------|---------|
| `coding-fast` | claudio | Fast autonomous workers via LLM router (default) |
| `autonomous` | claudio | Opus-level autonomous workers for complex tasks |
| `safe` | claude | Interactive workers with permission prompts |
| `interactive` | claude | Direct claude, no special flags |

## Managing Profiles

### List all profiles
```bash
genie profiles list
```

### Add a new profile
```bash
genie profiles add my-profile
# Interactive prompts for:
# - Launcher (claude or claudio)
# - Claudio profile name (if claudio)
# - Claude args (space-separated)
```

### Show profile details
```bash
genie profiles show coding-fast
```

### Remove a profile
```bash
genie profiles rm my-profile
# Requires confirmation
```

### Set default profile
```bash
genie profiles default coding-fast
```

## Using Profiles

### With term spawn
```bash
term spawn implementor --profile coding-fast
term spawn implementor --profile safe  # For interactive work
```

### With term work
```bash
term work bd-123 --profile autonomous  # Use opus for complex issue
term work bd-123 --profile safe        # Interactive with permissions
```

If no `--profile` flag is provided, the `defaultWorkerProfile` is used.

## Profile Configuration

Profiles are stored in `~/.genie/config.json`:

```json
{
  "workerProfiles": {
    "my-profile": {
      "launcher": "claudio",
      "claudioProfile": "coding-fast",
      "claudeArgs": ["--dangerously-skip-permissions", "--model", "sonnet"]
    }
  },
  "defaultWorkerProfile": "my-profile"
}
```

### Profile Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `launcher` | `"claude"` \| `"claudio"` | Yes | Which binary to invoke |
| `claudioProfile` | string | No | Claudio profile name (required if launcher is claudio) |
| `claudeArgs` | string[] | Yes | Arguments passed to Claude Code |

### Common Claude Args

| Arg | Purpose |
|-----|---------|
| `--dangerously-skip-permissions` | Autonomous mode (no permission prompts) |
| `--permission-mode default` | Standard permission prompts |
| `--permission-mode plan` | Plan mode by default |
| `--model opus` | Use Opus model |
| `--model sonnet` | Use Sonnet model |
| `--allowedTools Read,Grep,Glob` | Restrict to specific tools |

## Claudio Integration

When using `claudio` launcher, the worker goes through your LLM router:

1. Claudio reads its config from `~/.claudio/config.json`
2. Uses the specified `claudioProfile` for model routing
3. Passes `claudeArgs` through to Claude Code

This enables:
- Custom model routing (use different models for opus/sonnet/haiku)
- API URL customization (use local or proxy endpoints)
- Profile-based model selection without changing genie config

## First-Time Setup

Copy the template to get started:

```bash
cp templates/genie-config.template.json ~/.genie/config.json
```

Or run setup which will offer to create default profiles:

```bash
genie setup
```
