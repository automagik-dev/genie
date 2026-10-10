/**
 * Microagent discovery for `mikro mcp`.
 *
 * A "microagent" is an existing `agent.yaml` folder (see
 * `docs/agent-yaml-schema.md`). This module finds them on disk and turns each
 * into a description an MCP client can render as a callable tool, so a host
 * like Claude Code sees `mikro_test_writer` rather than one opaque escape
 * hatch.
 *
 * Discovery roots, lowest precedence first — a later root wins on name
 * collision, so a project can shadow a global agent:
 *
 *   1. ~/.mikro/agents/<name>/agent.yaml     (global)
 *   2. <cwd>/.agents/<name>/agent.yaml      (project, the documented convention)
 *   3. <cwd>/.mikro/agents/<name>/agent.yaml (project)
 *
 * `MIKRO_AGENTS_DIR` (colon-separated) replaces the defaults entirely
 * (`RLMX_AGENTS_DIR` is honoured as a legacy alias).
 *
 * Pre-rename `.rlmx/agents` roots are still scanned, at lower precedence than
 * their `.mikro` counterparts, so an unmigrated checkout keeps its agents.
 *
 * One name is reserved: a directory whose name ends `.proposed` is a draft
 * awaiting human approval and is skipped everywhere — see `PROPOSED_SUFFIX`.
 */
import { type ValidateConfig } from "../config.js";
import { type AgentSpec } from "../sdk/agent-spec.js";
/** A discovered microagent, ready to be exposed as one MCP tool. */
export interface Microagent {
    /** Directory name on disk — the human identity. */
    readonly name: string;
    /** MCP tool name: `mikro_<sanitized name>`. */
    readonly toolName: string;
    /** Absolute path to the agent directory. */
    readonly dir: string;
    readonly spec: AgentSpec;
    /** Contents of the agent's system prompt, if `system:` pointed at a file. */
    readonly system?: string;
    /** First non-empty line of the system prompt — used as the tool description. */
    readonly summary: string;
    /**
     * Cause and remedy when discovery proves this agent cannot run. The tool is
     * still advertised so the host can explain how to repair it, but every call
     * is refused before starting a doomed run.
     */
    readonly unavailable?: string;
    /**
     * The agent's own `VALIDATE.md` contract, when it ships one.
     *
     * Loaded by *convention* — `<agentdir>/VALIDATE.md`, no `agent.yaml` key —
     * for the same reason `SYSTEM.md` is the conventional name: a pack is a
     * directory of well-known files, and a key that could only ever hold one
     * value is a key worth not having. Absent or unparseable is the same
     * `undefined`; see `loadValidateMd`.
     */
    readonly validate?: ValidateConfig;
}
/**
 * Reserved directory suffix for propose-only drafts.
 *
 * `/microagent-create` writes a candidate agent it mined from transcripts into
 * `.mikro/agents/<name>.proposed/` and stops there. Activation is a rename, and
 * the rename is the user's — that is the whole approval step, so it only means
 * something if an un-renamed draft can do nothing at all.
 */
export declare const PROPOSED_SUFFIX = ".proposed";
/**
 * True when a directory name is a propose-only draft rather than an agent.
 *
 * Matched case-insensitively on purpose. The comparison decides whether an
 * unapproved agent can execute, so it fails toward *not* running: `X.Proposed`
 * is skipped like `x.proposed`. The cost of that choice is that `.proposed` is
 * reserved in every casing — documented in the plugin skill and in the wish's
 * risk table, because the skip's error surface is silence by design.
 */
export declare function isProposedDir(name: string): boolean;
/**
 * MCP tool names must match `^[a-zA-Z0-9_-]{1,128}$`. Directory names are
 * looser than that, so fold anything else to `_`.
 */
export declare function toToolName(agentName: string): string;
/** Discovery roots in precedence order (later wins). */
export declare function agentRoots(cwd: string): string[];
/**
 * Scan every root and return the discovered microagents, de-duplicated by
 * agent name with later roots winning.
 */
export declare function discoverAgents(cwd: string): Promise<Microagent[]>;
/**
 * Split an `agent.yaml` model string (`"<provider>/<model>"`) into its parts.
 * Returns null when the string has no provider prefix, in which case the
 * caller should keep the ambient configured provider.
 */
export declare function splitModel(value: string): {
    provider: string;
    model: string;
} | null;
//# sourceMappingURL=agents.d.ts.map