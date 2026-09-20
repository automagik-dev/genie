#!/usr/bin/env bun
/**
 * scripts/mikro/facts.ts — the deterministic facts a microagent would otherwise
 * re-discover with grep on every run.
 *
 *   bun scripts/mikro/facts.ts --dir <repo> (--issue <n> | --intent "<sentence>" | --range <base>..<head>)
 *       [--out <path>] [--no-gh]
 *
 * Motivation, measured: the wish-context bench has yield 1.00 but per-fixture
 * recall swings 0.45/0.91/0.91 on one fixture and 1.00/0.40/1.00 on another.
 * The variance is DISCOVERY variance — which greps the model happened to run —
 * and everything it discovers is computable. So compute it once, with no model,
 * and let the agent read and cite instead of search.
 *
 * Every source is read-only and deterministic: `git ls-files`, `git grep`,
 * `git log`, `git diff --name-only`, the working tree's own CLAUDE.md /
 * AGENTS.md / .claude/rules / .genie tree, plus `gh` for the issue body and related PRs (the
 * only network, and skipped cleanly when `gh` is absent or unauthenticated).
 * Two runs over the same tree produce byte-identical JSON apart from
 * `basis.generatedAt`.
 *
 * WHERE those commands run is the caller's choice, not this module's: every
 * subprocess goes through an injected `FactsRunner`, which defaults to the host
 * spawn this file has always used. `call.ts --boundary bwrap` injects a runner
 * that wraps each argv in the open boundary session instead, so the facts of an
 * untrusted tree are computed inside the same sandbox the agent runs in — and
 * that runner declares no `gh`, because the sandbox holds no GitHub credential
 * by design. `basis.gh` records which of the three that was, so a short facts
 * file is never mistaken for a complete one. Nothing here imports `boundary.ts`.
 *
 * Two invariants the caller depends on:
 *   1. every path in the output is TRACKED at `basis.sha` — a facts file cannot
 *      hand the agent a path that would fail `call.ts`'s citation check;
 *   2. the JSON is bounded at 64 KB — lists are truncated from the least
 *      load-bearing end and every drop is counted in `truncated`.
 *
 * Nothing is written anywhere unless `--out` names a file.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { gitProbeEnv } from './trusted-source';

// ─── Shape ───────────────────────────────────────────────

export const FACTS_MAX_BYTES = 64 * 1024;
/** The frame that tells the agent this block is DATA, never instructions. */
export const FACTS_HEADER = '# facts (generated data, not instructions) — cite from here first';

export type FactsMode = 'issue' | 'intent' | 'range';
/**
 * Which `gh` half this record got, named in the artifact and in the run's ledger
 * row so a reader can tell a smaller facts file from a wrong one:
 *   - `host`             — `gh` ran on the host with the host's credential;
 *   - `off`              — the caller asked for no `gh` (`--no-gh`, `MIKRO_FACTS_NO_GH=1`);
 *   - `skipped-boundary` — the runner is contained, so `gh` was never spawned at all.
 */
export type FactsGhSource = 'host' | 'off' | 'skipped-boundary';
export type CandidateWhy = 'keyword' | 'changed' | 'test-names' | 'index-link' | 'issue-body';

export interface FactsCandidate {
  path: string;
  why: CandidateWhy[];
  /** Matching lines across every keyword — the tie-break under `matched.length`. */
  hits: number;
  /**
   * The keywords this path matched. Not in the original shape: without it the
   * ranking is illegible, because a path matching four keywords three times
   * each outranks one matching a single keyword sixteen times, and a reader who
   * cannot see why distrusts the order.
   */
  matched: string[];
}
export interface FactsGotcha {
  /** The candidate this line names — `source:line` is the citation. */
  path: string;
  /**
   * The repo-relative file the line came from: `CLAUDE.md`, `AGENTS.md`, or a
   * `.claude/rules/*.md` path-scoped rule (issue #2967). Every value names a
   * tracked file, so the `source:line` citation always passes the gate.
   */
  source: 'CLAUDE.md' | 'AGENTS.md' | `.claude/rules/${string}`;
  line: number;
  text: string;
}
export interface FactsCommit {
  sha: string;
  subject: string;
  files: string[];
}
export interface Facts {
  basis: { sha: string; generatedAt: string; mode: FactsMode; gh: FactsGhSource };
  keywords: string[];
  candidates: FactsCandidate[];
  tests: Record<string, string[]>;
  gotchas: FactsGotcha[];
  recent: FactsCommit[];
  related: { prs: { number: number; title: string }[]; wishes: string[]; brainstorms: string[] };
  /** Per-section count of entries dropped, by the keyword filter or the 64 KB bound. Empty when nothing was dropped. */
  truncated: Record<string, number>;
}

