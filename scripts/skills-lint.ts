#!/usr/bin/env bun
/**
 * skills-lint: validate that every `genie <cmd>` / `omni <cmd>` invocation
 * inside a bash/sh code fence in any SKILL.md (or nested prompt .md)
 * corresponds to a real subcommand in the current CLI surface.
 *
 * Exit non-zero if any skill has missing commands.
 * Honors a `<!-- skills-lint:ignore -->` bailout marker to skip a file.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKILLS_DIR = join(ROOT, 'skills');

function collectSubcommands(helpText: string): Set<string> {
  const cmds = new Set<string>();
  const lines = helpText.split('\n');
  let inCommands = false;
  for (const line of lines) {
    if (/^Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    // Match "  name [options] ..." or "  name   description"
    const m = line.match(/^\s{2,}([a-z][a-z0-9:_-]*)\b/);
    if (m) cmds.add(m[1]);
  }
  return cmds;
}

function getGenieCommands(): Set<string> {
  // Validate against the repo's own freshly-built binary when present, not
  // whatever `genie` happens to be on PATH — a stale global install can lag
  // the source (e.g. missing the `v5` namespace) and produce false failures.
  // Run `bun run build` before linting so `dist/genie.js` reflects source.
  //
  // LIMITATION: only the FIRST token after `genie` is validated. `genie v5 task`
  // resolves to `v5`, so bogus subcommands under a valid namespace (e.g.
  // `genie v5 bogus-verb`) pass this lint. Command honesty below the namespace
  // level must be verified in review, not assumed from a green lint.
  const distBin = join(ROOT, 'dist', 'genie.js');
  const cmd = existsSync(distBin) ? `bun ${distBin} --help` : 'genie --help';
  const out = execSync(cmd, { encoding: 'utf8' });
  return collectSubcommands(out);
}

function getOmniCommands(): Set<string> {
  let out: string;
  try {
    out = execSync('omni --help --all 2>/dev/null || omni --help', { encoding: 'utf8' });
  } catch (err) {
    // Never silently swallow: CI must catch a missing or broken omni binary.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[skills-lint] failed to probe \`omni --help\`: ${detail}`);
    console.error('[skills-lint] install the omni CLI or unset skills linting before running.');
    process.exit(2);
  }
  // omni uses section headers (Core:, Management:, System:); strip them.
  const cmds = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s{4,}([a-z][a-z0-9:_-]*)\s{2,}/);
    if (m) cmds.add(m[1]);
  }
  return cmds;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

function extractBashFences(text: string): string[] {
  const fences: string[] = [];
  const re = /```(?:bash|sh)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    fences.push(m[1]);
    m = re.exec(text);
  }
  return fences;
}

function extractInvocations(fence: string, tool: 'genie' | 'omni'): string[] {
  const hits: string[] = [];
  // Match start of a command: "genie cmd" or "$ genie cmd" or "| genie cmd"
  const re = new RegExp(`(?:^|[;&|\\n\`$(])\\s*${tool}\\s+([a-z][a-z0-9:_-]*)`, 'g');
  let m: RegExpExecArray | null = re.exec(fence);
  while (m !== null) {
    hits.push(m[1]);
    m = re.exec(fence);
  }
  return hits;
}

interface Report {
  skill: string;
  missingCommands: Array<{ tool: string; command: string }>;
}

function main() {
  const genieCmds = getGenieCommands();

  if (genieCmds.size === 0) {
    console.error('skills-lint: failed to load `genie --help` output');
    process.exit(2);
  }

  const files = walk(SKILLS_DIR);
  const reports: Report[] = [];

  // First pass: collect all invocations from non-ignored skills. The omni CLI
  // is only probed when some scanned skill actually references it — every
  // omni-referencing skill is currently behind skills-lint:ignore, and CI
  // runners don't have the omni binary installed, so an unconditional probe
  // hard-fails the gate for commands nobody validates.
  const scanned: Array<{ file: string; genie: string[]; omni: string[] }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('<!-- skills-lint:ignore -->')) continue;
    const genie: string[] = [];
    const omni: string[] = [];
    for (const fence of extractBashFences(text)) {
      genie.push(...extractInvocations(fence, 'genie'));
      omni.push(...extractInvocations(fence, 'omni'));
    }
    scanned.push({ file, genie, omni });
  }

  const omniNeeded = scanned.some((s) => s.omni.length > 0);
  const omniCmds = omniNeeded ? getOmniCommands() : new Set<string>();

  for (const { file, genie, omni } of scanned) {
    const missing: Report['missingCommands'] = [];
    for (const cmd of genie) {
      if (!genieCmds.has(cmd)) missing.push({ tool: 'genie', command: cmd });
    }
    if (omniCmds.size > 0) {
      for (const cmd of omni) {
        if (!omniCmds.has(cmd)) missing.push({ tool: 'omni', command: cmd });
      }
    }
    reports.push({ skill: relative(ROOT, file), missingCommands: missing });
  }

  const failed = reports.filter((r) => r.missingCommands.length > 0);
  console.log(JSON.stringify(reports, null, 2));

  if (failed.length > 0) {
    console.error(`\nskills-lint: ${failed.length} skill(s) reference missing commands`);
    process.exit(1);
  }
  console.error(`skills-lint: OK (${reports.length} files scanned, 0 missing)`);
}

main();
