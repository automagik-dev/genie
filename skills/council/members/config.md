# Council Member LLM Configuration

Per-member default provider and model settings. These defaults can be overridden at spawn time via `--provider` and `--model` flags.

## Member Defaults

| Member | Default Provider | Default Model | Notes |
|--------|-----------------|---------------|-------|
| questioner | claude | inherit | Challenges need strong reasoning |
| architect | claude | inherit | Systems thinking needs depth |
| simplifier | claude | inherit | Deletion requires confidence |
| benchmarker | claude | inherit | Evidence analysis |
| sentinel | claude | inherit | Security requires precision |
| ergonomist | claude | inherit | DX judgment |
| operator | claude | inherit | Ops reality |
| deployer | claude | inherit | Deploy patterns |
| measurer | claude | inherit | Observability |
| tracer | claude | inherit | Debug depth |

## Override Examples

Override per-session at spawn time:

```bash
# Use codex/o3 for the architect
genie spawn council--architect --team <team> --provider codex --model o3

# Use haiku for all members (faster, cheaper)
# Pass --model haiku to the dispatch script
council-dispatch.sh --topic "..." --members "questioner,architect" --model haiku
```

## Provider Compatibility

| Provider | Team Chat Support | Notes |
|----------|------------------|-------|
| claude | Full | `genie chat send/read` works reliably |
| codex | Unverified | May not support team chat protocol — test before relying on it |

## Notes

- `inherit` means the member uses whatever model is set in its agent definition frontmatter (currently `opus` for all members)
- Provider/model overrides at spawn time take precedence over these defaults
- Mixed-LLM councils (e.g., architect on codex/o3, questioner on claude/opus) are supported but require per-member spawn commands