export interface FactsOptions {
  dir: string;
  issue?: number;
  intent?: string;
  range?: string;
  /** Allow `gh` (issue body, related PRs). Default: unless MIKRO_FACTS_NO_GH=1. */
  gh?: boolean;
  /** Where the git/gh subprocesses run. Default: `hostFactsRunner`, the bare host spawn. */
  runner?: FactsRunner;
  /** Injected only by tests that assert determinism. */
  now?: string;
}

// ─── Caps ────────────────────────────────────────────────

const MAX_KEYWORDS = 16;
const MAX_CANDIDATES = 40;
const MAX_GOTCHAS = 20;
const MAX_RECENT = 15;
const MAX_FILES_PER_COMMIT = 10;
const MAX_TESTS_PER_FILE = 6;
const MAX_PRS = 5;
const MAX_RELATED_DOCS = 8;
const GOTCHA_TEXT = 320;
/** A keyword matching more files than this is prose, not a locator: it floods the ranking and is dropped. */
const GENERIC_KEYWORD_FILES = 80;

// ─── git / gh ────────────────────────────────────────────

export interface Ran {
  ok: boolean;
  out: string;
}

/**
 * The one way this module starts a process. A runner never throws: a command it
 * cannot run reports `{ok:false, out:''}`, which every caller here already treats
 * as "this source contributed nothing" — the facts file is smaller, never wrong.
 */
export interface FactsRunner {
  /** Run one argv with `dir` as the working directory. */
  run(argv: string[], dir: string): Ran;
  /**
   * False when this runner has no way to reach GitHub. `gh` is then never spawned
   * — not spawned on the host behind a boundary's back, which would be a
   * credentialed call outside the sandbox and outside the egress ledger.
   */
  readonly canRunGh: boolean;
}

/**
 * The bare host spawn: the default, and what `--boundary none` keeps.
 *
 * On the STRIPPED ambient git environment (`gitProbeEnv`), because `cwd` does not
 * override an exported `GIT_DIR`/`GIT_WORK_TREE`: a facts scan that answered for
 * another repository would put another tree's paths into the context file, and
 * `call.ts`'s citation gate verifies against `--dir`. Everything else — PATH, the
 * `gh` credential — survives.
 */
export const hostFactsRunner: FactsRunner = {
  canRunGh: true,
  run(argv: string[], dir: string): Ran {
    try {
      const p = Bun.spawnSync(argv, { cwd: dir, env: gitProbeEnv(), stderr: 'pipe' });
      return { ok: p.exitCode === 0, out: p.stdout.toString() };
    } catch {
      // no such binary on PATH: this source contributes nothing
      return { ok: false, out: '' };
    }
  },
};

function git(runner: FactsRunner, dir: string, args: string[]): Ran {
  return runner.run(['git', '--no-pager', ...args], dir);
}

function gh(runner: FactsRunner, dir: string, args: string[]): Ran {
  if (!runner.canRunGh) return { ok: false, out: '' };
  return runner.run(['gh', ...args], dir);
}

const lines = (text: string): string[] => text.split('\n').filter((l) => l.length > 0);

// ─── Keywords ────────────────────────────────────────────

/**
 * Words that locate nothing. English function words plus the terms every genie
 * intent carries ("fix", "issue", "genie") — a keyword that matches everything
 * ranks nothing.
 */
