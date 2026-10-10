#!/usr/bin/env node
/**
 * scan-transcripts.mjs — the measurement half of `/mikro:microagent-create`.
 *
 * Reads recent Claude Code transcripts (`~/.claude/projects/**\/*.jsonl`) and
 * reports where this host's context actually went, bucketed into offload
 * families. The skill's judgement half then picks a candidate from the top of
 * that ranking and writes a `.proposed/` draft.
 *
 * Why a script and not "read the transcripts": the transcripts are ~100 MB a
 * day on an active machine. Reading them into a session to find out what is
 * burning the session's context would be the joke telling itself. This streams
 * them line by line and returns roughly a page.
 *
 * Two kinds of number come out, and they are labelled differently on purpose —
 * do not blur them when writing EVIDENCE.md:
 *
 *   MEASURED  — read verbatim from each assistant turn's `usage` block
 *               (output_tokens, cache_creation_input_tokens,
 *               cache_read_input_tokens). These are the API's own counts.
 *   ESTIMATED — context returned by tool results, counted in characters and
 *               divided by 4 to approximate tokens. Characters are exact; the
 *               ÷4 is a convention, so these are printed with `~`.
 *
 * Usage:
 *   node scan-transcripts.mjs [--hours 24] [--top 8] [--json] [--min-calls 5]
 *                             [--root <dir>] [--project <substring>]
 *   node scan-transcripts.mjs --explain git-history [--examples 12]
 *
 * `--explain <family>` drills into one family and prints every example with a
 * `<transcript>:<line>` reference. Those references are what EVIDENCE.md
 * cites: a claim about token burn that nobody can open is just an assertion.
 *
 * Exit codes: 0 on success (even with no candidates), 1 on unreadable root.
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const HOURS = Number(flag("hours", 24));
const TOP = Number(flag("top", 8));
const MIN_CALLS = Number(flag("min-calls", 5));
const AS_JSON = has("json");
const ROOT = flag("root", join(homedir(), ".claude", "projects"));
const PROJECT = flag("project", "");
const EXPLAIN = flag("explain", "");
const EXAMPLES = Number(flag("examples", 12));
const OPTIMIZER_DIR = join(homedir(), ".claude", "token-optimizer");

const cutoff = Date.now() - HOURS * 3600_000;

/**
 * Shell that changes something. Checked against every Bash command before it
 * is allowed into an *offloadable* family, because agents write compound
 * commands: `git diff HEAD && git add -A` reads and then writes, and a family
 * labelled read-only has to mean it. Erring toward "side-effecting" only ever
 * shrinks the candidate list, which is the safe direction for a claim.
 *
 * The last alternative is redirection to a file: `cmd > f`, `cmd >>f`, and the
 * usual `cmd > "$D"` with a space on both sides — that space is the common
 * form, so the character class before `>` must *allow* whitespace. What it
 * excludes is everything that looks like a redirect but writes no file:
 *
 *   `2>&1`, `2>/dev/null`, `1>&2`  — an fd number before `>` (digit excluded)
 *   `>&1`                          — the target is `&`
 *   `&>log`                        — `&` before `>`, kept out for the same
 *                                    reason `2>/dev/null` is: stream plumbing
 *   `a->b`, `x => y`, `3<>/dev/…`  — `-`, `=`, `<`, `>` before `>`
 *
 * Known residuals, all in the same direction — a comparison or a quoted `>`
 * reads as a redirect and its command lands in `side-effecting-shell`:
 * `awk 'NR>=255'` (the `>` is preceded by a letter, the target is `=`) and
 * `rg '>' file`. This is the safe direction by the rule above: over-classifying
 * only shrinks the offloadable families, never inflates them, and the residual
 * behaves identically under the pre- and post-fix rule, so it cancels exactly
 * in any A/B between them.
 *
 * An earlier revision of this comment sized the residual at "62 commands in a
 * 24 h window on this host". That figure is SELF-REPORTED AND NOT RE-DERIVABLE,
 * and is withdrawn as a measurement rather than restated: no flag on this
 * scanner counts residuals, no committed run record in
 * .genie/wishes/rlmx-microagent-plugin/scan-runs/ contains it, and the window
 * it was taken over has rolled and cannot be re-created. It also never fixed
 * its own unit — calls vs distinct command strings, redirect-arm-only vs any
 * command containing a comparison-shaped `>`. Four readings of that, run over a
 * later 24 h window, returned 302 / 1,915 / 302 / 1,910: the definition
 * dominates the answer. Treat the residual as small and one-sided, not as a
 * number. If it ever needs to be a number, add a `--residuals` mode here that
 * defines and prints it.
 *
 * Tighten by excluding `=` from the target class if that ever costs a real
 * candidate.
 */
