## Agent Front Matter & Forge Configuration

Every agent lives in a collective directory that includes an `AGENTS.md` marker and an `agents/` folder. The **agent identifier** is derived from its file path inside that folder, e.g. `.genie/code/agents/review.md` → `code/review`. If an agent sits at the workspace root (`.genie/agents/review.md`) it keeps the simple id `review`. Rename or relocate the markdown file to change the id—no extra metadata is required.

### Defaults

If an agent’s front matter omits a `genie` block, the CLI and MCP server use the defaults from `.genie/config.yaml`:

```yaml
defaults:
  executor: opencode        # maps to Forge executor key
  variant: DEFAULT          # maps to Forge executor profile variant
```

That means most agents can stay minimal:

```markdown
---
name: analyze
description: Discovery + risk triage
---
```

### Overriding Forge execution per agent

To specialize the executor or variant, add a `genie` section for orchestration settings and a `forge` section for executor-specific configuration. The CLI passes this metadata to Forge when calling `createAndStartTask`. Both blocks are optional.

```yaml
---
name: review
description: Evidence-based QA
genie:
  executor: opencode          # Orchestration: which executor to invoke
  variant: REVIEW_STRICT_EVIDENCE  # Orchestration: which profile variant
  background: true            # Orchestration: run in isolated worktree
forge:
  model: sonnet               # Executor config: passed to Forge as-is
  dangerously_skip_permissions: false
---
```

#### Supported keys

**`genie.*` namespace (Orchestration):**

| Key | Purpose | Forge mapping |
| --- | --- | --- |
| `executor` | Logical executor name (`CLAUDE_CODE`, `OPENCODE`, `CODEX`, …). Case-insensitive. | Translated to Forge `executor_profile_id.executor`. |
| `variant` | Profile variant (e.g. `DEFAULT`, `REVIEW_STRICT_EVIDENCE`, `DOCGEN_MEDIUM`). | Translated to Forge `executor_profile_id.variant`. |
| `background` | Set to `false` to force foreground streaming (rare). Default: `true`. | Affects CLI behaviour only (worktree isolation). |

**`forge.*` namespace (Executor Configuration):**

Genie passes `forge.*` fields directly to Forge without validation. Forge validates against executor-specific schemas. Common fields:

| Key | Executors | Purpose |
| --- | --- | --- |
| `model` | All | Model name (e.g. `sonnet`, `opus`, `haiku`) |
| `dangerously_skip_permissions` | All | Skip permission checks (use with caution) |
| `sandbox` | CODEX | Sandbox mode (`auto`, `write`, `workspace-write`) |
| `append_prompt` | CLAUDE_CODE | Additional prompt text appended to agent prompt |
| `claude_code_router` | CLAUDE_CODE | Enable Claude Code routing behavior |
| `additional_params` | OPENCODE, CODEX | Array of key-value parameters |

See Forge executor schemas for complete field reference: `automagik-forge/shared/schemas/*.json`

### Precedence

When a run starts, Genie applies overrides in this order:

1. Workspace defaults in `.genie/config.yaml`
2. Agent front matter (`genie.executor`, `genie.variant`, `forge.model`)
3. CLI flags at call-time (`genie run … --executor <id> --model <name>`)

The last value wins. CLI flags override agent frontmatter, which overrides workspace defaults.

### Discovering available Forge options

1. **Inspect Forge executor schemas**
   Check `automagik-forge/shared/schemas/*.json` for complete field definitions per executor. Each schema defines valid `forge.*` fields for that executor.

2. **Inspect Forge UI**
   The Automagik Forge UI exposes executor configurations under *Settings → Coding Agent Configurations*. Each field shown there can be set in agent `forge.*` frontmatter.

3. **Use agent frontmatter**
   Define executor-specific settings directly in agent frontmatter:

   ```yaml
   ---
   name: docgen
   genie:
     executor: OPENCODE
     variant: DOCGEN_DOCFIRST
   forge:
     append_prompt: |
       Prefer docstrings and API comments; avoid logic changes.
     additional_params:
       - { key: doc_mode, value: doc-first }
   ---
   ```

   Forge discovers `.genie/` folders natively and reads agent frontmatter directly.

### Quick checklist when creating a new agent

1. Place the markdown file in the correct collective (`.genie/<collective>/agents/`).
2. Keep identifiers simple. If you want the CLI id `analyze`, put the file under `.genie/agents/`; if you need `code/analyze`, move it under `.genie/code/agents/`.
3. Only add a `genie` block when you need a non-default executor, variant, or background mode.
4. Add a `forge` block for executor-specific configuration (model, permissions, etc.).
5. Run `pnpm run build:genie` so the CLI picks up changes, then `genie list agents` to verify the new id shows up.
