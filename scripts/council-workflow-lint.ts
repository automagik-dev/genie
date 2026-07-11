#!/usr/bin/env bun
/**
 * council-workflow-lint: structural lint for the /council workflow template.
 *
 * Checks, in order:
 *   (a) the template exists and parses as the workflow RUNTIME shape (NOT module-legal
 *       ESM): `export const meta` is extracted statically, the remaining body carries no
 *       other export (never `export default`), and it transpiles as an async function
 *       body — top-level await/return are the contract, so an ESM parse is the wrong check
 *   (b) meta.name === 'council' AND the __GENIE_LENS_ROOT__ placeholder is
 *       present (an unstamped template must never ship pre-stamped)
 *   (c) zero banned runtime APIs (the workflow determinism + self-contained
 *       contract: no Date.now / Math.random / new Date( / require( / import /
 *       process. / fs.)
 *   (d) every routing member, the audit roster, and the default trio are keys
 *       of LENSES
 *   (e) every LENSES path resolves on disk relative to plugins/genie/ (all 13)
 *   (f) every references/lenses/*.md card has name/modes/voice frontmatter
 *
 * The seven lane skills resolve through the committed physical plugin mirror;
 * `bun scripts/sync-plugin-skills.ts --check` enforces byte and mode parity.
 * The six deliberation cards resolve from the plugin reference tree.
 *
 * Exit 0 when every check passes, 1 otherwise. `bun run check` executes this
 * gate after wish lint and before tests.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'genie');
const TEMPLATE = join(PLUGIN_DIR, 'workflows', 'council.js');
const CARDS_DIR = join(PLUGIN_DIR, 'references', 'lenses');
const PLACEHOLDER = '__GENIE_LENS_ROOT__';

const BANNED: Array<[label: string, pattern: RegExp]> = [
  ['Date.now', /Date\.now/],
  ['Math.random', /Math\.random/],
  ['new Date(', /new Date\(/],
  ['require(', /require\(/],
  ['top-level import', /^import /m],
  ['process.', /process\./],
  ['fs.', /[^a-zA-Z.]fs\./],
];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  messages: string[];
}

function pass(name: string, detail: string): CheckResult {
  return { name, ok: true, detail, messages: [] };
}

function fail(name: string, detail: string, messages: string[] = []): CheckResult {
  return { name, ok: false, detail, messages };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Balanced-delimiter slice of a `const NAME = <literal>;` declaration. */