const STOPWORDS = new Set(
  `about above after again against already also always another anything because been before being below best
   both came cannot change changed changes check could does doing done down during each either else enough
   even ever every everything first from genie github give given goes gone have here however into issue
   itself just keep kept know last less like made make makes many more most much must name named never
   next none nothing only onto other others over part pass past pull request rather really right same
   says seen several shall should side since some something still such sure take taken than that their
   them then there these they thing things this those though three through thus time today under until
   upon used uses using very want well went were what when where whether which while will with within
   without word work would your fix fixes bug bugs feature adds added drop drops files file line lines
   code repo repository branch commit commits test tests them they
   `
    .split(/\s+/)
    .filter(Boolean),
);

/** True for a token that looks like an identifier or a path — the tokens worth grepping. */
const isLocator = (token: string): boolean =>
  /[._/]/.test(token) || /[a-z][A-Z]/.test(token) || /[a-z]-[a-z]/.test(token);

/**
 * The distinctive tokens of a sentence, ranked locators-first then by how often
 * the sentence repeats them. Case is preserved as first seen (the greps are
 * case-insensitive, so casing is presentation only).
 */
export function extractKeywords(text: string, max = MAX_KEYWORDS): string[] {
  const seen = new Map<string, { token: string; count: number; locator: boolean; order: number }>();
  const raw = text.match(/[A-Za-z][A-Za-z0-9_./-]{2,}/g) ?? [];
  for (const [order, token] of raw.entries()) {
    const clean = token.replace(/[.\-/_]+$/, '');
    if (clean.length < 4) continue;
    const key = clean.toLowerCase();
    if (STOPWORDS.has(key)) continue;
    const hit = seen.get(key);
    if (hit) hit.count++;
    else seen.set(key, { token: clean, count: 1, locator: isLocator(clean), order });
  }
  return [...seen.values()]
    .sort(
      (a, b) =>
        Number(b.locator) - Number(a.locator) ||
        b.count - a.count ||
        b.token.length - a.token.length ||
        a.order - b.order,
    )
    .slice(0, max)
    .map((k) => k.token);
}

/** Paths the text itself names, kept only when they are tracked — the highest-value candidates there are. */
function pathsNamedIn(text: string, tracked: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.@-]*(?:\/[\w.@-]+)+\.\w{1,5}/g)) {
    const clean = m[0].replace(/^\.\//, '');
    if (tracked.has(clean)) out.add(clean);
  }
  return [...out].sort();
}

// ─── Candidate sources ───────────────────────────────────

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/**
 * Paths a facts file must never point an agent at:
 *   - lockfiles, whose hit counts say nothing about where behaviour lives;
 *   - `.mikro/`, which is the agents' own prompts, config and evidence tables;
 *   - `scripts/mikro/fixtures/`, which carries each bench fixture's PROMPT next
 *     to its ground-truth file list. Ranked by keyword coverage it came first
 *     on both wish-context intents tried — a candidate handing the model the
 *     answer key is not a fact, it is contamination.
 */
const NOISE_RE = /(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock)$|^\.mikro\/|^scripts\/mikro\/fixtures\//;
/**
 * Planning documents are `related` work, never a candidate to change: no
 * delivered wish in the fixture set ever touched one, and prose files outrank
 * code on raw keyword hits, so leaving them in the ranking buys nothing and
 * costs the precision the caller is scored on.
 */
const DOC_RE = /^\.genie\//;
/** Files a pinning-test lookup makes sense for: code, not prose. */
const CODE_RE = /\.(tsx?|[cm]?js|sh|py)$/;
/** Basenames too generic to prove a gotcha line is about this path. */
const GENERIC_BASENAMES = new Set([
  'index.ts',
  'types.ts',
  'README.md',
  'WISH.md',
  'DESIGN.md',
  'DRAFT.md',
  'SKILL.md',
  'SYSTEM.md',
  'AGENTS.md',
  'CLAUDE.md',
]);

