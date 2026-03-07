# Worker Profiles

Worker profiles configure how genie-cli spawns Claude Code workers. Each profile bundles:
- **Launcher**: `claude` (direct Claude Code invocation)
- **Claude Args**: CLI arguments passed to Claude Code

## Default Profiles

The template config (`templates/genie-config.template.json`) includes these profiles:

| Profile | Launcher | Purpose |
|---------|----------|---------|
| `coding-fast` | claude | Fast autonomous workers (default) |
| `autonomous` | claude | Opus-level autonomous workers for complex tasks |
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

### With genie worker spawn
```bash
genie worker spawn --role implementor --profile coding-fast
genie worker spawn --role implementor --profile safe  # For interactive work
```

### With genie work
```bash
genie work bd-123 --profile autonomous  # Use opus for complex issue
genie work bd-123 --profile safe        # Interactive with permissions
```

If no `--profile` flag is provided, the `defaultWorkerProfile` is used.

## Profile Configuration

Profiles are stored in `~/.genie/config.json`:

```json
{
  "workerProfiles": {
    "my-profile": {
      "launcher": "claude",
      "claudeArgs": ["--dangerously-skip-permissions", "--model", "sonnet"]
    }
  },
  "defaultWorkerProfile": "my-profile"
}
```

### Profile Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `launcher` | `"claude"` | Yes | Which binary to invoke |
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

## First-Time Setup

Copy the template to get started:

```bash
cp templates/genie-config.template.json ~/.genie/config.json
```

Or run setup which will offer to create default profiles:

```bash
genie setup
```
