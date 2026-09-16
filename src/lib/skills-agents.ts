/**
 * Genie's mirror of the skills.sh 1.5.23 agent registry — the table that lets
 * `genie install`/`genie update` name the agents it installs to EXPLICITLY.
 *
 * Why this exists (r2 §3.2 B / M3): the production argv used to be `--all`,
 * which the pinned CLI expands to `--agent '*'`, i.e. every agent in its
 * registry whether or not the product is installed. On the 2026-09-01 dogfood
 * host that materialized ~53 product homes that did not exist — `~/.openclaw`,
 * `~/.adal`, `~/.qwen`, … — each holding nothing but genie-written skills, and
 * recorded all of them in `agentDirs`. Genie must never create a product home.
 *
 * The table is derived from `agents` in skills@1.5.23 `dist/cli.mjs`:
 *   - `roots`  — the paths that agent's own `detectInstalled()` probes, minus
 *     the project-relative (`process.cwd()`) and platform (`/Applications`,
 *     `%APPDATA%`) clauses. Dropping those makes genie's detection NARROWER
 *     than the CLI's, which is the safe direction: an undetected agent is an
 *     agent genie does not write to.
 *   - `skills` — where a GLOBAL (`-g`) install lands, applying the CLI's own
 *     `isUniversalAgent` rule: an agent whose `skillsDir` is `.agents/skills`
 *     resolves to the canonical `~/.agents/skills`, NOT to its `globalSkillsDir`
 *     field (see `getAgentBaseDir`). `~/.agents` is the shared canonical home
 *     Codex reads; it is not a product home.
 *
 * Agents with no global skills home (`eve`), no home-relative detection
 * (`replit`, `promptscript`) or no detection at all (`universal`) are
 * deliberately absent: genie can never prove those are installed, so it never
 * names them.
 *
 * Environment overrides the CLI honours (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
 * `HERMES_HOME`, …) are deliberately NOT mirrored: they can only make genie's
 * detection narrower, and a relocated home that genie already wrote to stays
 * selected through the previous record.
 */

import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface SkillsCliAgentSpec {
  /** The `--agent` name, exactly as the pinned CLI's registry keys it. */
  readonly agent: string;
  /** Home-relative product roots; the agent counts as installed if any exists. */
  readonly roots: readonly (readonly string[])[];
  /** Home-relative global skills home a `-g` install writes. */
  readonly skills: readonly string[];
}

