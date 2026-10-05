#!/usr/bin/env node
/**
 * Colony loop runner — one cycle over every active microagent with a TASK.md.
 *
 * For each member it calls the agent's MCP tool with the agent's standing
 * TASK.md as the prompt, saves the full report to
 * .mikro/loop/reports/cycle-NNN/<agent>.md, appends one journal line to the
 * agent's STATE.md and the colony STATE.md, and commits everything under
 * .mikro/ with a conventional message. Reports-as-commits IS the persistence
 * layer: `mikro mcp` runs do not call saveSession (only the CLI path does —
 * src/cli.ts:486 in the install checkout), so without this runner an MCP
 * agent run leaves no durable trace at all.
 *
 * Boundaries, deliberate:
 *   - Agents are read-only by contract; the runner writes only under .mikro/
 *     and commits only .mikro/ paths. It never touches src/, docs/, README.
 *   - agent-coach PATCH proposals are committed as report text, never
 *     auto-applied. Applying a patch is a reviewed host action.
 *
 * Usage:  node .mikro/loop/run.mjs [--only <agent>[,<agent>]] [--dry-run]
 */
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync,
  existsSync, realpathSync,
} from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = join(ROOT, ".mikro", "agents");
const LOOP_DIR = join(ROOT, ".mikro", "loop");
const REPORTS_DIR = join(LOOP_DIR, "reports");
const PER_CALL_TIMEOUT_MS = 560_000;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? "").split(",").filter(Boolean) : null;

// ── MCP SDK: resolve from the workspace, else from the mikro install ─────────
function mcpSdkRoot() {
  const local = join(ROOT, "node_modules", "@modelcontextprotocol", "sdk");
  if (existsSync(local)) return local;
  const bin = execSync("command -v mikro", { encoding: "utf8" }).trim();
  const cli = realpathSync(bin); // <install>/dist/src/cli.js
  const installRoot = resolve(dirname(cli), "..", "..");
  const shared = join(installRoot, "node_modules", "@modelcontextprotocol", "sdk");
  if (!existsSync(shared)) throw new Error(`MCP SDK not found near ${installRoot}`);
  return shared;
}
const SDK = mcpSdkRoot();
const { Client } = await import(join(SDK, "dist/esm/client/index.js"));
const { StdioClientTransport } = await import(join(SDK, "dist/esm/client/stdio.js"));

// ── env: fold in ~/.mikro/gate-env.sh (export KEY=value lines) ───────────────
const env = { ...process.env };
const gateEnv = join(homedir(), ".mikro", "gate-env.sh");
if (existsSync(gateEnv)) {
  for (const m of readFileSync(gateEnv, "utf8").matchAll(/^export\s+([A-Z0-9_]+)=(.+)$/gm)) {
    env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
  }
}
// cycle-001 lesson: the REPL's 30s default killed agent-coach mid-block.
// 120s covers exclusion-guarded greps with margin; explore-r-style recursion
// would need 600000 (docs/agent-yaml-schema.md), but no member recurses.
env.MIKRO_REPL_TIMEOUT_MS ??= "120000";
// cycle-002 lesson: readme-polish hit the 300s default run deadline once its
// task grew past-report re-verification. 480s stays under the runner's own
// 560s per-call rail (src/mcp/backends/prime.ts primeDeadlineMs).
env.MIKRO_MCP_RUN_TIMEOUT_MS ??= "480000";
// PR #126 review: pin the server's discovery to this colony's agent dir.
// An inherited MIKRO_AGENTS_DIR would REPLACE the default roots entirely
// (src/mcp/agents.ts agentRoots), making every member call an unknown tool
// while the runner still enumerates .mikro/agents locally.
env.MIKRO_AGENTS_DIR = AGENTS_DIR;

// ── members: active agent dirs that carry a TASK.md ─────────────────────────
const members = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !/\.proposed$/i.test(d.name))
  .filter((d) => existsSync(join(AGENTS_DIR, d.name, "TASK.md")))
  .map((d) => d.name)
  .filter((n) => !only || only.includes(n))
  .sort();
if (members.length === 0) {
  console.error("colony: no active agents with a TASK.md — nothing to run");
  process.exit(1);
}

// ── cycle number ────────────────────────────────────────────────────────────
mkdirSync(REPORTS_DIR, { recursive: true });
const prior = readdirSync(REPORTS_DIR)
  .map((n) => /^cycle-(\d+)$/.exec(n)?.[1])
  .filter(Boolean)
  .map(Number);
const cycle = (prior.length ? Math.max(...prior) : -1) + 1;
const cycleName = `cycle-${String(cycle).padStart(3, "0")}`;
const cycleDir = join(REPORTS_DIR, cycleName);
mkdirSync(cycleDir, { recursive: true });
const startedAt = new Date().toISOString();
console.error(`colony: ${cycleName} · members: ${members.join(", ")}${dryRun ? " · DRY RUN" : ""}`);

