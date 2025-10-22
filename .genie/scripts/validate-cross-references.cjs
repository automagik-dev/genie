#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function walk(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const name = e.name;
      if (['.git', 'node_modules', 'dist', 'build'].includes(name)) continue;
      if (p.includes(path.join('.genie', 'state'))) continue;
      if (p.includes(path.join('.genie', 'backups'))) continue;
      walk(p, files);
    } else {
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.md')) files.push(p);
    }
  }
  return files;
}

function isInCodeBlock(content, matchStart) {
  const before = content.slice(0, matchStart);
  const fenceTicks = (before.match(/```/g) || []).length;
  const fenceTildes = (before.match(/~~~/g) || []).length;
  if (fenceTicks % 2 === 1 || fenceTildes % 2 === 1) return true;
  // Inline code within the same line
  const lastNewline = before.lastIndexOf('\n');
  const lineStart = lastNewline === -1 ? 0 : lastNewline;
  const line = content.slice(lineStart, content.indexOf('\n', matchStart) === -1 ? content.length : content.indexOf('\n', matchStart));
  const backticksBefore = (line.slice(0, matchStart - lineStart).match(/`/g) || []).length;
  return backticksBefore % 2 === 1;
}

function isFalsePositive(refPath, context) {
  if (/^[\w\-]+\.(com|ai|org|net|io|dev|co|edu|gov)$/.test(refPath)) return true; // email domains
  if (['next', 'latest', 'canary', 'rc', 'beta', 'alpha'].includes(refPath)) return true; // tags
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(refPath)) return true; // versions
  if (refPath.includes('/') && !refPath.endsWith('.md') && !refPath.endsWith('/')) {
    const parts = refPath.split('/');
    if (parts.length === 2) return true; // @org/package
  }
  const placeholders = ['file.md', 'directory/', 'path', 'include', 'mcp', '...', 'X.Y.Z', 'roadmap', 'standards'];
  if (placeholders.includes(refPath)) return true;
  if (refPath.startsWith('agent-')) return true;
  if (/^[\w\-]{1,29}$/.test(refPath)) {
    const patterns = ['RASCI', 'Responsible:', 'Accountable:', 'Support:', 'Consulted:', 'Informed:', '@username', '@teams', '@eng-team', '@stakeholders', 'twitter.com', 'github.com', 'Follow', 'Discord'];
    if (patterns.some((p) => context.includes(p))) return true;
  }
  if (refPath.includes(':')) return true; // resource identifiers
  return false;
}

function extractRefs(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { return []; }
  const refs = [];
  const re = /@([\w\-.\/]+(?:\.md|\/)?)(?:\s|$|[^\w\-.\/:] )/g;
  let m;
  while ((m = re.exec(content))) {
    if (isInCodeBlock(content, m.index)) continue;
    const refPath = m[1];
    const line = content.slice(0, m.index).split(/\n/).length;
    const start = Math.max(0, m.index - 50);
    const end = Math.min(content.length, m.index + 50);
    const context = content.slice(start, end);
    if (isFalsePositive(refPath, context)) continue;
    refs.push({ refPath, line });
  }
  return refs;
}

function main() {
  const repoRoot = path.join(__dirname, '..', '..');
  console.log('🔍 Validating @ cross-references...');
  const files = walk(repoRoot);
  console.log(`   Found ${files.length} markdown files to check`);
  const broken = [];
  for (const f of files) {
    const refs = extractRefs(f);
    for (const r of refs) {
      const target = path.join(repoRoot, r.refPath);
      const ok = r.refPath.endsWith('/') ? fs.existsSync(target) && fs.statSync(target).isDirectory() : fs.existsSync(target) && fs.statSync(target).isFile();
      if (!ok) {
        broken.push({ source: path.relative(repoRoot, f), line: r.line, reference: r.refPath, error: r.refPath.endsWith('/') ? 'Directory not found' : 'File not found' });
      }
    }
  }
  if (broken.length) {
    console.error(`\n❌ Found ${broken.length} broken @ reference(s):\n`);
    for (const b of broken) {
      console.error(`   ${b.source}:${b.line}`);
      console.error(`      @${b.reference}`);
      console.error(`      ${b.error}`);
      console.error('');
    }
    console.error('Fix broken references before committing.');
    process.exit(1);
  }
  console.log('✅ All @ cross-references valid');
}

main();

