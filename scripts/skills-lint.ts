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
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  const out = execSync('genie --help', { encoding: 'utf8' });
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
  const omniCmds = getOmniCommands();

  if (genieCmds.size === 0) {
    console.error('skills-lint: failed to load `genie --help` output');
    process.exit(2);
  }

  const files = walk(SKILLS_DIR);
  const reports: Report[] = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('<!-- skills-lint:ignore -->')) continue;
    const fences = extractBashFences(text);
    const missing: Report['missingCommands'] = [];
    for (const fence of fences) {
      for (const cmd of extractInvocations(fence, 'genie')) {
        if (!genieCmds.has(cmd)) missing.push({ tool: 'genie', command: cmd });
      }
      // Only check omni if we managed to load its commands
      if (omniCmds.size > 0) {
        for (const cmd of extractInvocations(fence, 'omni')) {
          if (!omniCmds.has(cmd)) missing.push({ tool: 'omni', command: cmd });
        }
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