// ── connect one MCP server for the whole cycle ──────────────────────────────
const transport = new StdioClientTransport({
  command: "mikro",
  args: ["mcp", "--dir", ROOT],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "colony-loop", version: "1" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(d));

// footer: "… · 12 iterations · 27,942 in / 3,087 out · $0.0052 · 42.0s · …"
const FOOTER_RE =
  /(\d+)\s+iterations?\s+·\s+([\d,]+)\s+in\s+\/\s+([\d,]+)\s+out\s+·\s+\$([\d.]+)\s+·\s+([\d.]+)s/;

const rows = [];
for (const name of members) {
  const task = readFileSync(join(AGENTS_DIR, name, "TASK.md"), "utf8").trim();
  // Mirror the server's toToolName() (src/mcp/agents.ts): fold anything
  // outside [a-z0-9_-] to "_" — a raw directory name like "Foo.Bar" is
  // exposed as mikro_foo_bar, not mikro_Foo.Bar (PR #126 review).
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const tool = `mikro_${(cleaned || "agent").slice(0, 96)}`;
  console.error(`colony: → ${tool}`);
  let text = "";
  let isError = false;
  const t0 = Date.now();
  try {
    const res = await client.callTool(
      { name: tool, arguments: { prompt: task } },
      undefined,
      { timeout: PER_CALL_TIMEOUT_MS },
    );
    isError = Boolean(res.isError);
    text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } catch (err) {
    isError = true;
    text = `RUNNER ERROR: ${err?.message ?? err}`;
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  // Take the LAST footer-shaped match: reports may quote footer examples in
  // their body (cycle-003 readme-polish quoted the README's own example and
  // the journal recorded 3 iter / $0.00 instead of 8 / $0.0095 — PR #126).
  const f = [...text.matchAll(new RegExp(FOOTER_RE, "g"))].at(-1);
  const usage = f
    ? { iter: +f[1], tokIn: f[2], tokOut: f[3], cost: +f[4], secs: +f[5] }
    : { iter: null, tokIn: "?", tokOut: "?", cost: 0, secs: +wall };
  const firstLine =
    text.split("\n").map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("```") && !/^FINAL\(/.test(l)) ?? "(empty)";
  rows.push({ name, isError, usage, firstLine });

  const header = [
    `# ${name} — ${cycleName}`,
    "",
    `- when: ${new Date().toISOString()}`,
    `- tool: ${tool} · status: ${isError ? "ERROR" : "ok"} · wall: ${wall}s`,
    "",
    "---",
    "",
  ].join("\n");
  writeFileSync(join(cycleDir, `${name}.md`), header + text + "\n");

  const line = `- ${cycleName} · ${new Date().toISOString().slice(0, 10)} · ${
    usage.iter ?? "?"} iter · $${usage.cost.toFixed(4)} · ${
    isError ? "ERROR — " : ""}${firstLine.slice(0, 140)}\n`;
  appendFileSync(join(AGENTS_DIR, name, "STATE.md"), line);
  console.error(`colony: ← ${name}: ${isError ? "ERROR" : "ok"} · $${usage.cost.toFixed(4)} · ${wall}s`);
}
await client.close();

// ── colony journal ──────────────────────────────────────────────────────────
const total = rows.reduce((s, r) => s + r.usage.cost, 0);
const journal = [
  `## ${cycleName} — ${startedAt}`,
  ...rows.map(
    (r) =>
      `- ${r.name}: ${r.isError ? "ERROR" : "ok"} · ${r.usage.iter ?? "?"} iter · $${r.usage.cost.toFixed(4)} — ${r.firstLine.slice(0, 120)}`,
  ),
  `- total: $${total.toFixed(4)} across ${rows.length} agents`,
  "",
].join("\n");
appendFileSync(join(LOOP_DIR, "STATE.md"), journal + "\n");

// ── commit colony state (scoped to .mikro/) ──────────────────────────────────
if (dryRun) {
  console.error("colony: dry run — skipping commit");
  process.exit(0);
}
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
git("add", ".mikro");
const staged = git("diff", "--cached", "--name-only", "--", ".mikro").trim();
if (!staged) {
  console.error("colony: nothing to commit");
  process.exit(0);
}
const subject = `chore(colony): ${cycleName} — ${rows.length} agents · $${total.toFixed(4)}`;
// commitlint body-max-line-length is 100; prefix + slice(0, 72) stays under
// it (the cycle-003 commit broke CI with full-width verdict lines — PR #126).
const body = rows
  .map((r) => `${r.name}: ${r.isError ? "ERROR" : "ok"} — ${r.firstLine.slice(0, 72)}`)
  .join("\n");
// Pathspec-limited commit: records ONLY .mikro paths even if the caller had
// unrelated work staged, and leaves that other index state untouched
// (PR #126 review; the boundary .mikro/loop/README.md promises).
git("commit", "-m", subject, "-m", body, "--", ".mikro");
console.error(`colony: committed — ${git("log", "--oneline", "-1").trim()}`);