/** The mirrored registry, in the pinned CLI's own order. */
export const SKILLS_CLI_AGENTS: readonly SkillsCliAgentSpec[] = [
  { agent: 'aider-desk', roots: [['.aider-desk']], skills: ['.aider-desk', 'skills'] },
  { agent: 'amp', roots: [['.config', 'amp']], skills: ['.agents', 'skills'] },
  { agent: 'antigravity', roots: [['.gemini', 'antigravity']], skills: ['.agents', 'skills'] },
  { agent: 'antigravity-cli', roots: [['.gemini', 'antigravity-cli']], skills: ['.agents', 'skills'] },
  { agent: 'astrbot', roots: [['.astrbot']], skills: ['.astrbot', 'data', 'skills'] },
  { agent: 'autohand-code', roots: [['.autohand']], skills: ['.autohand', 'skills'] },
  { agent: 'augment', roots: [['.augment']], skills: ['.augment', 'skills'] },
  { agent: 'bob', roots: [['.bob']], skills: ['.bob', 'skills'] },
  { agent: 'claude-code', roots: [['.claude']], skills: ['.claude', 'skills'] },
  { agent: 'openclaw', roots: [['.openclaw'], ['.clawdbot'], ['.moltbot']], skills: ['.openclaw', 'skills'] },
  { agent: 'cline', roots: [['.cline']], skills: ['.agents', 'skills'] },
  { agent: 'codearts-agent', roots: [['.codeartsdoer']], skills: ['.codeartsdoer', 'skills'] },
  { agent: 'codebuddy', roots: [['.codebuddy']], skills: ['.codebuddy', 'skills'] },
  { agent: 'codemaker', roots: [['.codemaker']], skills: ['.codemaker', 'skills'] },
  { agent: 'codestudio', roots: [['.codestudio']], skills: ['.codestudio', 'skills'] },
  { agent: 'codex', roots: [['.codex']], skills: ['.agents', 'skills'] },
  { agent: 'command-code', roots: [['.commandcode']], skills: ['.commandcode', 'skills'] },
  { agent: 'continue', roots: [['.continue']], skills: ['.continue', 'skills'] },
  { agent: 'cortex', roots: [['.snowflake', 'cortex']], skills: ['.snowflake', 'cortex', 'skills'] },
  { agent: 'crush', roots: [['.config', 'crush']], skills: ['.config', 'crush', 'skills'] },
  { agent: 'cursor', roots: [['.cursor']], skills: ['.agents', 'skills'] },
  { agent: 'deepagents', roots: [['.deepagents']], skills: ['.agents', 'skills'] },
  { agent: 'devin', roots: [['.config', 'devin']], skills: ['.config', 'devin', 'skills'] },
  { agent: 'dexto', roots: [['.dexto']], skills: ['.agents', 'skills'] },
  { agent: 'droid', roots: [['.factory']], skills: ['.factory', 'skills'] },
  { agent: 'firebender', roots: [['.firebender']], skills: ['.agents', 'skills'] },
  { agent: 'forgecode', roots: [['.forge']], skills: ['.forge', 'skills'] },
  { agent: 'gemini-cli', roots: [['.gemini']], skills: ['.agents', 'skills'] },
  { agent: 'github-copilot', roots: [['.copilot']], skills: ['.agents', 'skills'] },
  { agent: 'goose', roots: [['.config', 'goose']], skills: ['.config', 'goose', 'skills'] },
  { agent: 'grok', roots: [['.grok']], skills: ['.grok', 'skills'] },
  { agent: 'hermes-agent', roots: [['.hermes']], skills: ['.hermes', 'skills'] },
  { agent: 'inference-sh', roots: [['.inferencesh']], skills: ['.inferencesh', 'skills'] },
  { agent: 'jazz', roots: [['.jazz']], skills: ['.jazz', 'skills'] },
  { agent: 'junie', roots: [['.junie']], skills: ['.junie', 'skills'] },
  { agent: 'iflow-cli', roots: [['.iflow']], skills: ['.iflow', 'skills'] },
  { agent: 'kilo', roots: [['.kilocode']], skills: ['.kilocode', 'skills'] },
  { agent: 'kimchi', roots: [['.config', 'kimchi']], skills: ['.config', 'kimchi', 'harness', 'skills'] },
  { agent: 'kimi-code-cli', roots: [['.kimi-code'], ['.kimi']], skills: ['.agents', 'skills'] },
  { agent: 'kiro-cli', roots: [['.kiro']], skills: ['.kiro', 'skills'] },
  { agent: 'kode', roots: [['.kode']], skills: ['.kode', 'skills'] },
  { agent: 'lingma', roots: [['.lingma']], skills: ['.lingma', 'skills'] },
  { agent: 'loaf', roots: [['.loaf']], skills: ['.agents', 'skills'] },
  { agent: 'mcpjam', roots: [['.mcpjam']], skills: ['.mcpjam', 'skills'] },
  { agent: 'minimax-code', roots: [['.minimax']], skills: ['.minimax', 'skills'] },
  { agent: 'mistral-vibe', roots: [['.vibe']], skills: ['.vibe', 'skills'] },
  { agent: 'moxby', roots: [['.moxby']], skills: ['.moxby', 'skills'] },
  { agent: 'mux', roots: [['.mux']], skills: ['.mux', 'skills'] },
  { agent: 'opencode', roots: [['.config', 'opencode']], skills: ['.agents', 'skills'] },
  { agent: 'openhands', roots: [['.openhands']], skills: ['.openhands', 'skills'] },
  { agent: 'ona', roots: [['.ona']], skills: ['.ona', 'skills'] },
  { agent: 'pi', roots: [['.pi', 'agent']], skills: ['.pi', 'agent', 'skills'] },
  {
    agent: 'posit-assistant',
    roots: [['.posit', 'assistant'], ['.positai']],
    skills: ['.posit', 'assistant', 'skills'],
  },
  { agent: 'qoder', roots: [['.qoder']], skills: ['.qoder', 'skills'] },
  { agent: 'qoder-cn', roots: [['.qoder-cn']], skills: ['.qoder-cn', 'skills'] },
  { agent: 'qwen-code', roots: [['.qwen']], skills: ['.qwen', 'skills'] },
  { agent: 'reasonix', roots: [['.reasonix']], skills: ['.reasonix', 'skills'] },
  { agent: 'rovodev', roots: [['.rovodev']], skills: ['.rovodev', 'skills'] },
  { agent: 'roo', roots: [['.roo']], skills: ['.roo', 'skills'] },
  { agent: 'tabnine-cli', roots: [['.tabnine']], skills: ['.tabnine', 'agent', 'skills'] },
  { agent: 'terramind', roots: [['.terramind']], skills: ['.terramind', 'skills'] },
  { agent: 'tinycloud', roots: [['.tinycloud']], skills: ['.tinycloud', 'skills'] },
  { agent: 'trae', roots: [['.trae']], skills: ['.trae', 'skills'] },
  { agent: 'trae-cn', roots: [['.trae-cn']], skills: ['.trae-cn', 'skills'] },
  { agent: 'warp', roots: [['.warp']], skills: ['.agents', 'skills'] },
  { agent: 'windsurf', roots: [['.codeium', 'windsurf']], skills: ['.codeium', 'windsurf', 'skills'] },
  // `detectInstalled` probes `$XDG_CONFIG_HOME/zed` (default `~/.config/zed`)
  // plus two platform app-data roots; only the home-relative clause is mirrored.
  { agent: 'zed', roots: [['.config', 'zed']], skills: ['.agents', 'skills'] },
  { agent: 'zcode', roots: [['.zcode']], skills: ['.zcode', 'skills'] },
  { agent: 'zencoder', roots: [['.zencoder']], skills: ['.zencoder', 'skills'] },
  { agent: 'zenflow', roots: [['.zencoder']], skills: ['.zencoder', 'skills'] },
  { agent: 'neovate', roots: [['.neovate']], skills: ['.neovate', 'skills'] },
  { agent: 'pochi', roots: [['.pochi']], skills: ['.pochi', 'skills'] },
  { agent: 'adal', roots: [['.adal']], skills: ['.adal', 'skills'] },
];

