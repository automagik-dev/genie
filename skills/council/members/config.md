# Council Member Model Configuration

Members are spawned as Agent-tool subagents; the `model` parameter on each member's Agent call selects its model. Omitting the parameter means **inherit** — the member runs on the orchestrator's model.

## Member Defaults

| Member | Default model | Notes |
|--------|---------------|-------|
| questioner | inherit | Challenges need strong reasoning |
| architect | inherit | Systems thinking needs depth |
| simplifier | inherit | Deletion requires confidence |
| benchmarker | inherit | Evidence analysis |
| sentinel | inherit | Security requires precision |
| ergonomist | inherit | DX judgment |
| operator | inherit | Ops reality |
| deployer | inherit | Deploy patterns |
| measurer | inherit | Observability |
| tracer | inherit | Debug depth |

## Overrides

- Set `model` on that member's Agent call (e.g. `opus`, `sonnet`, `haiku`) — per member, per session.
- Mixed-model councils are just per-member overrides: architect on `opus`, benchmarker on `haiku`, rest inherited.
- `haiku` suits fast, cheap councils; keep the questioner on a stronger model — assumption-challenging degrades first.