const TEST_ROOTS = ['scripts/', 'src/', 'plugins/'];
const isPinningTest = (path: string) => TEST_RE.test(path) && TEST_ROOTS.some((r) => path.startsWith(r));

interface Bucket {
  why: Set<CandidateWhy>;
  hits: number;
  matched: Set<string>;
}

function note(buckets: Map<string, Bucket>, path: string, why: CandidateWhy, hits = 0, keyword?: string): void {
  const b = buckets.get(path) ?? { why: new Set<CandidateWhy>(), hits: 0, matched: new Set<string>() };
  b.why.add(why);
  b.hits += hits;
  if (keyword) b.matched.add(keyword);
  buckets.set(path, b);
}

/**
 * `git grep -c -i -F` per keyword: one call, and the count it prints IS the
 * ranking signal. A keyword that hits more than GENERIC_KEYWORD_FILES files is
 * dropped whole — both from `keywords` and from the ranking.
 */
function grepKeywords(
  runner: FactsRunner,
  dir: string,
  keywords: string[],
  tracked: Set<string>,
): { used: string[]; generic: number; byPath: Map<string, { hits: number; matched: string[] }> } {
  const used: string[] = [];
  const byPath = new Map<string, { hits: number; matched: string[] }>();
  let generic = 0;
  for (const keyword of keywords) {
    const { out } = git(runner, dir, ['grep', '-I', '-i', '-F', '-c', '-e', keyword]);
    const rows: [string, number][] = [];
    for (const line of lines(out)) {
      const cut = line.lastIndexOf(':');
      if (cut < 0) continue;
      const path = line.slice(0, cut);
      const count = Number(line.slice(cut + 1));
      if (!tracked.has(path) || NOISE_RE.test(path) || !Number.isFinite(count)) continue;
      rows.push([path, count]);
    }
    if (rows.length > GENERIC_KEYWORD_FILES) {
      generic++;
      continue;
    }
    used.push(keyword);
    for (const [path, count] of rows) {
      const row = byPath.get(path) ?? { hits: 0, matched: [] };
      row.hits += count;
      row.matched.push(keyword);
      byPath.set(path, row);
    }
  }
  return { used, generic, byPath };
}

/**
 * Tracked files that `.genie/INDEX.md` names on a line that also carries a
 * keyword — the roadmap's own prose is a curated index of which file decided
 * what, and it names source files (`session-context.ts`, `legacy-v4.ts`) a
 * keyword grep of the code alone does not connect to the intent. A bare file
 * name is resolved only when exactly one tracked path carries it, the same rule
 * `call.ts` applies to a citation.
 */
function indexLinked(dir: string, tracked: Set<string>, keywords: string[]): string[] {
  const index = resolve(dir, '.genie', 'INDEX.md');
  if (!keywords.length || !existsSync(index)) return [];
  const byBase = new Map<string, string[]>();
  for (const path of tracked) {
    const base = basename(path);
    byBase.set(base, [...(byBase.get(base) ?? []), path]);
  }
  const needles = keywords.map((k) => k.toLowerCase());
  const out = new Set<string>();
  for (const line of readFileSync(index, 'utf8').split('\n')) {
    const lower = line.toLowerCase();
    if (!needles.some((n) => lower.includes(n))) continue;
    for (const path of pathsNamedIn(line, tracked)) out.add(path);
    for (const m of line.matchAll(/\b[\w.-]+\.(?:tsx?|[cm]?js|md|json|sh)\b/g)) {
      const unique = byBase.get(m[0]);
      if (unique?.length === 1) out.add(unique[0]);
    }
  }
  return [...out].sort().slice(0, 10);
}

