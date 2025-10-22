#!/usr/bin/env node
/**
 * Generate QA workflows from .genie/qa/scenarios-from-bugs.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SRC = path.join(ROOT, '.genie', 'qa', 'scenarios-from-bugs.md');
const DEST_DIR = path.join(ROOT, 'code', 'workflows', 'qa', 'bugs');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'bug';
}

function section(text, heading) {
  const re = new RegExp(`^###\\s+${heading}\\n([\s\S]*?)(?=\n###|\n---|$)`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function parseBugs(markdown) {
  const bugs = [];
  const re = /^##\s+Bug\s+#(\d+):\s+\[(?:Bug|bug)\]\s+(.+?)\n([\s\S]*?)(?=\n##\s+Bug\s+#|\n---|$)/gm;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const id = m[1];
    const title = m[2].trim();
    const body = m[3];
    bugs.push({
      id,
      title,
      reproduction: section(body, 'Reproduction Steps') || '1. TBD',
      expected: section(body, 'Expected Behavior') || '- TBD',
      actual: section(body, 'Actual Behavior') || '- TBD'
    });
  }
  return bugs;
}

function writeWorkflow(bug) {
  const filename = `${bug.id}-${slugify(bug.title)}.md`;
  const outPath = path.join(DEST_DIR, filename);
  const lines = [];
  lines.push(`**Last Updated:** !\`date -u +"%Y-%m-%d %H:%M:%S UTC"\``);
  lines.push('');
  lines.push('---');
  lines.push(`name: bug-${bug.id}`);
  lines.push(`description: ${bug.title}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`# QA Workflow — Bug #${bug.id}`);
  lines.push('');
  lines.push('## Steps');
  lines.push(bug.reproduction);
  lines.push('');
  lines.push('## Success Criteria');
  lines.push(bug.expected);
  lines.push('');
  lines.push('## Current Behavior (for reference)');
  lines.push(bug.actual);
  lines.push('');
  lines.push('## Evidence');
  lines.push(`- Save outputs to .genie/qa/evidence/bug-${bug.id}-<timestamp>.txt`);
  lines.push('');
  ensureDir(DEST_DIR);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  try { require('child_process').execSync(`git add ${outPath}`, { stdio: 'ignore' }); } catch {}
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('- Notes: No scenarios-from-bugs.md found (skipping QA migration)');
    return;
  }
  const markdown = fs.readFileSync(SRC, 'utf8');
  const bugs = parseBugs(markdown);
  if (!bugs.length) {
    console.log('- Notes: No bug scenarios detected');
    return;
  }
  bugs.forEach(writeWorkflow);
  console.log(`- Notes: Generated ${bugs.length} bug QA workflows`);
}

try { main(); } catch (e) {
  console.error('❌ QA migration failed:', e?.message || e);
}

