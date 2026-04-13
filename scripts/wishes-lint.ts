#!/usr/bin/env bun
/**
 * wishes-lint: validate that every markdown link in any wish file
 * whose target points at `.genie/brainstorms/...` resolves to a real file.
 *
 * Exit non-zero if any wish has unresolved brainstorm links.
 * Honors a `<!-- wishes-lint:ignore -->` bailout marker to skip a file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const WISHES_DIR = join(ROOT, '.genie/wishes');

const STUB_MARKERS = [
  '_No brainstorm — direct wish_',
  '_Design not recovered',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

interface BrokenLink {
  file: string;
  line: number;
  text: string;
  target: string;
  resolved: string;
}

function stripInlineCode(line: string): string {
  // Replace backtick-wrapped spans with spaces of equal length so
  // column positions are preserved but links inside code are ignored.
  return line.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length));
}

function lintFile(file: string): BrokenLink[] {
  const text = readFileSync(file, 'utf8');
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return [];

  const broken: BrokenLink[] = [];
  const rawLines = text.split('\n');
  const fileDir = dirname(file);
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;

  // Skip fenced code blocks entirely.
  const inFence: boolean[] = new Array(rawLines.length).fill(false);
  let fenced = false;
  for (let i = 0; i < rawLines.length; i++) {
    if (/^\s*```/.test(rawLines[i])) {
      fenced = !fenced;
      inFence[i] = true;
      continue;
    }
    inFence[i] = fenced;
  }

  for (let i = 0; i < rawLines.length; i++) {
    if (inFence[i]) continue;
    const line = stripInlineCode(rawLines[i]);
    if (STUB_MARKERS.some((m) => line.includes(m))) continue;
    let m: RegExpExecArray | null = linkRe.exec(line);
    while (m !== null) {
      const linkText = m[1];
      const target = m[2].split('#')[0].split(' ')[0];
      if (target && target.includes('brainstorms/')) {
        if (/^https?:\/\//i.test(target)) {
          m = linkRe.exec(line);
          continue;
        }
        const resolved = resolve(fileDir, target);
        if (!existsSync(resolved)) {
          broken.push({
            file,
            line: i + 1,
            text: linkText,
            target,
            resolved,
          });
        }
      }
      m = linkRe.exec(line);
    }
    linkRe.lastIndex = 0;
  }

  return broken;
}

function main() {
  const files = walk(WISHES_DIR);
  const allBroken: BrokenLink[] = [];

  for (const file of files) {
    allBroken.push(...lintFile(file));
  }

  if (allBroken.length > 0) {
    for (const b of allBroken) {
      console.error(`${relative(ROOT, b.file)}:${b.line}: ${b.text} → ${b.target}`);
    }
    console.error(
      `\nwishes-lint: ${allBroken.length} broken brainstorm link(s) across ${files.length} wish file(s)`,
    );
    process.exit(1);
  }

  console.error(`wishes-lint: OK (${files.length} files scanned, 0 broken brainstorm links)`);
}

main();