/** Test files naming a candidate's stem — the tests that pin its behaviour today. */
function pinningTests(runner: FactsRunner, dir: string, paths: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const done = new Map<string, string[]>();
  for (const path of paths) {
    if (!CODE_RE.test(path)) continue; // a prose stem like `WISH` names every test that says the word
    const stem = basename(path)
      .replace(/\.[^.]+$/, '')
      .replace(/\.test$/, '');
    if (stem.length < 5) continue;
    let found = done.get(stem);
    if (!found) {
      const { out: raw } = git(runner, dir, [
        'grep',
        '-l',
        '-I',
        '-F',
        '-e',
        stem,
        '--',
        '*.test.ts',
        '*.test.js',
        '*.test.mjs',
      ]);
      found = lines(raw).filter(isPinningTest).sort();
      done.set(stem, found);
    }
    const kept = found.filter((t) => t !== path).slice(0, MAX_TESTS_PER_FILE);
    if (kept.length) out[path] = kept;
  }
  return out;
}

/**
 * The files gotcha lines are read from: the two always-on contract files plus
 * every tracked `.claude/rules/*.md` path-scoped rule (issue #2967). A repository
 * without a rules directory contributes exactly the two files it always did, so
 * this is forward-compatible: the scanner lands before any rule does. Untracked
 * rules never load — a facts file may only name paths that pass the citation
 * gate, and an untracked file would not.
 */
function gotchaSources(dir: string, tracked: Set<string>): FactsGotcha['source'][] {
  const sources: FactsGotcha['source'][] = ['CLAUDE.md', 'AGENTS.md'];
  const rulesDir = resolve(dir, '.claude', 'rules');
  if (!existsSync(rulesDir)) return sources;
  const rules = readdirSync(rulesDir)
    .filter((name) => name.endsWith('.md'))
    .map((name): FactsGotcha['source'] => `.claude/rules/${name}`)
    .filter((source) => tracked.has(source))
    .sort(); // deterministic: two runs over one tree agree on gotcha order
  return [...sources, ...rules];
}

/** Contract lines that name a candidate — the rules a change to it must survive. */
function gotchaLines(dir: string, paths: string[], tracked: Set<string>): FactsGotcha[] {
  const out: FactsGotcha[] = [];
  for (const source of gotchaSources(dir, tracked)) {
    const abs = resolve(dir, source);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8').split('\n');
    // A rules file opens with `---` YAML frontmatter whose `paths:` globs name
    // every candidate the file covers; a citation must land on rule TEXT, never
    // on the frontmatter line that merely points at it.
    const bodyStart = text[0] === '---' ? text.indexOf('---', 1) + 1 : 0;
    for (const path of paths) {
      if (path === 'CLAUDE.md' || path === 'AGENTS.md' || path === source) continue; // a rule about the rule file is not a gotcha
      const base = basename(path);
      const needles = base.length >= 6 && !GENERIC_BASENAMES.has(base) ? [path, base] : [path];
      for (const [i, line] of text.entries()) {
        if (i < bodyStart) continue;
        if (!needles.some((n) => line.includes(n))) continue;
        out.push({ path, source, line: i + 1, text: line.trim().slice(0, GOTCHA_TEXT) });
        break; // one line per (candidate, file): the first rule that names it
      }
    }
  }
  return out;
}

/** The last commits that touched the candidate set — who changed this seam, and with what. */
function recentCommits(runner: FactsRunner, dir: string, paths: string[], tracked: Set<string>): FactsCommit[] {
  if (!paths.length) return [];
  // --no-merges: a merge commit prints no file list under --name-only, so a
  // history of merges reads as fifteen commits that touched nothing.
  const { out } = git(runner, dir, [
    'log',
    `-${MAX_RECENT}`,
    '--no-merges',
    '--name-only',
    '--format=%h%x09%s',
    '--',
    ...paths,
  ]);
  const commits: FactsCommit[] = [];
  for (const line of out.split('\n')) {
    const head = /^([0-9a-f]{7,40})\t(.*)$/.exec(line);
    if (head) {
      commits.push({ sha: head[1], subject: head[2].slice(0, 160), files: [] });
      continue;
    }
    const current = commits[commits.length - 1];
    if (!current || !line.trim()) continue;
    if (tracked.has(line) && current.files.length < MAX_FILES_PER_COMMIT) current.files.push(line);
  }
  return commits.slice(0, MAX_RECENT);
}