/** Absolute global skills home this agent writes under `home`. */
export function agentSkillsHome(home: string, spec: SkillsCliAgentSpec): string {
  return join(home, ...spec.skills);
}

/** True when any of the agent's product roots exists under `home`. */
export function agentProductInstalled(home: string, spec: SkillsCliAgentSpec): boolean {
  return spec.roots.some((segments) => existsSync(join(home, ...segments)));
}

export interface SkillsAgentSelection {
  /** `--agent` names, in registry order. */
  agents: string[];
  /** The global skills homes those agents write, deduplicated. */
  homes: string[];
  /** Agents selected only because the previous record already names their home. */
  recordedOnly: string[];
}

/**
 * The agents a run may install to: every agent whose product root exists right
 * now, plus every agent whose global skills home the previous record already
 * lists (so an install genie made before the product root vanished — or before
 * this table knew the product — is still refreshed and stays removable).
 *
 * An empty result is a legitimate answer on a host with no agent installed; the
 * caller skips the channel rather than inventing a home.
 */
export function selectSkillsCliAgents(options: {
  home: string;
  recordedDirs?: readonly string[];
}): SkillsAgentSelection {
  const recorded = new Set(options.recordedDirs ?? []);
  const agents: string[] = [];
  const recordedOnly: string[] = [];
  const homes: string[] = [];
  for (const spec of SKILLS_CLI_AGENTS) {
    const skillsHome = agentSkillsHome(options.home, spec);
    const detected = agentProductInstalled(options.home, spec);
    if (!detected && !recorded.has(skillsHome)) continue;
    agents.push(spec.agent);
    if (!detected) recordedOnly.push(spec.agent);
    if (!homes.includes(skillsHome)) homes.push(skillsHome);
  }
  return { agents, homes, recordedOnly };
}

/**
 * Every declared product root of every agent that reads `agentDir`, absolute.
 *
 * The prune uses it to find where an agent's OWN evidence would live: under an
 * explicit-agent record genie never created those roots (it names only detected
 * products), so a root on the skills dir's own ancestor chain is the boundary
 * the handback must stop below.
 */
export function agentDetectionRoots(home: string, agentDir: string): string[] {
  const roots: string[] = [];
  for (const spec of SKILLS_CLI_AGENTS) {
    if (agentSkillsHome(home, spec) !== agentDir) continue;
    for (const segments of spec.roots) {
      const root = join(home, ...segments);
      if (!roots.includes(root)) roots.push(root);
    }
  }
  return roots;
}

/**
 * True when some agent that reads `agentDir` is proven installed by evidence
 * that is NOT on `chainRoot`'s single-entry ancestor chain.
 *
 * This is the guard that keeps the genie-created-home prune honest, and
 * `chainRoot` is what makes it correct. A product root genie itself created
 * makes its own agent look "installed" (`~/.openclaw` exists BECAUSE genie
 * wrote `~/.openclaw/skills`), so self-detection proves nothing and is
 * excluded. Passing only the skills dir's PARENT excluded too little: for
 * `~/.astrbot/data/skills` the parent is `~/.astrbot/data`, so the genie-made
 * `~/.astrbot` above it read as independent evidence and the whole phantom
 * chain was kept forever (r3, D2). The chain root covers every directory that
 * exists only because the skills dir does; evidence elsewhere is real —
 * `~/.codex`, outside the `~/.agents` chain, proves Codex reads the shared
 * canonical home, so that home is never handed back.
 */
export function agentHomeIsIndependentlyDetected(home: string, agentDir: string, chainRoot: string): boolean {
  const inside = (path: string): boolean => path === chainRoot || path.startsWith(`${chainRoot}${sep}`);
  for (const root of agentDetectionRoots(home, agentDir)) {
    if (!inside(root) && existsSync(root)) return true;
  }
  return false;
}
