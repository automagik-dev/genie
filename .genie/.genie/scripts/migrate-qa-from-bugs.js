#!/usr/bin/env node
/**
 * Parse .genie/qa/scenarios-from-bugs.md and generate QA workflows under
 * .genie/code/workflows/qa/bugs/<id>-<slug>.md
 * AUTO-GENERATED (overwrites existing bug workflows with the same name).
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const GENIE = path.join(ROOT, '.genie');
const SRC = path.join(GENIE, 'qa', 'scenarios-from-bugs.md');
const DEST_DIR = path.join(GENIE, 'code', 'workflows', 'qa', 'bugs');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function slugify(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'bug'; }

function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function extractSections(block) {
  // simple heuristics for sections
  const get = (name) => {
    const re = new RegExp(`^###\\s+${name}\\n([\s\S]*?)(?=\n###|\n---|$)`, 'm');
    const m = block.match(re); return m ? m[1].trim() : '';
  };
  return {
    reproduction: get('Reproduction Steps'),
    expected: get('Expected Behavior'),
    actual: get('Actual Behavior'),
    validation: get('Validation')
  };
}

function main() {
  const src = readFile(SRC);
  if (!src) {
    console.log('No scenarios-from-bugs.md found; skipping migration.');
    process.exit(0);
  }
  // Match each bug block
  const bugRe = /^##\s+Bug\s+#(\d+):\s+\[(?:Bug|bug)\]\s+(.+)\n([\s\S]*?)(?=\n##\s+Bug\s+#|\n---\n\n##\s+Fixed|$)/gm;
  let m; const outputs = [];
  ensureDir(DEST_DIR);
  while ((m = bugRe.exec(src)) !== null) {
    const id = m[1];
    const title = m[2].trim();
    const body = m[3];
    const sections = extractSections(body);
    const fname = `${id}-${slugify(title)}.md`;
    const outPath = path.join(DEST_DIR, fname);
    const lines = [];
    lines.push(`**Last Updated:** !\`date -u +"%Y-%m-%d %H:%M:%S UTC"\``);
    lines.push('');
    lines.push('---');
    lines.push(`name: bug-${id}`);
    lines.push(`description: ${title}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`# QA Workflow — Bug #${id}`);
    lines.push('');
    if (sections.reproduction) {
      lines.push('## Steps');
      lines.push(sections.reproduction);
      lines.push('');
    }
    if (sections.expected) {
      lines.push('## Success Criteria');
      lines.push(sections.expected);
      lines.push('');
    }
    if (sections.actual) {
      lines.push('## Current Behavior (for reference)');
      lines.push(sections.actual);
      lines.push('');
    }
    lines.push('## Evidence');
    lines.push(`- Save outputs to .genie/qa/evidence/bug-${id}-<timestamp>.txt`);
    lines.push('');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    try { require('child_process').execSync(`git add ${outPath}`, { stdio: 'ignore' }); } catch {}
    outputs.push(outPath);
  }
  console.log(`✅ Migrated ${outputs.length} bug workflows to ${path.relative(ROOT, DEST_DIR)}`);
}

try { main(); } catch (e) {
  console.error('❌ Migration failed:', e?.message || e);
  process.exit(1);
}