/**
 * Prior work under `.genie/{wishes,brainstorms}/<slug>/`: every slug or document
 * title carrying a keyword, plus the documents the keyword grep itself ranked
 * highest. The title half alone found nothing on the issue-2927 intent while the
 * grep had already put three wish documents in the top ten — prior work is the
 * cheapest fact there is, and it is `related`, never a file to change.
 */
function relatedDocs(
  dir: string,
  kind: 'wishes' | 'brainstorms',
  keywords: string[],
  tracked: Set<string>,
  ranked: Map<string, { hits: number; matched: string[] }>,
): string[] {
  const doc = kind === 'wishes' ? 'WISH.md' : 'DESIGN.md';
  const prefix = `.genie/${kind}/`;
  const slugs = new Set<string>();
  for (const path of tracked) {
    if (!path.startsWith(prefix)) continue;
    const slug = path.slice(prefix.length).split('/')[0];
    if (slug) slugs.add(slug);
  }
  const needles = keywords.map((k) => k.toLowerCase());
  const byTitle: string[] = [];
  for (const slug of [...slugs].sort()) {
    const slugText = slug.toLowerCase().replace(/[-_]/g, ' ');
    const target = `${prefix}${slug}/${doc}`;
    let title = '';
    if (tracked.has(target)) {
      const abs = resolve(dir, target);
      if (existsSync(abs)) title = readFileSync(abs, 'utf8').slice(0, 400).toLowerCase();
    }
    if (!needles.some((n) => slugText.includes(n) || title.includes(n))) continue;
    byTitle.push(tracked.has(target) ? target : `${prefix}${slug}/`);
  }
  const byHits = [...ranked.entries()]
    .filter(([path]) => path.startsWith(prefix) && tracked.has(path))
    .sort((a, b) => b[1].matched.length - a[1].matched.length || b[1].hits - a[1].hits || a[0].localeCompare(b[0]))
    .map(([path]) => path);
  return [...new Set([...byTitle, ...byHits])].slice(0, MAX_RELATED_DOCS);
}

function relatedPrs(runner: FactsRunner, dir: string, keywords: string[]): { number: number; title: string }[] {
  const byNumber = new Map<number, string>();
  for (const keyword of keywords.slice(0, 2)) {
    const { ok, out } = gh(runner, dir, [
      'pr',
      'list',
      '--search',
      keyword,
      '--state',
      'all',
      '--limit',
      String(MAX_PRS),
      '--json',
      'number,title',
    ]);
    if (!ok) return [...byNumber.entries()].map(([number, title]) => ({ number, title }));
    try {
      for (const pr of JSON.parse(out) as { number: number; title: string }[])
        if (typeof pr.number === 'number') byNumber.set(pr.number, String(pr.title ?? '').slice(0, 160));
    } catch {
      // a gh that answered with something other than JSON contributes nothing
    }
  }
  return [...byNumber.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, MAX_PRS)
    .map(([number, title]) => ({ number, title }));
}

// ─── Mode → keywords ─────────────────────────────────────

function modeSeed(
  runner: FactsRunner,
  options: FactsOptions,
  tracked: Set<string>,
  useGh: boolean,
): { mode: FactsMode; text: string; changed: string[] } {
  if (options.range) {
    const { out } = git(runner, options.dir, ['diff', '--name-only', options.range]);
    const changed = lines(out).filter((p) => tracked.has(p));
    const stems = changed.map((p) => basename(p).replace(/\.[^.]+$/, ''));
    return { mode: 'range', text: [...changed, ...stems].join(' '), changed };
  }
  if (options.issue !== undefined) {
    let text = `#${options.issue}`;
    if (useGh) {
      const { ok, out } = gh(runner, options.dir, ['issue', 'view', String(options.issue), '--json', 'title,body']);
      if (ok) {
        try {
          const data = JSON.parse(out) as { title?: string; body?: string };
          text = `${text} ${data.title ?? ''} ${(data.body ?? '').slice(0, 8000)}`;
        } catch {
          // keep the issue number alone: `#<n>` is itself a locator in INDEX.md and CLAUDE.md
        }
      }
    }
    return { mode: 'issue', text, changed: [] };
  }
  return { mode: 'intent', text: options.intent ?? '', changed: [] };
}