function sliceLiteral(src: string, marker: string, open: string, close: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`declaration not found: ${marker}`);
  const start = src.indexOf(open, at);
  if (start < 0) throw new Error(`opening "${open}" not found after ${marker}`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced "${open}${close}" after ${marker}`);
}

/** Extract `name -> path` pairs from the LENSES object literal (string values only). */
function parseLensPairs(block: string): Array<[string, string]> {
  const re = /(['"]?)([A-Za-z][\w-]*)\1\s*:\s*'([^']+)'/g;
  return [...block.matchAll(re)].map((m) => [m[2], m[3]] as [string, string]);
}

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Extract every member name from `members: [...]` arrays inside the ROUTING literal. */
function routingMembers(block: string): string[] {
  return [...block.matchAll(/members:\s*\[([^\]]*)\]/g)].flatMap((m) => quotedStrings(m[1]));
}

/**
 * Remove the `export const meta = { ... };` statement, returning the remaining source.
 * The runtime extracts meta statically; everything else is the async function body.
 */
function stripMetaExport(src: string): string {
  const at = src.indexOf('export const meta');
  if (at < 0) throw new Error('missing `export const meta` declaration');
  const literal = sliceLiteral(src, 'export const meta', '{', '}');
  let end = src.indexOf(literal, at) + literal.length;
  while (end < src.length && /\s/.test(src[end])) end += 1;
  if (src[end] === ';') end += 1;
  return src.slice(0, at) + src.slice(end);
}

/**
 * Parse check against the RUNTIME shape, not module-legal ESM. The dynamic-workflow
 * runtime runs the script as an async function body (top-level await/return are the
 * contract) after extracting `export const meta` statically. So: strip meta, forbid any
 * other export (especially `export default`, which the runtime never calls), then wrap
 * the remainder as an async body and transpile — a syntax error fails with its message.
 */
function checkParse(file: string): CheckResult {
  if (!existsSync(file)) return fail('parse', `template missing: ${file}`);
  const src = readFileSync(file, 'utf8');
  let body: string;
  try {
    body = stripMetaExport(src);
  } catch (err) {
    return fail('parse', 'could not isolate the `export const meta` statement', [String(err)]);
  }
  if (/\bexport\s+default\b/.test(body)) {
    return fail('parse', '`export default` is not an honored workflow entrypoint', [
      'the runtime runs the script as an async function body; use top-level statements + `return`, not `export default`',
    ]);
  }
  if (/^\s*export\b/m.test(body)) {
    return fail('parse', 'workflow body has an export other than `export const meta`', [
      '`export const meta` is the only allowed export; the rest runs as a function body',
    ]);
  }
  try {
    new Bun.Transpiler({ loader: 'js' }).transformSync(`(async () => {\n${body}\n})`);
  } catch (err) {
    return fail('parse', 'workflow body does not parse as an async function body', [
      err instanceof Error ? err.message : String(err),
    ]);
  }
  return pass('parse', 'template parses as a workflow async-body');
}

function checkMeta(src: string): CheckResult {
  const problems: string[] = [];
  if (!/name:\s*'council'/.test(src)) problems.push("meta.name is not 'council'");
  if (!src.includes(PLACEHOLDER)) problems.push(`missing ${PLACEHOLDER} placeholder (template must ship unstamped)`);
  return problems.length
    ? fail('meta', 'meta/placeholder invariant broken', problems)
    : pass('meta', "meta.name === 'council' and placeholder present");
}

function checkBanned(src: string): CheckResult {
  const hits: string[] = [];
  for (const [label, pattern] of BANNED) {
    if (pattern.test(src)) hits.push(`banned API present: ${label}`);
  }
  return hits.length
    ? fail('banned-apis', 'template uses banned runtime APIs', hits)
    : pass('banned-apis', 'zero banned runtime APIs');
}

function checkIntegrity(src: string): { integrity: CheckResult; pairs: Array<[string, string]> } {
  let pairs: Array<[string, string]>;
  let members: string[];
  let auditRoster: string[];
  let defaultTrio: string[];
  try {
    pairs = parseLensPairs(sliceLiteral(src, 'const LENSES =', '{', '}'));
    members = routingMembers(sliceLiteral(src, 'const ROUTING =', '[', ']'));
    auditRoster = quotedStrings(sliceLiteral(src, 'const AUDIT_ROSTER =', '[', ']'));
    defaultTrio = quotedStrings(sliceLiteral(src, 'const DEFAULT_TRIO =', '[', ']'));
  } catch (err) {
    return { integrity: fail('integrity', 'could not extract LENSES/ROUTING literals', [String(err)]), pairs: [] };
  }
  const keySet = new Set(pairs.map(([name]) => name));
  if (!pairs.length) return { integrity: fail('integrity', 'LENSES literal parsed to zero entries'), pairs };
  const referenced = dedupe([...members, ...auditRoster, ...defaultTrio]);
  const unknown = referenced.filter((name) => !keySet.has(name));
  const integrity = unknown.length
    ? fail(
        'integrity',
        'routing/roster references lenses missing from LENSES',
        unknown.map((u) => `unknown lens: ${u}`),
      )
    : pass('integrity', `all ${referenced.length} referenced lenses are LENSES keys (${pairs.length} lenses total)`);
  return { integrity, pairs };
}

function checkLensFiles(pairs: Array<[string, string]>): CheckResult {
  if (!pairs.length) return fail('lens-files', 'no LENSES entries to resolve');
  const missing: string[] = [];
  for (const [name, rel] of pairs) {
    if (!existsSync(join(PLUGIN_DIR, rel))) missing.push(`${name} -> ${rel}`);
  }
  return missing.length
    ? fail('lens-files', `${missing.length}/${pairs.length} lens paths do not resolve under plugins/genie/`, missing)
    : pass('lens-files', `all ${pairs.length} lens paths resolve on disk`);
}

function checkCards(): CheckResult {
  if (!existsSync(CARDS_DIR)) return fail('lens-cards', `cards directory missing: ${CARDS_DIR}`);
  const files = readdirSync(CARDS_DIR).filter((f) => f.endsWith('.md'));
  if (!files.length) return fail('lens-cards', `no lens cards in ${CARDS_DIR}`);
  const problems: string[] = [];
  for (const file of files) {
    const body = readFileSync(join(CARDS_DIR, file), 'utf8');
    for (const key of ['name', 'modes', 'voice']) {
      if (!new RegExp(`^${key}: `, 'm').test(body)) problems.push(`${file}: missing "${key}:" frontmatter`);
    }
  }
  return problems.length
    ? fail('lens-cards', 'lens card frontmatter incomplete', problems)
    : pass('lens-cards', `${files.length} lens cards carry name/modes/voice`);
}

async function main(): Promise<void> {
  const parseOnlyIdx = process.argv.indexOf('--parse-only');
  if (parseOnlyIdx !== -1) {
    const file = process.argv[parseOnlyIdx + 1];
    if (!file) {
      console.error('council-workflow-lint: --parse-only requires a file path');
      process.exit(2);
    }
    const result = checkParse(file);
    report([result]);
    process.exit(result.ok ? 0 : 1);
  }

  const results: CheckResult[] = [];

  results.push(checkParse(TEMPLATE));

  if (!existsSync(TEMPLATE)) {
    report(results);
    process.exit(1);
  }

  const src = readFileSync(TEMPLATE, 'utf8');
  results.push(checkMeta(src));
  results.push(checkBanned(src));

  const { integrity, pairs } = checkIntegrity(src);
  results.push(integrity);
  results.push(checkLensFiles(pairs));
  results.push(checkCards());

  report(results);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

function report(results: CheckResult[]): void {
  console.log('council-workflow-lint');
  console.log('=====================');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(13)} ${r.detail}`);
    for (const m of r.messages) console.log(`        - ${m}`);
  }
  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `FAIL: ${failed.length} check(s) failed.` : 'OK: all checks passed.');
}

main().catch((err) => {
  console.error(`council-workflow-lint: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
