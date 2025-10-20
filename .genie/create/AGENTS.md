# Create Collective
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

The Create collective curates content-focused agents (wish authoring, discovery, blueprinting). Agents live under the `agents/` directory; supporting docs in this folder provide their shared knowledge base.

## Layout

- `agents/` — create-oriented agents (wish, blueprint, requirements, etc.)
- `*.md` — contextual docs that agents auto-load when orchestrating wish → forge → review

Collectives with this marker behave as first-class agent sources. If you add a new collective, include an `AGENTS.md` at the root so tooling picks it up automatically.