const SIDE_EFFECTING = new RegExp(
  [
    // state-changing binaries
    String.raw`(^|[\s;|&(])(sudo|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|kill|pkill|systemctl|launchctl|docker|kubectl|helm|terraform|ansible|apt|apt-get|dpkg|snap|pip|pipx|scp|rsync|ssh|gh|glab|\./[\w.-]+)\b`,
    // git verbs that write (history interrogation is the read half only)
    String.raw`(^|[\s;|&(])git\s+(add|commit|reset|checkout|switch|restore|stash|clean|push|pull|fetch|merge|rebase|cherry-pick|revert|worktree|apply|am|init|config|remote|gc|prune|mv|rm)\b`,
    // redirection into a file
    String.raw`(^|[^0-9&<>=-])>>?\s*[^&\s|]`,
  ].join("|")
);

/**
 * Offload families. Order matters: the first rule that matches a tool call
 * wins, so the specific families sit above `repo-exploration`.
 *
 * `offloadable` marks the families a microagent could actually absorb: work
 * that only reads, and whose whole product is a short written answer. An
 * editing family can be big and still be a bad candidate, which is why the
 * table shows it rather than hiding it.
 */
const FAMILIES = [
  {
    id: "agent-delegation",
    label: "delegation to subagents (Task/Agent)",
    offloadable: false,
    note: "already offloaded — shown for scale, not as a candidate",
    match: (name) => /^(Task|Agent|Explore)$/i.test(name),
  },
  {
    id: "edits",
    label: "edits (Edit/Write/NotebookEdit)",
    offloadable: false,
    note: "mutations — never a candidate for a read-only microagent",
    match: (name) => /^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(name),
  },
  {
    id: "git-history",
    label: "git history interrogation",
    offloadable: true,
    note: "read-only, self-contained questions over a repo's history",
    match: (name, cmd) =>
      name === "Bash" &&
      /(^|[\s;|&(])git\s+(log|show|diff|blame|shortlog|rev-list|describe|whatchanged|tag|status|ls-files)\b/.test(
        cmd
      ),
  },
  {
    id: "test-and-build",
    label: "test / build / typecheck runs",
    offloadable: false,
    note: "side-effecting and host-specific; keep them native",
    match: (name, cmd) =>
      name === "Bash" &&
      /(^|[\s;|&(])(npm|pnpm|yarn|bun|cargo|pytest|tsc|make|go|uv|ruff|eslint|vitest|jest)\b/.test(cmd),
  },
  {
    id: "web-research",
    label: "web fetch / search",
    offloadable: true,
    note: "read-only, but answers are external — offload only with citations",
    match: (name) => /^(WebFetch|WebSearch)$/i.test(name),
  },
  {
    id: "repo-exploration",
    label: "repo exploration (Read/Grep/Glob + read-only shell)",
    offloadable: true,
    note: "the explore-r class — already covered by an existing agent",
    match: (name, cmd) =>
      /^(Read|Grep|Glob|LS)$/i.test(name) ||
      (name === "Bash" &&
        /(^|[\s;|&(])(rg|grep|find|ls|cat|head|tail|sed|awk|wc|tree|jq|fd)\b/.test(cmd)),
  },
  {
    id: "side-effecting-shell",
    label: "shell that changes state",
    offloadable: false,
    note: "writes, installs, git mutations — not offloadable even when it also reads",
    match: (name, cmd) => name === "Bash" && SIDE_EFFECTING.test(cmd),
  },
  {
    id: "other",
    label: "everything else",
    offloadable: false,
    note: "unclassified",
    match: () => true,
  },
];

function classify(name, cmd) {
  for (const f of FAMILIES) {
    if (!f.match(name, cmd)) continue;
    // A read-only family may not absorb a command that also writes.
    if (f.offloadable && name === "Bash" && SIDE_EFFECTING.test(cmd)) continue;
    return f;
  }
  return FAMILIES[FAMILIES.length - 1];
}

// ── walk ──────────────────────────────────────────────────────────────────
async function* transcripts(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

/** `-home-namastex-prod-mikro` → the project slug the transcript belongs to. */
function projectOf(path) {
  const rel = path.slice(ROOT.length + 1);
  const slug = rel.split("/")[0] ?? "?";
  return slug;
}

const families = new Map(
  FAMILIES.map((f) => [
    f.id,
    { ...f, calls: 0, chars: 0, sessions: new Set(), projects: new Set(), samples: [], perCall: [] },
  ])
);
const measured = { turns: 0, output: 0, cacheCreate: 0, cacheRead: 0, input: 0 };
const byProject = new Map();
const toolNames = new Map();
/** `--explain` rows: one per call in the named family, with a citable ref. */
const explainRows = [];
const explainVerbs = new Map();
let files = 0;
let lines = 0;
let skipped = 0;

/**
 * The action a call performs, for the `--explain` histogram: the git
 * subcommand where there is one, else the leading argv word, else the tool.
 */
function verbOf(name, cmd) {
  if (!cmd) return name;
  const git = /(^|[\s;|&(])git\s+([a-z-]+)/.exec(cmd);
  if (git) return `git ${git[2]}`;
  const first = /(^|[\s;|&(])([a-z0-9_.-]+)/.exec(cmd);
  return first ? first[2] : name;
}

let rootOk = true;
try {
  await stat(ROOT);
} catch {
  rootOk = false;
}
if (!rootOk) {
  process.stderr.write(`scan-transcripts: cannot read ${ROOT}\n`);
  process.exit(1);
}

for await (const file of transcripts(ROOT)) {
  if (PROJECT && !file.includes(PROJECT)) continue;
  let st;
  try {
    st = await stat(file);
  } catch {
    continue;
  }
  if (st.mtimeMs < cutoff) continue;
  files += 1;

  const project = projectOf(file);
  /** tool_use_id → {family, name} so a result can be charged to its call. */
  const pending = new Map();

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line) continue;
    lines += 1;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const session = o.sessionId ?? file;

    if (o.type === "assistant" && o.message) {
      const u = o.message.usage;
      if (u) {
        measured.turns += 1;
        measured.output += u.output_tokens ?? 0;
        measured.input += u.input_tokens ?? 0;
        measured.cacheCreate += u.cache_creation_input_tokens ?? 0;
        measured.cacheRead += u.cache_read_input_tokens ?? 0;
        const p = byProject.get(project) ?? { output: 0, cacheCreate: 0, turns: 0, chars: 0 };
        p.output += u.output_tokens ?? 0;
        p.cacheCreate += u.cache_creation_input_tokens ?? 0;
        p.turns += 1;
        byProject.set(project, p);
      }
      for (const block of o.message.content ?? []) {
        if (block?.type !== "tool_use") continue;
        const name = String(block.name ?? "?");
        const cmd = typeof block.input?.command === "string" ? block.input.command : "";
        const fam = classify(name, cmd);
        const rec = families.get(fam.id);
        rec.calls += 1;
        rec.sessions.add(session);
        rec.projects.add(project);
        toolNames.set(`${fam.id}:${name}`, (toolNames.get(`${fam.id}:${name}`) ?? 0) + 1);
        const hint =
          block.input?.pattern ?? block.input?.file_path ?? block.input?.url ?? block.input?.description;
        if (cmd && rec.samples.length < 6) rec.samples.push(cmd.slice(0, 110));
        else if (!cmd && rec.samples.length < 6 && typeof hint === "string") {
          rec.samples.push(`${name}: ${hint.slice(0, 100)}`);
        }

        let row;
        if (EXPLAIN && fam.id === EXPLAIN) {
          const verb = verbOf(name, cmd);
          explainVerbs.set(verb, (explainVerbs.get(verb) ?? 0) + 1);
          row = {
            ref: `${file}:${lineNo}`,
            project,
            session: String(session).slice(0, 8),
            what: (cmd || (typeof hint === "string" ? `${name}: ${hint}` : name)).replace(/\s+/g, " ").slice(0, 150),
            verb,
            resultChars: 0,
          };
          explainRows.push(row);
        }
        pending.set(block.id, { famId: fam.id, row });
      }
      continue;
    }

    if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const block of o.message.content) {
        if (block?.type !== "tool_result") continue;
        const hit = pending.get(block.tool_use_id);
        if (!hit) continue;
        pending.delete(block.tool_use_id);
        const text =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const rec = families.get(hit.famId);
        rec.chars += text.length;
        rec.perCall.push(text.length);
        if (hit.row) hit.row.resultChars = text.length;
        const p = byProject.get(project);
        if (p) p.chars += text.length;
      }
    }
  }
  rl.close();
}

// ── token-optimizer corroboration (optional) ──────────────────────────────
const optimizer = { present: false, sessions: 0, waste: 0, toolCalls: 0, worst: null };
try {
  const entries = await readdir(OPTIMIZER_DIR);
  for (const name of entries) {
    if (!name.startsWith("quality-cache-") || !name.endsWith(".json")) continue;
    const p = join(OPTIMIZER_DIR, name);
    let st;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    let data;
    try {
      data = JSON.parse(await readFile(p, "utf8"));
    } catch {
      continue;
    }
    optimizer.present = true;
    optimizer.sessions += 1;
    const waste = data?.breakdown?.total_estimated_waste_tokens ?? 0;
    optimizer.waste += waste;
    optimizer.toolCalls += data?.tool_calls ?? 0;
    if (!optimizer.worst || waste > optimizer.worst.waste) {
      optimizer.worst = { session: name.slice(14, -5), waste, score: data?.score ?? null };
    }
  }
} catch {
  /* absent is normal — the skill says "when present" */
}

// ── report ────────────────────────────────────────────────────────────────
const tok = (chars) => Math.round(chars / 4);
const num = (n) => n.toLocaleString("en-US");
const totalChars = [...families.values()].reduce((s, f) => s + f.chars, 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const ranked = [...families.values()]
  .filter((f) => f.calls > 0)
  .sort((a, b) => b.chars - a.chars)
  .map((f) => ({
    family: f.id,
    label: f.label,
    offloadable: f.offloadable,
    note: f.note,
    calls: f.calls,
    sessions: f.sessions.size,
    projects: f.projects.size,
    callsPerSession: Number((f.calls / Math.max(1, f.sessions.size)).toFixed(1)),
    resultChars: f.chars,
    approxTokens: tok(f.chars),
    shareOfContextPct: totalChars ? Number(((f.chars / totalChars) * 100).toFixed(1)) : 0,
    medianCharsPerCall: median(f.perCall),
    tools: [...toolNames.entries()]
      .filter(([k]) => k.startsWith(`${f.id}:`))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k.split(":")[1]}×${v}`),
    samples: f.samples,
  }));

const candidates = ranked.filter((f) => f.offloadable && f.calls >= MIN_CALLS);

const report = {
  generatedAt: new Date().toISOString(),
  window: { hours: HOURS, since: new Date(cutoff).toISOString() },
  root: ROOT,
  scanned: { files, lines, unparsableLines: skipped },
  measured: {
    note: "verbatim from each assistant turn's usage block — API counts, not estimates",
    assistantTurns: measured.turns,
    outputTokens: measured.output,
    inputTokens: measured.input,
    cacheCreationInputTokens: measured.cacheCreate,
    cacheReadInputTokens: measured.cacheRead,
  },
  estimated: {
    note: "tool-result characters are exact; tokens are chars/4, a convention — print them with ~",
    toolResultChars: totalChars,
    approxTokens: tok(totalChars),
  },
  families: ranked,
  candidates: candidates.map((c) => c.family),
  tokenOptimizer: optimizer,
  topProjects: [...byProject.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .slice(0, 6)
    .map(([slug, v]) => ({ project: slug, ...v, approxResultTokens: tok(v.chars) })),
};

if (EXPLAIN) {
  const fam = ranked.find((f) => f.family === EXPLAIN);
  if (!fam) {
    process.stderr.write(`scan-transcripts: no family "${EXPLAIN}" in this window\n`);
    process.exit(0);
  }
  const perProject = new Map();
  for (const r of explainRows) {
    const p = perProject.get(r.project) ?? { calls: 0, chars: 0 };
    p.calls += 1;
    p.chars += r.resultChars;
    perProject.set(r.project, p);
  }
  const biggest = [...explainRows].sort((a, b) => b.resultChars - a.resultChars).slice(0, EXAMPLES);
  const lines2 = [];
  lines2.push(`family ${EXPLAIN} — ${fam.label}`);
  lines2.push(
    `  ${num(fam.calls)} calls · ${num(fam.sessions)} sessions · ${num(fam.projects)} projects · ` +
      `${num(fam.resultChars)} chars ~${num(fam.approxTokens)} tok · median ${num(fam.medianCharsPerCall)} ch/call`
  );
  lines2.push("");
  // The by-action block is truncated at 15 rows, so it prints its own
  // remainder and its own total: a histogram that does not add up to the
  // family's call count is a number nobody can check.
  const verbRows = [...explainVerbs.entries()].sort((a, b) => b[1] - a[1]);
  const shown = verbRows.slice(0, 15);
  const rest = verbRows.slice(15);
  const restCalls = rest.reduce((s, [, n]) => s + n, 0);
  const verbTotal = verbRows.reduce((s, [, n]) => s + n, 0);
  lines2.push(`  by action (${verbRows.length} distinct actions, top ${shown.length} shown):`);
  for (const [verb, n] of shown) {
    lines2.push(`    ${String(num(n)).padStart(5)}  ${verb}`);
  }
  if (rest.length) {
    lines2.push(`    ${String(num(restCalls)).padStart(5)}  (${rest.length} further actions below the top ${shown.length})`);
  }
  lines2.push(`    ${"—".repeat(5)}`);
  lines2.push(`    ${String(num(verbTotal)).padStart(5)}  total — equals the family's ${num(fam.calls)} calls`);
  lines2.push("");
  lines2.push(`  by project:`);
  for (const [p, v] of [...perProject.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
    lines2.push(`    ${String(num(v.calls)).padStart(5)} calls  ${String(num(v.chars)).padStart(9)} chars  ${p}`);
  }
  lines2.push("");
  lines2.push(`  heaviest ${biggest.length} calls (ref = transcript:line — open them):`);
  for (const r of biggest) {
    lines2.push(`    ${String(num(r.resultChars)).padStart(7)} ch  ${r.ref}`);
    lines2.push(`             ${r.what}`);
  }
  process.stdout.write(`${lines2.join("\n")}\n`);
  process.exit(0);
}

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const out = [];
out.push(`mikro microagent-create — transcript scan`);
out.push(`  window        last ${HOURS}h (since ${report.window.since})`);
out.push(`  root          ${ROOT}`);
out.push(`  scanned       ${num(files)} transcripts, ${num(lines)} lines${skipped ? `, ${num(skipped)} unparsable` : ""}`);
out.push("");
out.push(`MEASURED (assistant usage blocks — API counts)`);
out.push(`  turns ${num(measured.turns)} · output ${num(measured.output)} tok · cache-create ${num(measured.cacheCreate)} tok · cache-read ${num(measured.cacheRead)} tok`);
out.push("");
out.push(`ESTIMATED (tool-result payload returned into context; chars exact, ÷4 for tokens)`);
out.push(`  ${num(totalChars)} chars ~ ${num(tok(totalChars))} tok across all families`);
out.push("");
out.push(`OFFLOAD FAMILIES, ranked by context returned:`);
for (const f of ranked.slice(0, TOP)) {
  out.push(
    `  ${f.offloadable ? "*" : " "} ${f.family.padEnd(18)} ${String(num(f.resultChars)).padStart(12)} chars ~${String(num(f.approxTokens)).padStart(9)} tok  ${String(f.shareOfContextPct).padStart(5)}%  calls ${String(num(f.calls)).padStart(5)}  sess ${String(f.sessions).padStart(3)}  proj ${String(f.projects).padStart(2)}  ${f.callsPerSession}/sess  med ${num(f.medianCharsPerCall)} ch`
  );
  out.push(`      ${f.label} — ${f.note}`);
  if (f.tools.length) out.push(`      tools: ${f.tools.join(", ")}`);
}
out.push("");
out.push(`  * = offloadable family (read-only work whose product is a written answer)`);
out.push("");
if (optimizer.present) {
  out.push(
    `TOKEN-OPTIMIZER (corroboration): ${optimizer.sessions} session caches in window · ` +
      `${num(optimizer.toolCalls)} tool calls · ${num(optimizer.waste)} est. waste tok` +
      (optimizer.worst ? ` · worst session ${optimizer.worst.session} (${num(optimizer.worst.waste)} tok, score ${optimizer.worst.score})` : "")
  );
} else {
  out.push(`TOKEN-OPTIMIZER: no session data in window (optional input — absent is fine)`);
}
out.push("");
out.push(
  candidates.length
    ? `CANDIDATE FAMILIES (offloadable, >=${MIN_CALLS} calls): ${candidates.map((c) => c.family).join(", ")}`
    : `CANDIDATE FAMILIES: none cleared the >=${MIN_CALLS}-call floor. Propose nothing.`
);
out.push(`Sample commands per candidate family (verbatim, for EVIDENCE.md):`);
for (const c of candidates) {
  out.push(`  ${c.family}:`);
  for (const s of c.samples) out.push(`    ${s}`);
}
process.stdout.write(`${out.join("\n")}\n`);
