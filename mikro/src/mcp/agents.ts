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

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadValidateMd, parseModelRef, type ValidateConfig } from "../config.js";
import { loadAgentSpec, resolveAgentPath, type AgentSpec } from "../sdk/agent-spec.js";

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
export const PROPOSED_SUFFIX = ".proposed";

/**
 * True when a directory name is a propose-only draft rather than an agent.
 *
 * Matched case-insensitively on purpose. The comparison decides whether an
 * unapproved agent can execute, so it fails toward *not* running: `X.Proposed`
 * is skipped like `x.proposed`. The cost of that choice is that `.proposed` is
 * reserved in every casing — documented in the plugin skill and in the wish's
 * risk table, because the skip's error surface is silence by design.
 */
export function isProposedDir(name: string): boolean {
  return name.toLowerCase().endsWith(PROPOSED_SUFFIX);
}

/**
 * MCP tool names must match `^[a-zA-Z0-9_-]{1,128}$`. Directory names are
 * looser than that, so fold anything else to `_`.
 */
export function toToolName(agentName: string): string {
  const cleaned = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // `mikro_` prefix + a non-empty remainder, capped well under the 128 limit.
  return `mikro_${(cleaned || "agent").slice(0, 96)}`;
}

/** Discovery roots in precedence order (later wins). */
export function agentRoots(cwd: string): string[] {
  const override = (process.env.MIKRO_AGENTS_DIR ?? process.env.RLMX_AGENTS_DIR)?.trim();
  if (override) {
    return override
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return [
    join(homedir(), ".rlmx", "agents"),
    join(homedir(), ".mikro", "agents"),
    join(cwd, ".agents"),
    join(cwd, ".rlmx", "agents"),
    join(cwd, ".mikro", "agents"),
  ];
}

/**
 * Derive a one-line tool description. Prefers the agent's own
 * `description:` extra, then the first meaningful line of its system prompt,
 * then a generic fallback — an MCP client shows this to the model, so an
 * empty description makes the agent effectively invisible.
 */
function deriveSummary(
  name: string,
  spec: AgentSpec,
  system: string | undefined
): string {
  const described = spec.extras.description;
  if (typeof described === "string" && described.trim()) {
    return described.trim();
  }

  if (system) {
    for (const rawLine of system.split("\n")) {
      const line = rawLine.replace(/^#+\s*/, "").trim();
      // Skip headings that are just the agent's own name, and empty lines.
      if (!line) continue;
      if (line.toLowerCase() === name.toLowerCase()) continue;
      return line.length > 300 ? `${line.slice(0, 297)}...` : line;
    }
  }

  return `mikro microagent "${name}" (${spec.shape})`;
}

/**
 * Directories already reported as broken.
 *
 * Discovery re-runs on every request, so without this a single malformed
 * agent.yaml would repeat its warning for the lifetime of the server.
 */
const reportedBroken = new Set<string>();

/** True when the error is "there is no agent.yaml here" rather than "it is bad". */
function isMissingFile(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

async function loadOne(dir: string, name: string): Promise<Microagent | null> {
  let spec: AgentSpec;
  try {
    spec = await loadAgentSpec(dir);
  } catch (err) {
    // Not an agent folder, or an unreadable/invalid agent.yaml. Skipping is
    // correct here: one broken agent must not take down the whole server.
    //
    // Staying *silent* about it is not correct, though. Every validation the
    // parser performs — `shape`, `thinking` — lands in this catch, so a single
    // mistyped level made the agent vanish from tools/list with no error
    // anywhere: the clear message `parseAgentSpec` raises never reached a
    // human. So distinguish the two cases. A missing agent.yaml is the normal
    // "this directory is not an agent" and stays quiet; anything else means an
    // agent.yaml exists and is invalid, which is worth one line on stderr.
    // stderr, not stdout: stdout is the MCP transport's framed JSON-RPC.
    if (!isMissingFile(err) && !reportedBroken.has(dir)) {
      reportedBroken.add(dir);
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`mikro: skipping agent "${name}" (${dir}): ${reason}\n`);
    }
    return null;
  }

  let system: string | undefined;
  if (spec.systemPath) {
    try {
      system = await readFile(resolveAgentPath(spec, spec.systemPath), "utf-8");
    } catch {
      // A dangling system: pointer is not fatal — the agent still runs with
      // the ambient config's system prompt.
      system = undefined;
    }
  }

  // By convention, next to agent.yaml — nothing in the spec points at it.
  const validate = await loadValidateMd(join(dir, "VALIDATE.md"));

  return {
    name,
    toolName: toToolName(name),
    dir,
    spec,
    system,
    summary: deriveSummary(name, spec, system),
    ...(validate ? { validate } : {}),
  };
}

/**
 * Scan every root and return the discovered microagents, de-duplicated by
 * agent name with later roots winning.
 */
export async function discoverAgents(cwd: string): Promise<Microagent[]> {
  const byName = new Map<string, Microagent>();

  for (const root of agentRoots(cwd)) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // Root does not exist — normal.
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // The propose-only boundary. Skipping here — before the spec is even
      // read — keeps a draft out of BOTH answers at once: `tools/call`
      // dispatches from `byToolName`, which is built from this same list
      // (src/mcp/server.ts:252, src/mcp/server.ts:771), so "not listed" and
      // "not callable" cannot drift apart. Without it a perfectly valid
      // `x.proposed/agent.yaml` becomes the live tool `mikro_x_proposed` on the
      // very next request, since every request re-scans: an agent nobody
      // approved would be executable with no user action at all.
      if (isProposedDir(entry.name)) continue;
      const agent = await loadOne(join(root, entry.name), entry.name);
      if (agent) byName.set(agent.name, agent);
    }
  }

  // Stable ordering so the tool list does not shuffle between restarts.
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Split an `agent.yaml` model string (`"<provider>/<model>"`) into its parts.
 * Returns null when the string has no provider prefix, in which case the
 * caller should keep the ambient configured provider.
 */
export function splitModel(
  value: string
): { provider: string; model: string } | null {
  return parseModelRef(value);
}