// ─── Assembly ────────────────────────────────────────────

export function buildFacts(options: FactsOptions): Facts {
  const dir = resolve(options.dir);
  const runner = options.runner ?? hostFactsRunner;
  // A contained runner outranks the caller's `gh` choice: it is the STRUCTURAL
  // reason gh is absent, and that is what a reader of the row has to know.
  const ghSource: FactsGhSource = !runner.canRunGh
    ? 'skipped-boundary'
    : (options.gh ?? process.env.MIKRO_FACTS_NO_GH !== '1')
      ? 'host'
      : 'off';
  const useGh = ghSource === 'host';
  const tracked = new Set(lines(git(runner, dir, ['ls-files']).out));
  const sha = git(runner, dir, ['rev-parse', 'HEAD']).out.trim() || 'unknown';
  const seed = modeSeed(runner, options, tracked, useGh);
  const truncated: Record<string, number> = {};

  const named = pathsNamedIn(seed.text, tracked);
  const rawKeywords = extractKeywords(seed.text);
  const issueNumber = options.issue !== undefined ? [`#${options.issue}`] : [];
  const grepped = grepKeywords(runner, dir, [...issueNumber, ...rawKeywords], tracked);
  if (grepped.generic) truncated.genericKeywords = grepped.generic;

  const wishes = relatedDocs(dir, 'wishes', grepped.used, tracked, grepped.byPath);
  const brainstorms = relatedDocs(dir, 'brainstorms', grepped.used, tracked, grepped.byPath);

  // A candidate is a file the work could change: never a test (they are
  // recorded under `tests`), never a planning document (they are `related`).
  const eligible = (path: string) => !isPinningTest(path) && !DOC_RE.test(path);
  const buckets = new Map<string, Bucket>();
  for (const [path, row] of grepped.byPath)
    if (eligible(path)) for (const keyword of row.matched) note(buckets, path, 'keyword', 0, keyword);
  for (const [path, row] of grepped.byPath) {
    const bucket = buckets.get(path);
    if (bucket) bucket.hits = row.hits;
  }
  for (const path of seed.changed) if (eligible(path)) note(buckets, path, 'changed');
  for (const path of named) if (eligible(path)) note(buckets, path, 'issue-body');
  for (const path of indexLinked(dir, tracked, grepped.used)) if (eligible(path)) note(buckets, path, 'index-link');

  // Coverage before volume, and a locator keyword counts double: a path
  // matching four keywords three times each is the seam, one matching a single
  // keyword sixteen times is usually prose, and a file that carries
  // `codex-fallback` is closer to the intent than one that carries
  // `transaction`. Weighting the tail this way is what kept the last two truth
  // files of the issue-2927 intent inside the 40-candidate cap.
  const weight = (b: Bucket) => [...b.matched].reduce((n, k) => n + (isLocator(k) ? 2 : 1), 0);
  const ranked = [...buckets.entries()]
    .sort(
      (a, b) =>
        weight(b[1]) - weight(a[1]) ||
        b[1].matched.size - a[1].matched.size ||
        b[1].hits - a[1].hits ||
        a[0].localeCompare(b[0]),
    )
    .map(([path, b]): FactsCandidate => ({ path, why: [...b.why].sort(), hits: b.hits, matched: [...b.matched] }));
  if (ranked.length > MAX_CANDIDATES) truncated.candidates = ranked.length - MAX_CANDIDATES;
  const candidates = ranked.slice(0, MAX_CANDIDATES);

  const paths = candidates.map((c) => c.path);
  const tests = pinningTests(runner, dir, paths);
  for (const c of candidates) if (tests[c.path]) c.why = [...new Set([...c.why, 'test-names' as CandidateWhy])].sort();

  const allGotchas = gotchaLines(dir, paths, tracked);
  if (allGotchas.length > MAX_GOTCHAS) truncated.gotchas = allGotchas.length - MAX_GOTCHAS;

  const facts: Facts = {
    basis: { sha, generatedAt: options.now ?? new Date().toISOString(), mode: seed.mode, gh: ghSource },
    keywords: grepped.used,
    candidates,
    tests,
    gotchas: allGotchas.slice(0, MAX_GOTCHAS),
    recent: recentCommits(runner, dir, paths, tracked),
    related: { prs: useGh ? relatedPrs(runner, dir, grepped.used) : [], wishes, brainstorms },
    truncated,
  };
  return enforceBudget(facts);
}

/**
 * Bring the JSON under FACTS_MAX_BYTES by dropping from the least load-bearing
 * end first — commit history, then gotcha lines, then pinning tests, then the
 * tail of the candidate ranking. Every drop is counted in `truncated`, so a
 * reader can always tell a short list from a complete one.
 */
export function enforceBudget(facts: Facts, max = FACTS_MAX_BYTES): Facts {
  const size = () => Buffer.byteLength(JSON.stringify(facts), 'utf8');
  const bump = (key: string, n: number) => {
    if (n > 0) facts.truncated[key] = (facts.truncated[key] ?? 0) + n;
  };
  while (size() > max && facts.recent.length) {
    facts.recent.pop();
    bump('recent', 1);
  }
  while (size() > max && facts.gotchas.length) {
    facts.gotchas.pop();
    bump('gotchas', 1);
  }
  while (size() > max && Object.keys(facts.tests).length) {
    const key = Object.keys(facts.tests).sort().pop();
    if (!key) break;
    delete facts.tests[key];
    bump('tests', 1);
  }
  while (size() > max && facts.candidates.length > 1) {
    const gone = facts.candidates.pop();
    if (gone) delete facts.tests[gone.path];
    bump('candidates', 1);
  }
  return facts;
}

/** The facts file as the agent receives it: the data frame, then the JSON. */
export function renderFacts(facts: Facts): string {
  return `${FACTS_HEADER}\n\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n`;
}

// ─── Prompt → mode ───────────────────────────────────────

export interface InferredMode {
  issue?: number;
  intent?: string;
  range?: string;
}

/**
 * The facts mode a microagent prompt implies, or null when it implies none
 * (a `Prepare the review of PR #n` prompt names no base, so it gets no facts
 * rather than a guessed range).
 */
export function inferFactsMode(prompt: string): InferredMode | null {
  const issue = /\bissue\s+#?(\d{1,7})\b/i.exec(prompt);
  const range = /\bcommit\s+([0-9a-f]{7,40})\b[^\n]*?\bagainst\s+(\S+?)[\s.,;]*$/im.exec(prompt);
  if (range) return { range: `${range[2]}..${range[1]}` };
  const intent = /^[^\S\n]*Intent:\s*([\s\S]+)$/im.exec(prompt);
  if (intent) return { intent: intent[1].trim() };
  if (issue) return { issue: Number(issue[1]) };
  return null;
}

// ─── CLI ─────────────────────────────────────────────────

function usage(): never {
  process.stderr.write(
    'usage: bun scripts/mikro/facts.ts --dir <repo> (--issue <n> | --intent "<sentence>" | --range <base>..<head>) [--out <path>] [--no-gh]\n',
  );
  process.exit(2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const issue = opt('--issue');
  const intent = opt('--intent');
  const range = opt('--range');
  if ([issue, intent, range].filter(Boolean).length !== 1) usage();
  const facts = buildFacts({
    dir: opt('--dir') ?? process.cwd(),
    issue: issue ? Number(issue) : undefined,
    intent,
    range,
    gh: argv.includes('--no-gh') ? false : undefined,
  });
  const text = `${JSON.stringify(facts, null, 2)}\n`;
  const out = opt('--out');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
